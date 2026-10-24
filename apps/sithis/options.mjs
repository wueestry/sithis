import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const HELP = `Sithis — SDK-based pentest assistant

Usage: sithis [options] [prompt]
  --cwd PATH           Workspace (default: current directory)
  --agent-dir PATH     Settings, credentials and conversations (default: checkout/agent)
  -c, --continue       Continue the latest conversation for this workspace
  --session PATH       Open an existing conversation file
  --provider NAME      Model provider override for this run
  --model ID           Model override for this run (provider/id also accepted)
  --thinking LEVEL     off, minimal, low, medium, high, xhigh, max
  -p, --print          Single-shot text output
  --mode MODE          interactive, text, json or rpc
  --no-session         Keep this conversation in memory
  --trust-project      Allow reviewed project-local resources for this invocation
  --offline            Skip startup catalog and update network requests
  --check              Load SDK/resources and report diagnostics; no model request
  --doctor             Report SDK and local TUI resolution; no model request
  -h, --help           Show this help

In the TUI: /engagement opens the engagement menu.
Existing agent settings, credentials, sessions, and engagement data are reused.`;

export function parseOptions(args, cwd = process.cwd()) {
  const options = { cwd, agentDir: process.env.PI_CODING_AGENT_DIR || path.join(ROOT, 'agent'), mode: 'interactive', messages: [] };
  const values = new Map([['--cwd','cwd'],['--agent-dir','agentDir'],['--session','session'],['--provider','provider'],['--model','model'],['--thinking','thinking'],['--mode','mode']]);
  const flags = new Map([['-h','help'],['--help','help'],['--doctor','doctor'],['--check','check'],['-c','continue'],['--continue','continue'],['--no-session','noSession'],['--trust-project','trustProject'],['--offline','offline']]);
  for (let i=0; i<args.length; i++) {
    const arg = args[i];
    if (arg === '--') { options.messages.push(...args.slice(i+1)); break; }
    if (values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value. Run sithis --help.`);
      options[values.get(arg)] = value;
    } else if (flags.has(arg)) options[flags.get(arg)] = true;
    else if (arg === '-p' || arg === '--print') options.mode = 'text';
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. Run sithis --help for supported SDK host options.`);
    else options.messages.push(arg);
  }
  if (!['interactive','text','json','rpc'].includes(options.mode)) throw new Error('Mode must be interactive, text, json or rpc.');
  if (options.thinking && !['off','minimal','low','medium','high','xhigh','max'].includes(options.thinking)) throw new Error('Invalid thinking level.');
  if ([options.continue,options.session,options.noSession].filter(Boolean).length > 1) throw new Error('Choose only one of --continue, --session or --no-session.');
  options.cwd = path.resolve(cwd, options.cwd);
  options.agentDir = path.resolve(cwd, options.agentDir);
  if (options.session) options.session = path.resolve(cwd, options.session);
  return options;
}
