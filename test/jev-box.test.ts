import { describe, expect, test } from 'bun:test';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { PNG } from 'pngjs';

import type { TutorCandidate } from '../src/candidates.js';
import { loadConfig } from '../src/config.js';
import { CuaDriver } from '../src/driver.js';
import {
  decide,
  inferenceContext,
  liveBoxEngine,
  liveChooser,
  locateWithBox,
  snapBoxToCandidate,
  type BoxEngine,
  type Chooser,
  type CompanionSignals,
} from '../src/jev.js';
import { Tutor } from '../src/tutor.js';
import { CROP_SIDE, cropResize, MAX_IMAGE_SIDE, patchUnchanged, tileGrid, type Screenshot } from '../src/visual.js';

function solidShot(width: number, height: number, rgb: [number, number, number] = [40, 45, 50]): Screenshot {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return { png, width, height };
}

function companionChooser(pickId: string, topProb: number, companion: CompanionSignals): Chooser {
  const fn: Chooser = async (_g, obs, options) => {
    expect(obs.companion_nouls).toBe(true);
    expect(options.some((o) => o.id === 'abstain' || o.id === 'reobserve' || o.id === 'inspect')).toBe(false);
    const rest = options.length > 1 ? (1 - topProb) / (options.length - 1) : 0;
    return {
      selectedId: pickId,
      probabilities: Object.fromEntries(options.map((o) => [o.id, o.id === pickId ? topProb : rest])),
      companion,
    };
  };
  fn.supportsCompanion = true;
  return fn;
}

