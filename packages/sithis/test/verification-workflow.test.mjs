import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store, addFinding, probe, handoff } from '../src/core.mjs';
import { planVerification, runVerification, formatVerificationPlan, formatVerificationResult } from '../src/verification-workflow.mjs';
import { formatDashboard, formatPending } from '../src/commands.mjs';

const marker = 'SITHIS_WORKFLOW_CANARY';
const scope = ports => ({ allowed: ['127.0.0.1'], ports, expires: new Date(Date.now() + 3600000).toISOString(), authorization: 'fixture owner', maxRequests: 100, maxRequestsPerHost: 100, minIntervalMs: 1 });
function fixture(t, ports = [80]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sithis-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.create('test', scope(ports));
  return store;
}
async function server(t, handler = (req, res) => res.end(req.url.includes('probe') ? marker : 'clean')) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}
function finding(store, base, title = 'Canary', suffix = '') {
  return addFinding(store, 'test', { title, url: `${base}/probe${suffix}`, severity: 'low', recipe: { kind: 'http-marker', url: `${base}/probe${suffix}`, controlUrl: `${base}/control`, marker, status: 200, claim: 'Controlled marker observation' } });
}

test('deletion removes only the chosen engagement and refuses traversal, symlinks and busy stores', t => {
  const store = fixture(t);
  store.create('keep', scope([80]));
  store.evidence('test', 'fixture', { marker });
  assert.throws(() => store.delete('../outside'), /Invalid engagement/);
  fs.symlinkSync(store.dir('keep'), store.dir('alias'));
  assert.throws(() => store.delete('alias'), /symlink/);
  fs.mkdirSync(path.join(store.dir('test'), '.lock'));
  assert.throws(() => store.delete('test'), /busy/);
  fs.rmdirSync(path.join(store.dir('test'), '.lock'));
  const release = store.beginOperation('test');
  assert.throws(() => store.delete('test'), /active/);
  release();
  fs.mkdirSync(path.join(store.dir('test'), '.verification.lock'));
  assert.throws(() => store.delete('test'), /active/);
  fs.rmdirSync(path.join(store.dir('test'), '.verification.lock'));
  store.delete('test');
  assert.equal(fs.existsSync(store.dir('test')), false);
  assert.equal(store.load('keep').id, 'keep');
});

test('plans do not send requests; unsupported and malformed recipes remain for manual review', t => {
  const store = fixture(t);
  finding(store, 'http://127.0.0.1');
  addFinding(store, 'test', { title: 'Manual', url: 'http://127.0.0.1/manual', severity: 'low' });
  const malformed = finding(store, 'http://127.0.0.1', 'Malformed');
  store.transaction('test', state => { state.findings.find(f => f.id === malformed.id).recipe.marker = 'short'; });
  const plan = planVerification(store, 'test');
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.manual.length, 2);
  assert.match(formatVerificationPlan(plan), /Estimated requests: 4/);
  assert.equal(store.load('test').requests, 0);
  assert.equal(store.load('test').verificationRun, undefined);
});

test('workflow verifies sequentially, preserves manual candidates and resumes without repeating completed checks', async t => {
  const base = await server(t);
  const store = fixture(t, [Number(new URL(base).port)]);
  finding(store, base, 'First'); finding(store, base, 'Second', '2');
  const manual = addFinding(store, 'test', { title: 'Manual', url: `${base}/manual`, severity: 'low' });
  const controller = new AbortController();
  const initial = await runVerification(store, 'test', planVerification(store, 'test'), { signal: controller.signal, onProgress: run => {
    if (run.tasks[0].status === 'verified') controller.abort();
  } });
  assert.equal(initial.status, 'paused');
  assert.equal(store.load('test').requests, 4);
  const resumedStore = new Store(store.root);
  const plan = planVerification(resumedStore, 'test');
  assert.equal(plan.resuming, true);
  assert.match(formatVerificationPlan(plan), /Estimated requests: 4/);
  const finished = await runVerification(resumedStore, 'test', plan);
  assert.equal(finished.status, 'complete');
  assert.equal(store.load('test').requests, 8);
  assert.equal(store.load('test').findings.find(f => f.id === manual.id).status, 'candidate');
  assert.equal(store.load('test').findings[0].checks.length, 1);
  assert.match(formatVerificationResult(finished), /2 verified/);
  assert.equal(handoff(store, 'test').verificationWorkflow.status, 'complete');
  assert.match(formatDashboard(handoff(store, 'test')), /Verification workflow: complete · 2\/2 completed/);
});

test('workflow recovers a receipt committed before its task checkpoint without new requests', async t => {
  const base = await server(t);
  const store = fixture(t, [Number(new URL(base).port)]);
  finding(store, base);
  await runVerification(store, 'test', planVerification(store, 'test'));
  store.transaction('test', state => {
    state.verificationRun.status = 'running';
    state.verificationRun.tasks[0].status = 'running';
    delete state.verificationRun.tasks[0].receipt;
  });
  const result = await runVerification(store, 'test', planVerification(store, 'test'));
  assert.equal(result.tasks[0].status, 'verified');
  assert.equal(store.load('test').requests, 4);
});

