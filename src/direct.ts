/**
 * Direct System-1 virtual chat model (`cua-tutor/tutor`, displayed as "Tutor") for OpenCode.
 *
 * Pipeline (System-One / atomic Noul architecture):
 * 1. Fast Jev Intent Gate (~90 ms, 4 orthogonal atomic Nouls in ONE parallel request, zero
 *    screenshots, zero Cua Driver call):
 *    - `explicit_do_for_me` >= 0.7 -> instant point-only notice (switch to a full model to act).
 *    - `is_conceptual_or_chat` >= 0.65 && `wants_ui_pointer` < 0.5 -> skip screen observation
 *      entirely and route straight to System-2 fallback (`opencode-go/glm-5.3-flash#high`), which
 *      answers AND remembers the app if the user named/switched the app they are learning.
 *    - Otherwise -> System 1 (`Tutor.highlight`) using the session's remembered app (or matching an
 *      explicitly named open app when `switches_app` >= 0.7, or frontmost non-ignored app).
 * 2. When System 1 succeeds -> immediate cursor pointer + concise reply (ZERO System-2 inference).
 * 3. When System 1 misses (`reobserve`, `abstain`, `unsure`, `partial`, or no open app window) ->
 *    escalate ONLY that turn to System-2 fallback (`opencode-go/glm-5.3-flash#high`), optionally
 *    highlighting any concrete visible prerequisite `next_step` it identifies.
 * 4. Session-scoped app memory remembers the app you are learning across turns without requiring
 *    you to repeat it.
 */
import { randomUUID } from 'node:crypto';

import { formatModelRef, type ModelRef } from './config.js';
import type { IntentClassifier, IntentSignals } from './jev.js';
import type { HighlightResult } from './tutor.js';

export const DIRECT_PROVIDER_ID = 'cua-tutor';
export const DIRECT_MODEL_ID = 'tutor';
export const DIRECT_MODEL_NAME = 'Tutor';

export type ChatMessage = {
  role: string;
  content?: unknown;
};

export type DirectTutorLike = {
  highlight(step: string, app?: string, signal?: AbortSignal, visualCue?: string): Promise<HighlightResult>;
  matchOpenApp?(text: string, signal?: AbortSignal): Promise<string | undefined>;
};

export type FallbackGenerator = (prompt: string, signal?: AbortSignal) => Promise<string>;

export type FallbackPlan = {
  reply: string;
  nextStep?: string;
  visualCue?: string;
  app?: string;
};

/** Remove harness `<system-reminder>` blocks so only user-authored text reaches Jev. */
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return stripSystemReminders(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const t = (part as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return stripSystemReminders(parts.join('\n'));
  }
  return '';
}

/** Extract the latest user utterance from an OpenAI Chat Completions `messages` array. */
export function extractLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as ChatMessage | undefined;
    if (msg?.role !== 'user') continue;
    const text = contentToText(msg.content);
    if (text) return text;
  }
  return '';
}

/** Compact recent conversation turns (excluding system messages) for System-2 fallback context. */
export function extractRecentHistory(messages: unknown, maxTurns = 6): { role: string; text: string }[] {
  if (!Array.isArray(messages)) return [];
  const turns: { role: string; text: string }[] = [];
  for (const raw of messages) {
    const msg = raw as ChatMessage | undefined;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = contentToText(msg.content);
    if (!text) continue;
    turns.push({ role: msg.role, text: text.length > 400 ? `${text.slice(0, 400)}…` : text });
  }
  return turns.slice(-maxTurns);
}

/**
 * Parse optional leading `@AppName` or `@"App Name"` override from direct tutor input.
 * Plain text without `@...` uses the session's remembered app or the frontmost non-ignored app.
 */