describe('Companion-Noul text-AX routing', () => {
  const candidates: TutorCandidate[] = [
    { id: 'ax:toggle:play', label: 'Program: Play-Stop Toggle (Space)', description: 'toggle button "Program: Play-Stop Toggle (Space)"', point: { x: 830, y: 544 }, source: 'ax', enabled: true },
    { id: 'ax:tab:export', label: 'Export', description: 'tab (switches view) "Export"', point: { x: 280, y: 19 }, source: 'ax', enabled: true },
  ];

  test('routes cleanly to selected, reobserve, inspect, abstain, and unsure without meta-options in Choice', async () => {
    const sel = await decide(
      companionChooser('ax:toggle:play', 0.98, { exactInNamed: 0.86, isHiddenSubcontrol: 0.05, likelyVisualTarget: 0.12 }),
      'play the timeline',
      { app: 'FilmCraft', allow_visual_box: true },
      candidates,
      { minProbability: 0.7, minMargin: 0.1, minExactInNamed: 0.65 }
    );
    expect(sel.kind).toBe('selected');
    if (sel.kind === 'selected') expect(sel.candidate.id).toBe('ax:toggle:play');
    expect(sel.selection?.companion?.exactInNamed).toBe(0.86);

    const hidden = await decide(
      companionChooser('ax:tab:export', 0.85, { exactInNamed: 0.06, isHiddenSubcontrol: 0.91, likelyVisualTarget: 0.25 }),
      'change the export codec to ProRes',
      { app: 'FilmCraft', allow_visual_box: true },
      candidates,
      { minProbability: 0.7, minMargin: 0.1 }
    );
    expect(hidden.kind).toBe('reobserve');

    const inspect = await decide(
      companionChooser('ax:toggle:play', 0.72, { exactInNamed: 0.08, isHiddenSubcontrol: 0.05, likelyVisualTarget: 0.88 }),
      'select the Aurora Timelapse clip',
      { app: 'FilmCraft', allow_visual_box: true },
      candidates,
      { minProbability: 0.7, minMargin: 0.1 }
    );
    expect(inspect.kind).toBe('inspect');

    const unsure = await decide(
      companionChooser('ax:toggle:play', 0.92, { exactInNamed: 0.56, isHiddenSubcontrol: 0.1, likelyVisualTarget: 0.2 }),
      'play',
      { app: 'FilmCraft', allow_visual_box: true },
      candidates,
      { minProbability: 0.7, minMargin: 0.1, minExactInNamed: 0.65 }
    );
    expect(unsure.kind).toBe('unsure');

    // Low text probability (0.50) + high likelyVisualTarget (0.75) escalates to Box rather than stalling as unsure
    const escalateToBox = await decide(
      companionChooser('ax:toggle:play', 0.5, { exactInNamed: 0.72, isHiddenSubcontrol: 0.06, likelyVisualTarget: 0.75 }),
      'play the timeline',
      { app: 'FilmCraft', allow_visual_box: true },
      candidates,
      { minProbability: 0.7, minMargin: 0.1, minExactInNamed: 0.65 }
    );
    expect(escalateToBox.kind).toBe('inspect');
  });

  test('liveChooser sends candidate-only Choice + 3 parallel Companion Nouls with zero image opt-in', async () => {
    let seenBody: any;
    let seenImageHeader: string | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenImageHeader = req.headers.get('typesafe-danger-zone-images');
        const raw = new Uint8Array(await req.arrayBuffer());
        const enc = req.headers.get('content-encoding');
        const text =
          enc === 'zstd'
            ? zstdDecompressSync(raw).toString('utf8')
            : enc === 'gzip'
              ? gunzipSync(raw).toString('utf8')
              : Buffer.from(raw).toString('utf8');
        seenBody = JSON.parse(text);
        return Response.json({
          model: 'jev-1.14.0',
          answers: {
            candidate: { type: 'choice', choice: 'ax:toggle:play', confidence: 0.96, probabilities: { 'ax:toggle:play': 0.98, 'ax:tab:export': 0.02 } },
            exact_in_named: { type: 'noul', noul: 0.88 },
            is_hidden_subcontrol: { type: 'noul', noul: 0.05 },
            likely_visual_target: { type: 'noul', noul: 0.12 },
          },
          usage: { input_tokens: 420, output_tokens: 12 },
        });
      },
    });
    const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL };
    process.env.TYPESAFE_API_KEY = 'local-test';
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const ctx = inferenceContext();
      const d = await decide(
        liveChooser('jev-1.14.0'),
        'play the timeline',
        { app: 'FilmCraft', window_title: 'Demo', allow_visual_box: true },
        candidates,
        { minProbability: 0.7, minMargin: 0.1 },
        undefined,
        ctx
      );
      expect(d.kind).toBe('selected');
      expect(seenImageHeader).toBeNull();
      expect(Object.keys(seenBody.questions).sort()).toEqual([
        'candidate',
        'exact_in_named',
        'is_hidden_subcontrol',
        'likely_visual_target',
      ]);
      expect(Object.keys(seenBody.questions.candidate.criteria).sort()).toEqual(['ax:tab:export', 'ax:toggle:play']);
      expect(seenBody.state.controls['ax:toggle:play']).toContain('toggle button');
      expect(ctx.metrics.requests).toBe(1);
      expect(ctx.metrics.imageRequests).toBe(0);
    } finally {
      server.stop(true);
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = saved.url;
    }
  });
});

