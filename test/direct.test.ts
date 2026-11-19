import { describe, expect, test } from 'bun:test';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import { DEFAULT_FALLBACK_MODEL, formatModelRef, loadConfig, parseModelRef } from '../src/config.js';
import {
  extractLastUserText,
  handleDirectTurn,
  makeDirectTitle,
  parseDirectInput,
  parseFallbackJson,
  shouldEscalateToSystem2,
  startDirectServer,
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

describe('Direct Tutor config and parsing', () => {
  test('defaults directModel=true and fallbackModel=opencode-go/glm-5.3-flash#high, and allows overrides/disable', () => {
    const def = loadConfig({}, {});
    expect(def.directModel).toBe(true);
    expect(def.fallbackModel).toEqual({ providerID: 'opencode-go', id: 'glm-5.3-flash', variant: 'high' });
    expect(formatModelRef(def.fallbackModel!)).toBe(DEFAULT_FALLBACK_MODEL);

    expect(loadConfig({ directModel: false }, {}).directModel).toBe(false);
    expect(loadConfig({ fallbackModel: 'none' }, {}).fallbackModel).toBeUndefined();
    expect(loadConfig({ fallbackModel: false }, {}).fallbackModel).toBeUndefined();
    expect(parseModelRef('anthropic/claude-sonnet-5-5#low')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-5-5',
      variant: 'low',
    });
    expect(() => parseModelRef('no-slash')).toThrow();
  });

  test('parseDirectInput, extractLastUserText, and makeDirectTitle strip system reminders and parse @App', () => {
    expect(parseDirectInput('mute audio track 1')).toEqual({ step: 'mute audio track 1' });
    expect(parseDirectInput('@FilmCraft switch to razor tool')).toEqual({
      app: 'FilmCraft',
      step: 'switch to razor tool',
    });
    expect(parseDirectInput('@"QuickTime Player" start screen recording')).toEqual({
      app: 'QuickTime Player',
      step: 'start screen recording',
    });

    const userText = extractLastUserText([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'earlier' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>ignore me</system-reminder>\nlock video track 1' },
        ],
      },
    ]);
    expect(userText).toBe('lock video track 1');
    expect(makeDirectTitle('@FilmCraft switch to the razor tool')).toBe('FilmCraft: switch to the razor tool');
  });

  test('parseFallbackJson handles raw JSON, fenced JSON, and plain prose', () => {
    expect(
      parseFallbackJson(
        '```json\n{"reply":"Click Export first.","next_step":"switch to Export workspace","visual_cue":"Export tab top-left","app":null}\n```'
      )
    ).toEqual({
      reply: 'Click Export first.',
      nextStep: 'switch to Export workspace',
      visualCue: 'Export tab top-left',
      app: undefined,
    });
    expect(parseFallbackJson('A J-cut lets the next clip audio start early.')).toEqual({
      reply: 'A J-cut lets the next clip audio start early.',
    });
  });
});

