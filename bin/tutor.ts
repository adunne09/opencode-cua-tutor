#!/usr/bin/env bun
/**
 * Debug CLI outside OpenCode:
 *   bun bin/tutor.ts --app Keynote "add a new slide"
 *   bun bin/tutor.ts --verify --app Finder "create a new folder"   # also read back the agent cursor
 */
import { loadConfig } from '../src/config.js';
import { Tutor } from '../src/tutor.js';

const args = process.argv.slice(2);
let app: string | undefined;
let cue: string | undefined;
const verify = args.includes('--verify');
if (verify) args.splice(args.indexOf('--verify'), 1);
const i = args.indexOf('--app');
if (i >= 0) {
  app = args[i + 1];
  args.splice(i, 2);
}
const ci = args.indexOf('--cue');
if (ci >= 0) {
  cue = args[ci + 1];
  args.splice(ci, 2);
}
const text = args.join(' ').trim();
const config = loadConfig();
const targetApp = app ?? config.defaultApp;
if (!text || !targetApp) {
  console.log('usage: bun bin/tutor.ts --app <name or bundle id> [--cue "<visual cue>"] "<one step you want to do>"');
  process.exit(2);
}
const tutor = new Tutor(config);
console.error(`[cua-tutor] provider=${config.provider} app=${targetApp} driver=${config.driverBinary}`);
try {
  const result = await tutor.highlight(text, app, undefined, cue);
  const extra: Record<string, unknown> = {};
  if (verify) {
    if (result.ok) {
      await new Promise((r) => setTimeout(r, 900)); // let the glide finish
      extra.cursor = await tutor.driver.cursorState();
    }
    extra.driverCalls = tutor.driver.history;
  }
  console.log(JSON.stringify({ ...result, ...extra }, null, 2));
} finally {
  await tutor.close();
}