export function parseDirectInput(raw: string): { app?: string; step: string } {
  const text = stripSystemReminders(raw).trim();
  const quoted = text.match(/^@"([^"]+)"\s+([\s\S]+)$/);
  if (quoted) return { app: quoted[1].trim(), step: quoted[2].trim() };
  const single = text.match(/^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/);
  if (single) return { app: single[1].trim(), step: single[2].trim() };
  return { step: text };
}

/** Generate a short instant session title without invoking any LLM. */
export function makeDirectTitle(raw: string): string {
  const { app, step } = parseDirectInput(raw);
  const clean = step.replace(/\s+/g, ' ').trim();
  if (!clean) return app ? `${app} Tutor` : 'Tutor Session';
  const short = clean.length > 44 ? `${clean.slice(0, 43).trimEnd()}…` : clean;
  return app ? `${app}: ${short}` : short;
}

const isMissingWindowError = (r: HighlightResult) =>
  r.decision === 'error' && /has no on-screen window|No other on-screen app window/i.test(r.message);

/** Escalate only when System 1 could not map the request to a visible single control. */
export function shouldEscalateToSystem2(result: HighlightResult): boolean {
  if (result.ok) return false;
  return (
    result.decision === 'reobserve' ||
    result.decision === 'abstain' ||
    result.decision === 'unsure' ||
    result.decision === 'partial' ||
    isMissingWindowError(result)
  );
}

function summarizeSystem1Meta(r: HighlightResult): string {
  const parts: string[] = [];
  if (r.app) parts.push(r.app);
  const pathLabel =
    r.jev?.path === 'box'
      ? `Box${r.selection?.box?.tile ? ` (${r.selection.box.tile})` : ''}`
      : r.jev?.path === 'visual'
        ? 'visual AX'
        : 'named AX';
  parts.push(pathLabel);
  if (typeof r.timingsMs.total === 'number') parts.push(`${r.timingsMs.total} ms`);
  if (r.screenshotRequests === 0) parts.push('0 screenshots');
  else parts.push(`${r.screenshotRequests} ${r.screenshotRequests === 1 ? 'screenshot' : 'screenshots'}`);
  return parts.join(' · ');
}

function formatSystem1Success(r: HighlightResult, gateMs?: number): string {
  const headline = r.target?.label
    ? `Pointing at **"${r.target.label}"**. Click it yourself.`
    : r.message;
  const gate = typeof gateMs === 'number' ? ` · gate ${gateMs} ms` : '';
  return `${headline}\n\n<sub>${summarizeSystem1Meta(r)}${gate} · System 1 only</sub>`;
}

export function buildConceptualPrompt(args: {
  message: string;
  sessionApp?: string;
  history: { role: string; text: string }[];
}): string {
  const { message, sessionApp, history } = args;
  const prior = history.slice(0, -1);
  return [
    'You are the conversational coach inside OpenCode CUA Tutor on macOS.',
    'The user is learning software and wants to do all clicking themselves — NEVER claim you clicked anything or ran tools.',
    '',
    `User message: ${JSON.stringify(message)}`,
    `Remembered app for this session: ${sessionApp ?? '(none yet)'}`,
    ...(prior.length
      ? ['Recent session context:', ...prior.map((t) => `- ${t.role}: ${t.text}`)]
      : []),
    '',
    'Respond with ONLY a single JSON object (no markdown fences, no extra text):',
    '{',
    '  "reply": "Clear, concise, friendly answer (1-4 short sentences). If the user is introducing which app they want to learn, acknowledge it and invite them to ask where any control is or any concept question.",',
    '  "app": "If the user explicitly named or switched the macOS app they want to learn (e.g. \\"FilmCraft\\", \\"Keynote\\", \\"Blender\\"), put that app name here so the tutor remembers it for the rest of the session; otherwise null.",',
    '  "next_step": null,',
    '  "visual_cue": null',
    '}',
  ].join('\n');
}

