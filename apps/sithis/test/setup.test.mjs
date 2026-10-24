import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup } from '../../../scripts/setup.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sithis-setup-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'agent/install'),{recursive:true});
  fs.mkdirSync(path.join(root,'agent/bin'),{recursive:true});
  const entrypoints={};
  for(const name of ['sithis','pi']) {
    fs.writeFileSync(path.join(root,'agent/bin',name),'#!/bin/sh\n',{mode:0o755});
    entrypoints[name]={type:'symlink',path:path.join(root,'user-bin',name)};
  }
  fs.writeFileSync(path.join(root,'agent/install/managed-install.json'),JSON.stringify({kind:'sithis-sdk-install',schemaVersion:1,entrypoints}));
  return root;
}

test('npm setup installs and builds before linking, and reruns without replacing correct links',t=>{
  const root=fixture(t),calls=[];
  const run=(kind,args,cwd)=>{assert.equal(fs.existsSync(path.join(root,'user-bin')),false);calls.push({kind,args,cwd});};
  runSetup({root,run,log:()=>{}});
  assert.deepEqual(calls.map(c=>[c.kind,...c.args.slice(0,2)]),[['npm','ci','--include=dev'],['npm','run','build'],['npm','ci','--omit=dev'],['node','apps/sithis/install-packages.mjs'],['node','apps/sithis/main.mjs','--doctor']]);
  assert.equal(calls[2].cwd,path.join(root,'agent/npm'));
  assert.equal(fs.readlinkSync(path.join(root,'user-bin/sithis')),path.join(root,'agent/bin/sithis'));
  const previous=fs.lstatSync(path.join(root,'user-bin/sithis')).ino;
  runSetup({root,run:()=>{},log:()=>{}});
  assert.equal(fs.lstatSync(path.join(root,'user-bin/sithis')).ino,previous);
});

test('npm setup refuses regular files before running installs and never links after a failed install',t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'user-bin'));
  const destination=path.join(root,'user-bin/sithis');fs.writeFileSync(destination,'keep me');
  let called=false;
  assert.throws(()=>runSetup({root,run:()=>{called=true;},log:()=>{}}),/non-symlink/);
  assert.equal(called,false);assert.equal(fs.readFileSync(destination,'utf8'),'keep me');
  const other=fixture(t);
  assert.throws(()=>runSetup({root:other,run:()=>{throw new Error('offline install failed');},log:()=>{}}),/offline install failed/);
  assert.equal(fs.existsSync(path.join(other,'user-bin')),false);
});

test('npm setup --no-links leaves existing entrypoints untouched',t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'user-bin'));
  const destination=path.join(root,'user-bin/sithis');fs.writeFileSync(destination,'keep me');
  const result=runSetup({root,noLinks:true,run:()=>{},log:()=>{}});
  assert.equal(result.linksInstalled,false);
  assert.equal(fs.readFileSync(destination,'utf8'),'keep me');
});
