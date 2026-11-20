import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import { PNG } from 'pngjs';
import { axCandidates, type TutorCandidate } from '../src/candidates.js';
import { loadConfig } from '../src/config.js';
import { CuaDriver, NoWindowError, driverEnvironment } from '../src/driver.js';
import { bufferedFetch, decide, inferenceContext, liveChooser, type Chooser } from '../src/jev.js';
import { Tutor } from '../src/tutor.js';
import { normalizeScreenshot } from '../src/visual.js';
import { filmcraftTreeOnly } from './fixtures/filmcraft-tree-only.js';

const deferred = <T = void>() => {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const win = { pid: 1, window_id: 2, app_name: 'Synthetic', title: 'Test' };
const payload = (x = 10, extra: Record<string, unknown> = {}) => ({
  ...win, elements_complete: true, window_bounds: { x: 0, y: 0, width: 200, height: 100 },
  elements: [{ element_index: 1, role: 'AXButton', label: 'Export', actions: ['AXPress'], frame: { x, y: 10, w: 30, h: 20 } }],
  ...extra,
});
const select: Chooser = async (_g, _o, options) => ({
  selectedId: options[0].id, probabilities: Object.fromEntries(options.map(({ id }, i) => [id, i === 0 ? 1 : 0])),
});
const abstain: Chooser = async (_g, _o, options) => ({
  selectedId: 'abstain', probabilities: Object.fromEntries(options.map(({ id }) => [id, id === 'abstain' ? 1 : 0])),
});

class MemoryDriver extends CuaDriver {
  states = 0;
  moves: { x: number; y: number }[] = [];
  events: string[] = [];
  expandedReads: boolean[] = [];
  cursorReply?: Record<string, unknown>;
  snapshot: (n: number) => Record<string, unknown> = () => payload();
  beforeSnapshot?: () => void;
  constructor() { super('/never-spawn', 'test'); }
  window = win;
  override async findWindow() { return this.window; }
  override async frontWindowOf() { return this.window; }
  override async windowState(_pid: number, _id: number, signal?: AbortSignal, screenshot = false, expanded = false) {
    this.expandedReads.push(expanded);
    this.events.push(screenshot ? 'image-read' : 'text-read');
    this.beforeSnapshot?.();
    signal?.throwIfAborted();
    return { data: this.snapshot(++this.states), images: [] };
  }
  override async pointAt(x: number, y: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.events.push('point');
    this.moves.push({ x, y });
  }
  override async clear() { this.events.push(`hide:${this.session}`); }
  override async cursorState(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.events.push('cursor-readback');
    return this.cursorReply ?? { enabled: true, position: this.moves.at(-1) };
  }
  override async close() { await this.clear(); }
}
const tutorFor = (driver: MemoryDriver, chooser: Chooser = select, options: Record<string, unknown> = {}) =>
  new Tutor(loadConfig({ provider: 'mock', ...options }), chooser, driver);

describe('selection, budget and geometry regressions', () => {
  test('native tab/toggle semantics and real panel context survive candidate construction', () => {
    const table = axCandidates(filmcraftTreeOnly, 9099, 577);
    const exportTab = table.candidates.find(c => c.label === 'Export')!;
    expect(exportTab.description).toContain('tab (switches view)');
    expect(exportTab.description).toContain('AXRadioButton/AXTabButton');
    expect(table.candidates.find(c => c.label === 'Quick Export')?.description).toStartWith('button');
    const program = table.candidates.find(c => c.label === 'Program: Play-Stop Toggle (Space)')!;
    expect(program.description).toContain('toggle button');
    expect(program.description).toContain('selected=false');
    expect(program.description).toContain('enabled=true');
    // The observed empty Source panel has no transport. Add an explicit adversarial
    // Source counterpart, not a claim that it was present in the captured snapshot.
    const rawProgram = filmcraftTreeOnly.elements.find(e => e.element_index === 44)!;
    const data = { ...filmcraftTreeOnly, elements: [...filmcraftTreeOnly.elements,
      { element_index: 1000, role: 'AXGroup', label: 'Source', parent_index: 0,
        frame: { x: 500, y: 200, w: 500, h: 500 } },
      { ...rawProgram, element_index: 1001, label: 'Source: Play-Stop Toggle (Space)',
        title: 'Source: Play-Stop Toggle (Space)', parent_index: 1000,
        frame: { x: 600, y: 650, w: 28, h: 28 } },
      { element_index: 1002, role: 'AXMenuItem', label: 'Export', actions: ['AXPress'],
        enabled: true, parent_index: 0 }, // closed menu item, no visible frame
    ] };
    const candidates = axCandidates(data, 9099, 577).candidates;
    expect(candidates.find(c => c.label.startsWith('Source: Play'))?.description).toContain('inside Source');
    expect(candidates.find(c => c.label === program.label)?.description).not.toContain('inside Source');
    expect(candidates.filter(c => c.label === 'Export')).toHaveLength(1);
  });
  test('recorded playback ambiguity stays safe and exposes reserved as well as real alternatives', async () => {
    const table = axCandidates(filmcraftTreeOnly, 9099, 577);
    const chooser: Chooser = async () => ({
      selectedId: 'inspect', probabilities: { inspect: 0.50,
        'ax:checkbox:program-play-stop-toggle-space': 0.24, abstain: 0.12, reobserve: 0.05,
        'ax:radio:timeline': 0.04, 'ax:radio:program': 0.02,
        'ax:checkbox:list-view': 0.02, 'ax:control:music-hit': 0.01 },
    });
    const result = await decide(chooser, 'play the timeline', { inspect_unnamed: true },
      table.candidates, { minProbability: 0.7, minMargin: 0.1 });
    expect(result.kind).toBe('unsure');
    expect(result.selection?.alternatives.slice(0, 2)).toEqual([
      { id: 'inspect', label: 'inspect', probability: 0.5 },
      { id: 'ax:checkbox:program-play-stop-toggle-space', label: 'Program: Play-Stop Toggle (Space)', probability: 0.24 },
    ]);
    expect(result.selection?.margin).toBe(0.26);
  });
  test('abstain and reobserve count in the runner-up margin', async () => {
    for (const reserved of ['abstain', 'reobserve']) {
      const c = axCandidates(payload(), 1, 2).candidates;
      const answer: Chooser = async () => ({ selectedId: c[0].id, probabilities: {
        [c[0].id]: 0.45, [reserved]: 0.44, [reserved === 'abstain' ? 'reobserve' : 'abstain']: 0.11,
      } });
      const result = await decide(answer, 'export', {}, c, { minProbability: 0.35, minMargin: 0.05 });
      expect(result.kind).toBe('unsure');
    }
  });
  test('clips targets to the window and known scroll viewport; preserves negative screen coordinates', () => {
    const data = payload(190);
    expect(axCandidates(data, 1, 2).candidates[0].point).toEqual({ x: 195, y: 20 });
    const scrolled = { ...data, elements: [
      { element_index: 0, role: 'AXScrollArea', frame: { x: 0, y: 0, w: 195, h: 100 } },
      { ...data.elements[0], parent_index: 0 },
    ] };
    expect(axCandidates(scrolled, 1, 2).candidates[0].point.x).toBe(192.5);
    const negative = { ...payload(-90), window_bounds: { x: -100, y: 0, width: 200, height: 100 } };
    expect(axCandidates(negative, 1, 2).candidates[0].point.x).toBe(-75);
  });
  test('normalizes oversized/short images and inverts locator coordinates without treating padding as content', () => {
    const png = new PNG({ width: 4000, height: 100 });
    png.data.fill(120);
    const n = normalizeScreenshot({ png, width: 4000, height: 100 });
    expect([n.width, n.height]).toEqual([1568, 280]);
    const decoded = PNG.sync.read(Buffer.from(n.bytes));
    expect([decoded.width, decoded.height]).toEqual([1568, 280]);
    expect(n.toOriginal({ x: 0, y: 0, w: 1568, h: 39 })).toEqual({ x: 0, y: 0, w: 4000, h: 100 });
    expect(n.toOriginal({ x: 0, y: 100, w: 10, h: 10 })).toBeUndefined();
  });
  test('visual tournament has bounded concurrency and refuses an oversized request budget before sending', async () => {
    const candidates: TutorCandidate[] = Array.from({ length: 80 }, (_, i) => ({
      id: `c${i}`, label: '', description: 'icon', point: { x: i, y: 0 }, source: 'visual',
    }));
    let active = 0, peak = 0, invoked = 0;
    const chooser: Chooser = async (...args) => {
      invoked++; active++; peak = Math.max(peak, active);
      await Promise.resolve();
      const r = await select(...args);
      active--;
      return r;
    };
    const visuals = { crop: () => new Uint8Array([1]) };
    await decide(chooser, 'x', {}, candidates, { minProbability: 0.7, minMargin: 0.1 }, visuals, inferenceContext(undefined, 8, 2));
    expect(peak).toBeLessThanOrEqual(2);
    expect(invoked).toBe(5); // four chunks and one final choice
    invoked = 0;
    await expect(decide(chooser, 'x', {}, candidates, { minProbability: 0.7, minMargin: 0.1 }, visuals, inferenceContext(undefined, 2, 2))).rejects.toThrow(/budget/);
    expect(invoked).toBe(0);
  });
});

describe('operation lifetime', () => {
  test('cursor readback is on the owner connection, and mismatches or hidden cursors never report pointing success', async () => {
    for (const reply of [{ enabled: false, position: { x: 25, y: 20 } },
      { enabled: true, position: { x: 999, y: 999 } }, { enabled: true, position: null }]) {
      const driver = new MemoryDriver();
      driver.cursorReply = reply;
      const tutor = tutorFor(driver);
      const result = await tutor.highlight('export', 'Synthetic');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('readback');
      expect(driver.events.at(-1)).toBe(`hide:${driver.session}`);
      await tutor.close();
    }
  });
  test('actual tree-only FilmCraft geometry retains all seven targets without inventing completeness', async () => {
    const table = axCandidates(filmcraftTreeOnly, 9099, 577);
    expect(table.observation.complete).toBe(false);
    expect(table.coverage).toMatchObject({ status: 'unknown', nodesPending: 0, boundsSource: 'window_root' });
    for (const label of ['Razor Tool', 'Snap in Timeline (S)', 'Program: Play-Stop Toggle (Space)',
      'Quick Export', 'Export', 'Lock V1', 'Mute A1']) {
      expect(table.candidates.filter(c => c.label === label)).toHaveLength(1);
    }
    const driver = new MemoryDriver();
    driver.window = { pid: 9099, window_id: 577, app_name: 'FilmCraft', title: 'FilmCraft' };
    driver.snapshot = () => filmcraftTreeOnly;
    const chooser: Chooser = async (_g, observation, options) => {
      expect(observation.coverage).toBe('unknown');
      const target = options.find(o => o.id === 'ax:checkbox:razor-tool')!;
      return { selectedId: target.id, probabilities: Object.fromEntries(options.map(o => [o.id, o === target ? 1 : 0])) };
    };
    const tutor = tutorFor(driver, chooser);
    const result = await tutor.highlight('switch to the razor tool', 'FilmCraft');
    expect(result.ok).toBe(true);
    expect(result.target?.point).toEqual({ x: 979.260009765625, y: 862.5499877929688 });
    expect(result.table?.complete).toBe(false);
    expect(driver.states).toBe(2); // initial read plus fresh validation, not an incomplete-flag retry
    expect(driver.events).not.toContain('image-read');
    await tutor.close();
  });
  test('real truncation/pending/degradation get one expanded read, then refuse without inference', async () => {
    for (const metadata of [
      { truncated: true, truncation_reason: 'timeout', nodes_pending: 3 },
      { nodes_pending: 2 },
      { degraded_reason: 'ax_window_unresolved' },
    ]) {
      const driver = new MemoryDriver();
      driver.snapshot = () => payload(10, { elements_complete: false, ...metadata });
      let calls = 0;
      const tutor = tutorFor(driver, async (...args) => { calls++; return select(...args); });
      const result = await tutor.highlight('export', 'Synthetic');
      expect(result.decision).toBe('partial');
      expect(driver.states).toBe(2);
      expect(driver.expandedReads).toEqual([false, true]);
      expect(calls).toBe(0);
      expect(driver.moves).toHaveLength(0);
      expect(driver.events).not.toContain('image-read');
      await tutor.close();
    }
  });
  test('bounded reread can recover actual truncation and still validates before pointing', async () => {
    const driver = new MemoryDriver();
    driver.snapshot = n => payload(10, n === 1 ? { truncated: true, nodes_pending: 2 } : {});
    const tutor = tutorFor(driver);
    expect((await tutor.highlight('export', 'Synthetic')).ok).toBe(true);
    expect(driver.states).toBe(3);
    expect(driver.expandedReads).toEqual([false, true, false]);
    await tutor.close();
  });
  test('unknown coverage never proves absence or permits a duplicate named target', async () => {
    for (const duplicate of [false, true]) {
      const driver = new MemoryDriver();
      driver.snapshot = () => {
        const data = payload(10, { elements_complete: false, nodes_pending: 0 });
        return { ...data, elements: duplicate
          ? [{ ...data.elements[0], enabled: true }, { ...data.elements[0], enabled: true, element_index: 2, role: 'AXCheckBox' }]
          : data.elements };
      };
      const tutor = tutorFor(driver, duplicate ? select : abstain);
      const result = await tutor.highlight('export', 'Synthetic');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(duplicate ? /unique/ : /does not establish/);
      expect(driver.moves).toHaveLength(0);
      await tutor.close();
    }
  });
  test('unknown coverage revalidation rejects newly visible competitors', async () => {
    const driver = new MemoryDriver();
    driver.snapshot = n => {
      const data = payload(10, { elements_complete: false, nodes_pending: 0 });
      const control = { ...data.elements[0], enabled: true };
      return { ...data, elements: n === 1 ? [control] : [control,
        { ...control, element_index: 2, label: 'Quick Export' }] };
    };
    const tutor = tutorFor(driver);
    expect((await tutor.highlight('export', 'Synthetic')).decision).toBe('stale');
    expect(driver.moves).toHaveLength(0);
    await tutor.close();
  });
  test('tree-only bounds require one finite window root from the exact requested window', () => {
    expect(() => axCandidates(filmcraftTreeOnly, 9099, 999)).toThrow(/different window/);
    for (const roots of [
      [],
      [filmcraftTreeOnly.elements[0], { ...filmcraftTreeOnly.elements[0], element_index: 1000 }],
      [{ ...filmcraftTreeOnly.elements[0], frame: { x: 0, y: 0, w: Infinity, h: 100 } }],
    ]) {
      const table = axCandidates({ ...filmcraftTreeOnly,
        elements: [...roots, ...filmcraftTreeOnly.elements.slice(1)] }, 9099, 577);
      expect(table.coverage.status).toBe('partial');
      expect(table.coverage.reasons).toContain('window_geometry_missing');
      expect(table.candidates).toHaveLength(0);
    }
  });
  test('unrelated unnamed controls do not trigger screenshots for a named selection or uncertainty', async () => {
    for (const outcome of ['selected', 'abstain', 'reobserve', 'unsure'] as const) {
      const driver = new MemoryDriver();
      driver.snapshot = () => {
        const data = payload();
        return { ...data, elements: [...data.elements, {
          element_index: 2, role: 'AXUnknown', actions: ['AXPress'], frame: { x: 100, y: 10, w: 20, h: 20 },
        }] };
      };
      const chooser: Chooser = async (g, o, options, s, context) => {
        expect(options.some((option) => option.id === 'inspect')).toBe(true);
        if (outcome === 'selected') return select(g, o, options, s, context);
        const selectedId = outcome === 'unsure' ? options[0].id : outcome;
        return { selectedId, probabilities: Object.fromEntries(options.map(({ id }) =>
          [id, outcome === 'unsure' ? 1 / options.length : id === selectedId ? 1 : 0])) };
      };
      const tutor = tutorFor(driver, chooser);
      const result = await tutor.highlight('export', 'Synthetic');
      expect(result.decision).toBe(outcome);
      expect(result.screenshotRequests).toBe(0);
      expect(driver.events).not.toContain('image-read');
      await tutor.close();
    }
  });
  test('cancellation during inference propagates and never points', async () => {
    const started = deferred();
    let observedSignal: AbortSignal | undefined;
    const chooser: Chooser = async (_g, _o, _options, _s, context) => {
      observedSignal = context?.signal;
      started.resolve();
      await new Promise((_, reject) => context!.signal!.addEventListener('abort', () => reject(context!.signal!.reason), { once: true }));
      return { selectedId: 'abstain', probabilities: { abstain: 1 } };
    };
    const driver = new MemoryDriver(), controller = new AbortController();
    const tutor = tutorFor(driver, chooser);
    const running = tutor.highlight('export', 'Synthetic', controller.signal);
    await started.promise;
    controller.abort();
    expect((await running).decision).toBe('cancelled');
    expect(observedSignal?.aborted).toBe(true);
    expect(driver.moves).toHaveLength(0);
    expect(driver.events.at(-1)).toBe(`hide:${driver.session}`);
    await tutor.close();
  });
  test('cancellation after observation, and during the final read, both prevent pointing', async () => {
    for (const cancelAt of ['inference', 'verification']) {
      const driver = new MemoryDriver(), controller = new AbortController();
      const chooser: Chooser = async (...args) => {
        if (cancelAt === 'inference') controller.abort();
        else driver.beforeSnapshot = () => controller.abort();
        return select(...args);
      };
      const tutor = tutorFor(driver, chooser);
      expect((await tutor.highlight('export', 'Synthetic', controller.signal)).decision).toBe('cancelled');
      expect(driver.moves).toHaveLength(0);
      await tutor.close();
    }
  });
  test('moved window or changed target is reobserved instead of using old coordinates', async () => {
    for (const moveWindow of [false, true]) {
      const driver = new MemoryDriver();
      driver.snapshot = (n) => n === 1 ? payload() : moveWindow
        ? payload(10, { window_bounds: { x: 50, y: 0, width: 200, height: 100 } }) : payload(50);
      const tutor = tutorFor(driver);
      expect((await tutor.highlight('export', 'Synthetic')).decision).toBe('stale');
      expect(driver.moves).toHaveLength(0);
      await tutor.close();
    }
  });
  test('a changed toggle value invalidates an otherwise identical target', async () => {
    const driver = new MemoryDriver();
    driver.snapshot = (n) => {
      const data = payload();
      return { ...data, elements: data.elements.map((e) => ({ ...e, value: n !== 1 })) };
    };
    const tutor = tutorFor(driver);
    expect((await tutor.highlight('export', 'Synthetic')).decision).toBe('stale');
    expect(driver.moves).toHaveLength(0);
    await tutor.close();
  });
  test('partial observations do not claim no matching control and do not invoke a model', async () => {
    const driver = new MemoryDriver();
    driver.snapshot = () => payload(10, { elements_complete: false, truncated: true });
    let calls = 0;
    const tutor = tutorFor(driver, async (...args) => { calls++; return select(...args); });
    const result = await tutor.highlight('export', 'Synthetic');
    expect(result.decision).toBe('partial');
    expect(result.message).toContain('limited');
    expect(calls).toBe(0);
    expect(driver.moves).toHaveLength(0);
    await tutor.close();
  });
  test('latest step wins and older cleanup finishes before the new cursor; abstention clears only its owner', async () => {
    const driver = new MemoryDriver(), started = deferred(), release = deferred();
    let calls = 0;
    const chooser: Chooser = async (...args) => {
      calls++;
      if (calls === 1) { started.resolve(); await release.promise; }
      return calls === 3 ? abstain(...args) : select(...args);
    };
    const tutor = tutorFor(driver, chooser);
    const old = tutor.highlight('old', 'Synthetic');
    await started.promise;
    const next = tutor.highlight('new', 'Synthetic');
    release.resolve();
    expect((await old).decision).toBe('cancelled');
    expect((await next).ok).toBe(true);
    expect(driver.moves).toHaveLength(1);
    expect(driver.events.at(-1)).toBe('cursor-readback');
    const other = new MemoryDriver();
    expect(other.session).not.toBe(driver.session);
    const beforeMissing = driver.events.length;
    expect((await tutor.highlight('missing', 'Synthetic')).decision).toBe('abstain');
    expect(driver.events.slice(beforeMissing)).toContain(`hide:${driver.session}`);
    expect(driver.events.slice(beforeMissing)).not.toContain('point');
    expect(other.events).toHaveLength(0);
    await tutor.close();
  });
  test('whole-step deadline cancels a cooperative slow model', async () => {
    const driver = new MemoryDriver();
    const tutor = tutorFor(driver, async (_g, _o, _p, _s, context) => {
      await new Promise((_, reject) => context!.signal!.addEventListener('abort', () => reject(context!.signal!.reason), { once: true }));
      throw new Error('unreachable');
    }, { deadlineMs: 100 });
    const start = performance.now();
    expect((await tutor.highlight('export', 'Synthetic')).decision).toBe('cancelled');
    expect(performance.now() - start).toBeLessThan(1500);
    expect(driver.moves).toHaveLength(0);
    await tutor.close();
  });
  test('missing credentials return unavailable before reading a screen', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const driver = new MemoryDriver(), tutor = new Tutor(loadConfig({ provider: 'live' }), undefined, driver);
    try {
      const result = await tutor.highlight('export', 'Synthetic');
      expect(result.decision).toBe('unavailable');
      expect(driver.states).toBe(0);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
      await tutor.close();
    }
  });
});

