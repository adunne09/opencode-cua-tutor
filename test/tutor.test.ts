import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveDriverBinary } from '../src/config.js';
import { buildTutorGuidance } from '../src/direct.js';
import { resolveInstalledApp, type AppLauncher } from '../src/apps.js';
import { PNG } from 'pngjs';

import { axCandidates } from '../src/candidates.js';
import { bufferedFetch, decide, liveChooser, MAX_ACTIONS, mockChooser, snapToCandidate, type Chooser } from '../src/jev.js';
import { Tutor } from '../src/tutor.js';
import { CuaDriver, driverEnvironment } from '../src/driver.js';
import { CROP_SIDE, cropCandidate, decodeScreenshot } from '../src/visual.js';

describe('config', () => {
  test('missing credentials never silently select mock; mock is explicit', () => {
    expect(loadConfig({}, { HOME: '/nonexistent' }).provider).toBe('live');
    expect(loadConfig({}, { HOME: '/nonexistent', TYPESAFE_API_KEY: 'k' }).provider).toBe('live');
    expect(loadConfig({ provider: 'mock' }, {}).provider).toBe('mock');
    expect(() => loadConfig({ provider: 'liv' }, {})).toThrow(/provider/);
  });
  test('no app pinned by default; option or CUA_TUTOR_APP pins one', () => {
    expect(loadConfig({}, { HOME: '/nonexistent' }).defaultApp).toBeUndefined();
    expect(loadConfig({}, { HOME: '/nonexistent', CUA_TUTOR_APP: 'Notes' }).defaultApp).toBe('Notes');
    expect(loadConfig({ app: 'Keynote' }, { HOME: '/nonexistent' }).defaultApp).toBe('Keynote');
  });
  test('injectGuidance and autoLaunch default on; declareMcp defaults off', () => {
    const c = loadConfig({}, { HOME: '/nonexistent' });
    expect([c.injectGuidance, c.autoLaunch, c.declareMcp]).toEqual([true, true, false]);
    const custom = loadConfig({ injectGuidance: false, autoLaunch: false, declareMcp: true }, { HOME: '/nonexistent' });
    expect([custom.injectGuidance, custom.autoLaunch, custom.declareMcp]).toEqual([false, false, true]);
  });
  test('driver binary falls back to PATH lookup when not installed in a known place', () => {
    expect(resolveDriverBinary(undefined, '/nonexistent')).toMatch(/cua-driver$/);
    expect(resolveDriverBinary('/x/cua-driver', '/nonexistent')).toBe('/x/cua-driver');
  });
});

