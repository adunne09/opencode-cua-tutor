import { describe, expect, test } from 'bun:test';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import { assertFallbackModelConfigured, formatModelRef, loadConfig, parseModelRef } from '../src/config.js';
import {
  buildTutorGuidance,
  decideTutorRoute,
  inspectSessionMessages,
  makeDirectTitle,
  parseDirectInput,
  shouldEscalateToSystem2,
  startReplyServer,
  type DirectTutorLike,
} from '../src/direct.js';
import { liveIntentClassifier, type IntentSignals } from '../src/jev.js';
import { TUTOR_REVISION, type HighlightResult } from '../src/tutor.js';

function fakeResult(overrides: Partial<HighlightResult> = {}): HighlightResult {
  return {
    ok: true,
    decision: 'selected',
    message: 'Pointing at "Razor Tool". Click it yourself.',
    revision: TUTOR_REVISION,
    cursorSession: 'cua-tutor',
    app: 'FilmCraft',
    window: 'Demo Project',
    target: { id: 'ax:razor', label: 'Razor Tool', source: 'ax', probability: 0.99, point: { x: 979, y: 863 } },
    candidates: 24,
    screenshotRequests: 0,
    cursorReadbackRequests: 1,
    jev: {
      calls: 1,
      requests: 1,
      imageRequests: 0,
      multipartRequests: 0,
      inputTokens: 320,
      outputTokens: 12,
      usageResponses: 1,
      models: ['jev-1.14.0'],
      provider: 'live',
      rounds: 1,
      path: 'named',
    },
    timingsMs: { observe: 80, decide: 180, verify: 60, total: 340 },
    ...overrides,
  };
}

describe('Direct Tutor config and message inspection', () => {
  test('defaults directModel=true, autoLaunch=true, declareMcp=false, and requires an explicit fallbackModel', () => {
    const def = loadConfig({}, {});
    expect(def.directModel).toBe(true);
    expect(def.autoLaunch).toBe(true);
    expect(def.declareMcp).toBe(false);
    expect(def.fallbackModel).toBeUndefined();
    expect(() => assertFallbackModelConfigured({}, {})).toThrow(/fallbackModel/);
    expect(() => assertFallbackModelConfigured({ fallbackModel: 'opencode-go/glm-5.3-flash#high' }, {})).not.toThrow();
    expect(() => assertFallbackModelConfigured({}, { CUA_TUTOR_FALLBACK_MODEL: 'opencode-go/glm-5.3-flash' })).not.toThrow();
    expect(() => assertFallbackModelConfigured({ fallbackModel: 'none' }, {})).not.toThrow();
    expect(() => assertFallbackModelConfigured({ fallbackModel: false }, {})).not.toThrow();

    const configured = loadConfig({ fallbackModel: 'accomplish/zai-org/GLM-5.3-Flash#high' }, {});
    expect(configured.fallbackModel).toEqual({ providerID: 'accomplish', id: 'zai-org/GLM-5.3-Flash', variant: 'high' });
    expect(formatModelRef(configured.fallbackModel!)).toBe('accomplish/zai-org/GLM-5.3-Flash#high');

    expect(loadConfig({ directModel: false }, {}).directModel).toBe(false);
    expect(loadConfig({ autoLaunch: false }, {}).autoLaunch).toBe(false);
    expect(loadConfig({ fallbackModel: 'none' }, {}).fallbackModel).toBeUndefined();
    expect(loadConfig({ fallbackModel: false }, {}).fallbackModel).toBeUndefined();
    expect(parseModelRef('anthropic/claude-sonnet-5-5#low')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-5-5',
      variant: 'low',
    });
    expect(() => parseModelRef('no-slash')).toThrow();
  });

  test('parseDirectInput, inspectSessionMessages, and makeDirectTitle handle OpenCode V2 and OpenAI messages', () => {
    expect(parseDirectInput('mute audio track 1')).toEqual({ step: 'mute audio track 1' });
    expect(parseDirectInput('@FilmCraft switch to razor tool')).toEqual({
      app: 'FilmCraft',
      step: 'switch to razor tool',
    });
    expect(parseDirectInput('@"QuickTime Player" start screen recording')).toEqual({
      app: 'QuickTime Player',
      step: 'start screen recording',
    });

    // OpenCode V2 SessionMessage.Info format (ignoring model-switched / idle markers)
    const fresh = inspectSessionMessages([
      { type: 'user', id: 'msg_1', text: '<system-reminder>ignore</system-reminder>\nlock video track 1' },
      { type: 'model-switched', id: 'msg_2' },
    ]);
    expect(fresh).toEqual({ isContinuation: false, userMessageID: 'msg_1', userText: 'lock video track 1' });

    const cont = inspectSessionMessages([
      { type: 'user', id: 'msg_1', text: 'I want to learn FilmCraft' },
      { type: 'assistant', id: 'msg_2', content: [{ type: 'tool', name: 'tutor_set_app' }] },
    ]);
    expect(cont.isContinuation).toBe(true);

    expect(makeDirectTitle('@FilmCraft switch to the razor tool')).toBe('FilmCraft: switch to the razor tool');
  });
});

