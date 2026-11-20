/**
 * Direct System-1 / System-2 Router (`cua-tutor/tutor`) for OpenCode V2.
 *
 * Architecture:
 * - The `cua-tutor` provider exposes ONE visible model in OpenCode's picker (`CUA Tutor -> Tutor`,
 *   `cua-tutor/tutor`) and ONE hidden System 2 model (`cua-tutor/system2`, cloned from the
 *   required `system2Model` plugin option).
 * - On every request for `cua-tutor/tutor`, `experimental.model.resolve` runs `decideTutorRoute`:
 *   1. Tool-result / assistant continuations -> route immediately to `cua-tutor/system2` (0 ms).
 *   2. Fresh user prompt -> ~90 ms 4-Noul Jev Intent Gate (0 screenshots):
 *      - `explicit_do_for_me` >= 0.7 -> instant point-only notice via `LanguageModelV3` (0 LLM tokens).
 *      - `is_conceptual_or_chat` >= 0.65 && `wants_ui_pointer` < 0.5 -> route to `cua-tutor/system2`
 *        for a FULL native OpenCode agent loop (`tutor_set_app`, `websearch`, `webfetch`, `tutor_highlight`, etc.).
 *      - UI pointer request when `sessionApp` is set (or explicitly named & open) -> run System 1
 *        (`Tutor.highlight`) directly:
 *          - HIT  -> serve instant pointer reply via `LanguageModelV3` (ZERO System-2 tokens).
 *          - MISS -> route to `cua-tutor/system2` with System-1 miss diagnostics injected into
 *                    `session.hook("context")` so System 2 can coach, search docs, or highlight a prerequisite.
 *      - UI pointer request when `sessionApp` is NOT set yet -> route to `cua-tutor/system2` so
 *        System 2 can call `tutor_set_app` (if an app was named) or ask which app the user wants to learn.
 * - Outside `Tutor`, `session.hook("context")` strips `tutor_set_app` and `tutor_highlight` from
 *   `event.tools` and injects zero guidance, keeping non-Tutor sessions 100% untouched.
 */
import { randomUUID } from 'node:crypto';

import type { IntentClassifier, IntentSignals } from './jev.js';
import type { HighlightResult } from './tutor.js';

export const DIRECT_PROVIDER_ID = 'cua-tutor';
export const DIRECT_MODEL_ID = 'tutor';
export const DIRECT_SYSTEM2_MODEL_ID = 'system2';
export const DIRECT_MODEL_NAME = 'Tutor';

export type DirectTutorLike = {
  highlight(step: string, app?: string, signal?: AbortSignal, visualCue?: string): Promise<HighlightResult>;
  matchOpenApp?(text: string, signal?: AbortSignal): Promise<string | undefined>;
};

export type TutorTurnState = {
  mode: 'system1' | 'system2';
  userMessageID?: string;
  pendingText?: string;
  miss?: HighlightResult;
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

const IGNORED_MESSAGE_TYPES = new Set([
  'model-switched',
  'agent-switched',
  'location-switched',
  'idle',
  'system',
  'compaction',
]);

export type SessionContextInspection = {
  /** True when the latest conversational message is an assistant/tool step (System-2 loop continuation). */
  isContinuation: boolean;
  userMessageID?: string;
  userText: string;
};

/**
 * Inspect `ctx.session.context({ sessionID })` (OpenCode V2 `SessionMessage.Info[]`) or OpenAI-style
 * messages to determine whether this request is a fresh user turn or a System-2 tool-loop continuation.
 */
export function inspectSessionMessages(messages: readonly unknown[]): SessionContextInspection {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;

    // OpenCode V2 SessionMessage shape (`type: "user" | "assistant" | ...`)
    if (typeof m.type === 'string') {
      if (IGNORED_MESSAGE_TYPES.has(m.type)) continue;
      if (m.type === 'user') {
        const text =
          typeof m.text === 'string'
            ? stripSystemReminders(m.text)
            : contentToText(m.content);
        const id = typeof m.id === 'string' ? m.id : undefined;
        return { isContinuation: false, userMessageID: id, userText: text };
      }
      // assistant / tool / synthetic / shell / skill after user => System-2 continuation
      return { isContinuation: true, userText: '' };
    }

    // OpenAI / AI SDK message shape (`role: "user" | "assistant" | "tool" | "system"`)
    if (typeof m.role === 'string') {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const id = typeof m.id === 'string' ? m.id : undefined;
        return { isContinuation: false, userMessageID: id, userText: contentToText(m.content) };
      }
      return { isContinuation: true, userText: '' };
    }
  }
  return { isContinuation: false, userText: '' };
}