export function buildFallbackPrompt(args: {
  step: string;
  app?: string;
  result: HighlightResult;
  history: { role: string; text: string }[];
}): string {
  const { step, app, result, history } = args;
  const visibleControls = (result.selection?.alternatives ?? [])
    .map((a) => a.label)
    .filter((l) => l && !['abstain', 'reobserve', 'inspect'].includes(l))
    .slice(0, 30);

  const comp = result.selection?.companion;
  const prior = history.slice(0, -1);

  return [
    'You are the System-2 fallback coach inside OpenCode CUA Tutor.',
    'The user is LEARNING to use an app on macOS and wants to do all clicking themselves — NEVER claim you clicked anything.',
    'System 1 (Jev) already tried to highlight a single currently-visible control and did NOT point.',
    '',
    `User request: ${JSON.stringify(step)}`,
    `Detected/remembered app: ${result.app ?? app ?? '(unknown)'}`,
    ...(result.window ? [`Window title: ${result.window}`] : []),
    `System-1 outcome: ${result.decision ?? 'unknown'} — ${result.message}`,
    ...(comp
      ? [
          `System-1 signals: exact_in_named=${comp.exactInNamed.toFixed(2)}, is_hidden_subcontrol=${comp.isHiddenSubcontrol.toFixed(2)}, likely_visual_target=${comp.likelyVisualTarget.toFixed(2)}`,
        ]
      : []),
    ...(visibleControls.length
      ? [`Top currently visible named controls: ${visibleControls.map((c) => JSON.stringify(c)).join(', ')}`]
      : []),
    ...(prior.length
      ? ['Recent session context:', ...prior.map((t) => `- ${t.role}: ${t.text}`)]
      : []),
    '',
    'Respond with ONLY a single JSON object (no markdown fences, no extra text):',
    '{',
    '  "reply": "1-3 short, clear sentences telling the user what to click next (and why) or answering their question.",',
    '  "next_step": "ONE concrete control/tab/menu/button that is CURRENTLY visible on screen for them to click first so we can highlight it now, or null if purely conceptual, the app is closed, or nothing concrete is visible.",',
    '  "visual_cue": "Optional short visual description of an unlabeled icon/canvas target (e.g. \\"Export tab in top-left header\\"), or null.",',
    '  "app": "If the user explicitly named a specific macOS app to work in, put its exact name here; otherwise null."',
    '}',
  ].join('\n');
}

/** Parse structured JSON from the System-2 fallback model, degrading cleanly to plain prose. */
export function parseFallbackJson(raw: string): FallbackPlan {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '';
      const nextStep = typeof parsed.next_step === 'string' && parsed.next_step.trim() ? parsed.next_step.trim() : undefined;
      const visualCue = typeof parsed.visual_cue === 'string' && parsed.visual_cue.trim() ? parsed.visual_cue.trim() : undefined;
      const app = typeof parsed.app === 'string' && parsed.app.trim() ? parsed.app.trim() : undefined;
      if (reply) return { reply, nextStep, visualCue, app };
    } catch {
      // Fall through to plain text reply
    }
  }
  return { reply: trimmed || 'I could not find a matching control on screen. Try opening the relevant menu or panel first.' };
}

export type DirectTurnOutcome = {
  text: string;
  route: 'system1' | 'conceptual' | 'delegation' | 'fallback';
  escalated: boolean;
  pointed: boolean;
  sessionApp?: string;
};