describe('Direct Tutor System-1 / System-2 Router (`decideTutorRoute`)', () => {
  test('System-1 hit returns immediately with ZERO System-2 routing', async () => {
    const calls: unknown[] = [];
    const tutor: DirectTutorLike = {
      async highlight(step, app, _sig, visualCue) {
        calls.push({ step, app, visualCue });
        return fakeResult();
      },
    };
    const res = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u1', text: 'switch to razor tool' }],
      tutor,
      sessionApp: 'FilmCraft',
      hasFallbackModel: true,
    });
    expect(res.target).toBe('system1');
    if (res.target === 'system1') {
      expect(res.pointed).toBe(true);
      expect(res.text).toContain('Pointing at **"Razor Tool"**');
      expect(res.text).toContain('System 1 only');
    }
    expect(calls).toEqual([{ step: 'switch to razor tool', app: 'FilmCraft', visualCue: undefined }]);
  });

  test('System-1 miss routes natively to fallback with miss diagnostics for buildTutorGuidance', async () => {
    const tutor: DirectTutorLike = {
      async highlight() {
        return fakeResult({
          ok: false,
          decision: 'reobserve',
          target: undefined,
          message: 'No matching control was selected from this observation. A menu or panel may need opening first.',
          selection: {
            selectedId: 'ax:edit',
            probability: 0.4,
            margin: 0.1,
            companion: { exactInNamed: 0.06, isHiddenSubcontrol: 0.91, likelyVisualTarget: 0.22 },
            alternatives: [{ id: 'ax:edit', label: 'Edit', probability: 0.4 }],
          },
        });
      },
    };

    const res = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u2', text: 'change the export codec to ProRes' }],
      tutor,
      sessionApp: 'FilmCraft',
      hasFallbackModel: true,
    });

    expect(res.target).toBe('fallback');
    if (res.target === 'fallback') {
      expect(res.miss?.decision).toBe('reobserve');
      const guidance = buildTutorGuidance({ sessionApp: 'FilmCraft', autoLaunch: true, miss: res.miss });
      expect(guidance).toContain('is_hidden_subcontrol=0.91');
      expect(guidance).toContain('"Edit"');
      expect(guidance).toContain('tutor_highlight');
    }
  });

  test('tool-loop continuation routes straight to fallback in 0ms without re-running Jev or System 1', async () => {
    let gateCalls = 0;
    let highlightCalls = 0;
    const res = await decideTutorRoute({
      messages: [
        { type: 'user', id: 'u1', text: 'I want to learn FilmCraft today' },
        { type: 'assistant', id: 'a1', content: [{ type: 'tool', name: 'tutor_set_app' }] },
      ],
      tutor: {
        async highlight() {
          highlightCalls++;
          return fakeResult();
        },
      },
      intentClassifier: async () => {
        gateCalls++;
        return { wantsUiPointer: 0, isConceptualOrChat: 1, explicitDoForMe: 0, switchesApp: 0, latencyMs: 10 };
      },
      hasFallbackModel: true,
    });
    expect(res.target).toBe('fallback');
    expect(gateCalls).toBe(0);
    expect(highlightCalls).toBe(0);
  });

  test('does NOT escalate on stale/unavailable/cancelled errors', () => {
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'stale' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'unavailable' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'cancelled' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'reobserve' }))).toBe(true);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'abstain' }))).toBe(true);
  });

  test('Jev Intent Gate routes intro, conceptual/websearch, delegation, fast System-1 hit, and natural open-app switch', async () => {
    const intents = new Map<string, IntentSignals>([
      ['I want to learn FilmCraft today', { wantsUiPointer: 0.04, isConceptualOrChat: 0.98, explicitDoForMe: 0.01, switchesApp: 0.98, latencyMs: 85 }],
      ['switch to the razor tool', { wantsUiPointer: 0.99, isConceptualOrChat: 0.02, explicitDoForMe: 0.02, switchesApp: 0.03, latencyMs: 90 }],
      ['what is a J-cut?', { wantsUiPointer: 0.03, isConceptualOrChat: 0.97, explicitDoForMe: 0.01, switchesApp: 0.03, latencyMs: 82 }],
      ['can you lock V1 for me?', { wantsUiPointer: 0.99, isConceptualOrChat: 0.02, explicitDoForMe: 0.95, switchesApp: 0.03, latencyMs: 80 }],
      ['in Keynote, add a new slide', { wantsUiPointer: 0.95, isConceptualOrChat: 0.04, explicitDoForMe: 0.02, switchesApp: 0.98, latencyMs: 88 }],
    ]);

    const highlightCalls: { step: string; app?: string }[] = [];
    let remembered: string | undefined;

    const tutor: DirectTutorLike = {
      async highlight(step, app) {
        highlightCalls.push({ step, app });
        return fakeResult({ app: app ?? 'FilmCraft' });
      },
      async matchOpenApp(text) {
        return text.toLowerCase().includes('keynote') ? 'Keynote' : undefined;
      },
    };
    const intentClassifier = async (msg: string) => intents.get(msg)!;

    // Turn 1: Intro -> routes natively to System 2 (which calls `tutor_set_app`)
    const t1 = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u1', text: 'I want to learn FilmCraft today' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      hasFallbackModel: true,
    });
    expect(t1.target).toBe('fallback');
    expect(highlightCalls).toHaveLength(0);

    // Simulate System 2 calling `tutor_set_app({ app: "FilmCraft" })`
    remembered = 'FilmCraft';

    // Turn 2: UI request -> System 1 directly, ZERO System 2
    const t2 = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u2', text: 'switch to the razor tool' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      hasFallbackModel: true,
    });
    expect(t2.target).toBe('system1');
    if (t2.target === 'system1') expect(t2.pointed).toBe(true);
    expect(highlightCalls).toEqual([{ step: 'switch to the razor tool', app: 'FilmCraft' }]);

    // Turn 3: Conceptual / research question -> routes natively to System 2 (can call `websearch`, etc.)
    const t3 = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u3', text: 'what is a J-cut?' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      hasFallbackModel: true,
    });
    expect(t3.target).toBe('fallback');
    expect(highlightCalls).toHaveLength(1);

    // Turn 4: Explicit delegation ("for me") -> instant point-only notice, ZERO System 2
    const t4 = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u4', text: 'can you lock V1 for me?' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      hasFallbackModel: true,
    });
    expect(t4.target).toBe('system1');
    if (t4.target === 'system1') expect(t4.route).toBe('delegation');
    expect(highlightCalls).toHaveLength(1);

    // Turn 5: Natural switch to an explicitly named open app -> matches locally, ZERO System 2
    const t5 = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u5', text: 'in Keynote, add a new slide' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      hasFallbackModel: true,
    });
    expect(t5.target).toBe('system1');
    expect(remembered).toBe('Keynote');
    expect(highlightCalls.at(-1)).toEqual({ step: 'in Keynote, add a new slide', app: 'Keynote' });
  });

  test('when sessionApp is unset and user gives a generic UI step, routes to System 2 (or asks when fallback disabled) and NEVER calls highlight', async () => {
    let highlightCalls = 0;
    const tutor: DirectTutorLike = {
      async highlight() {
        highlightCalls++;
        return fakeResult();
      },
      async matchOpenApp() {
        return undefined;
      },
    };

    const withFallback = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u1', text: 'switch to the razor tool' }],
      tutor,
      sessionApp: undefined,
      hasFallbackModel: true,
    });
    expect(withFallback.target).toBe('fallback');
    expect(highlightCalls).toBe(0);

    const noFallback = await decideTutorRoute({
      messages: [{ type: 'user', id: 'u1', text: 'switch to the razor tool' }],
      tutor,
      sessionApp: undefined,
      hasFallbackModel: false,
    });
    expect(noFallback.target).toBe('system1');
    if (noFallback.target === 'system1') {
      expect(noFallback.route).toBe('no_app');
      expect(noFallback.text).toMatch(/No app is selected/i);
    }
    expect(highlightCalls).toBe(0);
  });

  test('liveIntentClassifier sends 4 orthogonal atomic Nouls in one text-only request', async () => {
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
            wants_ui_pointer: { type: 'noul', noul: 0.04 },
            is_conceptual_or_chat: { type: 'noul', noul: 0.97 },
            explicit_do_for_me: { type: 'noul', noul: 0.01 },
            switches_app: { type: 'noul', noul: 0.98 },
          },
          usage: { input_tokens: 180, output_tokens: 8 },
        });
      },
    });
    const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL };
    process.env.TYPESAFE_API_KEY = 'local-test';
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const sig = await liveIntentClassifier('jev-1.14.0')('I want to learn FilmCraft today', undefined);
      expect(seenImageHeader).toBeNull();
      expect(Object.keys(seenBody.questions).sort()).toEqual([
        'explicit_do_for_me',
        'is_conceptual_or_chat',
        'switches_app',
        'wants_ui_pointer',
      ]);
      expect(sig.isConceptualOrChat).toBe(0.97);
      expect(sig.switchesApp).toBe(0.98);
      expect(sig.wantsUiPointer).toBe(0.04);
      expect(sig.explicitDoForMe).toBe(0.01);
    } finally {
      server.stop(true);
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = saved.url;
    }
  });
});

