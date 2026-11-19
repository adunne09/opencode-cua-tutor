/**
 * TypeSafe Jev decision engine for tutor mode.
 *
 * Design principles (System One / "Jev does not reason"):
 * 1. Text-AX selection uses Companion Nouls + clean candidate-only Choice in ONE parallel request
 *    (no `abstain`/`reobserve`/`inspect` options stealing probability mass inside the Choice).
 *    Code owns routing with explicit thresholds over the returned probabilities.
 * 2. Visual fallback uses Coarse-to-Fine Tile -> Zoom Box (Jev 1.14+):
 *    - Pass 1: overlapping window tiles with parallel per-tile presence Nouls
 *    - Pass 2: hi-res winning tile Box + presence Noul
 *    - Pass 3: 3x zoomed crop Box + presence Noul for small targets (< 60px)
 *    - Pass 4 (optional): 3 atomic verification Nouls on a red-boxed crop to catch drifts
 *    Then exact-containment-first snapping to any small AX rect, or direct Box pixel targeting
 *    for canvas-drawn content with no AX element.
 */
import { box, choice, Image, noul, TypeSafeClient, withAssets, type Description, type Usage } from '@typesafe-ai/sdk';

import { RESERVED, type Rect, type TutorCandidate } from './candidates.js';
import { cropResize, tileGrid, tileHiRes, zoomRegionAround, type Screenshot } from './visual.js';

export const MAX_ACTIONS = 24;
// The API accepts up to 255 criteria. Named controls fit cheaply in one text-only choice.
export const MAX_TEXT_ACTIONS = 200;

export type InferenceMetrics = {
  calls: number;
  requests: number;
  imageRequests: number;
  multipartRequests: number;
  inputTokens: number;
  outputTokens: number;
  usageResponses: number;
  models: string[];
};
export type InferenceContext = { signal?: AbortSignal; metrics: InferenceMetrics; maxRequests: number; concurrency: number };
export const inferenceContext = (signal?: AbortSignal, maxRequests = 12, concurrency = 3): InferenceContext => ({
  signal,
  maxRequests,
  concurrency,
  metrics: { calls: 0, requests: 0, imageRequests: 0, multipartRequests: 0, inputTokens: 0, outputTokens: 0, usageResponses: 0, models: [] },
});
export class InferenceBudgetError extends Error {}

function reserve(context: InferenceContext) {
  context.signal?.throwIfAborted();
  if (context.metrics.calls >= context.maxRequests) {
    throw new InferenceBudgetError('Model request budget reached; narrow the step or expose a smaller panel.');
  }
  context.metrics.calls++;
}

function recordUsage(context: InferenceContext | undefined, response: { model: string; usage: Usage }) {
  if (!context) return;
  if (!context.metrics.models.includes(response.model)) context.metrics.models.push(response.model);
  context.metrics.inputTokens += response.usage.input_tokens ?? 0;
  context.metrics.outputTokens += response.usage.output_tokens ?? 0;
  if (response.usage.input_tokens !== null && response.usage.output_tokens !== null) context.metrics.usageResponses++;
}

function clientFor(context?: InferenceContext) {
  return new TypeSafeClient({
    timeout: 10_000,
    retry: { maxRetries: 0 },
    fetch: async (input, init) => {
      context?.signal?.throwIfAborted();
      if (context) {
        context.metrics.requests++;
        const headers = new Headers(init?.headers);
        if (headers.get('TypeSafe-Danger-Zone-Images') === 'true') context.metrics.imageRequests++;
        if (headers.get('Content-Type')?.startsWith('multipart/form-data')) context.metrics.multipartRequests++;
      }
      return bufferedFetch(input, init);
    },
  });
}

export type CompanionSignals = {
  exactInNamed: number;
  isHiddenSubcontrol: number;
  likelyVisualTarget: number;
};

/** 4 independent atomic Nouls run in ONE parallel Jev call (~90 ms) before screen observation. */
export type IntentSignals = {
  wantsUiPointer: number;
  isConceptualOrChat: number;
  explicitDoForMe: number;
  switchesApp: number;
  latencyMs: number;
};

export type IntentClassifier = (
  message: string,
  currentApp: string | undefined,
  signal?: AbortSignal
) => Promise<IntentSignals>;

/**
 * Live TypeSafe Jev Intent Gate (System-One pattern: 4 orthogonal atomic Nouls in one parallel
 * request, ~90 ms, zero screenshots; plain code owns the routing).
 */