describe('Visual tiles, snapping, and Coarse-to-Fine Box pipeline', () => {
  test('tileGrid keeps small windows as 1 tile and splits wide windows into 6 overlapping TypeSafe-valid tiles', () => {
    const small = tileGrid(solidShot(500, 400));
    expect(small).toHaveLength(1);
    expect(small[0].id).toBe('full_window');

    const wide = tileGrid(solidShot(1600, 980));
    expect(wide).toHaveLength(6);
    for (const t of wide) {
      const decoded = PNG.sync.read(Buffer.from(t.bytes));
      expect(decoded.width).toBeGreaterThanOrEqual(CROP_SIDE);
      expect(decoded.height).toBeGreaterThanOrEqual(CROP_SIDE);
      expect(decoded.width).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
      expect(decoded.height).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
    }
    // Tiles overlap horizontally so no icon sits on a seam
    expect(wide[0].region.x + wide[0].region.w).toBeGreaterThan(wide[1].region.x);
  });

  test('cropResize always clamps into [280, 1568] and patchUnchanged detects local edits', () => {
    const a = solidShot(400, 400, [50, 50, 50]);
    const b = solidShot(400, 400, [50, 50, 50]);
    const tiny = PNG.sync.read(Buffer.from(cropResize(a, { x: 10, y: 10, w: 20, h: 20 }, 100, 100)));
    expect([tiny.width, tiny.height]).toEqual([CROP_SIDE, CROP_SIDE]);
    expect(patchUnchanged(a, b, { x: 100, y: 100, w: 30, h: 30 })).toBe(true);
    // Paint a bright bar inside the target region on `b`
    for (let y = 100; y < 130; y++) {
      for (let x = 100; x < 130; x++) {
        const i = (y * b.width + x) * 4;
        b.png.data[i] = 240;
      }
    }
    expect(patchUnchanged(a, b, { x: 100, y: 100, w: 30, h: 30 })).toBe(false);
  });

  test('snapBoxToCandidate prefers exact containment over an earlier adjacent neighbor, and ignores giant containers', () => {
    // Regression: Source Patch V1 (e104, x=548..572) sits 3px left of Lock V1 (e105, x=575..593).
    const patchV1: TutorCandidate = {
      id: 'vis:control:e104', label: '', description: '', point: { x: 560, y: 765 }, source: 'visual',
      shot: { x: 548, y: 736, w: 24, h: 57 },
    };
    const lockV1: TutorCandidate = {
      id: 'vis:control:e105', label: '', description: '', point: { x: 584, y: 765 }, source: 'visual',
      shot: { x: 575, y: 756, w: 18, h: 18 },
    };
    const timelineContainer: TutorCandidate = {
      id: 'vis:control:e154', label: '', description: '', point: { x: 1100, y: 770 }, source: 'visual',
      shot: { x: 730, y: 650, w: 740, h: 260 },
    };
    // Center at (577, 764) is inside Lock V1 (and within 5px of Patch V1!) — must pick Lock V1!
    expect(snapBoxToCandidate({ x: 570, y: 757, w: 14, h: 14 }, [patchV1, lockV1])?.id).toBe('vis:control:e105');
    // Canvas clip inside huge timelineContainer must NOT snap to timelineContainer!
    expect(snapBoxToCandidate({ x: 866, y: 735, w: 112, h: 65 }, [timelineContainer])).toBeUndefined();
  });

  test('locateWithBox zooms small targets, verifies red box, snaps small AX rects, and falls back to pixel for canvas targets', async () => {
    const shot = solidShot(1600, 980);
    const stages: string[] = [];
    const makeEngine = (verifyPass: boolean): BoxEngine => ({
      async screenTiles(_app, _q, tiles) {
        stages.push(`tiles:${tiles.length}`);
        return Object.fromEntries(tiles.map((t) => [t.id, t.id === 'bottom_center' ? 0.91 : 0.04]));
      },
      async locateInCrop(_app, _q, _bytes, zoomed) {
        stages.push(zoomed ? 'zoom' : 'tile');
        // Small target inside bottom_center tile -> triggers zoom
        return zoomed
          ? { present: 0.95, box: { left: 0.48, right: 0.52, top: 0.48, bottom: 0.52 }, confidence: 0.9 }
          : { present: 0.9, box: { left: 0.15, right: 0.18, top: 0.45, bottom: 0.50 }, confidence: 0.85 };
      },
      async verifyRedBox() {
        stages.push('verify');
        return verifyPass ? { clickable: 0.95, matches: 0.96, exact: 0.91 } : { clickable: 0.3, matches: 0.4, exact: 0.2 };
      },
    });

    // 1. Canvas target (no matching small AX rect) -> returns pixel target after tile + zoom + verify
    const px = await locateWithBox(makeEngine(true), shot, 'FilmCraft', 'select Aurora clip', [], { verifyBox: true });
    expect(px.kind).toBe('pixel');
    expect(stages).toEqual(['tiles:6', 'tile', 'zoom', 'verify']);

    // 2. Failed verification -> safe unsure
    stages.length = 0;
    const rejected = await locateWithBox(makeEngine(false), shot, 'FilmCraft', 'toggle snapping', [], { verifyBox: true });
    expect(rejected.kind).toBe('unsure');
    expect(rejected.diagnostics.reason).toBe('verification_failed');

    // 3. Tile screen below threshold -> fast 1-call abstain
    stages.length = 0;
    const abstainEngine: BoxEngine = {
      ...makeEngine(true),
      async screenTiles(_app, _q, tiles) {
        stages.push('tiles');
        return Object.fromEntries(tiles.map((t) => [t.id, 0.05]));
      },
    };
    const absent = await locateWithBox(abstainEngine, shot, 'FilmCraft', 'nonexistent', [], { verifyBox: true });
    expect(absent.kind).toBe('abstain');
    expect(stages).toEqual(['tiles']);
  });

  test('liveBoxEngine sends image headers and records usage across screenTiles, locateInCrop, verifyRedBox', async () => {
    const headersSeen: (string | null)[] = [];
    let callNum = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        headersSeen.push(req.headers.get('typesafe-danger-zone-images'));
        await req.arrayBuffer();
        callNum++;
        if (callNum === 1) {
          return Response.json({
            model: 'jev-1.14.0',
            answers: { in_a: { type: 'noul', noul: 0.9 }, in_b: { type: 'noul', noul: 0.1 } },
            usage: { input_tokens: 300, output_tokens: 4 },
          });
        }
        if (callNum === 2) {
          return Response.json({
            model: 'jev-1.14.0',
            answers: {
              present: { type: 'noul', noul: 0.92 },
              loc: { type: 'box', box: { left: 0.2, right: 0.4, top: 0.3, bottom: 0.5 }, confidence: 0.88 },
            },
            usage: { input_tokens: 500, output_tokens: 8 },
          });
        }
        return Response.json({
          model: 'jev-1.14.0',
          answers: {
            clickable: { type: 'noul', noul: 0.95 },
            matches: { type: 'noul', noul: 0.96 },
            exact: { type: 'noul', noul: 0.91 },
          },
          usage: { input_tokens: 400, output_tokens: 6 },
        });
      },
    });
    const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL };
    process.env.TYPESAFE_API_KEY = 'local-test';
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const engine = liveBoxEngine('jev-1.14.0');
      const ctx = inferenceContext();
      const bytes = new Uint8Array(PNG.sync.write(solidShot(280, 280).png));
      const tiles = await engine.screenTiles('App', 'step', [{ id: 'a', bytes }, { id: 'b', bytes }], ctx);
      expect(tiles).toEqual({ a: 0.9, b: 0.1 });
      const loc = await engine.locateInCrop('App', 'step', bytes, false, ctx);
      expect(loc.present).toBe(0.92);
      const ver = await engine.verifyRedBox('App', 'step', bytes, ctx);
      expect(ver).toEqual({ clickable: 0.95, matches: 0.96, exact: 0.91 });
      expect(headersSeen).toEqual(['true', 'true', 'true']);
      expect(ctx.metrics.imageRequests).toBe(3);
      expect(ctx.metrics.inputTokens).toBe(1200);
    } finally {
      server.stop(true);
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = saved.url;
    }
  });
});