describe('Loopback OpenAI-compatible ReplyServer (`startReplyServer`)', () => {
  test('enforces Bearer auth, streams pending System-1 SSE with zero usage, and handles titles without an LLM', async () => {
    const pending = new Map<string, string>([['ses_1', 'Pointing at **"Razor Tool"**. Click it yourself.']]);
    const srv = startReplyServer({
      consumePendingText: (id) => {
        const t = pending.get(id);
        pending.delete(id);
        return t;
      },
    });
    try {
      const unauth = await fetch(`${srv.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
      expect(unauth.status).toBe(401);

      const sse = await fetch(`${srv.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'x-tutor-token': srv.token,
          'content-type': 'application/json',
          'x-tutor-session-id': 'ses_1',
          'x-tutor-kind': 'primary',
        },
        body: JSON.stringify({ model: 'tutor', stream: true, messages: [{ role: 'user', content: 'switch to razor tool' }] }),
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      const raw = await sse.text();
      expect(raw).toContain('Pointing at **\\"Razor Tool\\"**');
      expect(raw).toContain('"finish_reason":"stop"');
      expect(raw).toContain('data: [DONE]');

      const title = await fetch(`${srv.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'x-tutor-token': srv.token,
          'content-type': 'application/json',
          'x-tutor-kind': 'title',
        },
        body: JSON.stringify({ model: 'tutor', stream: false, messages: [{ role: 'user', content: '@FilmCraft mute audio track 1' }] }),
      });
      const json = (await title.json()) as { choices: [{ message: { content: string } }] };
      expect(json.choices[0].message.content).toBe('FilmCraft: mute audio track 1');
    } finally {
      srv.close();
    }
  });
});
