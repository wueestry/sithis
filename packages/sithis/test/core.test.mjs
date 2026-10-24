import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store, validateScope, resolveTarget, probe, addFinding, verify, reviewFinding, coverage, handoff, report, capsule, importCapsule, dispatch } from '../src/core.mjs';

const scope = (ports = [80]) => ({ allowed: ['127.0.0.1'], excluded: [], ports, expires: new Date(Date.now()+3600000).toISOString(), authorization: 'local fixture owner', minIntervalMs: 1, maxRequests: 100, maxRequestsPerHost: 100 });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sithis-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => s.close(resolve)));
  return `http://127.0.0.1:${s.address().port}`;
}
const wait = () => new Promise(r => setTimeout(r, 4));

test('scope rejects missing authorization, expiry, malformed CIDRs, ports and traversal', async t => {
  assert.throws(() => validateScope({ ...scope(), authorization: '' }));
  assert.throws(() => validateScope({ ...scope(), expires: '2020-01-01' }));
  assert.throws(() => validateScope({ ...scope(), allowed: ['127.0.0.1/33'] }));
  assert.throws(() => validateScope({ ...scope(), ports: [0] }));
  assert.throws(() => fixture(t).create('../escape', scope()));
  await assert.rejects(resolveTarget(scope(), 'http://user:pass@127.0.0.1/'));
  await assert.rejects(resolveTarget(scope(), 'file:///etc/passwd'));
  await assert.rejects(resolveTarget(scope(), 'http://127.0.0.1:81/'));
});

test('DNS exclusions win across all answers; wildcards exclude apex; CIDR and IPv6 checked', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
  await assert.rejects(resolveTarget({ ...scope(), allowed: ['lab.test'], excluded: ['10.0.0.0/8'] }, 'http://lab.test', resolver), /excluded/);
  await assert.rejects(resolveTarget({ ...scope(), allowed: ['*.lab.test'] }, 'http://lab.test', resolver), /outside/);
  await resolveTarget({ ...scope(), allowed: ['*.lab.test'] }, 'http://a.lab.test', resolver);
  await resolveTarget({ ...scope(), allowed: ['127.0.0.0/8'] }, 'http://lab.test', async () => [{ address: '127.0.0.9', family: 4 }]);
  await resolveTarget({ ...scope(), allowed: ['::1'] }, 'http://[::1]/');
  await assert.rejects(resolveTarget({ ...scope(), allowed: ['::/0'] }, 'http://[::ffff:7f00:1]/'), /mapped/);
});

