import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function host(url) { return url.hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
function match(address, rule) {
  if (rule.includes('/')) {
    const [ip, bits] = rule.split('/');
    const list = new BlockList();
    list.addSubnet(ip, Number(bits), isIP(ip) === 6 ? 'ipv6' : 'ipv4');
    return isIP(address) !== 0 && list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  return rule.startsWith('*.') ? address.endsWith(rule.slice(1)) && address !== rule.slice(2) : address === rule;
}
function validateRule(rule) {
  assert(typeof rule === 'string' && rule === rule.toLowerCase(), 'Scope entries must be lowercase hosts, IPs, or CIDRs');
  if (rule.includes('/')) {
    const parts = rule.split('/');
    assert(parts.length === 2 && isIP(parts[0]) && /^\d+$/.test(parts[1]), 'Invalid CIDR');
    match(parts[0], rule);
  } else assert(isIP(rule) || /^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rule), 'Invalid scope host');
}
export function validateScope(scope) {
  assert(scope && Array.isArray(scope.allowed) && scope.allowed.length, 'Scope needs allowed hosts/IPs/CIDRs');
  assert(Array.isArray(scope.excluded ?? []), 'excluded must be an array');
  [...scope.allowed, ...(scope.excluded ?? [])].forEach(validateRule);
  assert(Array.isArray(scope.ports) && scope.ports.length && scope.ports.every(p => Number.isInteger(p) && p > 0 && p < 65536), 'Explicit valid ports required');
  assert(Number.isFinite(Date.parse(scope.expires)) && Date.parse(scope.expires) > Date.now(), 'Future scope expiry required');
  for (const [key, fallback, max] of [['maxRequests',100,100000],['maxRequestsPerHost',30,10000],['minIntervalMs',1000,60000]]) {
    const v = scope[key] ?? fallback;
    assert(Number.isInteger(v) && v >= 1 && v <= max, `Invalid ${key}`);
  }
  assert(typeof scope.authorization === 'string' && scope.authorization.trim(), 'Authorization reference required');
  return { excluded: [], maxRequests: 100, maxRequestsPerHost: 30, minIntervalMs: 1000, ...scope };
}
export async function resolveTarget(scope, target, resolver = lookup) {
  assert(Date.parse(scope.expires) > Date.now(), 'Engagement scope expired');
  const url = new URL(target);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Only HTTP(S) without URL credentials is supported');
  const hostname = host(url);
  assert(!url.hash, 'URL fragments are not sent to targets');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  assert(scope.ports.includes(port), 'Port outside scope');
  assert(!(scope.excluded ?? []).some(r => match(hostname, r)), 'Host explicitly excluded');
  let timer;
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    resolver(hostname, { all: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 10000); }),
  ]).finally(() => clearTimeout(timer));
  assert(addresses.length > 0, 'No target address');
  const hostAllowed = scope.allowed.some(r => match(hostname, r));
  for (const { address } of addresses) {
    assert(!(scope.excluded ?? []).some(r => match(address, r)), 'Resolved address explicitly excluded');
    assert(hostAllowed || scope.allowed.some(r => match(address, r)), 'Target outside scope');
    // IPv4-mapped IPv6 is intentionally rejected to prevent alternate-address scope bypasses.
    assert(!address.toLowerCase().includes('::ffff:'), 'IPv4-mapped IPv6 unsupported');
  }
  return { url, hostname, port, address: addresses[0] };
}
export class Store {
  constructor(root = process.env.SITHIS_DATA_DIR || path.join(os.homedir(), '.local/share/sithis')) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  dir(id) { assert(idPattern.test(id), 'Invalid engagement ID'); return path.join(this.root, id); }
  load(id) { return read(path.join(this.dir(id), 'state.json')); }
  transaction(id, action) {
    const dir = this.dir(id), lock = path.join(dir, '.lock');
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('Engagement busy or stale lock; retry, or inspect .lock after checking running processes'); }
    try {
      const state = this.load(id);
      const result = action(state);
      atomic(path.join(dir, 'state.json'), state);
      return result;
    } finally { fs.rmdirSync(lock); }
  }
  create(id, scope) {
    const validated = validateScope(scope), dir = this.dir(id);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'evidence'), { mode: 0o700 });
    const state = { schemaVersion: 1, id, created: now(), scope: validated, requests: 0, hosts: {}, assets: [], coverage: [], findings: [], actions: [], evidence: [] };
    atomic(path.join(dir, 'state.json'), state);
    return state;
  }
  evidence(id, kind, data) {
    const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    const artifact = { id: randomUUID(), kind, sha256: hash(bytes), bytes: bytes.length, created: now() };
    const file = path.join(this.dir(id), 'evidence', `${artifact.id}.json`);
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    this.transaction(id, s => s.evidence.push(artifact));
    return artifact;
  }
  artifact(id, artifactId) {
    const record = this.load(id).evidence.find(e => e.id === artifactId);
    assert(record, 'Unknown evidence ID');
    const bytes = fs.readFileSync(path.join(this.dir(id), 'evidence', `${record.id}.json`));
    assert(hash(bytes) === record.sha256, 'Evidence integrity mismatch');
    return bytes.toString('utf8');
  }
  reserve(id, hostname) {
    return this.transaction(id, s => {
      assert(Date.parse(s.scope.expires) > Date.now(), 'Engagement scope expired');
      const previous = s.hosts[hostname] ?? { requests: 0, last: 0 };
      assert(s.requests < s.scope.maxRequests && previous.requests < s.scope.maxRequestsPerHost, 'Request budget exhausted');
      assert(Date.now() - previous.last >= s.scope.minIntervalMs, 'Host rate limit: retry later');
      s.requests++;
      s.hosts[hostname] = { requests: previous.requests + 1, last: Date.now() };
    });
  }
}
function requestPinned(target, signal) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    let deadline;
    const req = transport.request(target.url, {
      method: 'GET', signal, agent: false, timeout: 10000,
      headers: { 'user-agent': 'Sithis/0.1 authorized-security-assessment', accept: '*/*', 'accept-encoding': 'identity' },
      lookup: (_name, options, cb) => options.all ? cb(null, [target.address]) : cb(null, target.address.address, target.address.family),
    }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 1024 * 1024) { res.destroy(new Error('Response exceeds 1 MiB limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), bodyBase64: Buffer.concat(chunks).toString('base64') }));
    });
    deadline = setTimeout(() => req.destroy(new Error('Request deadline exceeded')), 15000);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}
