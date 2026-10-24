#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const HELP='Usage: npm run setup [-- --no-links]\n\nInstall locked SDK/extension dependencies, build sithis-tui, check resources,\nand create the configured launchers. --no-links skips PATH entrypoint changes.';

export function checkEntrypoint(destination) {
  try {
    if (!fs.lstatSync(destination).isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink: ${destination}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function runCommand(kind,args,cwd) {
  // npm_execpath avoids shell quoting and npm.cmd handling when launched through npm.
  const npmCli=process.env.npm_execpath;
  const file=kind==='node' || npmCli ? process.execPath : 'npm';
  const argv=kind==='npm' && npmCli ? [npmCli,...args] : args;
  const result=spawnSync(file,argv,{cwd,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${kind} ${args.join(' ')} failed (${result.signal ?? result.status}).`);
}

export function runSetup({root=ROOT,noLinks=false,run=runCommand,log=console.log}={}) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if (major < 22 || (major===22 && minor<19)) throw new Error('Node.js 22.19.0 or newer is required.');
  const config=JSON.parse(fs.readFileSync(path.join(root,'agent/install/managed-install.json'),'utf8'));
  if (config.kind!=='sithis-sdk-install' || config.schemaVersion!==1 || !config.entrypoints || typeof config.entrypoints!=='object' || Array.isArray(config.entrypoints)) throw new Error('Unsupported managed-install.json configuration.');
  const links=Object.entries(config.entrypoints).map(([name,entry])=>{
    if (!['sithis','pi'].includes(name) || entry.type!=='symlink' || typeof entry.path!=='string' || !path.isAbsolute(entry.path)) throw new Error('Invalid SDK entrypoint configuration.');
    const launcher=path.join(root,'agent/bin',name);
    fs.accessSync(launcher,fs.constants.X_OK);
    if (!noLinks) checkEntrypoint(entry.path);
    return {destination:entry.path,launcher};
  });
  if (!links.some(link=>path.basename(link.launcher)==='sithis')) throw new Error('The sithis entrypoint must be configured.');
  log('Installing locked SDK dependencies');
  // Keep the compiler even when NODE_ENV=production: the local fork is built here.
  run('npm',['ci','--include=dev','--no-audit','--no-fund','--engine-strict'],root);
  run('npm',['run','build'],root);
  log('Installing locked extension dependencies');
  run('npm',['ci','--omit=dev','--no-audit','--no-fund','--engine-strict'],path.join(root,'agent/npm'));
  run('node',['apps/sithis/install-packages.mjs'],root);
  run('node',['apps/sithis/main.mjs','--doctor'],root);
  if (!noLinks) {
    for (const {destination,launcher} of links) {
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      checkEntrypoint(destination);
      try {
        const current=fs.readlinkSync(destination);
        if (path.resolve(path.dirname(destination),current)===path.resolve(launcher)) continue;
        fs.unlinkSync(destination);
      } catch (error) { if (error.code!=='ENOENT') throw error; }
      fs.symlinkSync(launcher,destination);
    }
  }
  log('Sithis is ready. Existing credentials, settings, conversations and engagements are preserved.');
  return {linksInstalled:!noLinks,entrypoints:links};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const args=process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) console.log(HELP);
    else {
      const unknown=args.filter(arg=>arg!=='--no-links');
      if (unknown.length) throw new Error(`Unknown setup option: ${unknown.join(' ')}. ${HELP}`);
      runSetup({noLinks:args.includes('--no-links')});
    }
  } catch (error) { console.error(`Setup failed: ${error.message}`); process.exitCode=1; }
}
