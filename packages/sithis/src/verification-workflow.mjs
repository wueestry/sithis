import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateRecipe, verify } from './core.mjs';

const pending = new Set(['candidate', 'reproduced', 'inconclusive']);
const complete = task => ['verified', 'inconclusive'].includes(task.status);
const digest = recipe => createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
const timestamp = () => new Date().toISOString();

export function planVerification(store, id, { restart = false } = {}) {
  const state = store.load(id);
  const previous = state.verificationRun;
  if (!restart && previous && ['running', 'paused'].includes(previous.status)) {
    return { ...structuredClone(previous), scope: structuredClone(state.scope), requestsUsed: state.requests, resuming: true };
  }
  const tasks = [], manual = [];
  for (const finding of state.findings.filter(f => pending.has(f.status))) {
    try {
      validateRecipe(finding.recipe);
      for (const target of [finding.recipe.url, finding.recipe.controlUrl]) {
        const url = new URL(target);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) recipes can run');
      }
      tasks.push({ finding: finding.id, title: finding.title, recipe: structuredClone(finding.recipe), recipeHash: digest(finding.recipe), expectedStatus: finding.status, baselineChecks: finding.checks.map(c => c.id), status: 'pending' });
    } catch (error) { manual.push({ finding: finding.id, title: finding.title, reason: error.message }); }
  }
  return { id: randomUUID(), status: 'ready', created: timestamp(), scope: structuredClone(state.scope), tasks, manual, requestsUsed: state.requests, resuming: false };
}

export function formatVerificationPlan(plan) {
  const remaining = plan.tasks.filter(task => !complete(task));
  return [
    `${plan.resuming ? 'Resume' : 'Start'} verification: ${remaining.length} findings`,
    `Estimated requests: ${remaining.length * 4} (two probes and two controls per finding). Interrupted findings restart their full check.`,
    `Requests already used: ${plan.requestsUsed}. Remaining budget: ${plan.scope.maxRequests === 0 ? 'no limit' : Math.max(0, plan.scope.maxRequests - plan.requestsUsed)}; per-host limit: ${plan.scope.maxRequestsPerHost === 0 ? 'no limit' : plan.scope.maxRequestsPerHost}`,
    `Scope expires: ${plan.scope.expires}${Date.parse(plan.scope.expires) <= Date.now() ? ' (expired; target requests will be blocked)' : ''}`,
    ...remaining.map(task => `- ${task.title} (${task.finding})\n  Probe: ${task.recipe.url}\n  Control: ${task.recipe.controlUrl}`),
    `Manual review: ${plan.manual.length} unsupported or missing recipes remain pending.`,
    ...plan.manual.map(task => `- ${task.title}: ${task.reason}`),
    'Checks run sequentially within scope, expiration, rate limits, and remaining request budgets. Escape pauses the workflow.',
  ].join('\n');
}

export function formatVerificationResult(run) {
  const count = status => run.tasks.filter(task => task.status === status).length;
  return [
    `Verification ${run.status === 'paused' ? 'paused' : run.status === 'running' ? 'running' : 'complete'}`,
    `${count('verified')} verified · ${count('inconclusive')} inconclusive · ${count('blocked')} blocked · ${run.tasks.filter(task => ['pending', 'running'].includes(task.status)).length} pending`,
    ...run.tasks.map(task => `${task.status} | ${task.title}${task.reason ? ` | ${task.reason}` : ''}${task.receipt ? ` | receipt: ${task.receipt}` : ''}`),
    `Manual review: ${run.manual.length} findings remain outside automatic verification.`,
    ...(run.status === 'paused' ? ['Use /engagement verify-pending to resume unfinished checks. Completed checks will not be repeated. Use /engagement verify-pending new to review a fresh plan instead.'] : []),
  ].join('\n');
}

function requestCounts(recipe) {
  const counts = new Map();
  for (const target of [recipe.url, recipe.controlUrl]) {
    const hostname = new URL(target).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    counts.set(hostname, (counts.get(hostname) ?? 0) + 2);
  }
  return counts;
}

export async function runVerification(store, id, approvedPlan, { signal, onProgress = () => {} } = {}) {
  const lock = path.join(store.dir(id), '.verification.lock');
  store.transaction(id, state => {
    if (JSON.stringify(state.scope) !== JSON.stringify(approvedPlan.scope)) throw new Error('Scope changed; review the verification plan again.');
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new Error('Verification workflow busy or stale lock; inspect running processes before removing .verification.lock.'); }
  });
  const run = structuredClone(approvedPlan);
  const save = () => store.transaction(id, state => { state.verificationRun = structuredClone(run); });
  try {
    run.status = 'running'; run.updated = timestamp(); save();
    for (const task of run.tasks) {
      if (complete(task)) continue;
      if (signal?.aborted) break;
      const state = store.load(id);
      const finding = state.findings.find(f => f.id === task.finding);
      // Recover the receipt if execution finished before the workflow checkpoint was saved.
      const receipt = finding?.checks.findLast(check => !task.baselineChecks.includes(check.id) && check.recipeHash === task.recipeHash && ['verified', 'inconclusive'].includes(check.verdict));
      if (receipt) {
        task.status = receipt.verdict; task.receipt = receipt.id; delete task.reason; save(); continue;
      }
      try {
        if (!finding || !pending.has(finding.status) || finding.status !== task.expectedStatus || digest(finding.recipe) !== task.recipeHash) throw new Error('Finding changed since planning; review it before starting a new workflow.');
        if (JSON.stringify(state.scope) !== JSON.stringify(run.scope)) throw new Error('Scope changed; review the plan again.');
        if (Date.parse(state.scope.expires) <= Date.now()) throw new Error('Engagement scope expired');
        const counts = requestCounts(task.recipe);
        if (state.scope.maxRequests !== 0 && state.requests + 4 > state.scope.maxRequests) throw new Error('Insufficient remaining request budget for a complete check');
        let wait = 0;
        for (const [hostname, requests] of counts) {
          const host = state.hosts[hostname] ?? { requests: 0, last: 0 };
          if (state.scope.maxRequestsPerHost !== 0 && host.requests + requests > state.scope.maxRequestsPerHost) throw new Error(`Insufficient per-host request budget: ${hostname}`);
          wait = Math.max(wait, host.last + state.scope.minIntervalMs - Date.now());
        }
        task.status = 'running'; delete task.reason; save(); onProgress(structuredClone(run));
        if (wait > 0) await delay(wait, undefined, { signal });
        const result = await verify(store, id, task.finding, { signal, expectedRecipeHash: task.recipeHash, expectedStatus: task.expectedStatus });
        task.status = result.verdict; task.receipt = result.id;
      } catch (error) {
        task.status = signal?.aborted ? 'pending' : 'blocked';
        task.reason = signal?.aborted ? 'Paused by operator; partial requests still consume budget.' : error.message;
      }
      run.updated = timestamp(); save(); onProgress(structuredClone(run));
      if (signal?.aborted) break;
    }
    run.status = signal?.aborted || run.tasks.some(task => !complete(task)) ? 'paused' : 'complete';
    run.updated = timestamp(); save();
    return run;
  } finally { fs.rmdirSync(lock); }
}