test('budget, per-host budget, expired scope and out-of-scope controls block before any requests', async t => {
  for (const scenario of ['total', 'host', 'expired', 'scope']) {
    const store = fixture(t);
    finding(store, 'http://127.0.0.1');
    store.transaction('test', state => {
      if (scenario === 'total') state.scope.maxRequests = 3;
      if (scenario === 'host') state.scope.maxRequestsPerHost = 3;
      if (scenario === 'expired') state.scope.expires = '2020-01-01T00:00:00Z';
      if (scenario === 'scope') state.findings[0].recipe.controlUrl = 'http://127.0.0.1:81/control';
    });
    const result = await runVerification(store, 'test', planVerification(store, 'test'));
    assert.equal(result.tasks[0].status, 'blocked', scenario);
    assert.equal(result.status, 'paused');
    assert.equal(store.load('test').requests, 0);
  }
});

test('pausing during a request preserves progress and consumed budget; deletion waits for active operations', async t => {
  const controller = new AbortController();
  let store;
  const base = await server(t, (_req, res) => {
    assert.throws(() => store.delete('test'), /active/);
    controller.abort(); res.end(marker);
  });
  store = fixture(t, [Number(new URL(base).port)]);
  finding(store, base);
  const result = await runVerification(store, 'test', planVerification(store, 'test'), { signal: controller.signal });
  assert.equal(result.status, 'paused');
  assert.equal(result.tasks[0].status, 'pending');
  assert.equal(store.load('test').requests, 1);
  assert.equal(fs.readdirSync(store.dir('test')).some(name => name.startsWith('.active-') || name === '.verification.lock'), false);
});

test('workflow rejects concurrent execution and changed plans without requests', async t => {
  const store = fixture(t);
  finding(store, 'http://127.0.0.1');
  const plan = planVerification(store, 'test');
  fs.mkdirSync(path.join(store.dir('test'), '.verification.lock'));
  await assert.rejects(runVerification(store, 'test', plan), /busy/);
  fs.rmdirSync(path.join(store.dir('test'), '.verification.lock'));
  store.transaction('test', state => { state.scope.maxRequests = 50; });
  await assert.rejects(runVerification(store, 'test', plan), /Scope changed/);
  const changed = planVerification(store, 'test');
  store.transaction('test', state => { state.findings[0].recipe.marker = 'A_DIFFERENT_CANARY'; });
  const result = await runVerification(store, 'test', changed);
  assert.match(result.tasks[0].reason, /Finding changed/);
  assert.equal(store.load('test').requests, 0);
  assert.equal(planVerification(store, 'test', { restart: true }).resuming, false);
});

test('recipe changes after a workflow step starts cannot redirect its approved requests', async t => {
  const store = fixture(t);
  finding(store, 'http://127.0.0.1');
  const result = await runVerification(store, 'test', planVerification(store, 'test'), { onProgress: run => {
    if (run.tasks[0].status === 'running') store.transaction('test', state => {
      state.findings[0].recipe.url = 'http://127.0.0.1/unapproved';
    });
  } });
  assert.equal(result.tasks[0].status, 'blocked');
  assert.match(result.tasks[0].reason, /Finding changed/);
  assert.equal(store.load('test').requests, 0);
});

test('inconclusive controls remain inconclusive and unlimited budgets are supported', async t => {
  const base = await server(t, (_req, res) => res.end(marker));
  const store = fixture(t, [Number(new URL(base).port)]);
  store.transaction('test', state => { state.scope.maxRequests = 0; state.scope.maxRequestsPerHost = 0; });
  finding(store, base);
  const result = await runVerification(store, 'test', planVerification(store, 'test'));
  assert.equal(result.status, 'complete');
  assert.equal(result.tasks[0].status, 'inconclusive');
  assert.equal(store.load('test').findings[0].status, 'inconclusive');
});

test('blocked tasks expose their reasons and can resume after an operator resolves a budget limit', async t => {
  const base = await server(t);
  const store = fixture(t, [Number(new URL(base).port)]);
  finding(store, base);
  store.transaction('test', state => { state.scope.maxRequests = 3; });
  const blocked = await runVerification(store, 'test', planVerification(store, 'test'));
  assert.equal(blocked.tasks[0].status, 'blocked');
  assert.match(formatPending(handoff(store, 'test')), /Insufficient remaining request budget/);
  assert.equal(store.load('test').requests, 0);
  store.transaction('test', state => { state.scope.maxRequests = 4; });
  const resumed = await runVerification(store, 'test', planVerification(store, 'test'));
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.tasks[0].status, 'verified');
  assert.equal(resumed.tasks[0].reason, undefined);
  assert.equal(store.load('test').requests, 4);
});

test('standalone probes also prevent deletion while their request is active', async t => {
  let store;
  const base = await server(t, (_req, res) => {
    assert.throws(() => store.delete('test'), /active/);
    res.end('clean');
  });
  store = fixture(t, [Number(new URL(base).port)]);
  await probe(store, 'test', base);
  store.delete('test');
  assert.equal(fs.existsSync(store.dir('test')), false);
});
