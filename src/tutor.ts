/** One bounded, cancellable tutor step. Only the user clicks. */
import { defaultAppLauncher, type AppLauncher } from './apps.js';
import { axCandidates, type CandidateTable, type Rect, type TutorCandidate } from './candidates.js';
import type { TutorConfig } from './config.js';
import { CuaDriver, NoWindowError, type WindowInfo } from './driver.js';
import {
  decide,
  inferenceContext,
  InferenceBudgetError,
  liveBoxEngine,
  liveChooser,
  liveLocator,
  locateWithBox,
  mockChooser,
  type BoxEngine,
  type Chooser,
  type Decision,
  type InferenceMetrics,
  type SelectionDiagnostics,
  type Visuals,
} from './jev.js';
import { cropCandidate, decodeScreenshot, normalizeScreenshot, patchUnchanged, type Screenshot } from './visual.js';

export const TUTOR_REVISION = 'jev-box-20261120.2';

export type SetAppResult = {
  ok: boolean;
  appName: string;
  windowTitle?: string;
  open: boolean;
  launched: boolean;
  message: string;
};

export type HighlightResult = {
  ok: boolean;
  message: string;
  revision: string;
  /** Public owner label for a read-only Cua cursor-state verification. */
  cursorSession: string;
  app?: string;
  window?: string;
  decision?: Decision['kind'] | 'partial' | 'stale' | 'cancelled' | 'unavailable' | 'budget' | 'error';
  target?: {
    id: string;
    label: string;
    source: TutorCandidate['source'] | 'box';
    probability: number;
    point: { x: number; y: number };
  };
  candidates: number;
  screenshotRequests: number;
  cursorReadbackRequests: number;
  table?: { labelled: number; visual: number; excluded: Record<string, number>; complete: boolean; truncated: boolean };
  observation?: CandidateTable['coverage'] & { elements: number; pid: number; windowId: number };
  selection?: SelectionDiagnostics;
  cursorReadback?: { enabled: true; position: { x: number; y: number }; matched: true };
  jev?: InferenceMetrics & { provider: 'live' | 'mock'; rounds: number; path: 'named' | 'visual' | 'box' };
  timingsMs: Record<string, number>;
};

type Observed = { window: WindowInfo; table: CandidateTable; shot?: Screenshot; visuals?: Visuals };
const sameNumbers = (a?: readonly number[], b?: readonly number[]) =>
  Boolean(a && b && a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) <= 0.5));
const frameNumbers = (c: TutorCandidate) => c.frame && [c.frame.x, c.frame.y, c.frame.w, c.frame.h];
const usable = (o: Observed) => o.table.coverage.status !== 'partial';
const positiveUnknownTarget = (o: Observed, c: TutorCandidate) =>
  o.table.coverage.status === 'complete' ||
  (c.source === 'ax' &&
    c.enabled === true &&
    Boolean(c.label) &&
    o.table.candidates.filter((other) => other.label === c.label).length === 1);

function whereInWindow(p: { x: number; y: number }, bounds?: readonly number[]): string {
  if (!bounds || bounds.length < 4) return '';
  const [wx, wy, ww, wh] = bounds;
  if (ww <= 0 || wh <= 0) return '';
  const fx = (p.x - wx) / ww;
  const fy = (p.y - wy) / wh;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return '';
  const v = fy < 0.2 ? 'top' : fy > 0.8 ? 'bottom' : 'middle';
  const h = fx < 0.33 ? 'left' : fx > 0.67 ? 'right' : 'centre';
  return `${v} ${h} of the window`;
}

const driverFailure = (appName: string, error: unknown): SetAppResult => ({
  ok: false,
  appName,
  open: false,
  launched: false,
  message: `Could not check ${appName}'s windows because Cua Driver failed: ${error instanceof Error ? error.message : String(error)}`,
});

export class Tutor {
  readonly driver: CuaDriver;
  private readonly chooser: Chooser;
  private readonly boxEngine?: BoxEngine;
  private readonly launcher: AppLauncher;
  private pending: Promise<unknown> = Promise.resolve();
  private active?: AbortController;
  private disposed = false;

