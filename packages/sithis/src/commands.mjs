import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateScope } from './core.mjs';

export const HELP = `Sithis engagements

Run /engagement to open the menu.

Create an engagement:
  /engagement new                      Guided setup
  /engagement new my-test              Guided scope setup
  /engagement new my-test @scope.json  Load a scope file
  /engagement new my-test scope.json   Also accepts a plain file path
  /engagement new my-test {"allowed":[...],...}

Then use /engagement status for the dashboard or /engagement report.
Use /engagement pending, /engagement coverage, or /engagement retest [ID].
Resume saved work with /engagement resume ID; list it with /engagement list.
Use /engagement leave to return to general Pi tools.
Scope file paths resolve from Pi's working directory. The example template is
packages/sithis/examples/scope.json; replace its placeholder values first.
Set maxRequests or maxRequestsPerHost to 0 for no limit. Omitted values default
to 100 total requests and 30 per host.`;

export function splitWord(text) {
  const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? [match[1], match[2] ?? ''] : ['', ''];
}
export function parsePayload(text, cwd = process.cwd()) {
  let source = text.trim();
  if (!source) throw new Error('Missing JSON or file path. Use @scope.json, scope.json, or inline {"allowed":[...],...}.');
  if ((source.startsWith("'") && source.endsWith("'")) || (source.startsWith('"') && source.endsWith('"'))) source = source.slice(1,-1);
  if (!source.startsWith('{') && !source.startsWith('[')) {
    let file = source.startsWith('@') ? source.slice(1).trim() : source;
    if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1,-1);
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    const absolute = path.resolve(cwd, file);
    try { source = fs.readFileSync(absolute,'utf8'); }
    catch (error) { throw new Error(`Cannot read JSON file ${absolute}: ${error.code ?? error.message}. Use a path relative to ${cwd}, or an absolute path.`); }
  }
  let data;
  try { data = JSON.parse(source); }
  catch { throw new Error('Invalid JSON. Use double-quoted property names and a complete JSON object, or save it to a file and pass @scope.json. Run /engagement new for guided setup.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object.');
  if (JSON.stringify(data).includes('REPLACE_WITH_')) throw new Error('The scope template still has placeholders. Set expires to a future ISO timestamp and authorization to your rules-of-engagement reference, or use /engagement new for guided setup.');
  return data;
}
export function listEngagements(store) {
  return fs.readdirSync(store.root,{withFileTypes:true}).filter(e=>e.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(e.name)).flatMap(e=>{
    try {
      const state=store.load(e.name);
      return [{id:e.name,expires:state.scope.expires,findings:state.findings.length}];
    } catch { return []; }
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export class SetupCancelled extends Error {
  constructor() { super('Setup cancelled; no engagement created.'); }
}
function remainingTime(milliseconds) {
  const minutes = Math.ceil(Math.abs(milliseconds) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, (rest || !days && !hours) && `${rest}m`].filter(Boolean).join(' ');
}
export function formatDashboard(state, now = Date.now()) {
  const remaining = Date.parse(state.scope.expires) - now;
  const count = status => state.findings.filter(f => f.status === status).length;
  const coverageCount = status => state.coverage.filter(c => c.status === status).length;
  const budget = state.requestBudget;
  const requestLine = budget.total === 0
    ? `Requests: ${budget.used} · no limit`
    : `Requests: ${budget.used}/${budget.total} · ${Math.max(0, budget.total - budget.used)} remaining${budget.used >= budget.total ? ' · budget exhausted' : ''}`;
  const awaiting = state.findings.filter(f => ['candidate', 'reproduced', 'inconclusive'].includes(f.status)).length;
  return [
    `Engagement: ${state.id}${remaining <= 0 ? ' (expired)' : ''}`,
    remaining <= 0 ? `Expired ${remainingTime(remaining)} ago` : `Expires in: ${remainingTime(remaining)}`,
    `Deadline: ${new Date(state.scope.expires).toLocaleString(undefined, { timeZoneName: 'short' })}`,
    requestLine,
    `Assets recorded: ${state.assets.length}`,
    `Findings: ${count('verified')} verified · ${awaiting} awaiting validation · ${count('fixed')} fixed · ${count('retested')} retested · ${count('rejected')} rejected`,
    `Verified evidence: ${state.findings.filter(f => f.status === 'verified' && f.verificationSource === 'http-marker').length} machine · ${state.findings.filter(f => f.status === 'verified' && f.verificationSource === 'manual-review').length} manual`,
    `Coverage records: ${coverageCount('tested')} tested · ${coverageCount('blocked')} blocked · ${coverageCount('skipped')} skipped · ${coverageCount('unknown')} unknown`,
    'Coverage reflects recorded checks; total application coverage is unknown.',
    `Pending work: ${state.pending.length}`,
  ].join('\n');
}
export function formatPending(state) {
  const names = { verify: 'Verify recipe', 'manual-review': 'Manual review required', retest: 'Retest fix' };
  return [`Pending work: ${state.id}`, '', ...state.pending.map(task => {
    const finding = state.findings.find(f => f.id === task.finding);
    return `${names[task.next] ?? task.next}: ${finding?.title ?? task.finding} (${task.finding})`;
  }), ...(state.pending.length ? [] : ['No pending findings.'])].join('\n');
}
export function formatCoverageGaps(state) {
  const gaps = state.coverage.filter(c => c.status !== 'tested');
  return [`Coverage gaps: ${state.id}`, 'Only recorded checks are shown; unrecorded application areas remain unknown.', '',
    ...gaps.map(c => `${c.status} | ${c.url} | role: ${c.role} | ${c.check}${c.parameter ? ` | parameter: ${c.parameter}` : ''}\n  ${c.reason || 'No reason recorded.'}`),
    ...(gaps.length ? [] : ['No recorded coverage gaps. This does not imply complete coverage.']),
  ].join('\n');
}
export function formatStatus(state) {
  return [formatDashboard(state), '',
    `Allowed: ${state.scope.allowed.join(', ')}`,
    `Excluded: ${state.scope.excluded.join(', ') || 'none'}`,
    `Ports: ${state.scope.ports.join(', ')}`,
    `Expires: ${state.scope.expires}`, '',
    ...state.findings.map(f => `  ${f.severity} | ${f.status} | ${f.title} (${f.id})`), '',
    'Use /engagement pending, /engagement coverage, or /engagement report for details.',
  ].join('\n');
}
export function formatEngagementList(saved) {
  if (!saved.length) return 'No saved engagements yet. Start with /engagement new.';
  return ['Saved engagements', '', ...saved.map(e => `${e.id} | ${Date.parse(e.expires) <= Date.now() ? 'expired' : 'active'} | expires ${e.expires} | ${e.findings} findings`), '', 'Use /engagement resume ID to select one.'].join('\n');
}
export async function engagementMenu(ui, selected, saved, state) {
  const actions = ['New engagement'];
  if (saved.length) actions.push('Resume engagement');
  if (selected) actions.push('View dashboard', 'Review pending findings', 'View coverage gaps', 'Retest fixes', 'Generate report', 'Leave engagement');
  actions.push('Help');
  const action = await ui.select(state ? formatDashboard(state) : selected ? `Engagement: ${selected}` : 'Sithis engagements', actions);
  return { 'New engagement': 'new', 'Resume engagement': 'resume', 'View dashboard': 'status', 'Review pending findings': 'pending', 'View coverage gaps': 'coverage', 'Retest fixes': 'retest', 'Generate report': 'report', 'Leave engagement': 'leave', Help: 'help' }[action];
}
export async function guidedScope(ui, initialId, { existingIds = [] } = {}) {
  const exampleExpiry = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = { allowed: ['example.test'], ports: [443], expires: exampleExpiry, authorization: 'pending' };
  const field = async (label, placeholder, validate, optional = false) => {
    while (true) {
      const response = await ui.input(label, placeholder);
      if (response === undefined) throw new SetupCancelled();
      const value = response.trim();
      try {
        if (!optional && !value) throw new Error(`${label} is required.`);
        return validate(value);
      } catch (error) {
        ui.notify?.(error.message, 'error');
      }
    }
  };
  const checkId = id => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Use 1–80 letters, digits, underscores or hyphens, starting with a letter or digit.');
    if (existingIds.includes(id)) throw new Error(`Engagement "${id}" already exists. Resume it or choose another ID.`);
    return id;
  };
  const id = initialId ? checkId(initialId) : await field('Engagement ID', 'customer-web-test', checkId);
  const hosts = value => value.split(',').map(s => s.trim()).filter(Boolean);
  const allowed = await field('Authorized hosts, IPs or CIDRs (comma-separated)', 'app.example.test, api.example.test', value => {
    const parsed = hosts(value); validateScope({ ...base, allowed: parsed }); return parsed;
  });
  const ports = await field('Allowed ports (comma-separated)', '443', value => {
    if (!/^\d+(?:\s*,\s*\d+)*$/.test(value)) throw new Error('Enter port numbers, for example 80,443.');
    const parsed = value.split(',').map(Number); validateScope({ ...base, ports: parsed }); return [...new Set(parsed)];
  });
  const durations = { '1 hour': 3600000, '4 hours': 14400000, '24 hours': 86400000, '7 days': 604800000 };
  const expiration = await ui.select('Engagement expires in', [...Object.keys(durations), 'Custom deadline…']);
  if (expiration === undefined) throw new SetupCancelled();
  const expires = expiration === 'Custom deadline…' ? await field(`Scope expires (e.g. ${exampleExpiry})`, exampleExpiry, value => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`Include date, time and timezone, for example ${exampleExpiry}.`);
    validateScope({ ...base, expires: value }); return new Date(value).toISOString();
  }) : new Date(Date.now() + durations[expiration]).toISOString();
  const authorization = await field('Authorization / rules-of-engagement reference', 'Customer approval or engagement document reference', value => value);
  const budget = await field('Request budget (blank or 0 = no limit)', '0', value => {
    if (!value || /^(?:none|unlimited)$/i.test(value)) return 0;
    if (!/^\d+$/.test(value)) throw new Error('Enter a whole number of requests, or blank/0 for no limit.');
    const parsed = Number(value);
    validateScope({ ...base, maxRequests: parsed });
    return parsed;
  }, true);
  const excluded = await field('Excluded hosts, IPs or CIDRs (optional, comma-separated)', 'Leave blank if none', value => {
    const parsed = hosts(value); validateScope({ ...base, excluded: parsed }); return parsed;
  }, true);
  const scope = validateScope({ allowed, ports, expires, authorization, excluded, maxRequests: budget, maxRequestsPerHost: budget === 0 ? 0 : 30 });
  // Show the completed scope before persisting; cancellation never creates partial state.
  if (ui.confirm && !await ui.confirm('Create engagement?', `${id}\nAllowed: ${allowed.join(', ')}\nPorts: ${ports.join(', ')}\nExpires: ${scope.expires}\nRequests: ${scope.maxRequests === 0 ? 'no limit' : `${scope.maxRequests} total, ${scope.maxRequestsPerHost} per host`}\nAuthorization: ${authorization}\nExclusions: ${excluded.join(', ') || 'none'}`)) throw new SetupCancelled();
  return { id, scope };
}