/**
 * Parse optional leading `@AppName` or `@"App Name"` override from direct tutor input.
 * Plain text without `@...` uses the session's remembered app.
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
  // OpenCode's title request wraps the first user message in `<message>` tags.
  const { app, step } = parseDirectInput(raw.match(/<message>\s*([\s\S]*?)\s*<\/message>/)?.[1] ?? raw);
  const clean = step.replace(/\s+/g, ' ').trim();
  if (!clean) return app ? `${app} Tutor` : 'Tutor Session';
  const short = clean.length > 44 ? `${clean.slice(0, 43).trimEnd()}…` : clean;
  return app ? `${app}: ${short}` : short;
}

const isMissingWindowError = (r: HighlightResult) =>
  r.decision === 'error' && /has no on-screen window|no installed macOS app|Launched .* no on-screen window/i.test(r.message);

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

export function formatSystem1Success(r: HighlightResult, gateMs?: number): string {
  const headline = r.target?.label
    ? `Pointing at **"${r.target.label}"**. Click it yourself.`
    : r.message;
  const gate = typeof gateMs === 'number' ? ` · gate ${gateMs} ms` : '';
  return `${headline}\n\n<sub>${summarizeSystem1Meta(r)}${gate} · System 1 only</sub>`;
}

export type RouteDecision =
  | {
      target: 'system2';
      userMessageID?: string;
      miss?: HighlightResult;
      intent?: IntentSignals;
      sessionApp?: string;
    }
  | {
      target: 'system1';
      route: 'system1' | 'delegation' | 'no_app' | 'conceptual';
      userMessageID?: string;
      text: string;
      pointed: boolean;
      intent?: IntentSignals;
      sessionApp?: string;
    };

/**
 * Decide whether a `cua-tutor/tutor` request is handled directly by System 1 (zero LLM tokens)
 * or routed natively to `cua-tutor/system2` for a full OpenCode tool-calling System-2 loop.
 */
