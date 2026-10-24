#!/usr/bin/env node
import { parsePayload } from './commands.mjs';
import { Store, dispatch } from './core.mjs';
const [operation, id, input] = process.argv.slice(2);
if (!operation || !id) {
  console.error('Usage: node packages/sithis/src/cli.mjs OPERATION ENGAGEMENT [JSON | @file.json]');
  process.exitCode = 1;
} else {
  try {
    const data = input ? parsePayload(input) : {};
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const value = await dispatch(new Store(), operation, id, data, controller.signal);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