export function liveIntentClassifier(model = 'jev-1.14.0'): IntentClassifier {
  return async (message, currentApp, signal) => {
    const t0 = performance.now();
    const client = new TypeSafeClient({
      timeout: 6_000,
      retry: { maxRetries: 0 },
      fetch: bufferedFetch,
    });
    const response = await client.systemOne(
      {
        model,
        state: {
          mode: 'macOS app tutor (users often type short imperatives like "mute audio track 1" or "razor tool" to ask where to click)',
          message,
          current_app: currentApp || '(none yet)',
        },
        questions: {
          wants_ui_pointer: noul(
            {
              question:
                'In this tutor mode, is `message` naming a UI control/action/setting the user wants to find or perform in the app (including terse imperatives like "mute A1" or "switch to razor tool")?',
            },
            {
              true: 'Names a UI tool, button, track, setting, or action in the app (whether phrased as a question like "where is X?" or a short command like "mute audio track 1" or "razor tool").',
              false: 'Pure conceptual/explanatory/comparison question (what/why/when), greeting, or only declaring which app they want to learn.',
            }
          ),
          is_conceptual_or_chat: noul(
            {
              question:
                'Is `message` purely a conceptual explanation/comparison question, general conversation, or just stating/switching which app they want to learn (with NO specific UI control or action to point at)?',
            },
            {
              true: 'Conceptual question (what/why/when/theory), greeting, or only naming/switching the app to learn.',
              false: 'Mentions a specific UI tool, button, control, menu, track, clip, or concrete app action.',
            }
          ),
          explicit_do_for_me: noul(
            {
              question:
                'Does `message` contain explicit delegation wording asking the AI to take over and execute clicks/actions on the user\'s behalf ("for me", "you do it", "go ahead and click it") rather than just naming an action?',
            },
            {
              true: 'Explicitly asks the AI to perform the action for them (contains phrases like "for me", "do it yourself", "can you do X for me").',
              false: 'Does not explicitly delegate execution to the AI (plain imperatives like "mute audio track 1" or "switch to razor tool" are tutor pointer requests, NOT delegation).',
            }
          ),
          switches_app: noul(
            {
              question: 'Does `message` explicitly name a specific application that is DIFFERENT from `current_app`?',
            },
            {
              true: 'Explicitly names an app different from `current_app` (or names an app when `current_app` is `(none yet)`).',
              false: 'Does not name any app, or names the same app already in `current_app`.',
            }
          ),
        },
      },
      { signal }
    );
    const val = (k: keyof typeof response.answers) => {
      const a = response.answers[k];
      return a?.type === 'noul' && Number.isFinite(a.noul) ? a.noul : 0;
    };
    return {
      wantsUiPointer: val('wants_ui_pointer'),
      isConceptualOrChat: val('is_conceptual_or_chat'),
      explicitDoForMe: val('explicit_do_for_me'),
      switchesApp: val('switches_app'),
      latencyMs: Math.round(performance.now() - t0),
    };
  };
}

export type BoxDiagnostics = {
  tile: string;
  tileProbability: number;
  boxProbability: number;
  boxConfidence: number | null;
  zoomed: boolean;
  verified?: { clickable: number; matches: number; exact: number };
  reason?: string;
};

export type Decision =
  | {
      kind: 'selected';
      candidate: TutorCandidate;
      probability: number;
      margin: number;
      runnersUp: TutorCandidate[];
    }
  | { kind: 'abstain' | 'reobserve' | 'inspect' | 'unsure'; probability: number; runnersUp: TutorCandidate[] };

type Choice = { selectedId: string; probabilities: Record<string, number>; companion?: CompanionSignals };
export type SelectionDiagnostics = {
  selectedId: string;
  probability: number;
  margin: number;
  companion?: CompanionSignals;
  box?: BoxDiagnostics;
  /** Full final-round distribution, sorted for useful uncertainty reports. */
  alternatives: { id: string; label: string; probability: number }[];
};

/** One choice option as Jev sees it. `text` always set; `label` optional short label; `image` for visual candidates. */
export type ChoiceOption = { id: string; text: string; label?: string; image?: Uint8Array };

export type Chooser = ((
  goal: string,
  observation: Record<string, unknown>,
  options: ChoiceOption[],
  screenshot?: Uint8Array,
  context?: InferenceContext
) => Promise<Choice>) & {
  /** When true, `decide()` omits reserved meta-options from text-only Choices and routes on Companion Nouls. */
  supportsCompanion?: boolean;
};

/** Finds where on the screenshot a step's control is; returns a rect in screenshot pixels. */
export type Locator = (utterance: string, app: string, context?: InferenceContext) => Promise<(Rect & { confidence: number | null }) | undefined>;

/** Pictures for unnamed controls and an optional whole-window locator. */
export type Visuals = {
  crop: (c: TutorCandidate) => Uint8Array | undefined;
  screenshot?: Uint8Array;
  locate?: Locator;
};

export type BoxHit = {
  present: number;
  box: { left: number; right: number; top: number; bottom: number };
  confidence: number | null;
};

export type BoxVerification = {
  clickable: number;
  matches: number;
  exact: number;
};

/** Primitive visual operations backed by Jev 1.14+ (or a deterministic fake in unit tests). */
export type BoxEngine = {
  screenTiles(
    app: string,
    query: string,
    tiles: { id: string; bytes: Uint8Array }[],
    context: InferenceContext
  ): Promise<Record<string, number>>;
  locateInCrop(
    app: string,
    query: string,
    cropBytes: Uint8Array,
    zoomed: boolean,
    context: InferenceContext
  ): Promise<BoxHit>;
  verifyRedBox(
    app: string,
    query: string,
    annotatedBytes: Uint8Array,
    context: InferenceContext
  ): Promise<BoxVerification>;
};