describe('Tutor end-to-end with Coarse-to-Fine Box fallback', () => {
  class VisualMemoryDriver extends CuaDriver {
    moves: { x: number; y: number }[] = [];
    shotReads = 0;
    changeSecondShot = false;
    constructor() { super('/never-spawn', 'box-test'); }
    win = { pid: 99, window_id: 7, app_name: 'CanvasApp', title: 'CanvasApp' };
    override async findWindow() { return this.win; }
    override async frontWindowOf() { return this.win; }
    override async windowState(_pid: number, _id: number, signal?: AbortSignal, screenshot = false) {
      signal?.throwIfAborted();
      const baseShot = solidShot(800, 600, [40, 45, 50]);
      if (screenshot) {
        this.shotReads++;
        this.screenshotRequests++;
        if (this.changeSecondShot && this.shotReads >= 2) {
          baseShot.png.data.fill(200);
        }
      }
      const data = {
        pid: 99, window_id: 7, elements_complete: false, nodes_pending: 0,
        window_bounds: { x: 100, y: 50, width: 800, height: 600 },
        screenshot_width: 800, screenshot_height: 600,
        elements: [
          { element_index: 0, role: 'AXWindow', label: 'CanvasApp', frame: { x: 100, y: 50, w: 800, h: 600 }, depth: 0 },
          { element_index: 1, role: 'AXButton', label: 'Save', actions: ['AXPress'], enabled: true, frame: { x: 120, y: 60, w: 50, h: 24 }, parent_index: 0, depth: 1 },
        ],
      };
      return {
        data,
        images: screenshot ? [PNG.sync.write(baseShot.png).toString('base64')] : [],
      };
    }
    override async pointAt(x: number, y: number, signal?: AbortSignal) {
      signal?.throwIfAborted();
      this.moves.push({ x, y });
    }
    override async clear() {}
    override async cursorState() { return { enabled: true, position: this.moves.at(-1) }; }
    override async close() {}
  }

  test('points directly at canvas pixel target via Box and rejects stale pixel changes', async () => {
    const chooser = companionChooser('ax:button:save', 0.6, { exactInNamed: 0.08, isHiddenSubcontrol: 0.04, likelyVisualTarget: 0.92 });
    const boxEngine: BoxEngine = {
      async screenTiles(_app, _q, tiles) {
        return Object.fromEntries(tiles.map((t) => [t.id, t.id === 'bottom_right' ? 0.92 : 0.05]));
      },
      async locateInCrop() {
        // Large canvas item (>= 60px) in bottom_right tile (no zoom needed)
        return { present: 0.94, box: { left: 0.4, right: 0.6, top: 0.4, bottom: 0.6 }, confidence: 0.9 };
      },
      async verifyRedBox() {
        return { clickable: 0.96, matches: 0.95, exact: 0.92 };
      },
    };

    const driver = new VisualMemoryDriver();
    const tutor = new Tutor(loadConfig({ provider: 'mock', visual: true }), chooser, driver, boxEngine);
    const res = await tutor.highlight('select the blue clip on track 1', 'CanvasApp', undefined, 'blue clip in bottom right');
    expect(res.ok).toBe(true);
    expect(res.target?.source).toBe('box');
    expect(res.jev?.path).toBe('box');
    expect(res.selection?.box?.tile).toBe('bottom_right');
    expect(driver.moves).toHaveLength(1);
    expect(driver.moves[0].x).toBeGreaterThan(500);
    expect(driver.moves[0].y).toBeGreaterThan(350);

    // Now simulate window content changing between Box localization and fresh verification -> stale!
    const staleDriver = new VisualMemoryDriver();
    staleDriver.changeSecondShot = true;
    const staleTutor = new Tutor(loadConfig({ provider: 'mock', visual: true }), chooser, staleDriver, boxEngine);
    const staleRes = await staleTutor.highlight('select the blue clip on track 1', 'CanvasApp');
    expect(staleRes.ok).toBe(false);
    expect(staleRes.decision).toBe('stale');
    expect(staleDriver.moves).toHaveLength(0);
    await tutor.close();
    await staleTutor.close();
  });
});