test('pinned DNS reaches approved fixture; redirects do not contact destination', async t => {
  let hits = 0;
  const base = await server(t, (_req, res) => { hits++; res.writeHead(302, { location: 'http://outside.invalid/' }); res.end('redirect'); });
  const store = fixture(t), port = Number(new URL(base).port);
  store.create('demo', { ...scope([port]), allowed: ['fixture.invalid'] });
  const result = await probe(store, 'demo', `http://fixture.invalid:${port}/`, { resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(hits, 1); assert.equal(result.status, 302);
  const raw = JSON.parse(store.artifact('demo', result.evidence));
  assert.equal(raw.resolvedAddress, '127.0.0.1');
  fs.appendFileSync(path.join(store.dir('demo'),'evidence',`${result.evidence}.json`), 'tamper');
  assert.throws(() => store.artifact('demo', result.evidence), /integrity/);
});

test('shared budgets, rate limits and locks fail closed across store instances', t => {
  const store = fixture(t); store.create('demo', { ...scope(), maxRequests: 2, maxRequestsPerHost: 1, minIntervalMs: 10000 });
  store.reserve('demo','a');
  const other = new Store(store.root);
  assert.throws(() => other.reserve('demo','a'), /budget/);
  other.reserve('demo','b');
  assert.throws(() => store.reserve('demo','c'), /budget/);
  store.create('rate', { ...scope(), minIntervalMs: 10000 });
  store.reserve('rate','a'); assert.throws(() => other.reserve('rate','a'), /rate/);
  fs.mkdirSync(path.join(store.dir('rate'),'.lock'));
  assert.throws(() => other.reserve('rate','b'), /busy/);
});

test('vulnerable and hardened fixtures: independent controls, report, capsule replay, fix retest', async t => {
  let hardened = false;
  const marker = 'SITHIS_CANARY_9173';
  const base = await server(t, (req, res) => { res.end(!hardened && req.url === '/probe' ? marker : 'clean page'); });
  const store = fixture(t); store.create('demo', scope([Number(new URL(base).port)]));
  const recipe = { kind: 'http-marker', url: base+'/probe', controlUrl: base+'/control', marker, status: 200, claim: 'The canary appears at /probe and is absent from /control' };
  const f = addFinding(store,'demo',{title:'Canary disclosure',url:recipe.url,severity:'low',recipe});
  const receipt = await verify(store,'demo',f.id); assert.equal(receipt.verdict,'verified'); assert.equal(receipt.evidence.length,4);
  coverage(store,'demo',{url:recipe.url,role:'anonymous',check:'marker',status:'tested',evidence:receipt.evidence});
  assert.match(report(store,'demo'),/Canary disclosure/);
  const exported = capsule(store,'demo',f.id);
  store.create('replay',scope([Number(new URL(base).port)]));
  const imported = importCapsule(store,'replay',exported); assert.equal(imported.status,'candidate');
  assert.equal((await verify(store,'replay',imported.id)).verdict,'verified');
  assert.throws(() => importCapsule(store,'replay',{...exported,sha256:'wrong'}),/integrity/);
  hardened = true;
  reviewFinding(store,'demo',f.id,{status:'fixed',reviewer:'fixture owner',reason:'Applied fixture patch'});
  await wait(); assert.equal((await verify(store,'demo',f.id,{retest:true})).verdict,'retested');
  const reloaded = new Store(store.root); assert.equal(handoff(reloaded,'demo').findings[0].status,'retested');
  assert.equal(reloaded.load('demo').findings[0].checks.length,3);
});

test('false-positive controls, error pages, missing recipes and denied replay stay unconfirmed', async t => {
  const marker = 'SITHIS_CANARY_9173';
  const base = await server(t, (_req,res) => res.end(marker));
  const store = fixture(t); store.create('demo',scope([Number(new URL(base).port)]));
  const f=addFinding(store,'demo',{title:'False positive',url:base+'/a',severity:'high',recipe:{kind:'http-marker',url:base+'/a',controlUrl:base+'/b',marker,status:200,claim:'marker observation'}});
  assert.equal((await verify(store,'demo',f.id)).verdict,'inconclusive');
  assert.doesNotMatch(report(store,'demo'),/### False positive/);
  const missing=addFinding(store,'demo',{title:'Version guess',url:base,severity:'high'});
  await assert.rejects(verify(store,'demo',missing.id),/oracle/);
  const denied=addFinding(store,'demo',{title:'Denied replay',url:base+'/c',severity:'high',recipe:{...f.recipe,url:'http://192.0.2.1/a'}});
  await assert.rejects(verify(store,'demo',denied.id),/Port|scope/);
  assert.throws(() => coverage(store,'demo',{url:base,role:'anonymous',check:'xss',status:'tested',evidence:[]}),/evidence/);
  assert.throws(() => reviewFinding(store,'demo',missing.id,{status:'verified',reviewer:'a',reason:'guess'}),/evidence/);
});

test('oversized responses, cancellation and HTTP errors do not create verification receipts', async t => {
  const base = await server(t, (req,res) => {
    if(req.url === '/large') res.end('x'.repeat(1024*1024+1));
    else {res.writeHead(500);res.end('error');}
  });
  const store = fixture(t); store.create('demo',scope([Number(new URL(base).port)]));
  await assert.rejects(probe(store,'demo',base+'/large'),/exceeds/);
  const aborted = new AbortController(); aborted.abort(); await wait();
  await assert.rejects(probe(store,'demo',base,{signal:aborted.signal}),/abort/i);
  const f = addFinding(store,'demo',{title:'Error control',url:base+'/p',severity:'low',recipe:{kind:'http-marker',url:base+'/p',controlUrl:base+'/c',marker:'LONG_CANARY',status:200,claim:'marker'}});
  await wait(); assert.equal((await verify(store,'demo',f.id)).verdict,'inconclusive');
  await assert.rejects(dispatch(store,'execute','demo',{}),/Unknown/);
});

test('operator evidence capture supports manual verification and manual fix retest', async t => {
  const store=fixture(t);store.create('manual',scope());
  const evidence=await dispatch(store,'capture','manual',{kind:'browser-observation',content:{artifact:'secure://browser-1',description:'Controlled marker executed in browser'}});
  const f=addFinding(store,'manual',{title:'Manual browser finding',url:'http://127.0.0.1/',severity:'medium'});
  await dispatch(store,'review','manual',{finding:f.id,status:'verified',reviewer:'operator',reason:'Reproduced execution with controlled data',evidence:[evidence.id],oracle:'fake-oracle'});
  assert.equal(store.load('manual').findings[0].checks[0].oracle,'manual-review');
  reviewFinding(store,'manual',f.id,{status:'fixed',reviewer:'operator',reason:'Patch applied'});
  reviewFinding(store,'manual',f.id,{status:'retested',reviewer:'operator',reason:'Replayed original steps after patch',evidence:[evidence.id]});
  assert.equal(store.load('manual').findings[0].status,'retested');
  assert.match(report(store,'manual'),/manual-review/);
});