export type BoxDecision =
  | { kind: 'snapped'; candidate: TutorCandidate; boxRect: Rect; probability: number; diagnostics: BoxDiagnostics }
  | { kind: 'pixel'; boxRect: Rect; pointInShot: { x: number; y: number }; probability: number; diagnostics: BoxDiagnostics }
  | { kind: 'abstain' | 'unsure'; probability: number; diagnostics: BoxDiagnostics };

const IMAGE_HEADERS = { 'TypeSafe-Danger-Zone-Images': 'true' };

function validUnitBox(b: { left: number; right: number; top: number; bottom: number }): boolean {
  return (
    [b.left, b.right, b.top, b.bottom].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
    b.right > b.left &&
    b.bottom > b.top
  );
}

function boxToShotRect(b: { left: number; right: number; top: number; bottom: number }, region: Rect): Rect {
  return {
    x: region.x + b.left * region.w,
    y: region.y + b.top * region.h,
    w: (b.right - b.left) * region.w,
    h: (b.bottom - b.top) * region.h,
  };
}

/** Live Jev 1.14+ Box engine (overlapping tiles -> hi-res Box -> zoomed Box -> 3-Noul verification). */
export function liveBoxEngine(model = 'jev-1.14.0'): BoxEngine {
  return {
    async screenTiles(app, query, tiles, context) {
      reserve(context);
      const client = clientFor(context);
      const state: Record<string, unknown> = { app, target: query };
      const questions: Record<string, ReturnType<typeof noul>> = {};
      for (const t of tiles) {
        state[t.id] = Image.fromBase64(Buffer.from(t.bytes).toString('base64'));
        questions[`in_${t.id}`] = noul(
          `Is the exact clickable UI control, tab, icon, or canvas item for \`target\` directly visible inside \`${t.id}\`?`
        );
      }
      const response = await client.systemOne(
        { model, state: state as never, questions },
        { headers: IMAGE_HEADERS, signal: context.signal }
      );
      recordUsage(context, response);
      const scores: Record<string, number> = {};
      for (const t of tiles) {
        const a = response.answers[`in_${t.id}`];
        scores[t.id] = a?.type === 'noul' && Number.isFinite(a.noul) ? a.noul : 0;
      }
      return scores;
    },

    async locateInCrop(app, query, cropBytes, zoomed, context) {
      reserve(context);
      const client = clientFor(context);
      const view = zoomed ? 'crop' : 'tile';
      const response = await client.systemOne(
        {
          model,
          state: {
            app: zoomed ? `${app} (zoomed-in region)` : app,
            target: query,
            [view]: Image.fromBase64(Buffer.from(cropBytes).toString('base64')),
          },
          questions: {
            present: noul(
              {
                question: `Is the exact clickable UI control, icon, tab, toggle, or item for \`target\` visible inside \`${view}\`?`,
              },
              {
                true: `The exact target described in \`target\` is clearly visible in \`${view}\`.`,
                false: `The target is not visible in \`${view}\` (or only unrelated controls/different rows are shown).`,
              }
            ),
            loc: box(
              `the exact tight bounding box around the single clickable button, icon, tab, toggle, or item in \`${view}\` for \`target\``
            ),
          },
        },
        { headers: IMAGE_HEADERS, signal: context.signal }
      );
      recordUsage(context, response);
      const p = response.answers.present;
      const b = response.answers.loc;
      if (p?.type !== 'noul' || b?.type !== 'box') throw new Error('Jev returned unexpected Box/Noul answer types');
      return { present: p.noul, box: b.box, confidence: b.confidence };
    },

    async verifyRedBox(app, query, annotatedBytes, context) {
      reserve(context);
      const client = clientFor(context);
      const response = await client.systemOne(
        {
          model,
          state: {
            app: `${app} (zoomed crop with a red box drawn around a proposed target)`,
            target: query,
            annotated: Image.fromBase64(Buffer.from(annotatedBytes).toString('base64')),
          },
          questions: {
            clickable: noul(
              'In `annotated`, is the red box outlining a real clickable UI button, icon, tab, toggle, or selectable canvas item (rather than blank background or non-interactive chrome)?'
            ),
            matches: noul(
              'In `annotated`, does clicking the exact element inside the red box perform `target`?'
            ),
            exact: noul(
              'In `annotated`, is the red box accurately centered on the exact target for `target` (matching any specified row, track, or panel), rather than shifted onto a neighboring icon?'
            ),
          },
        },
        { headers: IMAGE_HEADERS, signal: context.signal }
      );
      recordUsage(context, response);
      const c = response.answers.clickable;
      const m = response.answers.matches;
      const e = response.answers.exact;
      return {
        clickable: c?.type === 'noul' ? c.noul : 0,
        matches: m?.type === 'noul' ? m.noul : 0,
        exact: e?.type === 'noul' ? e.noul : 0,
      };
    },
  };
}

/** Distance from a point to a rectangle (0 if inside). */
function distToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Exact-containment-first AX snapping for a located Box rect.
 * Only snaps to reasonably sized UI controls so canvas items (like timeline clips) are never
 * hijacked by huge surrounding panel containers.
 */
