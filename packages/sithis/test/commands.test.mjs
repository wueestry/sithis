import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePayload, splitWord, guidedScope } from '../src/commands.mjs';

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
  await assert.rejects(guidedScope({input:async()=>''}),/required/);
  const invalid=['app.test','443','yesterday','approval',''];
  await assert.rejects(guidedScope({input:async()=>invalid.shift()},'demo'),/expiry/);
});
