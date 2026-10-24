import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePayload, splitWord, guidedScope, engagementMenu, formatStatus } from '../src/commands.mjs';

test('command payloads accept inline JSON, shell quotes and bare or @file paths', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sithis-command-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'scope file.json'),'{"allowed":["app.test"],"description":"two  spaces"}');
  for(const input of ['scope file.json','@scope file.json','@"scope file.json"','"scope file.json"']) {
    assert.equal(parsePayload(input,root).description,'two  spaces');
  }
  assert.equal(parsePayload("'{\"description\":\"two  spaces\"}'").description,'two  spaces');
  const [id,payload]=splitWord('demo {\n "description": "two  spaces"\n}');
  assert.equal(id,'demo'); assert.equal(parsePayload(payload).description,'two  spaces');
});

test('missing, malformed, placeholder and nonexistent payloads explain how to recover', () => {
  assert.throws(()=>parsePayload(''),/Missing JSON or file path/);
  for(const input of ['{','{allowed:[]}','{"allowed":']) assert.throws(()=>parsePayload(input),/Invalid JSON.*guided setup/);
  assert.throws(()=>parsePayload('example/scope.json','/tmp'),/Cannot read JSON file.*example\/scope.json/);
  assert.throws(()=>parsePayload('{"expires":"REPLACE_WITH_ISO_8601_ENGAGEMENT_END"}'),/placeholders/);
  assert.throws(()=>parsePayload('[]'),/JSON object/);
});

test('guided setup collects explicit scope, handles cancellation and rejects invalid scopes',async () => {
  const expires=new Date(Date.now()+3600000).toISOString();
  const answers=['demo','app.test, api.test','443,8443',expires,'Customer approval','169.254.0.0/16'];
  const setup=await guidedScope({input:async()=>answers.shift()});
  assert.equal(setup.id,'demo'); assert.deepEqual(setup.scope.ports,[443,8443]);
  assert.deepEqual(setup.scope.allowed,['app.test','api.test']);
  assert.equal(setup.scope.maxRequests,100);
  await assert.rejects(guidedScope({input:async()=>undefined}),/cancelled/);
  const errors=[];
  const retry=['','bad id','valid-id','http://bad','app.test','NaN','0','443','yesterday',new Date(Date.now()-1000).toISOString(),expires,'','approval',''];
  const corrected=await guidedScope({input:async()=>retry.shift(),notify:message=>errors.push(message)});
  assert.equal(corrected.id,'valid-id');
  assert.deepEqual(corrected.scope.allowed,['app.test']);
  assert.equal(errors.length,8);
  await assert.rejects(guidedScope({input:async()=>undefined},'existing',{existingIds:['existing']}),/already exists/);
  const decline=['app.test','443',expires,'approval',''];
  await assert.rejects(guidedScope({input:async()=>decline.shift(),confirm:async()=>false},'declined'),/cancelled/);
});


test('engagement menu exposes actions appropriate to saved and selected state',async()=>{
  let choices;
  const ui={select:async(_title,items)=>{choices=items;return 'New engagement';}};
  assert.equal(await engagementMenu(ui,undefined,[]),'new');
  assert.deepEqual(choices,['New engagement','Help']);
  await engagementMenu(ui,'demo',[{id:'demo'}]);
  assert.ok(choices.includes('Resume engagement'));
  assert.ok(choices.includes('View status'));
  assert.equal(await engagementMenu({select:async()=>undefined},undefined,[]),undefined);
});