export function snapBoxToCandidate(rect: Rect, candidates: TutorCandidate[]): TutorCandidate | undefined {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const boxArea = Math.max(1, rect.w * rect.h);
  const eligible = candidates.filter((c) => {
    if (!c.shot) return false;
    const area = c.shot.w * c.shot.h;
    const smallControl = c.shot.w <= 120 && c.shot.h <= 120;
    const similarSize = area <= boxArea * 2.5 && Math.max(c.shot.w, c.shot.h) <= Math.max(rect.w, rect.h) * 2.2;
    return smallControl || similarSize;
  });

  // 1. Exact containment first — smallest area wins.
  const containing = eligible
    .filter((c) => cx >= c.shot!.x && cx <= c.shot!.x + c.shot!.w && cy >= c.shot!.y && cy <= c.shot!.y + c.shot!.h)
    .sort((a, b) => a.shot!.w * a.shot!.h - b.shot!.w * b.shot!.h);
  if (containing[0]) return containing[0];

  // 2. Otherwise, nearest small control within 10px of its border (closest border first, then center).
  const small = eligible.filter((c) => c.shot!.w <= 80 && c.shot!.h <= 80);
  const scored = small
    .map((c) => ({
      c,
      edge: distToRect(cx, cy, c.shot!),
      center: Math.hypot(c.shot!.x + c.shot!.w / 2 - cx, c.shot!.y + c.shot!.h / 2 - cy),
    }))
    .filter((x) => x.edge <= 10)
    .sort((a, b) => a.edge - b.edge || a.center - b.center);
  return scored[0]?.c;
}

/**
 * Coarse-to-Fine Tile -> Zoom Box pipeline:
 * 1. Screen overlapping tiles in parallel (skipped for small windows).
 * 2. Locate target with Box + presence Noul in the winning hi-res tile.
 * 3. If the target box is small (< 60px) in a large window, zoom 3x around it and refine Box.
 * 4. Optionally run 3 atomic verification Nouls on a red-boxed crop.
 * 5. Snap to containing/nearest small AX rect if present, else return raw Box pixel coordinates.
 */
export async function locateWithBox(
  engine: BoxEngine,
  shot: Screenshot,
  app: string,
  step: string,
  candidates: TutorCandidate[],
  opts: { visualCue?: string; verifyBox?: boolean; tileThreshold?: number; boxThreshold?: number } = {},
  context = inferenceContext()
): Promise<BoxDecision> {
  const query = opts.visualCue?.trim() ? `${step} (visual cue: ${opts.visualCue.trim()})` : step;
  const tileThreshold = opts.tileThreshold ?? 0.45;
  const boxThreshold = opts.boxThreshold ?? 0.5;
  const tiles = tileGrid(shot);

  let chosenTile = tiles[0];
  let tileProb = 1;
  if (tiles.length > 1) {
    const scores = await engine.screenTiles(
      app,
      query,
      tiles.map((t) => ({ id: t.id, bytes: t.bytes })),
      context
    );
    const ranked = tiles.map((t) => ({ t, p: scores[t.id] ?? 0 })).sort((a, b) => b.p - a.p);
    chosenTile = ranked[0].t;
    tileProb = ranked[0].p;
    if (tileProb < tileThreshold) {
      return {
        kind: 'abstain',
        probability: tileProb,
        diagnostics: { tile: chosenTile.id, tileProbability: tileProb, boxProbability: 0, boxConfidence: null, zoomed: false, reason: 'not_in_any_tile' },
      };
    }
  }

  // Pass 2: Hi-res tile Box
  const hiRes = tileHiRes(shot, chosenTile.region);
  const hit1 = await engine.locateInCrop(app, query, hiRes, false, context);
  if (hit1.present < boxThreshold || !validUnitBox(hit1.box)) {
    return {
      kind: 'abstain',
      probability: hit1.present,
      diagnostics: { tile: chosenTile.id, tileProbability: tileProb, boxProbability: hit1.present, boxConfidence: hit1.confidence, zoomed: false, reason: 'not_in_tile' },
    };
  }
  let boxRect = boxToShotRect(hit1.box, chosenTile.region);
  let boxProb = hit1.present;
  let boxConf = hit1.confidence;
  let zoomed = false;

  // Pass 3: 3x Zoom refinement for small targets in large windows
  if (Math.max(boxRect.w, boxRect.h) < 60 && Math.max(shot.width, shot.height) > 680 && context.metrics.calls < context.maxRequests) {
    const z = zoomRegionAround(shot, boxRect);
    const zoomBytes = cropResize(shot, z.region, z.width, z.height);
    const hit2 = await engine.locateInCrop(app, query, zoomBytes, true, context);
    zoomed = true;
    if (hit2.present < boxThreshold || !validUnitBox(hit2.box)) {
      return {
        kind: 'abstain',
        probability: hit2.present,
        diagnostics: { tile: chosenTile.id, tileProbability: tileProb, boxProbability: hit2.present, boxConfidence: hit2.confidence, zoomed: true, reason: 'not_in_zoom' },
      };
    }
    boxRect = boxToShotRect(hit2.box, z.region);
    boxProb = hit2.present;
    boxConf = hit2.confidence;
  }

  const diagnostics: BoxDiagnostics = {
    tile: chosenTile.id,
    tileProbability: tileProb,
    boxProbability: boxProb,
    boxConfidence: boxConf,
    zoomed,
  };

  // Pass 4: Optional 3-Noul red-box self-verification
  if (opts.verifyBox !== false && context.metrics.calls < context.maxRequests) {
    const z = zoomRegionAround(shot, boxRect);
    const annotated = cropResize(shot, z.region, z.width, z.height, boxRect);
    const v = await engine.verifyRedBox(app, query, annotated, context);
    diagnostics.verified = v;
    if (v.clickable < 0.45 || v.matches < 0.55 || v.exact < 0.45) {
      diagnostics.reason = 'verification_failed';
      return {
        kind: 'unsure',
        probability: Math.min(v.clickable, v.matches, v.exact),
        diagnostics,
      };
    }
  }

  const snapped = snapBoxToCandidate(boxRect, candidates);
  if (snapped) {
    return { kind: 'snapped', candidate: snapped, boxRect, probability: boxProb, diagnostics };
  }
  return {
    kind: 'pixel',
    boxRect,
    pointInShot: { x: boxRect.x + boxRect.w / 2, y: boxRect.y + boxRect.h / 2 },
    probability: boxProb,
    diagnostics,
  };
}

