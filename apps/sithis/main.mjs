#!/usr/bin/env node
import { parseOptions, HELP } from './options.mjs';

export async function main(argv = process.argv.slice(2)) {
  const options=parseOptions(argv);
  if(options.help) { console.log(HELP); return 0; }
  // Set the shared agent path before importing SDK/extensions, including subagents.
  process.env.PI_CODING_AGENT_DIR=options.agentDir;
  delete process.env.PI_MANAGED_INSTALL_ROOT;
  if (options.offline) process.env.PI_OFFLINE='1';
  const {createSithisRuntime,doctor,assertSharedTui} = await import('./runtime.mjs');
  await assertSharedTui();
  if(options.doctor) { console.log(JSON.stringify(doctor(),null,2)); return 0; }
  if(options.mode==='interactive' && !options.check && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive mode needs a terminal. Use --print with a prompt, --mode rpc, or --check.');
  const runtime=await createSithisRuntime(options);
  let interactive;
  try {
    const sdk=await import('@earendil-works/pi-coding-agent');
    if(options.check) {
      const registered=runtime.services.resourceLoader.getExtensions().extensions;
      console.log(JSON.stringify({...doctor(),agentDir:options.agentDir,workspace:runtime.cwd,model:runtime.session.model?.id ?? null,extensions:registered.map(e=>e.path),commands:registered.flatMap(e=>[...e.commands.keys()]),diagnostics:runtime.diagnostics},null,2));
      return 0;
    }
    if(options.mode==='interactive') {
      const { ProcessTerminal, setCapabilityOverrides }=await import('sithis-tui');
      setCapabilityOverrides(runtime.services.settingsManager.getTerminalCapabilityOverrides());
      sdk.initTheme(runtime.services.settingsManager.getTheme(),true);
      interactive=new sdk.InteractiveMode(runtime,{terminal:new ProcessTerminal(),startupDiagnostics:[...runtime.diagnostics],initialMessage:options.messages[0],initialMessages:options.messages.slice(1)});
      await interactive.run();
      return 0;
    }
    if(options.mode==='rpc') { await sdk.runRpcMode(runtime); return 0; }
    if(!options.messages.length) throw new Error('Provide a prompt with --print or --mode json.');
    sdk.initTheme(runtime.services.settingsManager.getTheme(),false);
    return await sdk.runPrintMode(runtime,{mode:options.mode==='json'?'json':'text',initialMessage:options.messages[0],messages:options.messages.slice(1)});
  } finally {
    interactive?.stop();
    await runtime.dispose();
  }
}

// Keep imports usable by tests without starting a terminal or a model request.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try { process.exitCode=await main(); }
  catch(error) { console.error(`Sithis: ${error.message}`); process.exitCode=1; }
}
