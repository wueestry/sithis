import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions, ROOT } from '../options.mjs';
import { doctor, assertSharedTui, createSithisRuntime } from '../runtime.mjs';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { Store } from '../../../packages/sithis/src/core.mjs';

function temp(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sithis-sdk-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('SDK host validates options and never silently forwards unsupported CLI flags',()=>{
  const options=parseOptions(['--cwd','/tmp','--agent-dir','agent','--model','provider/model','--print','hello'],'/work');
  assert.equal(options.cwd,'/tmp'); assert.equal(options.agentDir,'/work/agent');
  assert.equal(options.mode,'text'); assert.deepEqual(options.messages,['hello']);
  assert.throws(()=>parseOptions(['--mode','invalid']),/Mode/);
  assert.throws(()=>parseOptions(['--continue','--session','a']),/Choose only one/);
  assert.throws(()=>parseOptions(['--unknown']),/Unknown option/);
  assert.throws(()=>parseOptions(['--model']),/requires a value/);
  assert.equal(parseOptions(['--thinking','max']).thinking,'max');
});

test('SDK compatibility imports share the repository-owned sithis-tui classes',async()=>{
  await assertSharedTui();
  assert.equal(doctor().tui.name,'sithis-tui');
  assert.match(doctor().tui.entry,/packages\/sithis-tui\/dist\/index.js$/);
  const local=await import('sithis-tui'), compatibility=await import('@earendil-works/pi-tui');
  assert.equal(local.Text,compatibility.Text);
  assert.equal(local.TuiMainScreen,compatibility.TuiMainScreen);
});

test('SDK session dispatches engagement commands, preserves selection on replacement and does not call a model',async t=>{
  const root=temp(t),agentDir=path.join(root,'agent'),cwd=path.join(root,'workspace');
  fs.mkdirSync(agentDir);fs.mkdirSync(cwd);
  const previous=process.env.SITHIS_DATA_DIR;
  process.env.SITHIS_DATA_DIR=path.join(root,'engagements');
  t.after(()=>{if(previous)process.env.SITHIS_DATA_DIR=previous;else delete process.env.SITHIS_DATA_DIR;});
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({packages:[path.join(ROOT,'packages/sithis')]}));
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:path.join(agentDir,'models-store.json'),refreshOnCreate:false});
  let modelCalls=0;
  modelRuntime.streamSimple=()=>{modelCalls++;throw new Error('Unexpected model call');};
  const options={cwd,agentDir};
  const runtime=await createSithisRuntime(options,{modelRuntime});
  t.after(()=>runtime.dispose());
  const scope={allowed:['127.0.0.1'],ports:[80],expires:new Date(Date.now()+3600000).toISOString(),authorization:'Test fixture owner'};
  fs.writeFileSync(path.join(cwd,'scope.json'),JSON.stringify(scope));
  await runtime.session.bindExtensions({});
  // Model-free fixture representing a conversation the operator has started.
  runtime.session.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'Assess this local test fixture'}],timestamp:Date.now()});
  await runtime.session.prompt('/engagement new sdk-test @scope.json');
  const store=new Store(process.env.SITHIS_DATA_DIR);
  assert.equal(store.load('sdk-test').id,'sdk-test');
  assert.ok(runtime.session.sessionManager.getBranch().some(e=>e.customType==='sithis-engagement'&&e.data.id==='sdk-test'));
  const original=runtime.session.sessionFile;
  assert.ok(original.includes('--'+cwd.replace(/^\//,'').replaceAll('/','-')+'--'));
  await runtime.newSession();
  await runtime.session.bindExtensions({});
  assert.ok(!runtime.session.sessionManager.getBranch().some(e=>e.customType==='sithis-engagement'));
  await runtime.switchSession(original);
  await runtime.session.bindExtensions({});
  await runtime.session.prompt('/engagement status');
  assert.ok(runtime.session.messages.some(m=>m.role==='custom'&&JSON.stringify(m.content).includes('Engagement: sdk-test')));
  assert.equal(modelCalls,0);
  assert.equal(store.load('sdk-test').requests,0);
});

test('untrusted project resources stay disabled in SDK sessions',async t=>{
  const root=temp(t),agentDir=path.join(root,'agent');fs.mkdirSync(agentDir);
  fs.mkdirSync(path.join(root,'.pi'),{recursive:true});
  fs.writeFileSync(path.join(root,'.pi','settings.json'),JSON.stringify({defaultProvider:'untrusted',defaultModel:'untrusted'}));
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const runtime=await createSithisRuntime({cwd:root,agentDir,noSession:true},{modelRuntime});
  try {
    assert.equal(runtime.services.settingsManager.isProjectTrusted(),false);
    assert.notEqual(runtime.services.settingsManager.getDefaultModel(),'untrusted');
    assert.ok(runtime.diagnostics.some(d=>d.message.includes('Project-local resources are disabled')));
  } finally { await runtime.dispose(); }
});

test('launcher uses the SDK host and remains callable through the existing pi entrypoint',()=>{
  for(const executable of [path.join(ROOT,'agent/bin/sithis'),path.join(ROOT,'agent/bin/pi'),'agent/bin/sithis']) {
    const result=spawnSync(executable,['--doctor'],{cwd:ROOT,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    const info=JSON.parse(result.stdout); assert.equal(info.tui.name,'sithis-tui');
    assert.ok(!info.sdk.includes('/install/releases/'));
  }
});


test('invocation-only project trust does not grant trust to a different resumed workspace',async t=>{
  const root=temp(t),agentDir=path.join(root,'agent'),first=path.join(root,'first'),second=path.join(root,'second');
  fs.mkdirSync(agentDir);
  for(const cwd of [first,second]) {
    fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
    fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({defaultModel:'project-model'}));
  }
  const saved=SessionManager.create(second,path.join(root,'saved'));
  saved.appendMessage({role:'user',content:[{type:'text',text:'Fixture conversation'}],timestamp:Date.now()});
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const runtime=await createSithisRuntime({cwd:first,agentDir,trustProject:true,noSession:true},{modelRuntime});
  try {
    assert.equal(runtime.services.settingsManager.isProjectTrusted(),true);
    await runtime.switchSession(saved.getSessionFile());
    assert.equal(runtime.cwd,second);
    assert.equal(runtime.services.settingsManager.isProjectTrusted(),false);
    assert.notEqual(runtime.services.settingsManager.getDefaultModel(),'project-model');
  } finally { await runtime.dispose(); }
});
