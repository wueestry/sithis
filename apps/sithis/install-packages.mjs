// Reconcile resources with the SDK package manager; never invoke the Pi CLI.
import path from 'node:path';
import { ROOT } from './options.mjs';
const agentDir=path.join(ROOT,'agent');
process.env.PI_CODING_AGENT_DIR=agentDir;
const {DefaultPackageManager,SettingsManager}=await import('@earendil-works/pi-coding-agent');
const manager=new DefaultPackageManager({cwd:ROOT,agentDir,settingsManager:SettingsManager.create(ROOT,agentDir,{projectTrusted:false})});
manager.setProgressCallback(event=> { if(event.type==='start') console.log(`${event.action}: ${event.source}`); });
const resources=await manager.resolve(async()=> 'install');
console.log(`SDK resources ready: ${resources.extensions.filter(e=>e.enabled).length} extension paths`);