export async function decideTutorRoute(args: {
  messages: readonly unknown[];
  lastRoutedUserMessageID?: string;
  sessionApp?: string;
  onSessionApp?: (app: string | undefined) => void;
  tutor: DirectTutorLike;
  intentClassifier?: IntentClassifier;
  hasSystem2Model: boolean;
  signal?: AbortSignal;
}): Promise<RouteDecision> {
  const inspected = inspectSessionMessages(args.messages);
  let activeApp = args.sessionApp;
  const rememberApp = (app: string | undefined) => {
    const clean = app?.trim();
    if (!clean) return;
    activeApp = clean;
    args.onSessionApp?.(clean);
  };

  // Tool-loop continuation (or repeated resolve for a user message already routed to System 2)
  if (
    inspected.isContinuation ||
    (inspected.userMessageID && inspected.userMessageID === args.lastRoutedUserMessageID)
  ) {
    if (args.hasSystem2Model) {
      return { target: 'system2', userMessageID: inspected.userMessageID, sessionApp: activeApp };
    }
    return {
      target: 'system1',
      route: 'conceptual',
      userMessageID: inspected.userMessageID,
      text: 'System 2 is disabled.',
      pointed: false,
      sessionApp: activeApp,
    };
  }

  const { app: explicitApp, step } = parseDirectInput(inspected.userText);
  if (explicitApp) rememberApp(explicitApp);

  if (!step) {
    if (args.hasSystem2Model) {
      return { target: 'system2', userMessageID: inspected.userMessageID, sessionApp: activeApp };
    }
    return {
      target: 'system1',
      route: 'no_app',
      userMessageID: inspected.userMessageID,
      text: 'Tell me which app you want to learn or what you want to do (e.g. `I’m learning FilmCraft`).',
      pointed: false,
      sessionApp: activeApp,
    };
  }

  // Fast 4-Noul Jev Intent Gate (~90 ms, zero screenshots, zero Cua Driver calls)
  let intent: IntentSignals | undefined;
  if (args.intentClassifier) {
    try {
      intent = await args.intentClassifier(step, activeApp, args.signal);
      args.signal?.throwIfAborted();
    } catch {
      args.signal?.throwIfAborted();
    }
  }

  // Route A: Explicit delegation ("lock V1 for me", "export this for me") -> instant point-only notice
  if (intent && intent.explicitDoForMe >= 0.7) {
    return {
      target: 'system1',
      route: 'delegation',
      userMessageID: inspected.userMessageID,
      text:
        'I’m in point-only **Tutor** mode, so I won’t click or operate apps for you. ' +
        'Switch to another model in the model picker if you want me to do that for you — or ask where the control is and I’ll point right at it.\n\n' +
        `<sub>Jev intent gate (${intent.latencyMs} ms · do=${intent.explicitDoForMe.toFixed(2)}) · 0 screenshots</sub>`,
      pointed: false,
      intent,
      sessionApp: activeApp,
    };
  }

  // Route B: Conceptual / chat / app intro / research -> native System-2 OpenCode agent loop
  if (intent && intent.isConceptualOrChat >= 0.65 && intent.wantsUiPointer < 0.5) {
    if (args.hasSystem2Model) {
      return { target: 'system2', userMessageID: inspected.userMessageID, intent, sessionApp: activeApp };
    }
    return {
      target: 'system1',
      route: 'conceptual',
      userMessageID: inspected.userMessageID,
      text:
        'That looks like a conceptual question rather than a single on-screen control, and System 2 is disabled.\n\n' +
        `<sub>Jev intent gate (${intent.latencyMs} ms · conceptual=${intent.isConceptualOrChat.toFixed(2)}) · 0 screenshots</sub>`,
      pointed: false,
      intent,
      sessionApp: activeApp,
    };
  }

  // Route C: UI pointer request — check if the user explicitly named an open app in their message
  let targetApp = activeApp;
  if (!explicitApp && args.tutor.matchOpenApp && (!activeApp || (intent && intent.switchesApp >= 0.7))) {
    const matched = await args.tutor.matchOpenApp(step, args.signal);
    args.signal?.throwIfAborted();
    if (matched) {
      rememberApp(matched);
      targetApp = matched;
    }
  }

  // Hard gate: no app set for this session yet -> let System 2 call `tutor_set_app` (or ask the user)
  if (!targetApp) {
    if (args.hasSystem2Model) {
      return { target: 'system2', userMessageID: inspected.userMessageID, intent, sessionApp: activeApp };
    }
    const gateNote = intent ? `\n\n<sub>Jev intent gate (${intent.latencyMs} ms) · 0 screenshots</sub>` : '';
    return {
      target: 'system1',
      route: 'no_app',
      userMessageID: inspected.userMessageID,
      text:
        'No app is selected for this session yet. Tell me which app you’re working in ' +
        '(e.g. `I’m learning FilmCraft` or `@FilmCraft switch to the razor tool`), and I’ll remember it for the rest of the session.' +
        gateNote,
      pointed: false,
      intent,
      sessionApp: activeApp,
    };
  }

  // Run System 1 directly (zero System-2 tokens on hit)
  const s1 = await args.tutor.highlight(step, targetApp, args.signal);
  args.signal?.throwIfAborted();

  if (s1.ok) {
    if (s1.app) rememberApp(s1.app);
    return {
      target: 'system1',
      route: 'system1',
      userMessageID: inspected.userMessageID,
      text: formatSystem1Success(s1, intent?.latencyMs),
      pointed: true,
      intent,
      sessionApp: activeApp,
    };
  }

  if (args.hasSystem2Model && shouldEscalateToSystem2(s1)) {
    return {
      target: 'system2',
      userMessageID: inspected.userMessageID,
      miss: s1,
      intent,
      sessionApp: activeApp,
    };
  }

  return {
    target: 'system1',
    route: 'system1',
    userMessageID: inspected.userMessageID,
    text: `${s1.message}\n\n<sub>${summarizeSystem1Meta(s1)} · ${s1.decision ?? 'no match'}</sub>`,
    pointed: false,
    intent,
    sessionApp: activeApp,
  };
}

/**
 * Dynamic Tutor system instructions injected ONLY into `Tutor` (`cua-tutor/tutor`) System-2 turns.
 * Never injected into non-Tutor models.
 */