describe('driver ownership and process lifetime', () => {
  test('concurrent first calls share one process, then close terminates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tutor-race-'));
    const pidLog = join(dir, 'pids');
    const driver = new CuaDriver(join(import.meta.dir, 'fake-cua-driver.ts'), 'race', {
      ...driverEnvironment(), FAKE_DRIVER_LOG: join(dir, 'calls'), FAKE_DRIVER_PID_LOG: pidLog,
    });
    try {
      await Promise.all([driver.call('list_apps', {}), driver.call('list_apps', {})]);
      const pids = readFileSync(pidLog, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(1);
      await driver.close();
      expect(() => process.kill(pids[0], 0)).toThrow();
    } finally { await driver.close(); }
  });
  test('a driver process that exits is respawned on the next call, and missing windows stay distinguishable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tutor-respawn-'));
    const pidLog = join(dir, 'pids');
    const driver = new CuaDriver(join(import.meta.dir, 'fake-cua-driver.ts'), 'respawn', {
      ...driverEnvironment(), FAKE_DRIVER_LOG: join(dir, 'calls'), FAKE_DRIVER_PID_LOG: pidLog,
    });
    try {
      expect((await driver.findWindow('Notes')).window_id).toBe(9);
      const [first] = readFileSync(pidLog, 'utf8').trim().split('\n').map(Number);
      process.kill(first, 'SIGKILL');
      for (let i = 0; i < 50; i++) {
        try { process.kill(first, 0); } catch { break; }
        await Bun.sleep(20);
      }
      await Bun.sleep(50);
      expect((await driver.findWindow('Notes')).window_id).toBe(9);
      const pids = readFileSync(pidLog, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(2);
      await expect(driver.findWindow('NoSuchApp')).rejects.toBeInstanceOf(NoWindowError);
    } finally { await driver.close(); }
  });
  test('close during connection cleans its in-flight process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tutor-close-'));
    const pidLog = join(dir, 'pids');
    const driver = new CuaDriver(join(import.meta.dir, 'fake-cua-driver.ts'), 'close', {
      ...driverEnvironment(), FAKE_DRIVER_LOG: join(dir, 'calls'), FAKE_DRIVER_PID_LOG: pidLog,
    });
    const call = driver.call('list_apps', {}).catch((e) => e);
    await driver.close();
    expect(await call).toBeInstanceOf(Error);
    for (const pid of readFileSync(pidLog, 'utf8').trim().split('\n').map(Number)) expect(() => process.kill(pid, 0)).toThrow();
  });
  test('driver environment excludes provider credentials and wrapper refuses action/foreign cursor routes', async () => {
    const env = driverEnvironment({ HOME: '/home/test', PATH: '/bin', TYPESAFE_API_KEY: 'secret', OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret' });
    expect(env).toEqual({ HOME: '/home/test', PATH: '/bin' });
    const driver = new CuaDriver('/never-spawn', 'owner', env);
    await expect(driver.call('click', {})).rejects.toThrow(/refuses/);
    await expect(driver.call('move_cursor', { x: 1, y: 1, target: {} })).rejects.toThrow(/overlay/);
    await expect(driver.call('set_agent_cursor_enabled', { session: 'other', enabled: false })).rejects.toThrow(/another/);
    await driver.close();
  });
});