/**
 * Legacy single-shot whole-window Jev `box` question (kept for backwards compatibility).
 */
export function liveLocator(screenshot: Uint8Array, size: { width: number; height: number }, model = 'jev-1.14.0'): Locator {
  return async (utterance, app, context) => {
    const client = clientFor(context);
    const response = await client.systemOne(
      {
        model,
        state: Image.fromBase64(Buffer.from(screenshot).toString('base64')),
        questions: {
          target: box(`The single control a person should click in this ${app} window to do this: "${utterance}"`),
        },
      },
      { headers: IMAGE_HEADERS, signal: context?.signal }
    );
    recordUsage(context, response);
    const a = response.answers.target;
    if (a.type !== 'box' || (a.confidence !== null && a.confidence < 0.2)) return undefined;
    if (!validUnitBox(a.box)) return undefined;
    return {
      x: a.box.left * size.width,
      y: a.box.top * size.height,
      w: (a.box.right - a.box.left) * size.width,
      h: (a.box.bottom - a.box.top) * size.height,
      confidence: a.confidence,
    };
  };
}

/** The candidate a located rect points at: smallest one containing its centre, else nearest nearby. */
export function snapToCandidate(rect: Rect, candidates: TutorCandidate[]): TutorCandidate | undefined {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const withShot = candidates.filter((c) => c.shot);
  const containing = withShot
    .filter((c) => cx >= c.shot!.x && cx <= c.shot!.x + c.shot!.w && cy >= c.shot!.y && cy <= c.shot!.y + c.shot!.h)
    .sort((a, b) => a.shot!.w * a.shot!.h - b.shot!.w * b.shot!.h);
  if (containing[0]) return containing[0];
  const reach = Math.max(24, Math.hypot(rect.w, rect.h) / 2);
  const dist = (c: TutorCandidate) => Math.hypot(c.shot!.x + c.shot!.w / 2 - cx, c.shot!.y + c.shot!.h / 2 - cy);
  const nearest = withShot.sort((a, b) => dist(a) - dist(b))[0];
  return nearest && dist(nearest) <= reach ? nearest : undefined;
}

const INSTRUCTIONS = (utterance: string, app: string, visual: boolean, inspect: boolean) =>
  `A person is learning to use ${app} and said: "${utterance}". ` +
  'Which single on-screen control should they click next to do that themselves? ' +
  'Interpret the goal by the control’s function, not exact word overlap. A tab switches to its named view or workspace. ' +
  'A toggle button may name both actions (such as play/stop); selected=false is its current state, not a disabled control. ' +
  'Prefer a visible control that directly performs the requested step over a generic menu or container for related settings. ' +
  'Use panel names, label prefixes, native subroles and current state to distinguish controls with related functions. ' +
  (visual
    ? 'Some options are unlabeled; each of those comes with a picture of the control outlined in red, ' +
      'cropped from the window screenshot, so judge them by their icon, text and surroundings. '
    : '') +
  (inspect ? 'Choose inspect only if the requested control is likely already visible among the unnamed controls and no named option fits. Do not inspect merely because other unrelated controls have no names, or when named options are ambiguous. ' : '') +
  'Choose abstain if no listed control fits, or reobserve if the screen probably needs to change first ' +
  '(for example a menu or panel has to be opened).';

/**
 * SDK 0.7.0 acquires/releases the original response reader while draining a clone. Bun 1.2.22
 * and 1.4.4 mark some already-buffered bodies used in that path; delayed streamed bodies can
 * succeed. Avoid acquiring that original reader. This is a delivery-dependent workaround,
 * not evidence that all Bun requests fail. The SDK's timeout/abort signal covers buffering.
 */
export const bufferedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const r = await fetch(input, init);
  const buffered = new Response(await r.arrayBuffer(), { status: r.status, statusText: r.statusText, headers: r.headers });
  Object.defineProperty(buffered, 'body', { get: () => null });
  return buffered;
};