export function buildTutorGuidance(args: {
  sessionApp?: string;
  autoLaunch: boolean;
  miss?: HighlightResult;
}): string {
  const lines = [
    'You are in **Tutor** mode (`cua-tutor/tutor`). The user is LEARNING to use macOS apps and wants to do all clicking themselves.',
    `- Current tutor app for this session: ${args.sessionApp ? `**${args.sessionApp}**` : '**(none yet)**'}.`,
    '- **Hard gate on `tutor_set_app`:** `tutor_highlight` CANNOT run until an application has been set for this session via `tutor_set_app`.',
    `  - Whenever the user tells you which app they want to learn or explicitly switches to another app, call \`tutor_set_app({ app })\` first.${args.autoLaunch ? ' It validates against installed macOS apps and automatically launches the app if it is not open yet.' : ''}`,
    '  - Do NOT call `tutor_set_app` just because the user mentions another app in a comparison or background remark (e.g. "How does this compare to Premiere Pro?" or "I used to use Resolve").',
    '  - Never guess an app from open windows. If no app is set yet and the user has not named one, ask them which app they want to work in.',
    '- **Pointing (`tutor_highlight`):** Once the app is set, call `tutor_highlight` with ONE concrete currently-visible step at a time (and an optional concrete `visualCue` for unlabeled icons or canvas elements). It moves an on-screen pointer and NEVER clicks. Then tell the user in 1–2 short sentences what to click and why, and wait for them to click it.',
    '- **Learning & research:** You may freely use OpenCode’s normal read/research tools (such as `websearch`, `webfetch`, `read`) to answer conceptual questions, look up shortcuts/docs, or check how a feature works.',
    '- **Point-only boundary:** NEVER click, type, edit files, or operate the target app on the user’s behalf. If they want automation, tell them to switch away from Tutor to a full model.',
  ];

  if (args.miss) {
    const r = args.miss;
    const visibleControls = (r.selection?.alternatives ?? [])
      .map((a) => a.label)
      .filter((l) => l && !['abstain', 'reobserve', 'inspect'].includes(l))
      .slice(0, 25);
    const comp = r.selection?.companion;
    lines.push(
      '',
      '[System-1 pre-check on this turn — do NOT repeat the exact same failing step without changing it]',
      `- App: ${r.app ?? args.sessionApp ?? '(unknown)'}${r.window ? ` (window: "${r.window}")` : ''}`,
      `- Outcome: ${r.decision ?? 'miss'} — ${r.message}`,
      ...(comp
        ? [
            `- Signals: exact_in_named=${comp.exactInNamed.toFixed(2)}, is_hidden_subcontrol=${comp.isHiddenSubcontrol.toFixed(2)}, likely_visual_target=${comp.likelyVisualTarget.toFixed(2)}`,
          ]
        : []),
      ...(visibleControls.length
        ? [`- Currently visible named controls: ${visibleControls.map((c) => JSON.stringify(c)).join(', ')}`]
        : []),
      '- If the requested control is hidden behind a currently-visible menu, tab, or panel, explain that briefly and call `tutor_highlight` on that visible prerequisite control instead.'
    );
  }

  return lines.join('\n');
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

function extractLastOpenAiUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (m?.role !== 'user') continue;
    const text = contentToText(m.content);
    if (text) return text;
  }
  return '';
}

export type ReplyServer = {
  baseURL: string;
  token: string;
  port: number;
  close(): void;
};

/**
 * Tiny authenticated `127.0.0.1` OpenAI-compatible SSE emitter backing `cua-tutor/tutor`
 * for zero-LLM System-1 responses (used because OpenCode's native `@opencode/ai/providers/openai-compatible`
 * runs natively over HTTP rather than `@ai-sdk` language hooks).
 */
export function startReplyServer(args: {
  consumePendingText: (sessionID: string) => string | undefined;
}): ReplyServer {
  const token = randomUUID();
  const encoder = new TextEncoder();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 120,
    async fetch(req) {
      if (req.headers.get('x-tutor-token') !== token) {
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

      const sessionID = req.headers.get('x-tutor-session-id') || '';
      const kind = req.headers.get('x-tutor-kind') || 'primary';
      const model = typeof body.model === 'string' && body.model ? body.model : DIRECT_MODEL_ID;
      const streamRequested = body.stream !== false;
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      let text: string;
      if (kind === 'title') {
        text = makeDirectTitle(extractLastOpenAiUserText(body.messages));
      } else if (kind === 'compaction') {
        const last = extractLastOpenAiUserText(body.messages);
        text = last ? `Tutor session checkpoint: ${last.slice(0, 200)}` : 'Tutor session summary.';
      } else {
        text =
          (sessionID ? args.consumePendingText(sessionID) : undefined) ??
          'Tell me which app you want to learn or ask where a control is, and I will point right at it.';
      }

      const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (!streamRequested) {
        return Response.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: zeroUsage,
        });
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseChunk(id, created, model, { role: 'assistant', content: '' }, null)));
          if (text) controller.enqueue(encoder.encode(sseChunk(id, created, model, { content: text }, null)));
          controller.enqueue(encoder.encode(sseChunk(id, created, model, {}, 'stop', zeroUsage)));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
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
    close: () => {
      server.stop(true);
    },
  };
}
