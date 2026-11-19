#!/usr/bin/env bun
/**
 * Dev harness: take ONE live observation of an app (read-only get_window_state), then run several
 * steps through the decision step and print each Jev round's top picks. Never moves or clicks.
 *   bun scripts/eval-snapshot.ts --app FilmCraft "switch to the razor tool" "lock track V1"
 */
import { axCandidates, type TutorCandidate } from '../src/candidates.js';
import { loadConfig } from '../src/config.js';
import { CuaDriver } from '../src/driver.js';
import { decide, liveChooser, liveLocator, mockChooser, type Chooser } from '../src/jev.js';
import { PNG } from 'pngjs';

import { cropCandidate, decodeScreenshot, normalizeScreenshot } from '../src/visual.js';

const args = process.argv.slice(2);
const i = args.indexOf('--app');
const app = i >= 0 ? args.splice(i, 2)[1] : 'FilmCraft';
const config = loadConfig();
const driver = new CuaDriver(config.driverBinary, config.driverSession);
const win = await driver.findWindow(app);
const { data, images } = await driver.windowState(win.pid, win.window_id, undefined, config.visual);
await driver.close();
const shot = images[0] ? decodeScreenshot(images[0]) : undefined;
const table = axCandidates(data, win.pid, win.window_id, { visual: config.visual && Boolean(shot) });
console.log(`${app}: ${table.candidates.length} candidates (${table.labelled} labelled, ${table.visual} visual)`, table.excluded);
const base = config.provider === 'live' ? liveChooser(config.jevModel) : mockChooser();
const byId = new Map(table.candidates.map((c) => [c.id, c] as const));
const fmt = (c?: TutorCandidate) => (c ? `${c.label || c.id}@(${Math.round(c.point.x)},${Math.round(c.point.y)})` : '?');
const marks: { x: number; y: number }[] = [];
for (const step of args) {
  const log: string[] = [];
  const chooser: Chooser = async (g, o, options, s) => {
    const r = await base(g, o, options, s);
    const top = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
    log.push(`  [${options.length - 2}] ` + top.map(([id, p]) => `${byId.has(id) ? fmt(byId.get(id)) : id}=${p.toFixed(2)}`).join('  '));
    return r;
  };
  const t = performance.now();
  const normalized = shot && config.locate ? normalizeScreenshot(shot) : undefined;
  const locator = normalized ? liveLocator(normalized.bytes, normalized, config.locateModel) : undefined;
  const visuals = shot
    ? {
        crop: (c: TutorCandidate) => (c.shot ? cropCandidate(shot, c.shot) : undefined),
        ...(config.provider === 'live' && locator && normalized ? { locate: async (...args: Parameters<typeof locator>) => {
          const box = await locator(...args);
          const original = box && normalized.toOriginal(box);
          return box && original ? { ...original, confidence: box.confidence } : undefined;
        } } : {}),
      }
    : undefined;
  const d = await decide(chooser, step, { app: win.app_name, window_title: win.title }, table.candidates, config, visuals);
  console.log(`\n"${step}" -> ${d.kind} ${d.kind === 'selected' ? fmt(d.candidate) : ''} p=${d.probability.toFixed(2)} (${Math.round(performance.now() - t)} ms, ${d.calls} calls, located ${d.located ? fmt(byId.get(d.located)) : '-'})`);
  console.log(log.join('\n'));
  if (d.kind === 'selected') marks.push(d.candidate.point);
}
// Annotated screenshot: each selected point mapped back from screen points to screenshot pixels.
const out = process.env.EVAL_OUT;
if (out && shot && win.bounds) {
  const k = shot.width / win.bounds.width;
  for (const m of marks) {
    const px = Math.round((m.x - win.bounds.x) * k);
    const py = Math.round((m.y - win.bounds.y) * k);
    for (let t = -14; t <= 14; t++)
      for (const [x, y] of [[px + t, py], [px, py + t], [px + t, py + 1], [px + 1, py + t]]) {
        if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) continue;
        const i = (y * shot.width + x) * 4;
        shot.png.data[i] = 0; shot.png.data[i + 1] = 255; shot.png.data[i + 2] = 0;
      }
  }
  await Bun.write(out, PNG.sync.write(shot.png));
  console.log(`\nannotated screenshot: ${out} (window ${JSON.stringify(win.bounds)}, scale ${k.toFixed(4)} px/pt)`);
}
