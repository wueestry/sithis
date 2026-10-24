import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateScope } from './core.mjs';

export const HELP = `Sithis engagements

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
export async function guidedScope(ui, initialId) {
  const input = async (label, placeholder) => {
    const value=await ui.input(label,placeholder);
    if (value === undefined) throw new Error('Setup cancelled; no engagement created.');
    if (!value.trim()) throw new Error(`${label} is required. Run /engagement new to try again.`);
    return value.trim();
  };
  const id=initialId || await input('Engagement ID','customer-web-test');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Engagement ID must be 1–80 letters, digits, underscores or hyphens, starting with a letter or digit.');
  const allowed=(await input('Authorized hosts, IPs or CIDRs (comma-separated)','app.example.test, api.example.test')).split(',').map(s=>s.trim());
  const ports=(await input('Allowed ports (comma-separated)','443')).split(',').map(s=>Number(s.trim()));
  const expires=await input('Scope expires (e.g. 2026-10-25T18:00:00+01:00)',new Date(Date.now()+86400000).toISOString());
  const authorization=await input('Authorization / rules-of-engagement reference','Customer approval or engagement document reference');
  const excluded=await ui.input('Excluded hosts, IPs or CIDRs (optional, comma-separated)','Leave blank if none');
  if (excluded === undefined) throw new Error('Setup cancelled; no engagement created.');
  return { id, scope: validateScope({allowed,ports,expires,authorization,excluded:excluded.split(',').map(s=>s.trim()).filter(Boolean)}) };
}
