import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store, addFinding, verify, reviewFinding, coverage, report, handoff } from './core.mjs';

let hardened = false;
const marker = 'SITHIS_DEMO_CANARY_9173';
const server = http.createServer((req,res) => res.end(!hardened && req.url === '/probe' ? marker : 'Clean response'));
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
try {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'sithis-demo-'));
  const store = new Store(root), base = `http://127.0.0.1:${server.address().port}`;
  store.create('demo',{allowed:['127.0.0.1'],ports:[server.address().port],expires:new Date(Date.now()+3600000).toISOString(),authorization:'Bundled local fixture owned by this process',minIntervalMs:10});
  const finding = addFinding(store,'demo',{title:'Demo canary disclosure',url:base+'/probe',severity:'low',description:'A bundled fixture exposes a synthetic marker.',remediation:'Remove the exposed marker.',recipe:{kind:'http-marker',url:base+'/probe',controlUrl:base+'/control',marker,status:200,claim:'Canary disclosure'}});
  const original = await verify(store,'demo',finding.id);
  coverage(store,'demo',{url:base+'/probe',role:'anonymous',check:'marker disclosure',status:'tested',evidence:original.evidence});
  hardened = true;
  reviewFinding(store,'demo',finding.id,{status:'fixed',reviewer:'demo fixture owner',reason:'Disabled marker response'});
  await new Promise(resolve=>setTimeout(resolve,15));
  const retest = await verify(store,'demo',finding.id,{retest:true});
  report(store,'demo');
  console.log(JSON.stringify({verification:original.verdict,retest:retest.verdict,requests:handoff(store,'demo').requestBudget.used,dataDirectory:store.dir('demo'),report:path.join(store.dir('demo'),'report.md')},null,2));
  if(original.verdict!=='verified'||retest.verdict!=='retested')process.exitCode=1;
} finally { await new Promise(resolve=>server.close(resolve)); }