  constructor(
    readonly config: TutorConfig,
    chooser?: Chooser,
    driver?: CuaDriver,
    boxEngine?: BoxEngine,
    launcher?: AppLauncher
  ) {
    this.driver = driver ?? new CuaDriver(config.driverBinary, config.driverSession);
    this.chooser = chooser ?? (config.provider === 'live' ? liveChooser(config.jevModel) : mockChooser());
    this.boxEngine =
      boxEngine ?? (config.visual && config.provider === 'live' && !chooser ? liveBoxEngine(config.boxModel) : undefined);
    this.launcher = launcher ?? defaultAppLauncher();
  }

  private async waitForWindow(appName: string, signal?: AbortSignal, waitMs = 5000): Promise<WindowInfo | undefined> {
    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
      signal?.throwIfAborted();
      try {
        return await this.driver.findWindow(appName, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof NoWindowError)) throw error;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 250);
        const onAbort = () => {
          clearTimeout(t);
          reject(signal?.reason ?? new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return undefined;
  }

  /**
   * Resolve an explicitly specified app name/bundle id to an open window, auto-launching a verified
   * installed macOS `.app` bundle when `config.autoLaunch` is enabled and no window is open yet.
   */
  private async resolveOrLaunchWindow(app: string, signal: AbortSignal): Promise<WindowInfo> {
    try {
      return await this.driver.findWindow(app, signal);
    } catch (firstError) {
      signal.throwIfAborted();
      // Only a confirmed "no window" justifies launching; driver failures must surface as-is.
      if (!(firstError instanceof NoWindowError) || !this.config.autoLaunch) throw firstError;
      const installed = this.launcher.resolve(app);
      if (!installed) throw firstError;
      if (installed.name.toLowerCase() !== app.toLowerCase()) {
        try {
          return await this.driver.findWindow(installed.name, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof NoWindowError)) throw error;
        }
      }
      await this.launcher.launch(installed.path, signal);
      const win = await this.waitForWindow(installed.name, signal);
      if (win) return win;
      throw new Error(`Launched ${installed.name}, but no on-screen window appeared yet. Wait a moment and try again.`);
    }
  }

  /**
   * Validate and select the session's target app (called by `tutor_set_app`). If not already open
   * and `config.autoLaunch` is enabled, launches the verified installed macOS `.app` bundle.
   */
  async setApp(appQuery: string, signal?: AbortSignal): Promise<SetAppResult> {
    const query = appQuery.trim();
    if (!query) {
      return { ok: false, appName: '', open: false, launched: false, message: 'Provide a non-empty application name or bundle id.' };
    }
    try {
      const win = await this.driver.findWindow(query, signal);
      const appName = win.app_name?.trim() || query;
      return {
        ok: true,
        appName,
        windowTitle: win.title,
        open: true,
        launched: false,
        message: `Current tutor app set to "${appName}" (already open${win.title ? ` — window "${win.title}"` : ''}).`,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof NoWindowError)) return driverFailure(query, error);
    }

    const installed = this.launcher.resolve(query);
    if (!installed) {
      return {
        ok: false,
        appName: query,
        open: false,
        launched: false,
        message: `Could not find an open window or installed macOS app matching "${query}". Check the exact app name.`,
      };
    }