/**
 * Live TypeSafe Jev chooser.
 * - Text-only requests with clean candidate options run Companion Nouls + candidate-only Choice
 *   in ONE parallel call (controls put ONCE in `state` to avoid duplicating tokens across criteria).
 * - Visual crop requests or direct legacy callers with reserved options retain full compatibility.
 */
export function liveChooser(model?: string): Chooser {
  const fn: Chooser = async (goal, observation, options, _screenshot, context) => {
    const client = clientFor(context);
    const hasImages = options.some((o) => Boolean(o.image));
    const hasReserved = options.some((o) => RESERVED.includes(o.id as (typeof RESERVED)[number]));
    const useCompanion = !hasImages && !hasReserved && observation.companion_nouls === true;

    const criteria: Record<string, Description> = {};
    let state: Record<string, unknown>;
    let questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>>;

    if (useCompanion) {
      const controls: Record<string, string> = {};
      for (const o of options) {
        controls[o.id] = o.text;
        criteria[o.id] = o.label || o.id;
      }
      const step = typeof observation.step === 'string' && observation.step ? observation.step : goal;
      const app = typeof observation.app === 'string' && observation.app ? observation.app : 'the app';
      state = {
        app,
        window_title: observation.window_title ?? '',
        step,
        ...(typeof observation.visual_cue === 'string' && observation.visual_cue ? { visual_cue: observation.visual_cue } : {}),
        controls,
        has_unlabeled_controls: observation.inspect_unnamed === true,
      };
      questions = {
        candidate: choice(
          {
            question: 'Which control in `controls` best matches the function of `step`?',
            focus:
              'Match by function, role/subrole, and exact panel/track scope. Tabs switch views or workspaces; toggles may name both on/off actions (selected=false is current state, not disabled). Prefer direct controls over generic menus.',
          },
          criteria
        ),
        exact_in_named: noul(
          {
            question:
              'Does `controls` contain a specific visible control that directly performs `step` (matching the exact requested track, item, or panel if specified)?',
          },
          {
            true: 'A listed control in `controls` directly performs the requested action (including view/workspace tabs, toggles, switches, and toolbar buttons).',
            false:
              'No listed control directly matches — either the target is an unlabeled icon/tab or canvas item missing from `controls`, or it lives inside an unopened dialog, menu, or inactive panel.',
          }
        ),
        is_hidden_subcontrol: noul(
          {
            question:
              'Does `step` ask to adjust a deeper setting, dropdown option, or parameter that ONLY appears after opening a dialog, submenu, or inactive panel?',
          },
          {
            true: 'Asks to change a specific setting, option, or parameter inside a dialog, submenu, or inactive panel that is not currently open.',
            false: 'Asks to click a top-level workspace/view tab, toolbar button, track/row switch, or canvas item.',
          }
        ),
        likely_visual_target: noul(
          {
            question:
              'If no control in `controls` matches `step`, could the target be directly visible on screen as an unlabeled icon, header tab, switch, or canvas-drawn item?',
          },
          {
            true: 'Could be an unlabeled button/tab/switch or a canvas-drawn item visible on screen.',
            false: 'Is a deeper dialog/submenu/parameter control not drawn on the current screen.',
          }
        ),
      };
    } else {
      for (const o of options) {
        if (o.image) {
          criteria[o.id] = withAssets`${o.text}. Picture: ${Image.fromBase64(Buffer.from(o.image).toString('base64'))}`;
        } else {
          criteria[o.id] = o.text;
        }
      }
      state = { observation: JSON.stringify(observation) };
      questions = { candidate: choice(goal, criteria) };
    }

    const response = await client.systemOne(
      {
        ...(model ? { model } : {}),
        state: state as never,
        questions,
      },
      { ...(hasImages ? { headers: IMAGE_HEADERS } : {}), signal: context?.signal }
    );
    recordUsage(context, response);

    const answer = response.answers.candidate;
    if (answer?.type !== 'choice') throw new Error('Jev returned the wrong answer type');
    if (!Object.hasOwn(criteria, answer.choice)) throw new Error(`Jev selected unknown candidate ${answer.choice}`);
    const probabilities: Record<string, number> = {};
    for (const [id, p] of Object.entries(answer.probabilities)) {
      if (!Object.hasOwn(criteria, id)) throw new Error(`Jev scored unknown candidate ${id}`);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('Jev returned an invalid probability');
      probabilities[id] = p;
    }
    if (
      Object.keys(probabilities).length !== Object.keys(criteria).length ||
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.05
    ) {
      throw new Error('Jev returned an incomplete probability distribution');
    }

    let companion: CompanionSignals | undefined;
    if (useCompanion) {
      const e = response.answers.exact_in_named;
      const h = response.answers.is_hidden_subcontrol;
      const v = response.answers.likely_visual_target;
      if (e?.type === 'noul' && h?.type === 'noul' && v?.type === 'noul') {
        companion = { exactInNamed: e.noul, isHiddenSubcontrol: h.noul, likelyVisualTarget: v.noul };
      }
    }
    return { selectedId: answer.choice, probabilities, ...(companion ? { companion } : {}) };
  };
  fn.supportsCompanion = true;
  return fn;
}