describe('Direct Tutor System-1-first + System-2 fallback orchestration', () => {
  test('System-1 hit returns immediately with ZERO System-2 calls', async () => {
    let fallbackCalls = 0;
    const calls: unknown[] = [];
    const tutor: DirectTutorLike = {
      async highlight(step, app, _sig, visualCue) {
        calls.push({ step, app, visualCue });
        return fakeResult();
      },
    };
    const res = await handleDirectTurn({
      rawUserText: 'switch to razor tool',
      history: [{ role: 'user', text: 'switch to razor tool' }],
      tutor,
      fallback: async () => {
        fallbackCalls++;
        return '{"reply":"never"}';
      },
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(res.escalated).toBe(false);
    expect(res.pointed).toBe(true);
    expect(fallbackCalls).toBe(0);
    expect(calls).toEqual([{ step: 'switch to razor tool', app: undefined, visualCue: undefined }]);
    expect(res.text).toContain('Pointing at **"Razor Tool"**');
    expect(res.text).toContain('System 1 only');
  });

  test('System-1 reobserve miss escalates to System-2 fallback and highlights the suggested prerequisite step', async () => {
    const highlightCalls: { step: string; app?: string; visualCue?: string }[] = [];
    let fallbackPrompt = '';
    const tutor: DirectTutorLike = {
      async highlight(step, app, _sig, visualCue) {
        highlightCalls.push({ step, app, visualCue });
        if (highlightCalls.length === 1) {
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
        }
        return fakeResult({
          ok: true,
          target: { id: 'vis:export', label: 'Export', source: 'visual', probability: 0.94, point: { x: 761, y: 157 } },
          jev: {
            calls: 4,
            requests: 4,
            imageRequests: 3,
            multipartRequests: 0,
            inputTokens: 1200,
            outputTokens: 20,
            usageResponses: 4,
            models: ['jev-1.14.0'],
            provider: 'live',
            rounds: 2,
            path: 'box',
          },
          screenshotRequests: 2,
        });
      },
    };

    const res = await handleDirectTurn({
      rawUserText: 'change the export codec to ProRes',
      history: [{ role: 'user', text: 'change the export codec to ProRes' }],
      tutor,
      fallback: async (prompt) => {
        fallbackPrompt = prompt;
        return JSON.stringify({
          reply: 'Codec settings live in the Export workspace. Click the Export tab first, then we can select ProRes.',
          next_step: 'switch to the Export workspace',
          visual_cue: 'Export tab in top-left header',
          app: null,
        });
      },
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });

    expect(res.escalated).toBe(true);
    expect(res.pointed).toBe(true);
    expect(fallbackPrompt).toContain('is_hidden_subcontrol=0.91');
    expect(highlightCalls).toEqual([
      { step: 'change the export codec to ProRes', app: undefined, visualCue: undefined },
      { step: 'switch to the Export workspace', app: 'FilmCraft', visualCue: 'Export tab in top-left header' },
    ]);
    expect(res.text).toContain('Codec settings live in the Export workspace');
    expect(res.text).toContain('Pointing at **"Export"**');
    expect(res.text).toContain('opencode-go/glm-5.3-flash#high');
  });

  test('does NOT escalate on stale/unavailable/cancelled errors and degrades cleanly if fallback throws', async () => {
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'stale' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'unavailable' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'cancelled' }))).toBe(false);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'reobserve' }))).toBe(true);
    expect(shouldEscalateToSystem2(fakeResult({ ok: false, decision: 'abstain' }))).toBe(true);

    const tutor: DirectTutorLike = {
      async highlight() {
        return fakeResult({ ok: false, decision: 'abstain', target: undefined, message: 'No matching control.' });
      },
    };
    const res = await handleDirectTurn({
      rawUserText: 'what is a J-cut?',
      history: [{ role: 'user', text: 'what is a J-cut?' }],
      tutor,
      fallback: async () => {
        throw new Error('offline');
      },
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(res.escalated).toBe(true);
    expect(res.pointed).toBe(false);
    expect(res.text).toContain('No matching control.');
    expect(res.text).toContain('offline');
  });

  test('Jev Intent Gate routes delegation, conceptual chat, natural app switching, and remembers sessionApp across turns', async () => {
    const intents = new Map<string, IntentSignals>([
      ['I want to learn FilmCraft today', { wantsUiPointer: 0.04, isConceptualOrChat: 0.98, explicitDoForMe: 0.01, switchesApp: 0.98, latencyMs: 85 }],
      ['switch to the razor tool', { wantsUiPointer: 0.99, isConceptualOrChat: 0.02, explicitDoForMe: 0.02, switchesApp: 0.03, latencyMs: 90 }],
      ['what is a J-cut?', { wantsUiPointer: 0.03, isConceptualOrChat: 0.97, explicitDoForMe: 0.01, switchesApp: 0.03, latencyMs: 82 }],
      ['can you lock V1 for me?', { wantsUiPointer: 0.99, isConceptualOrChat: 0.02, explicitDoForMe: 0.95, switchesApp: 0.03, latencyMs: 80 }],
      ['in Keynote, add a new slide', { wantsUiPointer: 0.95, isConceptualOrChat: 0.04, explicitDoForMe: 0.02, switchesApp: 0.98, latencyMs: 88 }],
    ]);

    const highlightCalls: { step: string; app?: string }[] = [];
    let fallbackCalls = 0;
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
    const fallback = async (prompt: string) => {
      fallbackCalls++;
      if (prompt.includes('I want to learn FilmCraft today')) {
        return JSON.stringify({ reply: 'Ready to help you learn FilmCraft!', app: 'FilmCraft', next_step: null, visual_cue: null });
      }
      expect(prompt).toContain('Remembered app for this session: FilmCraft');
      return JSON.stringify({ reply: 'A J-cut starts the next clip audio early.', app: null, next_step: null, visual_cue: null });
    };

    // Turn 1: User introduces FilmCraft -> skips Cua Driver completely, remembers FilmCraft
    const t1 = await handleDirectTurn({
      rawUserText: 'I want to learn FilmCraft today',
      history: [{ role: 'user', text: 'I want to learn FilmCraft today' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      fallback,
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(t1.route).toBe('conceptual');
    expect(remembered).toBe('FilmCraft');
    expect(highlightCalls).toHaveLength(0);
    expect(fallbackCalls).toBe(1);

    // Turn 2: User asks without naming any app -> uses remembered FilmCraft, ZERO System 2
    const t2 = await handleDirectTurn({
      rawUserText: 'switch to the razor tool',
      history: [{ role: 'user', text: 'switch to the razor tool' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      fallback,
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(t2.route).toBe('system1');
    expect(t2.escalated).toBe(false);
    expect(t2.pointed).toBe(true);
    expect(highlightCalls).toEqual([{ step: 'switch to the razor tool', app: 'FilmCraft' }]);
    expect(fallbackCalls).toBe(1);

    // Turn 3: Conceptual question -> skips Cua Driver completely, passes remembered FilmCraft to System 2
    const t3 = await handleDirectTurn({
      rawUserText: 'what is a J-cut?',
      history: [{ role: 'user', text: 'what is a J-cut?' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      fallback,
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(t3.route).toBe('conceptual');
    expect(highlightCalls).toHaveLength(1);
    expect(fallbackCalls).toBe(2);

    // Turn 4: Explicit delegation ("for me") -> instant point-only notice, ZERO Cua Driver, ZERO System 2
    const t4 = await handleDirectTurn({
      rawUserText: 'can you lock V1 for me?',
      history: [{ role: 'user', text: 'can you lock V1 for me?' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      fallback,
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(t4.route).toBe('delegation');
    expect(t4.escalated).toBe(false);
    expect(highlightCalls).toHaveLength(1);
    expect(fallbackCalls).toBe(2);

    // Turn 5: Natural switch to another open app ("in Keynote, add a new slide") -> matches locally, ZERO System 2
    const t5 = await handleDirectTurn({
      rawUserText: 'in Keynote, add a new slide',
      history: [{ role: 'user', text: 'in Keynote, add a new slide' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
      intentClassifier,
      fallback,
      fallbackModel: parseModelRef(DEFAULT_FALLBACK_MODEL),
    });
    expect(t5.route).toBe('system1');
    expect(remembered).toBe('Keynote');
    expect(highlightCalls.at(-1)).toEqual({ step: 'in Keynote, add a new slide', app: 'Keynote' });
    expect(fallbackCalls).toBe(2);
  });

  test('recovers to frontmost app when remembered sessionApp window was closed', async () => {
    let remembered: string | undefined = 'FilmCraft';
    const seenApps: (string | undefined)[] = [];
    const tutor: DirectTutorLike = {
      async highlight(_step, app) {
        seenApps.push(app);
        if (app === 'FilmCraft') {
          return fakeResult({ ok: false, decision: 'error', target: undefined, message: 'Tutor error: FilmCraft has no on-screen window. Open it first.' });
        }
        return fakeResult({ app: 'Keynote' });
      },
    };
    const res = await handleDirectTurn({
      rawUserText: 'add a slide',
      history: [{ role: 'user', text: 'add a slide' }],
      tutor,
      sessionApp: remembered,
      onSessionApp: (a) => { remembered = a; },
    });
    expect(res.pointed).toBe(true);
    expect(seenApps).toEqual(['FilmCraft', undefined]);
    expect(remembered).toBe('Keynote');
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

describe('Direct loopback OpenAI-compatible HTTP server', () => {
  test('enforces Bearer auth, handles SSE streaming, JSON mode, and zero-LLM title requests', async () => {
    const seenSessions: string[] = [];
    const srv = startDirectServer({
      getTutor: (sessionID) => {
        seenSessions.push(sessionID);
        return { async highlight() { return fakeResult(); } };
      },
    });
    try {
      // Unauthorized rejected
      const unauth = await fetch(`${srv.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
      expect(unauth.status).toBe(401);

      // Streaming SSE request
      const sse = await fetch(`${srv.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${srv.token}`,
          'content-type': 'application/json',
          'x-tutor-session-id': 'ses_test1',
        },
        body: JSON.stringify({
          model: 'tutor',
          stream: true,
          messages: [{ role: 'user', content: 'switch to razor tool' }],
        }),
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      const raw = await sse.text();
      expect(raw).toContain('Pointing at **\\"Razor Tool\\"**');
      expect(raw).toContain('"finish_reason":"stop"');
      expect(raw).toContain('data: [DONE]');
      expect(seenSessions).toEqual(['ses_test1']);

      // Non-streaming title request bypasses tutor entirely
      const title = await fetch(`${srv.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${srv.token}`,
          'content-type': 'application/json',
          'x-tutor-kind': 'title',
        },
        body: JSON.stringify({
          model: 'tutor',
          stream: false,
          messages: [{ role: 'user', content: '@FilmCraft mute audio track 1' }],
        }),
      });
      const json = (await title.json()) as { choices: [{ message: { content: string } }] };
      expect(json.choices[0].message.content).toBe('FilmCraft: mute audio track 1');
      expect(seenSessions).toHaveLength(1);
    } finally {
      srv.close();
    }
  });
});