    // Check if the canonical bundle name is already open (e.g. query "Chrome" -> "Google Chrome")
    if (installed.name.toLowerCase() !== query.toLowerCase()) {
      try {
        const win = await this.driver.findWindow(installed.name, signal);
        const appName = win.app_name?.trim() || installed.name;
        return {
          ok: true,
          appName,
          windowTitle: win.title,
          open: true,
          launched: false,
          message: `Current tutor app set to "${appName}" (already open${win.title ? ` — window "${win.title}"` : ''}).`,
        };
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof NoWindowError)) return driverFailure(installed.name, error);
      }
    }

    if (!this.config.autoLaunch) {
      return {
        ok: true,
        appName: installed.name,
        open: false,
        launched: false,
        message: `Current tutor app set to "${installed.name}", but it is not open yet (autoLaunch is disabled). Open it before highlighting.`,
      };
    }

    await this.launcher.launch(installed.path, signal);
    const win = await this.waitForWindow(installed.name, signal);
    const appName = win?.app_name?.trim() || installed.name;
    return {
      ok: true,
      appName,
      windowTitle: win?.title,
      open: Boolean(win),
      launched: true,
      message: win
        ? `Current tutor app set to "${appName}" (automatically launched — window "${win.title ?? appName}" is ready).`
        : `Current tutor app set to "${appName}" (automatically launched; window is still starting up).`,
    };
  }

  private async observe(app: string | undefined, signal: AbortSignal, visual = false, knownWindow?: WindowInfo): Promise<Observed> {
    const target = app?.trim() || this.config.defaultApp;
    if (!knownWindow && !target) {
      throw new Error('No application specified. Specify the app name or bundle id first.');
    }
    const window = knownWindow ?? (await this.resolveOrLaunchWindow(target!, signal));
    let { data, images } = await this.driver.windowState(window.pid, window.window_id, signal, visual);
    signal.throwIfAborted();
    if (axCandidates(data, window.pid, window.window_id).coverage.status === 'partial') {
      ({ data, images } = await this.driver.windowState(window.pid, window.window_id, signal, visual, true));
      signal.throwIfAborted();
    }
    const shot = visual && images[0] ? decodeScreenshot(images[0]) : undefined;
    const table = axCandidates(data, window.pid, window.window_id, { visual: Boolean(shot) });
    let visuals: Visuals | undefined;
    if (shot && table.visual > 0) {
      const cache = new Map<string, Uint8Array>();
      visuals = {
        crop: (c) => {
          if (!c.shot) return undefined;
          if (!cache.has(c.id)) cache.set(c.id, cropCandidate(shot, c.shot));
          return cache.get(c.id);
        },
      };
      if (this.config.provider === 'live' && this.config.locate) {
        const normalized = normalizeScreenshot(shot);
        const locate = liveLocator(normalized.bytes, normalized, this.config.locateModel);
        visuals.locate = async (utterance, appName, context) => {
          const b = await locate(utterance, appName, context);
          const original = b && normalized.toOriginal(b);
          return original && b ? { ...original, confidence: b.confidence } : undefined;
        };
      }
    }
    return { window, table, shot, visuals };
  }

  /** Re-read the exact window and selected control; never reuse screen coordinates across a UI change. */
  private async fresh(observed: Observed, selected: TutorCandidate, signal: AbortSignal, fromBox = false): Promise<boolean> {
    const current = await this.driver.frontWindowOf(observed.window.pid, signal);
    if (!current || current.window_id !== observed.window.window_id) return false;
    const needVisual = fromBox || selected.source === 'visual';
    const next = await this.observe(undefined, signal, needVisual, current);
    if (!usable(next) || !sameNumbers(observed.table.observation.windowBounds, next.table.observation.windowBounds)) return false;
    const matches = next.table.candidates.filter(
      (c) =>
        c.id === selected.id &&
        c.label === selected.label &&
        c.role === selected.role &&
        c.subrole === selected.subrole &&
        c.state === selected.state &&
        sameNumbers(frameNumbers(c), frameNumbers(selected))
    );
    if (matches.length !== 1) return false;
    if (!fromBox) {
      if (!positiveUnknownTarget(next, matches[0])) return false;
      if (observed.table.coverage.status === 'unknown' || next.table.coverage.status === 'unknown') {
        const names = (o: Observed) =>
          o.table.candidates
            .filter((c) => c.source === 'ax')
            .map((c) => `${c.label}\0${c.role}`)
            .sort()
            .join('\n');
        if (names(observed) !== names(next)) return false;
      }
    }
    if (selected.source === 'visual') {
      const before = observed.visuals?.crop(selected);
      const after = next.visuals?.crop(matches[0]);
      if (!before || !after || !Buffer.from(before).equals(Buffer.from(after))) return false;
    } else if (fromBox && observed.shot && next.shot && selected.shot) {
      if (!patchUnchanged(observed.shot, next.shot, selected.shot)) return false;
    }
    signal.throwIfAborted();
    return true;
  }

  /** Re-read the exact window and verify the local pixel patch around a non-AX Box target did not change. */
  private async freshBoxPixel(observed: Observed, boxRect: Rect, signal: AbortSignal): Promise<boolean> {
    if (!observed.shot) return false;
    const current = await this.driver.frontWindowOf(observed.window.pid, signal);
    if (!current || current.window_id !== observed.window.window_id) return false;
    const next = await this.observe(undefined, signal, true, current);
    if (!next.shot || !sameNumbers(observed.table.observation.windowBounds, next.table.observation.windowBounds)) return false;
    if (!patchUnchanged(observed.shot, next.shot, boxRect)) return false;
    signal.throwIfAborted();
    return true;
  }

  /** Match an on-screen app whose name is explicitly mentioned in `text`. Never guesses an unmentioned app. */
  async matchOpenApp(text: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const names = await this.driver.openAppNames(signal);
      const lower = text.toLowerCase();
      for (const name of names) {
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lower)) return name;
      }
      return undefined;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  /** Latest step wins. Serialize cleanup and pointing so an older operation cannot erase a newer cursor. */
  highlight(step: string, app?: string, callerSignal?: AbortSignal, visualCue?: string): Promise<HighlightResult> {
    if (this.disposed) return Promise.reject(new Error('Tutor is closed'));
    callerSignal?.throwIfAborted();
    this.active?.abort(new Error('Superseded by a newer tutor step'));
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Tutor step deadline exceeded')), this.config.deadlineMs);
    const result = this.pending.then(() => this.run(step, app, controller.signal, visualCue));
    this.pending = result.catch(() => {});
    return result.finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      if (this.active === controller) this.active = undefined;
    });
  }

  private async run(step: string, app: string | undefined, signal: AbortSignal, visualCue?: string): Promise<HighlightResult> {
    const timingsMs: Record<string, number> = {};
    const t0 = performance.now();
    const screenshotsBefore = this.driver.screenshotRequests;
    const cursorReadsBefore = this.driver.history.filter((name) => name === 'get_agent_cursor_state').length;
    const context = inferenceContext(signal, this.config.maxRequests, this.config.concurrency);
    let observed: Observed | undefined;
    let path: 'named' | 'visual' | 'box' = 'named';
    let rounds = 0;
    let selection: SelectionDiagnostics | undefined;
    let cursorReadback: HighlightResult['cursorReadback'];

    const result = (
      ok: boolean,
      decision: HighlightResult['decision'],
      message: string,
      target?: HighlightResult['target']
    ): HighlightResult => ({
      ok,
      decision,
      message,
      target,
      revision: TUTOR_REVISION,
      cursorSession: this.driver.session,
      app: observed?.window.app_name ?? app,
      window: observed?.window.title,
      candidates: observed?.table.candidates.length ?? 0,
      screenshotRequests: this.driver.screenshotRequests - screenshotsBefore,
      cursorReadbackRequests: this.driver.history.filter((name) => name === 'get_agent_cursor_state').length - cursorReadsBefore,
      selection,
      cursorReadback,
      table: observed && {
        labelled: observed.table.labelled,
        visual: observed.table.visual,
        excluded: observed.table.excluded,
        complete: observed.table.observation.complete,
        truncated: observed.table.observation.truncated,
      },
      observation: observed && {
        ...observed.table.coverage,
        elements: observed.table.observation.elements.length,
        pid: observed.window.pid,
        windowId: observed.window.window_id,
      },
      jev: { ...context.metrics, provider: this.config.provider, rounds, path },
      timingsMs: { ...timingsMs, total: Math.round(performance.now() - t0) },
    });

    const pointAndVerify = async (point: { x: number; y: number }): Promise<void> => {
      const pointStart = performance.now();
      await this.driver.pointAt(point.x, point.y, signal);
      signal.throwIfAborted();
      timingsMs.point = Math.round(performance.now() - pointStart);
      const readbackStart = performance.now();
      const cursor = await this.driver.cursorState(signal);
      const position = cursor.position as { x?: unknown; y?: unknown } | undefined;
      if (
        cursor.enabled !== true ||
        typeof position?.x !== 'number' ||
        typeof position?.y !== 'number' ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        Math.hypot(position.x - point.x, position.y - point.y) > 0.5
      ) {
        throw new Error('Cursor target readback did not match; the cue will be cleared.');
      }
      signal.throwIfAborted();
      cursorReadback = { enabled: true, position: { x: position.x, y: position.y }, matched: true };
      timingsMs.cursorReadback = Math.round(performance.now() - readbackStart);
    };

    try {
      await this.driver.clear();
      signal.throwIfAborted();
      const targetApp = app?.trim() || this.config.defaultApp;
      if (!targetApp) {
        return result(
          false,
          'error',
          'No application specified. Specify the app name or bundle id (e.g. "FilmCraft" or "Keynote") before highlighting.'
        );
      }
      if (this.config.provider === 'live' && !process.env.TYPESAFE_API_KEY?.trim()) {
        return result(
          false,
          'unavailable',
          'TypeSafe is unavailable: configure TYPESAFE_API_KEY for the OpenCode service. Mock mode is development-only and must be selected explicitly.'
        );
      }
      observed = await this.observe(targetApp, signal);
      timingsMs.observe = Math.round(performance.now() - t0);
      if (!usable(observed)) {
        return result(
          false,
          'partial',
          `The accessibility read is still limited after one expanded read (${observed.table.coverage.reasons.join(', ')}). I cannot compare the controls reliably; try a narrower panel.`
        );
      }

      const t1 = performance.now();
      const choose = async () => {
        const o = observed!;
        const d = await decide(
          this.chooser,
          step,
          {
            app: o.window.app_name ?? app,
            window_title: o.window.title ?? '',
            ...(visualCue?.trim() ? { visual_cue: visualCue.trim() } : {}),
            controls_on_screen: o.table.candidates.length,
            coverage: o.table.coverage.status,
            coverage_note:
              'Coverage can be unknown even with zero pending nodes. Judge positive matches among the supplied controls; missing options do not prove the target is absent. Abstain if the available names do not resolve ambiguity.',
            inspect_unnamed: path === 'named' && this.config.visual && (o.table.excluded.unlabeled ?? 0) > 0,
            allow_visual_box: path === 'named' && this.config.visual && Boolean(this.boxEngine),
            scope: path === 'named' ? 'Only accessible named controls are listed.' : 'Named controls and pictured unnamed controls.',
          },
          o.table.candidates,
          this.config,
          o.visuals,
          context
        );
        rounds += d.rounds;
        selection = d.selection;
        return d;
      };

      let decision = await choose();

      // Coarse-to-Fine Tile -> Zoom Box visual fallback (preferred when Box engine is active)
      if (decision.kind === 'inspect' && this.config.visual && this.boxEngine) {
        path = 'box';
        const captureStart = performance.now();
        observed = await this.observe(app, signal, true, observed.window);
        timingsMs.visualObserve = Math.round(performance.now() - captureStart);
        if (!observed.shot || !observed.table.observation.windowBounds) {
          return result(false, 'reobserve', 'The visual fallback needs a window screenshot and bounds, but a usable capture was unavailable.');
        }
        const appName = observed.window.app_name ?? app ?? 'the app';
        const boxDecision = await locateWithBox(
          this.boxEngine,
          observed.shot,
          appName,
          step,
          observed.table.candidates,
          { visualCue, verifyBox: this.config.verifyBox },
          context
        );
        rounds++;
        selection = {
          selectedId: boxDecision.kind === 'snapped' ? boxDecision.candidate.id : boxDecision.kind === 'pixel' ? 'box:pixel' : boxDecision.kind,
          probability: boxDecision.probability,
          margin: boxDecision.probability,
          ...(selection?.companion ? { companion: selection.companion } : {}),
          box: boxDecision.diagnostics,
          alternatives: selection?.alternatives ?? [],
        };
        timingsMs.decide = Math.round(performance.now() - t1);
        signal.throwIfAborted();

        if (boxDecision.kind === 'snapped') {
          const c = boxDecision.candidate;
          const verifyStart = performance.now();
          if (!(await this.fresh(observed, c, signal, true))) {
            return result(false, 'stale', 'The window or control changed while I was looking. Ask again when it is ready; no new pointer was shown.');
          }
          timingsMs.verify = Math.round(performance.now() - verifyStart);
          await pointAndVerify(c.point);
          const name = c.label ? `"${c.label}"` : `the control under the agent cursor${c.where ? ` (${c.where})` : ''}`;
          return result(true, 'selected', `Pointing at ${name}. Click it yourself.`, {
            id: c.id,
            label: c.label,
            source: c.source === 'ax' ? 'visual' : c.source,
            probability: boxDecision.probability,
            point: c.point,
          });
        }

        if (boxDecision.kind !== 'pixel') {
          const why =
            boxDecision.kind === 'unsure'
              ? `Visual Box self-check was not confident enough to point (${boxDecision.diagnostics.reason ?? 'uncertain'}).`
              : 'Visual Box search did not find a matching control on screen. A menu or panel may need opening first.';
          return result(false, boxDecision.kind, why);
        }

        // Direct non-AX pixel target (e.g. canvas-drawn timeline clip, waveform, custom surface)
        const verifyStart = performance.now();
        if (!(await this.freshBoxPixel(observed, boxDecision.boxRect, signal))) {
          return result(false, 'stale', 'The window changed while I was locating the visual target. Ask again when it is ready; no new pointer was shown.');
        }
        timingsMs.verify = Math.round(performance.now() - verifyStart);
        const [wx, wy, ww, wh] = observed.table.observation.windowBounds;
        const point = {
          x: wx + (boxDecision.pointInShot.x / observed.shot.width) * ww,
          y: wy + (boxDecision.pointInShot.y / observed.shot.height) * wh,
        };
        await pointAndVerify(point);
        const where = whereInWindow(point, observed.table.observation.windowBounds);
        return result(
          true,
          'selected',
          `Pointing at the target under the agent cursor${where ? ` (${where})` : ''}. Click it yourself.`,
          { id: 'box:pixel', label: '', source: 'box', probability: boxDecision.probability, point }
        );
      }

      // Legacy crop-choice visual fallback (used when a custom/mock chooser is injected without a Box engine)
      if (decision.kind === 'inspect' && this.config.visual) {
        path = 'visual';
        const captureStart = performance.now();
        observed = await this.observe(app, signal, true, observed.window);
        timingsMs.visualObserve = Math.round(performance.now() - captureStart);
        if (!usable(observed)) {
          return result(
            false,
            'partial',
            'The visual fallback is still truncated or degraded after an expanded read. Please expose a smaller panel and try again.'
          );
        }
        if (!observed.visuals) {
          return result(false, 'reobserve', 'The unnamed controls need a screenshot, but a usable capture was unavailable.');
        }
        decision = await choose();
      }

      timingsMs.decide = Math.round(performance.now() - t1);
      signal.throwIfAborted();

      if (decision.kind !== 'selected') {
        if (observed.table.coverage.status === 'unknown') {
          return result(
            false,
            decision.kind,
            'The observed controls did not yield a clear selection. Accessibility coverage is unknown, so this does not establish whether the target is available.'
          );
        }
        const why =
          decision.kind === 'unsure'
            ? `No clear selection (top-option probability ${decision.probability.toFixed(2)}).`
            : 'No matching control was selected from this observation. A menu or panel may need opening first.';
        return result(false, decision.kind, why);
      }

      if (!positiveUnknownTarget(observed, decision.candidate)) {
        return result(false, 'unsure', 'With unknown accessibility coverage, I need a unique, explicitly enabled named target before pointing.');
      }

      const verifyStart = performance.now();
      if (!(await this.fresh(observed, decision.candidate, signal))) {
        return result(false, 'stale', 'The window or control changed while I was looking. Ask again when it is ready; no new pointer was shown.');
      }
      timingsMs.verify = Math.round(performance.now() - verifyStart);
      signal.throwIfAborted();

      await pointAndVerify(decision.candidate.point);
      const c = decision.candidate;
      const name = c.label ? `"${c.label}"` : `the control under the agent cursor${c.where ? ` (${c.where})` : ''}`;
      const warning = decision.probability < 0.7 ? ' This is an uncertain suggestion; check the control before clicking.' : '';
      const mock = this.config.provider === 'mock' ? '[DEVELOPMENT MOCK: word matching, not Jev] ' : '';
      return result(true, 'selected', `${mock}Pointing at ${name}. Click it yourself.${warning}`, {
        id: c.id,
        label: c.label,
        source: c.source,
        probability: decision.probability,
        point: c.point,
      });
    } catch (error) {
      const cleared = await this.driver.clear().then(() => true, () => false);
      if (signal.aborted) {
        return result(
          false,
          'cancelled',
          `Tutor step cancelled, superseded, or timed out.${cleared ? '' : ' Cursor cleanup could not be confirmed.'}`
        );
      }
      if (error instanceof InferenceBudgetError) return result(false, 'budget', error.message);
      return result(false, 'error', `Tutor error: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.active?.abort(new Error('Tutor unloaded'));
    await this.pending;
    await this.driver.close();
  }
}