describe('guidance and app resolution', () => {
  test('guidance is app-agnostic, names tutor_set_app + tutor_highlight, and reflects live sessionApp', () => {
    const gUnset = buildTutorGuidance({ sessionApp: undefined, autoLaunch: true });
    expect(gUnset).toContain('tutor_set_app');
    expect(gUnset).toContain('tutor_highlight');
    expect(gUnset).toContain('(none yet)');
    expect(gUnset.toLowerCase()).not.toContain('filmcraft');
    const gSet = buildTutorGuidance({ sessionApp: 'Keynote', autoLaunch: true });
    expect(gSet).toContain('**Keynote**');
  });

  test('resolveInstalledApp matches exact, normalized, alias, and unique prefix strictly against installed bundles', () => {
    const installed = [
      { name: 'FilmCraft', path: '/Applications/FilmCraft.app', normalized: 'filmcraft' },
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app', normalized: 'googlechrome' },
      { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', normalized: 'visualstudiocode' },
      { name: 'Adobe Premiere Pro 2026', path: '/Applications/Adobe Premiere Pro 2026.app', normalized: 'adobepremierepro2026' },
    ];
    expect(resolveInstalledApp('filmcraft', installed)?.path).toBe('/Applications/FilmCraft.app');
    expect(resolveInstalledApp('Film Craft', installed)?.name).toBe('FilmCraft');
    expect(resolveInstalledApp('Chrome', installed)?.name).toBe('Google Chrome');
    expect(resolveInstalledApp('VS Code', installed)?.name).toBe('Visual Studio Code');
    expect(resolveInstalledApp('Premiere', installed)?.name).toBe('Adobe Premiere Pro 2026');
    expect(resolveInstalledApp('NotInstalledApp', installed)).toBeUndefined();
  });
});

describe('decide', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Control ${i}`, description: `control ${i}`, point: { x: i, y: i }, source: 'ax' as const }));
  test('text tournament handles more than 200 candidates and only returns supplied ids', async () => {
    const candidates = mk(260);
    candidates[47] = { ...candidates[47], label: 'Razor', description: 'button "Razor Tool"' };
    const d = await decide(mockChooser(), 'cut with the razor', {}, candidates, { minProbability: 0.3, minMargin: 0 });
    expect(d.kind).toBe('selected');
    if (d.kind === 'selected') expect(d.candidate.label).toBe('Razor');
  });
  test('abstain highlights nothing', async () => {
    const d = await decide(mockChooser(), 'make me coffee', {}, mk(5), { minProbability: 0.3, minMargin: 0 });
    expect(d.kind).toBe('abstain');
  });
  test('rejects a chooser that invents an id', async () => {
    const bad: Chooser = async () => ({ selectedId: 'click_everything', probabilities: { click_everything: 1 } });
    const d = await decide(bad, 'x', {}, mk(3), { minProbability: 0.3, minMargin: 0 });
    expect(d.kind).toBe('unsure');
  });
  test('low confidence is unsure', async () => {
    const flat: Chooser = async (_g, _o, options) => {
      const ids = options.map((o) => o.id);
      return { selectedId: ids[0], probabilities: Object.fromEntries(ids.map((id) => [id, 1 / ids.length])) };
    };
    const d = await decide(flat, 'x', {}, mk(5), { minProbability: 0.35, minMargin: 0.05 });
    expect(d.kind).toBe('unsure');
  });
  test('chunks never exceed the 24-action cap and are balanced', async () => {
    const sizes: number[] = [];
    const spy: Chooser = async (g, o, options) => {
      sizes.push(options.length - 2);
      return mockChooser()(g, o, options);
    };
    const candidates = mk(50);
    candidates[33] = { ...candidates[33], description: 'button "Razor Tool"' };
    await decide(spy, 'razor', {}, candidates, { minProbability: 0.1, minMargin: 0 }, { crop: () => undefined });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_ACTIONS);
    expect(sizes.slice(0, 3)).toEqual([17, 17, 16]);
  });
  test('visual candidates reach the chooser with crops without repeating the whole window', async () => {
    const seen: { images: number; shot: boolean }[] = [];
    const spy: Chooser = async (_g, _o, options, screenshot) => {
      seen.push({ images: options.filter((o) => o.image).length, shot: Boolean(screenshot) });
      const pick = options.find((o) => o.image)!.id;
      return { selectedId: pick, probabilities: Object.fromEntries(options.map(({ id }) => [id, id === pick ? 0.9 : 0.1 / options.length])) };
    };
    const c = [
      { id: 'vis:control:e1', label: '', description: 'unlabeled clickable control', point: { x: 1, y: 1 }, source: 'visual' as const, shot: { x: 0, y: 0, w: 4, h: 4 } },
      { id: 'ax:button:ok', label: 'OK', description: 'button "OK"', point: { x: 2, y: 2 }, source: 'ax' as const },
    ];
    const d = await decide(spy, 'press the icon', {}, c, { minProbability: 0.3, minMargin: 0 }, {
      crop: () => new Uint8Array([1, 2, 3]),
      screenshot: new Uint8Array([4]),
    });
    expect(d.kind).toBe('selected');
    expect(seen).toEqual([{ images: 1, shot: false }]);
  });
  test('locator hit snaps to the smallest candidate containing the box centre', () => {
    const c = (id: string, x: number, y: number, w: number, h: number) =>
      ({ id, label: '', description: '', point: { x, y }, source: 'visual' as const, shot: { x, y, w, h } });
    const big = c('big', 0, 0, 400, 40);
    const icon = c('icon', 100, 10, 20, 20);
    expect(snapToCandidate({ x: 105, y: 12, w: 10, h: 10 }, [big, icon])?.id).toBe('icon');
    expect(snapToCandidate({ x: 300, y: 300, w: 10, h: 10 }, [big, icon])).toBeUndefined();
  });
  test('Jev prompt names the app being learned', async () => {
    let goal = '';
    const spy: Chooser = async (g, _o, options) => {
      goal = g;
      return { selectedId: 'abstain', probabilities: Object.fromEntries(options.map(({ id }) => [id, id === 'abstain' ? 1 : 0])) };
    };
    await decide(spy, 'share this', { app: 'Notes' }, mk(2), { minProbability: 0.3, minMargin: 0 });
    expect(goal).toContain('learning to use Notes');
  });
});

describe('end to end with a fake Cua Driver (mock Jev)', () => {
  async function run(step: string, app?: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cua-tutor-'));
    const log = join(dir, 'calls.ndjson');
    const config = loadConfig({ provider: 'mock', minProbability: 0.35, driverBinary: join(import.meta.dir, 'fake-cua-driver.ts') }, { ...process.env, HOME: '/nonexistent' });
    const driver = new CuaDriver(config.driverBinary, config.driverSession, {
      ...driverEnvironment(), FAKE_DRIVER_LOG: log, FAKE_ACTIVE_APP: env.FAKE_ACTIVE_APP ?? 'Ghostty',
    });
    const tutor = new Tutor(config, undefined, driver);
    try {
      const result = await tutor.highlight(step, app);
      const calls = existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      return { result, calls, session: driver.session };
    } finally {
      await tutor.close();
    }
  }

  test('refuses to guess an open app when no app is specified', async () => {
    const { result, calls } = await run('switch to the razor tool');
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('error');
    expect(result.message).toMatch(/No application specified/i);
    expect(calls).toEqual([]);
  }, 20_000);

  test('explicit app points at the control, verifies cursor readback, and never clicks', async () => {
    const { result, calls, session } = await run('switch to the razor tool', 'DemoEditor');
    expect(result.ok).toBe(true);
    expect(result.app).toBe('DemoEditor');
    expect(result.target?.label).toBe('Razor Tool');
    expect(calls.map((c) => c.name)).not.toContain('click');
    const move = calls.find((c) => c.name === 'move_cursor');
    expect(move.args).toEqual({ x: 120, y: 210, session });
    expect(calls.find((c) => c.name === 'get_agent_cursor_state').args).toEqual({ session });
    expect(result.cursorReadback).toEqual({ enabled: true, position: { x: 120, y: 210 }, matched: true });
    expect(result.cursorReadbackRequests).toBe(1);
    expect(calls.filter((c) => c.name === 'get_window_state').map((c) => c.args.include_screenshot)).toEqual([false, false]);
    expect(calls.find((c) => c.name === 'get_window_state').args).toMatchObject({
      full_output: true, max_depth: 25, max_elements: 1500, timeout_ms: 3000,
    });
  }, 20_000);

  test('explicit app works by name or bundle id', async () => {
    const byName = await run('share the note', 'Notes');
    expect(byName.result.app).toBe('Notes');
    expect(byName.result.target?.label).toBe('Share Note');
    expect(byName.calls.find((c) => c.name === 'list_windows').args).toEqual({ app: 'Notes' });
    const byBundle = await run('share the note', 'com.apple.Notes');
    expect(byBundle.result.target?.label).toBe('Share Note');
    const move = byBundle.calls.find((c) => c.name === 'move_cursor');
    expect(move.args).toEqual({ x: 520, y: 70, session: byBundle.session });
  }, 20_000);

  test('egui-style app: unnamed AXUnknown controls are pointed at by picture, at the frame centre, never clicked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cua-tutor-'));
    const log = join(dir, 'calls.ndjson');
    const config = loadConfig({ provider: 'mock', driverBinary: join(import.meta.dir, 'fake-cua-driver.ts') }, { ...process.env, HOME: '/nonexistent' });
    let got: { ids: string[]; images: number; shot: boolean } | undefined;
    // Stand-in for Jev looking at the crops: pick the visual candidate at the window's middle.
    const chooser: Chooser = async (_g, _o, options, screenshot) => {
      got = { ids: options.map((o) => o.id), images: options.filter((o) => o.image).length, shot: Boolean(screenshot) };
      const pick = options.some((o) => o.image) ? 'vis:control:e4' : 'inspect';
      return { selectedId: pick, probabilities: Object.fromEntries(options.map(({ id }) => [id, id === pick ? 0.9 : 0.01])) };
    };
    const driver = new CuaDriver(config.driverBinary, config.driverSession, { ...driverEnvironment(), FAKE_DRIVER_LOG: log });
    const tutor = new Tutor(config, chooser, driver);
    try {
      const result = await tutor.highlight('open the effects panel', 'EguiCraft');
      expect(result.ok).toBe(true);
      expect(result.target?.source).toBe('visual');
      expect(result.table).toEqual({ labelled: 2, visual: 3, excluded: { window_chrome: 1, not_actionable: 1, container: 1 }, complete: true, truncated: false });
      expect(got).toEqual({
        ids: ['vis:control:e2', 'vis:control:e3', 'vis:control:e4', 'ax:menu_item:file', 'ax:control:play', 'reobserve', 'abstain'],
        images: 3,
        shot: false,
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(calls.map((c) => c.name)).not.toContain('click');
      expect(calls.find((c) => c.name === 'move_cursor').args).toEqual({ x: 914, y: 614, session: driver.session });
      expect(calls.filter((c) => c.name === 'get_window_state').map((c) => c.args.include_screenshot)).toEqual([false, true, true]);
      expect(result.screenshotRequests).toBe(2);
      expect(tutor.driver.history).not.toContain('click');
    } finally {
      await tutor.close();
    }
  }, 20_000);

  test('unknown app is a clear error when not installed', async () => {
    const { result } = await run('anything', 'NoSuchApp');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no on-screen window/);
  }, 20_000);

  test('setApp auto-launches a verified installed closed app and resolves its window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cua-tutor-'));
    const log = join(dir, 'calls.ndjson');
    const config = loadConfig({ provider: 'mock', autoLaunch: true, driverBinary: join(import.meta.dir, 'fake-cua-driver.ts') }, { ...process.env, HOME: '/nonexistent' });
    const driver = new CuaDriver(config.driverBinary, config.driverSession, { ...driverEnvironment(), FAKE_DRIVER_LOG: log });
    const launched: string[] = [];
    const launcher: AppLauncher = {
      resolve: (q) =>
        q.toLowerCase() === 'notes' || q.toLowerCase() === 'demoapp'
          ? { name: 'Notes', path: '/System/Applications/Notes.app', normalized: 'notes' }
          : undefined,
      launch: async (p) => {
        launched.push(p);
      },
    };
    const tutor = new Tutor(config, undefined, driver, undefined, launcher);
    try {
      // Notes is already open in fake-cua-driver -> no launch needed
      const openRes = await tutor.setApp('Notes');
      expect(openRes.ok).toBe(true);
      expect(openRes.appName).toBe('Notes');
      expect(openRes.launched).toBe(false);
      expect(launched).toEqual([]);

      // Unknown app -> not found
      const missingRes = await tutor.setApp('NonExistentApp');
      expect(missingRes.ok).toBe(false);
      expect(missingRes.message).toMatch(/Could not find/);

      // Alias to installed app that is closed -> launches it
      const closedLauncher: AppLauncher = {
        resolve: (q) => (q === 'LaunchMe' ? { name: 'LaunchMe', path: '/Applications/LaunchMe.app', normalized: 'launchme' } : undefined),
        launch: async (p) => {
          launched.push(p);
        },
      };
      const tutor2 = new Tutor(config, undefined, driver, undefined, closedLauncher);
      // Wait only briefly by aborting or using a small fake driver window response; override findWindow on driver
      const origFind = driver.findWindow.bind(driver);
      let calls = 0;
      driver.findWindow = async (app, sig) => {
        if (app === 'LaunchMe') {
          calls++;
          if (calls === 1) throw new Error('LaunchMe has no on-screen window. Open it first.');
          return { pid: 55, window_id: 77, app_name: 'LaunchMe', title: 'Welcome' };
        }
        return origFind(app, sig);
      };
      const launchRes = await tutor2.setApp('LaunchMe');
      expect(launchRes.ok).toBe(true);
      expect(launchRes.launched).toBe(true);
      expect(launchRes.open).toBe(true);
      expect(launchRes.appName).toBe('LaunchMe');
      expect(launched).toEqual(['/Applications/LaunchMe.app']);
    } finally {
      await tutor.close();
    }
  }, 20_000);
});

describe('candidates (egui/AccessKit-style accessibility trees)', () => {
  // Shape copied from a live FilmCraft get_window_state (Cua Driver 0.49.11): AXUnknown + AXPress, no names.
  const unk = (i: number, x: number, y: number, w = 28, h = 28, extra: Record<string, unknown> = {}) => ({
    element_index: i, element_token: `s:${i}`, role: 'AXUnknown', subrole: 'AXUnknown', actions: ['AXPress'], enabled: true,
    frame: { x, y, w, h }, screenshot_frame: { x: (x - 767) * 0.854, y: (y - 177) * 0.854, w: w * 0.854, h: h * 0.854 },
    parent_index: 0, depth: 1, ...extra,
  });
  const payload = (elements: unknown[]) => ({
    pid: 1, window_id: 2, window_bounds: { x: 767, y: 177, width: 1600, height: 980 }, screenshot_width: 1366, screenshot_height: 837,
    elements: [{ element_index: 0, role: 'AXWindow', label: 'FilmCraft', actions: ['AXRaise'], frame: { x: 767, y: 177, w: 1600, h: 980 }, depth: 0 }, ...elements],
  });

  test('unknown-role actionable elements are kept, not dropped as unknown_role', () => {
    const t = axCandidates(payload([unk(1, 868, 183), unk(2, 904, 183, 55, 26)]), 1, 2, { visual: true });
    expect(t.candidates.map((c) => c.id)).toEqual(['vis:control:e1', 'vis:control:e2']);
    expect(t.excluded.unknown_role).toBeUndefined();
    expect(t.visual).toBe(2);
  });
  test('unlabeled ones are dropped without a screenshot (text-only mode)', () => {
    const t = axCandidates(payload([unk(1, 868, 183)]), 1, 2, { visual: false });
    expect(t.candidates).toEqual([]);
    expect(t.excluded.unlabeled).toBe(1);
  });
  test('labels fall back to title / description / help', () => {
    const t = axCandidates(payload([unk(1, 868, 183, 28, 28, { description: 'Razor Tool' }), unk(2, 904, 183, 28, 28, { help: 'Export' })]), 1, 2);
    expect(t.candidates.map((c) => [c.id, c.label, c.source])).toEqual([
      ['ax:control:razor-tool', 'Razor Tool', 'ax'],
      ['ax:control:export', 'Export', 'ax'],
    ]);
  });
  test('point is the frame centre in screen points; shot is the screenshot_frame', () => {
    const [c] = axCandidates(payload([unk(1, 1000, 700, 18, 16)]), 1, 2, { visual: true }).candidates;
    expect(c.point).toEqual({ x: 1009, y: 708 });
    expect(c.shot!.x).toBeCloseTo((1000 - 767) * 0.854);
  });
  test('derives the screenshot rect from the window scale when screenshot_frame is missing', () => {
    const el = { ...unk(1, 967, 277, 20, 20), screenshot_frame: undefined };
    const [c] = axCandidates(payload([el]), 1, 2, { visual: true }).candidates;
    expect(c.shot!.x).toBeCloseTo(200 * (1366 / 1600));
    expect(c.shot!.w).toBeCloseTo(20 * (1366 / 1600));
  });
  test('drops traffic lights, non-actionable unknowns, unlabeled containers, disabled and off-window elements', () => {
    const t = axCandidates(
      payload([
        unk(1, 767, 177, 1600, 38), // header container wrapping 2 and 3
        unk(2, 868, 183), unk(3, 904, 183),
        { element_index: 4, element_token: 's:4', role: 'AXButton', subrole: 'AXCloseButton', actions: ['AXPress'], frame: { x: 775, y: 185, w: 16, h: 16 }, parent_index: 0 },
        { ...unk(5, 900, 400), actions: [] },
        unk(6, 950, 400, 28, 28, { enabled: false }),
        unk(7, 5000, 400),
      ]),
      1,
      2,
      { visual: true }
    );
    expect(t.candidates.map((c) => c.elementIndex)).toEqual([2, 3]);
    expect(t.excluded).toEqual({ container: 1, window_chrome: 1, not_actionable: 1, disabled: 1, off_screen: 1 });
  });
  test('menu bar items outside the window rect are kept', () => {
    const t = axCandidates(
      payload([
        { element_index: 1, element_token: 's:1', role: 'AXMenuBar', actions: ['AXCancel'], frame: { x: 0, y: 0, w: 2560, h: 30 } },
        { element_index: 2, element_token: 's:2', role: 'AXMenuBarItem', title: 'File', actions: ['AXPress'], frame: { x: 125, y: 0, w: 42, h: 30 }, parent_index: 1 },
      ]),
      1,
      2
    );
    expect(t.candidates.map((c) => c.id)).toEqual(['ax:menu_item:file']);
  });
});

describe('visual crops', () => {
  test('are CROP_SIDE square PNGs (TypeSafe rejects small images) with a red outline', () => {
    const p = new PNG({ width: 400, height: 300 });
    p.data.fill(50);
    const shot = decodeScreenshot(PNG.sync.write(p).toString('base64'))!;
    const crop = PNG.sync.read(Buffer.from(cropCandidate(shot, { x: 380, y: 10, w: 15, h: 15 }))); // near the edge
    expect([crop.width, crop.height]).toEqual([CROP_SIDE, CROP_SIDE]);
    let red = 0;
    for (let i = 0; i < crop.data.length; i += 4) if (crop.data[i] === 255 && crop.data[i + 1] === 32) red++;
    expect(red).toBeGreaterThan(50);
  });
});

describe('TypeSafe SDK under Bun', () => {
  test('bufferedFetch avoids "Body already used" and live requests only opt into images when needed', async () => {
    const seen: { images: string | null; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ images: req.headers.get('typesafe-danger-zone-images'), body: await req.text() });
        return Response.json({
          model: 'jev-latest',
          answers: { candidate: { type: 'choice', choice: 'ax:button:ok', confidence: 0.9, probabilities: { 'ax:button:ok': 0.9, reobserve: 0.05, abstain: 0.05 } } },
          usage: { input_tokens: 10, output_tokens: 1 },
        });
      },
    });
    const saved = { url: process.env.TYPESAFE_BASE_URL, key: process.env.TYPESAFE_API_KEY };
    Object.assign(process.env, { TYPESAFE_BASE_URL: `http://localhost:${server.port}`, TYPESAFE_API_KEY: 'test' });
    try {
      const options = [{ id: 'ax:button:ok', text: 'button "OK"' }, { id: 'reobserve', text: 'r' }, { id: 'abstain', text: 'a' }];
      const r = await liveChooser()('goal', { app: 'X' }, options);
      expect(r.selectedId).toBe('ax:button:ok');
      expect(seen[0].images).toBeNull();
      expect(JSON.parse(seen[0].body).assets).toBeUndefined();
      const p = new PNG({ width: 280, height: 280 });
      const png = new Uint8Array(PNG.sync.write(p));
      await liveChooser()('goal', { app: 'X' }, [{ ...options[0], image: png }, options[1], options[2]], png);
      expect(seen[1].images).toBe('true');
      const res = await bufferedFetch(`http://localhost:${server.port}`);
      expect(res.body).toBeNull();
      expect(((await res.json()) as { model: string }).model).toBe('jev-latest');
    } finally {
      server.stop(true);
      process.env.TYPESAFE_BASE_URL = saved.url;
      process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.TYPESAFE_BASE_URL;
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    }
  });
});
