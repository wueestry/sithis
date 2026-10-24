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

Then use /engagement status or /engagement report.
Resume saved work with /engagement resume ID; list it with /engagement list.
Use /engagement leave to return to general Pi tools.
Scope file paths resolve from Pi's working directory. The example template is
packages/sithis/examples/scope.json; replace its placeholder values first.`;

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
export function formatStatus(state) {
  const expired = Date.parse(state.scope.expires) <= Date.now();
  return [
    `Engagement: ${state.id}${expired ? ' (expired)' : ''}`,
    `Allowed: ${state.scope.allowed.join(', ')}`,
    `Excluded: ${state.scope.excluded.join(', ') || 'none'}`,
    `Ports: ${state.scope.ports.join(', ')}`,
    `Expires: ${state.scope.expires}`,
    `Requests: ${state.requestBudget.used}/${state.requestBudget.total}`,
    `Assets: ${state.assets.length} | Findings: ${state.findings.length} | Pending: ${state.pending.length}`,
    '',
    ...state.findings.map(f => `  ${f.severity} | ${f.status} | ${f.title} (${f.id})`),
    '',
    'Use /engagement report for the report, or ask the agent to investigate within this scope.',
  ].join('\n');
}
export function formatEngagementList(saved) {
  if (!saved.length) return 'No saved engagements yet. Start with /engagement new.';
  return ['Saved engagements', '', ...saved.map(e => `${e.id} | ${Date.parse(e.expires) <= Date.now() ? 'expired' : 'active'} | expires ${e.expires} | ${e.findings} findings`), '', 'Use /engagement resume ID to select one.'].join('\n');
}
export async function engagementMenu(ui, selected, saved) {
  const actions = ['New engagement'];
  if (saved.length) actions.push('Resume engagement');
  if (selected) actions.push('View status', 'Generate report', 'Leave engagement');
  actions.push('Help');
  const action = await ui.select(selected ? `Engagement: ${selected}` : 'Sithis engagements', actions);
  return { 'New engagement': 'new', 'Resume engagement': 'resume', 'View status': 'status', 'Generate report': 'report', 'Leave engagement': 'leave', Help: 'help' }[action];
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
  const excluded = await field('Excluded hosts, IPs or CIDRs (optional, comma-separated)', 'Leave blank if none', value => {
    const parsed = hosts(value); validateScope({ ...base, excluded: parsed }); return parsed;
  }, true);
  const scope = validateScope({ allowed, ports, expires, authorization, excluded });
  // Show the completed scope before persisting; cancellation never creates partial state.
  if (ui.confirm && !await ui.confirm('Create engagement?', `${id}\nAllowed: ${allowed.join(', ')}\nPorts: ${ports.join(', ')}\nExpires: ${scope.expires}\nAuthorization: ${authorization}\nExclusions: ${excluded.join(', ') || 'none'}`)) throw new SetupCancelled();
  return { id, scope };
}