/** Deterministic lexical stand-in so the pipeline runs without a TypeSafe key. Not a model. Ignores images. */
export function mockChooser(): Chooser {
  return async (goal, _observation, options) => {
    const said = goal.match(/said: "([^"]*)"/)?.[1] ?? goal;
    const tokens = new Set(said.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
    const scores: Record<string, number> = {};
    for (const { id, text } of options) {
      if (RESERVED.includes(id as (typeof RESERVED)[number])) continue;
      const words = `${id} ${text}`.toLowerCase().split(/[^a-z0-9]+/);
      scores[id] = words.filter((w) => tokens.has(w)).length;
    }
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const probabilities: Record<string, number> = {};
    for (const { id } of options) probabilities[id] = total ? (scores[id] ?? 0) / total : 0;
    if (!total) probabilities.abstain = 1;
    const selectedId = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    return { selectedId, probabilities };
  };
}

const LOCATOR_HINT = ' (a visual search of the whole window for this step pointed here)';

function optionsFor(candidates: TutorCandidate[], visuals?: Visuals, hinted?: string, inspect = false, includeReserved = true): ChoiceOption[] {
  const options: ChoiceOption[] = candidates.map((c) => {
    const image = c.source === 'visual' ? visuals?.crop(c) : undefined;
    return {
      id: c.id,
      label: c.label || c.id,
      text: c.description + (c.id === hinted ? LOCATOR_HINT : ''),
      ...(image ? { image } : {}),
    };
  });
  if (includeReserved) {
    options.push({ id: 'reobserve', text: 'The needed control is not visible yet; the screen must change first.' });
    options.push({ id: 'abstain', text: 'None of these controls fits what the person asked.' });
    if (inspect) {
      options.push({
        id: 'inspect',
        text: 'The needed control is probably one of the currently visible unnamed controls. Inspect their icons to identify it; no named control fits.',
      });
    }
  }
  return options;
}

async function round(
  chooser: Chooser,
  utterance: string,
  observation: Record<string, unknown>,
  candidates: TutorCandidate[],
  visuals?: Visuals,
  hinted?: string,
  context = inferenceContext()
) {
  reserve(context);
  const useCompanion = !visuals && chooser.supportsCompanion === true;
  const inspect = !visuals && observation.inspect_unnamed === true;
  const options = optionsFor(candidates, visuals, hinted, inspect, !useCompanion);
  const app = typeof observation.app === 'string' && observation.app ? observation.app : 'an app';
  const visual = options.some((o) => o.image);
  const obs = useCompanion ? { ...observation, step: utterance, companion_nouls: true } : observation;
  return chooser(INSTRUCTIONS(utterance, app, visual, inspect), obs, options, undefined, context);
}