export async function handleDirectTurn(args: {
  rawUserText: string;
  history: { role: string; text: string }[];
  tutor: DirectTutorLike;
  sessionApp?: string;
  onSessionApp?: (app: string | undefined) => void;
  intentClassifier?: IntentClassifier;
  fallback?: FallbackGenerator;
  fallbackModel?: ModelRef;
  signal?: AbortSignal;
}): Promise<DirectTurnOutcome> {
  const { app: explicitApp, step } = parseDirectInput(args.rawUserText);
  let activeApp = explicitApp ?? args.sessionApp;
  const rememberApp = (app: string | undefined) => {
    const clean = app?.trim();
    if (!clean) return;
    activeApp = clean;
    args.onSessionApp?.(clean);
  };
  if (explicitApp) rememberApp(explicitApp);

  if (!step) {
    return {
      text: 'Tell me what app you want to learn or what you want to do (e.g. `switch to the razor tool` or `what is a J-cut?`).',
      route: 'conceptual',
      escalated: false,
      pointed: false,
      sessionApp: activeApp,
    };
  }

  const modelLabel = args.fallbackModel ? formatModelRef(args.fallbackModel) : 'System 2';

  // Step 1: Fast atomic 4-Noul Jev Intent Gate (~90 ms, zero screenshots, zero Cua Driver calls)
  let intent: IntentSignals | undefined;
  if (args.intentClassifier) {
    try {
      intent = await args.intentClassifier(step, activeApp, args.signal);
      args.signal?.throwIfAborted();
    } catch (error) {
      args.signal?.throwIfAborted();
      // If the intent gate fails transiently, fall through safely to System 1 highlight.
      void error;
    }
  }

  // Route A: Explicit delegation ("lock V1 for me", "export this for me") -> instant point-only notice
  if (intent && intent.explicitDoForMe >= 0.7) {
    return {
      text:
        'I’m in point-only **Tutor** mode, so I won’t click or operate apps for you. ' +
        'Switch to a full model in the model picker if you want me to do that for you — or ask where the control is and I’ll point right at it.\n\n' +
        `<sub>Jev intent gate (${intent.latencyMs} ms · do=${intent.explicitDoForMe.toFixed(2)}) · 0 screenshots</sub>`,
      route: 'delegation',
      escalated: false,
      pointed: false,
      sessionApp: activeApp,
    };
  }

  // Route B: Pure conceptual question / chat / introducing which app to learn -> skip Cua Driver & Box completely!
  if (intent && intent.isConceptualOrChat >= 0.65 && intent.wantsUiPointer < 0.5) {
    if (!args.fallback) {
      return {
        text:
          'That looks like a conceptual question rather than a single on-screen control, and System-2 fallback is disabled.\n\n' +
          `<sub>Jev intent gate (${intent.latencyMs} ms · conceptual=${intent.isConceptualOrChat.toFixed(2)}) · 0 screenshots</sub>`,
        route: 'conceptual',
        escalated: false,
        pointed: false,
        sessionApp: activeApp,
      };
    }
    const t2 = performance.now();
    try {
      const raw = await args.fallback(
        buildConceptualPrompt({ message: step, sessionApp: activeApp, history: args.history }),
        args.signal
      );
      args.signal?.throwIfAborted();
      const plan = parseFallbackJson(raw);
      if (plan.app) rememberApp(plan.app);
      const s2Ms = Math.round(performance.now() - t2);
      const appTag = activeApp ? ` · app: ${activeApp}` : '';
      return {
        text:
          `${plan.reply}\n\n` +
          `<sub>Jev intent gate (${intent.latencyMs} ms, 0 screenshots) → ${modelLabel} (${s2Ms} ms)${appTag}</sub>`,
        route: 'conceptual',
        escalated: true,
        pointed: false,
        sessionApp: activeApp,
      };
    } catch (error) {
      args.signal?.throwIfAborted();
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        text: `System-2 fallback \`${modelLabel}\` failed: ${errMsg}`,
        route: 'conceptual',
        escalated: true,
        pointed: false,
        sessionApp: activeApp,
      };
    }
  }

  // Route C: UI pointer request — if the user naturally named a different open app (e.g. "in Keynote, add a slide"),
  // match it against open macOS windows locally (~15 ms) without needing `@App` or System 2.
  let targetApp = activeApp;
  let usedRememberedApp = !explicitApp && Boolean(args.sessionApp);
  if (!explicitApp && intent && intent.switchesApp >= 0.7 && args.tutor.matchOpenApp) {
    const matched = await args.tutor.matchOpenApp(step, args.signal);
    args.signal?.throwIfAborted();
    if (matched) {
      rememberApp(matched);
      targetApp = matched;
      usedRememberedApp = false;
    }
  }

  let s1 = await args.tutor.highlight(step, targetApp, args.signal);
  args.signal?.throwIfAborted();

  // If the remembered sessionApp was closed since an earlier turn, recover seamlessly to frontmost non-ignored app.
  if (!s1.ok && usedRememberedApp && isMissingWindowError(s1)) {
    args.onSessionApp?.(undefined);
    activeApp = undefined;
    s1 = await args.tutor.highlight(step, undefined, args.signal);
    args.signal?.throwIfAborted();
  }

  if (s1.ok) {
    if (s1.app) rememberApp(s1.app);
    return {
      text: formatSystem1Success(s1, intent?.latencyMs),
      route: 'system1',
      escalated: false,
      pointed: true,
      sessionApp: activeApp,
    };
  }

  if (!args.fallback || !shouldEscalateToSystem2(s1)) {
    return {
      text: `${s1.message}\n\n<sub>${summarizeSystem1Meta(s1)} · ${s1.decision ?? 'no match'}</sub>`,
      route: 'system1',
      escalated: false,
      pointed: false,
      sessionApp: activeApp,
    };
  }

  // System-1 miss (`reobserve`, `abstain`, `unsure`, `partial`, or missing window) -> System-2 fallback
  const t2 = performance.now();
  let plan: FallbackPlan;
  try {
    const raw = await args.fallback(
      buildFallbackPrompt({ step, app: targetApp, result: s1, history: args.history }),
      args.signal
    );
    args.signal?.throwIfAborted();
    plan = parseFallbackJson(raw);
    if (plan.app) rememberApp(plan.app);
  } catch (error) {
    args.signal?.throwIfAborted();
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      text:
        `${s1.message}\n\n` +
        `*(System-2 fallback \`${modelLabel}\` failed: ${errMsg})*\n\n` +
        `<sub>${summarizeSystem1Meta(s1)} · ${s1.decision ?? 'no match'}</sub>`,
      route: 'fallback',
      escalated: true,
      pointed: false,
      sessionApp: activeApp,
    };
  }
  const s2Ms = Math.round(performance.now() - t2);

  // If System 2 proposed a concrete visible prerequisite step (e.g. "switch to the Export workspace"),
  // run System 1 once more to point the agent cursor directly at it.
  let pointed = false;
  let followNote = '';
  const nextStep = plan.nextStep?.trim();
  const shouldRetryHighlight =
    Boolean(nextStep) &&
    !isMissingWindowError(s1) &&
    (nextStep!.toLowerCase() !== step.toLowerCase() || Boolean(plan.visualCue));

  if (shouldRetryHighlight && nextStep) {
    const s1b = await args.tutor.highlight(nextStep, targetApp ?? plan.app ?? s1.app, args.signal, plan.visualCue);
    args.signal?.throwIfAborted();
    if (s1b.ok) {
      if (s1b.app) rememberApp(s1b.app);
      pointed = true;
      const targetNote = s1b.target?.label ? `Pointing at **"${s1b.target.label}"**` : 'Pointer placed on target';
      followNote = `\n\n${targetNote} (${summarizeSystem1Meta(s1b)}).`;
    }
  }

  const gateNote = intent ? `gate ${intent.latencyMs} ms + ` : '';
  return {
    text:
      `${plan.reply}${followNote}\n\n` +
      `<sub>System 1 (${gateNote}${s1.decision ?? 'miss'}, ${s1.timingsMs.total ?? '-'} ms) → System 2 fallback (${modelLabel}, ${s2Ms} ms)</sub>`,
    route: 'fallback',
    escalated: true,
    pointed,
    sessionApp: activeApp,
  };
}

function sseChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, number>
): string {
  const payload: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export type DirectServer = {
  baseURL: string;
  token: string;
  port: number;
  sessionApps: Map<string, string>;
  close(): void;
};

/**
 * Ephemeral loopback OpenAI-compatible Chat Completions endpoint backing the `Tutor` virtual model.
 * Bound strictly to `127.0.0.1` and authenticated with a per-process Bearer secret.
 */
export function startDirectServer(args: {
  getTutor: (sessionID: string) => DirectTutorLike;
  defaultApp?: string;
  intentClassifier?: IntentClassifier;
  fallback?: FallbackGenerator;
  fallbackModel?: ModelRef;
}): DirectServer {
  const token = randomUUID();
  const encoder = new TextEncoder();
  const sessionApps = new Map<string, string>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 120,
    async fetch(req) {
      const auth = req.headers.get('authorization');
      if (auth !== `Bearer ${token}`) {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }

      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: DIRECT_MODEL_ID, object: 'model', owned_by: DIRECT_PROVIDER_ID }],
        });
      }

      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        return new Response('Not Found', { status: 404 });
      }

      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      const sessionID = req.headers.get('x-tutor-session-id') || 'direct-default';
      const kind = req.headers.get('x-tutor-kind') || 'primary';
      const model = typeof body.model === 'string' && body.model ? body.model : DIRECT_MODEL_ID;
      const streamRequested = body.stream !== false;
      const rawUserText = extractLastUserText(body.messages);
      const history = extractRecentHistory(body.messages);
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      const produceText = async (signal?: AbortSignal): Promise<string> => {
        if (kind === 'title') return makeDirectTitle(rawUserText);
        if (kind === 'compaction') {
          const recent = history
            .filter((t) => t.role === 'user')
            .slice(-5)
            .map((t) => `- ${t.text}`)
            .join('\n');
          return recent ? `Tutor session steps:\n${recent}` : 'Tutor session summary.';
        }
        const tutor = args.getTutor(sessionID);
        const turn = await handleDirectTurn({
          rawUserText,
          history,
          tutor,
          sessionApp: sessionApps.get(sessionID) ?? args.defaultApp,
          onSessionApp: (app) => {
            if (app) sessionApps.set(sessionID, app);
            else sessionApps.delete(sessionID);
          },
          intentClassifier: args.intentClassifier,
          fallback: args.fallback,
          fallbackModel: args.fallbackModel,
          signal,
        });
        return turn.text;
      };

      if (!streamRequested) {
        try {
          const content = await produceText(req.signal);
          return Response.json({
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(JSON.stringify({ error: { message } }), {
            status: req.signal.aborted ? 499 : 500,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      const abortController = new AbortController();
      const onReqAbort = () => abortController.abort(req.signal.reason);
      req.signal.addEventListener('abort', onReqAbort, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(sseChunk(id, created, model, { role: 'assistant', content: '' }, null)));
            const text = await produceText(abortController.signal);
            if (abortController.signal.aborted) return;
            controller.enqueue(encoder.encode(sseChunk(id, created, model, { content: text }, null)));
            controller.enqueue(
              encoder.encode(
                sseChunk(id, created, model, {}, 'stop', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (error) {
            if (abortController.signal.aborted) {
              try {
                controller.close();
              } catch {}
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            try {
              controller.enqueue(encoder.encode(sseChunk(id, created, model, { content: `Tutor error: ${message}` }, null)));
              controller.enqueue(
                encoder.encode(
                  sseChunk(id, created, model, {}, 'stop', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch {}
          } finally {
            req.signal.removeEventListener('abort', onReqAbort);
          }
        },
        cancel() {
          abortController.abort(new Error('Stream cancelled'));
          req.signal.removeEventListener('abort', onReqAbort);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    },
  });

  const port = server.port ?? 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    token,
    port,
    sessionApps,
    close: () => {
      server.stop(true);
    },
  };
}