export async function probe(store, id, url, { signal, resolver = lookup } = {}) {
  let resolved;
  try {
    resolved = await resolveTarget(store.load(id).scope, url, resolver);
    store.reserve(id, resolved.hostname);
  } catch (error) {
    store.transaction(id, s => s.actions.push({ at: now(), type: 'scope-or-budget-denied', target: url, reason: error.message }));
    throw error;
  }
  const started = now();
  try {
    const response = await requestPinned(resolved, signal);
    const artifact = store.evidence(id, 'http-response', { url, started, ended: now(), resolvedAddress: resolved.address.address, method: 'GET', runtime: process.version, ...response });
    store.transaction(id, s => {
      if (!s.assets.some(a => a.url === url)) s.assets.push({ id: randomUUID(), url, role: 'anonymous', discovered: now() });
      s.actions.push({ at: now(), type: 'http-get', target: url, evidence: artifact.id, status: response.status });
    });
    return { ...response, evidence: artifact.id };
  } catch (error) {
    store.transaction(id, s => s.actions.push({ at: now(), type: 'http-error', target: url, reason: error.message, started }));
    throw error;
  }
}
export function addFinding(store, id, input) {
  assert(typeof input.title === 'string' && input.title.trim() && typeof input.url === 'string', 'Finding title and URL required');
  assert(['info','low','medium','high','critical'].includes(input.severity), 'Invalid severity');
  const url = new URL(input.url).href;
  return store.transaction(id, s => {
    assert(!s.findings.some(f => f.url === url && f.title === input.title), 'Duplicate finding');
    const evidence = input.evidence ?? [];
    assert(Array.isArray(evidence) && evidence.every(e => s.evidence.some(a => a.id === e)), 'Unknown evidence reference');
    const finding = { id: randomUUID(), title: input.title, url, severity: input.severity, description: input.description ?? '', remediation: input.remediation ?? '', evidence, recipe: input.recipe ?? null, status: 'candidate', created: now(), checks: [] };
    s.findings.push(finding);
    return finding;
  });
}
function validateRecipe(recipe) {
  assert(recipe && recipe.kind === 'http-marker', 'Supported automatic oracle: http-marker; use manual review for other classes');
  assert(typeof recipe.marker === 'string' && recipe.marker.length >= 8 && recipe.marker.length <= 256, 'Marker must be 8–256 characters');
  assert(Number.isInteger(recipe.status) && recipe.status >= 200 && recipe.status < 600, 'Expected HTTP status required');
  assert(typeof recipe.controlUrl === 'string' && typeof recipe.url === 'string' && recipe.controlUrl !== recipe.url, 'Distinct probe and negative-control URLs required');
  assert(typeof recipe.claim === 'string' && recipe.claim.trim(), 'Precise oracle claim required');
}
async function pause(ms, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function verify(store, id, findingId, { signal, retest = false } = {}) {
  const finding = store.load(id).findings.find(f => f.id === findingId);
  assert(finding, 'Unknown finding');
  assert(!retest || ['fixed','retested'].includes(finding.status), 'Mark finding fixed before retesting');
  validateRecipe(finding.recipe);
  const recipe = finding.recipe, evidence = []; let passed = 0, controls = 0;
  // Validate both destinations before the first request, then recheck before every request.
  await resolveTarget(store.load(id).scope, recipe.url);
  await resolveTarget(store.load(id).scope, recipe.controlUrl);
  for (let i = 0; i < 2; i++) {
    if (i) await pause(store.load(id).scope.minIntervalMs, signal);
    const result = await probe(store, id, recipe.url, { signal }); evidence.push(result.evidence);
    if (result.status === recipe.status && result.body.includes(recipe.marker)) passed++;
    await pause(store.load(id).scope.minIntervalMs, signal);
    const control = await probe(store, id, recipe.controlUrl, { signal }); evidence.push(control.evidence);
    // Reject error pages as negative controls: absence alone is insufficient.
    if (control.status === recipe.status && !control.body.includes(recipe.marker)) controls++;
  }
  const verdict = passed === 2 && controls === 2 ? 'verified' : retest && passed === 0 && controls === 2 ? 'retested' : 'inconclusive';
  const receipt = { id: randomUUID(), at: now(), oracle: 'http-marker', claim: `HTTP ${recipe.status} marker observation: ${passed}/2 probe responses contained the marker; ${controls}/2 control responses did not. This does not establish script execution or exploitability.`, requestedClaim: recipe.claim, verdict, passed, controls, attempts: 2, evidence, recipeHash: hash(JSON.stringify(recipe)) };
  store.transaction(id, s => {
    const f = s.findings.find(f => f.id === findingId);
    assert(JSON.stringify(f.recipe) === JSON.stringify(recipe) && f.status === finding.status, 'Finding changed during verification');
    f.checks.push(receipt); f.evidence = [...new Set([...f.evidence, ...evidence])];
    f.status = retest && verdict === 'inconclusive' ? finding.status : verdict;
  });
  return receipt;
}
export function reviewFinding(store, id, findingId, input) {
  assert(['reproduced','verified','rejected','fixed','retested','inconclusive'].includes(input.status), 'Invalid manual status');
  assert(typeof input.reviewer === 'string' && input.reviewer.trim() && typeof input.reason === 'string' && input.reason.trim(), 'Reviewer and reasoning required');
  return store.transaction(id, s => {
    const f = s.findings.find(f => f.id === findingId); assert(f, 'Unknown finding');
    const evidence = input.evidence ?? [];
    assert(Array.isArray(evidence) && evidence.every(e => s.evidence.some(a => a.id === e)), 'Unknown evidence');
    assert(!['reproduced','verified','retested'].includes(input.status) || evidence.length, 'Reproduction/verification requires evidence');
    assert(input.status !== 'fixed' || f.status === 'verified', 'Only verified findings may be marked fixed');
    assert(input.status !== 'retested' || ['fixed','retested'].includes(f.status), 'Mark finding fixed before manual retesting');
    const check = { id: randomUUID(), at: now(), oracle: 'manual-review', status: input.status, reviewer: input.reviewer, reason: input.reason, evidence };
    f.checks.push(check); f.status = input.status; f.evidence = [...new Set([...f.evidence, ...evidence])];
    return f;
  });
}
export function coverage(store, id, input) {
  assert(typeof input.url === 'string' && typeof input.check === 'string' && typeof input.role === 'string', 'Coverage URL, check and role required');
  assert(['tested','skipped','blocked','unknown'].includes(input.status), 'Invalid coverage status');
  return store.transaction(id, s => {
    const item = { url: new URL(input.url).href, check: input.check, role: input.role, parameter: input.parameter ?? '', status: input.status, reason: input.reason ?? '', evidence: input.evidence ?? [], at: now() };
    assert(Array.isArray(item.evidence) && item.evidence.every(e => s.evidence.some(a => a.id === e)), 'Unknown evidence');
    assert(item.status !== 'tested' || item.evidence.length, 'Tested coverage requires evidence');
    const key = x => [x.url,x.check,x.role,x.parameter].join('\0');
    s.coverage = s.coverage.filter(x => key(x) !== key(item)); s.coverage.push(item); return item;
  });
}
export function handoff(store, id) {
  const s = store.load(id);
  return { id, scope: s.scope, requestBudget: { used: s.requests, total: s.scope.maxRequests }, assets: s.assets, findings: s.findings.map(({id,title,status,severity,evidence,checks}) => ({id,title,status,severity,evidence, verificationSource: checks.findLast(c => (c.verdict ?? c.status) === status)?.oracle ?? null})), coverage: s.coverage, pending: s.findings.filter(f => ['candidate','reproduced','inconclusive','fixed'].includes(f.status)).map(f => ({finding: f.id, next: f.status === 'fixed' ? 'retest' : f.recipe ? 'verify' : 'manual-review'})), recentActions: s.actions.slice(-20) };
}
const safeText = value => String(value ?? '').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
export function report(store, id) {
  const s = store.load(id);
  const lines = [`# Sithis assessment: ${safeText(id)}`, '', `Generated: ${now()}`, `Scope expires: ${s.scope.expires}`, `Requests: ${s.requests}/${s.scope.maxRequests}`, '', '## Verified observations and reviewed findings', '', 'Automatic receipts establish only their stated observation; assess vulnerability impact separately.', ''];
  for (const f of s.findings.filter(f => ['verified','fixed','retested'].includes(f.status))) {
    lines.push(`### ${safeText(f.title)}`, '', `Severity: ${f.severity}; status: ${f.status}`, '', safeText(f.url), '', safeText(f.description), '', `Remediation: ${safeText(f.remediation)}`, '', `Evidence: ${f.evidence.join(', ')}`, '', `Verification: ${safeText(f.checks.findLast(c => c.oracle === 'http-marker')?.oracle ?? f.checks.at(-1)?.oracle)} — ${safeText(f.checks.findLast(c => c.oracle === 'http-marker')?.claim ?? f.checks.at(-1)?.reason)}`, '');
  }
  lines.push('## Coverage and limitations', '', 'Coverage records describe completed checks, not proof of absence of vulnerabilities.', '');
  for (const c of s.coverage) lines.push(`- ${safeText(c.url)} | ${safeText(c.role)} | ${safeText(c.check)} | ${c.status}: ${safeText(c.reason)}`);
  lines.push('', `Unconfirmed findings: ${s.findings.filter(f => ['candidate','reproduced','inconclusive'].includes(f.status)).length}`, '');
  const output = lines.join('\n');
  fs.writeFileSync(path.join(store.dir(id), 'report.md'), output, { mode: 0o600 });
  return output;
}
export function capsule(store, id, findingId) {
  const finding = store.load(id).findings.find(f => f.id === findingId);
  assert(finding?.status === 'verified', 'Only verified findings can be exported');
  const artifacts = finding.evidence.map(e => ({ id: e, content: store.artifact(id, e) }));
  const body = { schemaVersion: 1, packageVersion: '0.1.0', created: now(), finding, artifacts };
  return { ...body, sha256: hash(JSON.stringify(body)) };
}
export function importCapsule(store, id, data) {
  const { sha256, ...body } = data;
  assert(body.schemaVersion === 1 && hash(JSON.stringify(body)) === sha256, 'Capsule integrity mismatch');
  validateRecipe(body.finding?.recipe);
  // Import creates a candidate. Neither a digest nor a historical receipt establishes a fresh verdict.
  return addFinding(store, id, { ...body.finding, evidence: [] });
}
export async function dispatch(store, operation, id, data = {}, signal) {
  switch (operation) {
    case 'new': return store.create(id, data);
    case 'status': case 'resume': return handoff(store, id);
    case 'probe': return probe(store, id, data.url, { signal });
    case 'finding': return addFinding(store, id, data);
    case 'verify': return verify(store, id, data.finding, { signal });
    case 'retest': return verify(store, id, data.finding, { signal, retest: true });
    case 'review': return reviewFinding(store, id, data.finding, data);
    case 'coverage': return coverage(store, id, data);
    case 'evidence': return store.artifact(id, data.evidence);
    case 'capture': {
      assert(typeof data.kind === 'string' && data.content !== undefined, 'Evidence kind and content required');
      return store.evidence(id, data.kind, data.content);
    }
    case 'report': return report(store, id);
    case 'capsule': return capsule(store, id, data.finding);
    case 'import': return importCapsule(store, id, data);
    default: throw new Error('Unknown operation');
  }
}