export async function decide(
  chooser: Chooser,
  utterance: string,
  observation: Record<string, unknown>,
  candidates: TutorCandidate[],
  policy: { minProbability: number; minMargin: number; minExactInNamed?: number },
  visuals?: Visuals,
  context = inferenceContext()
): Promise<Decision & { rounds: number; calls: number; located?: string; selection?: SelectionDiagnostics }> {
  let rounds = 0;
  let calls = 0;
  let located: string | undefined;
  let selection: SelectionDiagnostics | undefined;
  const done = <T extends Decision>(d: T) => ({ ...d, rounds, calls, selection, ...(located ? { located } : {}) });
  if (!candidates.length) {
    if (observation.allow_visual_box === true || observation.inspect_unnamed === true) {
      return done({ kind: 'inspect', probability: 1, runnersUp: [] });
    }
    return done({ kind: 'reobserve', probability: 0, runnersUp: [] });
  }
  const app = typeof observation.app === 'string' && observation.app ? observation.app : 'the app';
  context.signal?.throwIfAborted();
  let pool = candidates;
  const cap = visuals ? MAX_ACTIONS : MAX_TEXT_ACTIONS;

  // Tournament when candidates exceed cap
  while (pool.length > cap) {
    const chunks: TutorCandidate[][] = [];
    const n = Math.ceil(pool.length / cap);
    const size = Math.ceil(pool.length / n);
    for (let i = 0; i < pool.length; i += size) chunks.push(pool.slice(i, i + size));
    rounds++;
    calls += chunks.length;
    if (context.metrics.calls + chunks.length + 1 > context.maxRequests) {
      throw new InferenceBudgetError('Too many controls for this step’s request budget; expose a smaller panel.');
    }
    const results: Awaited<ReturnType<typeof round>>[] = new Array(chunks.length);
    let nextChunk = 0;
    const controller = new AbortController();
    const batch = { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
    await Promise.all(
      Array.from({ length: Math.min(context.concurrency, chunks.length) }, async () => {
        try {
          while (nextChunk < chunks.length) {
            batch.signal.throwIfAborted();
            const i = nextChunk++;
            results[i] = await round(chooser, utterance, observation, chunks[i], visuals, undefined, batch);
          }
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      })
    );
    const next: TutorCandidate[] = [];
    results.forEach((result, i) => {
      const ranked = chunks[i]
        .map((c) => [c, result.probabilities[c.id] ?? 0] as const)
        .sort((a, b) => b[1] - a[1]);
      if (result.companion) {
        if (ranked[0] && result.companion.exactInNamed >= 0.25) next.push(ranked[0][0]);
        if (ranked[1] && ranked[1][1] > 0.25 && result.companion.exactInNamed >= 0.25) next.push(ranked[1][0]);
      } else {
        if (ranked[0] && ranked[0][1] > (result.probabilities.abstain ?? 0)) next.push(ranked[0][0]);
        if (ranked[1] && ranked[1][1] > 0.25) next.push(ranked[1][0]);
      }
    });
    pool = next;
    if (!pool.length) break;
  }

  let hit: TutorCandidate | undefined;
  if (visuals?.locate && context.metrics.calls + 2 <= context.maxRequests) {
    reserve(context);
    calls++;
    try {
      const r = await visuals.locate(utterance, app, context);
      hit = r ? snapToCandidate(r, candidates) : undefined;
    } catch {
      context.signal?.throwIfAborted();
    }
  }
  located = hit?.id;
  if (hit && !pool.includes(hit)) pool = [...pool, hit];
  if (!pool.length) {
    if (observation.allow_visual_box === true || observation.inspect_unnamed === true) {
      return done({ kind: 'inspect', probability: 1, runnersUp: [] });
    }
    return done({ kind: 'abstain', probability: 0, runnersUp: [] });
  }

  rounds++;
  calls++;
  const final = await round(chooser, utterance, observation, pool, visuals, hit?.id, context);
  context.signal?.throwIfAborted();

  const probabilityOfSelection = final.probabilities[final.selectedId] ?? 0;
  const secondOverall = Math.max(
    0,
    ...Object.entries(final.probabilities)
      .filter(([id]) => id !== final.selectedId)
      .map(([, p]) => p)
  );
  const marginOfSelection = probabilityOfSelection - secondOverall;
  selection = {
    selectedId: final.selectedId,
    probability: probabilityOfSelection,
    margin: marginOfSelection,
    ...(final.companion ? { companion: final.companion } : {}),
    alternatives: Object.entries(final.probabilities)
      .map(([id, probability]) => ({
        id,
        probability,
        label: pool.find((c) => c.id === id)?.label || id,
      }))
      .sort((a, b) => b.probability - a.probability),
  };

  const ranked = pool
    .map((c) => [c, final.probabilities[c.id] ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const runnersUp = ranked.slice(0, 3).map(([c]) => c);

  // Decomposed Companion-Noul routing (explicit decision tree in code, no reasoning stuffed into Choice)
  if (final.companion) {
    const { exactInNamed, isHiddenSubcontrol, likelyVisualTarget } = final.companion;
    const minExact = policy.minExactInNamed ?? 0.65;
    const allowVisual = observation.allow_visual_box === true || observation.inspect_unnamed === true;
    const [best] = ranked;

    if (
      best &&
      best[0].id === final.selectedId &&
      exactInNamed >= minExact &&
      probabilityOfSelection >= policy.minProbability &&
      marginOfSelection >= policy.minMargin
    ) {
      return done({
        kind: 'selected',
        candidate: best[0],
        probability: probabilityOfSelection,
        margin: marginOfSelection,
        runnersUp: runnersUp.slice(1),
      });
    }
    if (isHiddenSubcontrol >= 0.7 && exactInNamed < 0.5) {
      return done({ kind: 'reobserve', probability: isHiddenSubcontrol, runnersUp });
    }
    if (
      allowVisual &&
      isHiddenSubcontrol < 0.7 &&
      ((exactInNamed < 0.5 && (likelyVisualTarget >= 0.4 || observation.inspect_unnamed === true)) ||
        likelyVisualTarget >= 0.65)
    ) {
      return done({ kind: 'inspect', probability: Math.max(likelyVisualTarget, 1 - exactInNamed), runnersUp });
    }
    if (exactInNamed < 0.5) {
      return done({ kind: 'abstain', probability: 1 - exactInNamed, runnersUp });
    }
    return done({ kind: 'unsure', probability: Math.min(probabilityOfSelection, exactInNamed), runnersUp });
  }

  // Legacy reserved-option routing (used by mockChooser and synthetic test choosers)
  if (final.selectedId === 'inspect') {
    const p = final.probabilities.inspect ?? 0;
    const next = Math.max(0, ...Object.entries(final.probabilities).filter(([id]) => id !== 'inspect').map(([, value]) => value));
    return done({ kind: p >= policy.minProbability && p - next >= policy.minMargin ? 'inspect' : 'unsure', probability: p, runnersUp });
  }
  if (final.selectedId === 'abstain' || final.selectedId === 'reobserve') {
    return done({ kind: final.selectedId, probability: final.probabilities[final.selectedId] ?? 0, runnersUp });
  }
  const [best] = ranked;
  const probability = best?.[1] ?? 0;
  const margin = probability - secondOverall;
  if (!best || best[0].id !== final.selectedId) return done({ kind: 'unsure', probability, runnersUp });
  if (probability < policy.minProbability || margin < policy.minMargin) {
    return done({ kind: 'unsure', probability, runnersUp });
  }
  return done({ kind: 'selected', candidate: best[0], probability, margin, runnersUp: runnersUp.slice(1) });
}