describe('real SDK body adapter (local HTTP only)', () => {
  test('422 retains its error class; mid-body timeout and caller abort remain bounded', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.startsWith('/error')) return Response.json({ detail: 'synthetic rejection' }, { status: 422 });
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
      },
    });
    const client = (route: string) => new TypeSafeClient({
      apiKey: 'local-test', baseURL: `http://127.0.0.1:${server.port}/${route}`, fetch: bufferedFetch,
      timeout: 100, retry: { maxRetries: 0 }, logLevel: 'off',
    });
    const request = { state: 'synthetic', questions: { x: choice('Select x', { x: 'x' }) } };
    try {
      await expect(Promise.resolve(client('error').systemOne(request))).rejects.toMatchObject({ name: 'UnprocessableEntityError', status: 422 });
      await expect(Promise.resolve(client('timeout').systemOne(request))).rejects.toMatchObject({ name: 'APITimeoutError' });
      await expect(Promise.resolve(client('abort').systemOne(request, { signal: AbortSignal.timeout(20) }))).rejects.toMatchObject({ name: 'APIUserAbortError' });
    } finally { server.stop(true); }
  });
  test('live adapter records actual HTTP attempts and reported usage, with zero implicit retries', async () => {
    let requests = 0;
    let mode: 'ok' | 'error' | 'hang' = 'ok';
    const server = Bun.serve({ port: 0, fetch() {
      requests++;
      if (mode === 'error') return Response.json({ detail: 'synthetic unavailable' }, { status: 503 });
      if (mode === 'hang') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
      return Response.json({ model: 'synthetic', answers: { candidate: { type: 'choice', choice: 'x', confidence: 1, probabilities: { x: 1 } } }, usage: { input_tokens: 12, output_tokens: 2 } });
    } });
    const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL };
    process.env.TYPESAFE_API_KEY = 'local-test';
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const context = inferenceContext();
      await liveChooser()('x', {}, [{ id: 'x', text: 'x' }], undefined, context);
      expect(requests).toBe(1);
      expect(context.metrics.requests).toBe(1);
      expect(context.metrics.inputTokens).toBe(12);
      expect(context.metrics.usageResponses).toBe(1);
      mode = 'error';
      const failed = inferenceContext();
      await expect(liveChooser()('x', {}, [{ id: 'x', text: 'x' }], undefined, failed)).rejects.toMatchObject({ status: 503 });
      expect(failed.metrics.requests).toBe(1);
      expect(requests).toBe(2);
      mode = 'hang';
      const cancelled = inferenceContext(AbortSignal.timeout(20));
      await expect(liveChooser()('x', {}, [{ id: 'x', text: 'x' }], undefined, cancelled)).rejects.toMatchObject({ name: 'APIUserAbortError' });
      expect(cancelled.metrics.requests).toBe(1);
    } finally {
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = saved.url;
      server.stop(true);
    }
  });
});
