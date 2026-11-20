/**
 * OpenCode V2 plugin: macOS computer-use Tutor (`cua-tutor/tutor`).
 *
 * ZERO footprint outside the `Tutor` model:
 * - Registers the `CUA Tutor` provider (`cua-tutor`) with ONE visible model (`cua-tutor/tutor`,
 *   displayed as "Tutor") and ONE hidden fallback model (`cua-tutor/fallback`, cloned from
 *   `config.fallbackModel`, default `opencode-go/glm-5.3-flash#high`).
 * - Registers `tutor_set_app` and `tutor_highlight`, then strips BOTH from `event.tools` and
 *   injects zero guidance on every non-Tutor model via `session.hook("context")`.
 * - When `Tutor` IS selected:
 *   1. `experimental.model.resolve` runs a ~90 ms 4-Noul Jev Intent Gate + direct System-1
 *      `Tutor.highlight` on visible UI requests when an app is already selected (served via
 *      `aisdk.hook("language")` with ZERO System-2 tokens).
 *   2. On conceptual questions, app setup/switching, web research, System-1 misses, or tool-loop
 *      continuations, `experimental.model.resolve` routes natively to `cua-tutor/fallback` for a
 *      full OpenCode agent loop (`tutor_set_app`, `tutor_highlight`, `websearch`, `webfetch`, etc.).
 *   3. `tutor_highlight` is hard-gated on `tutor_set_app` (session app must be set first), and
 *      `tutor_set_app` validates installed macOS `.app` bundles + auto-launches if closed.
 */
import { Model, Plugin, Provider } from '@opencode/plugin';

import { loadConfig } from './config.js';
import {
  buildTutorGuidance,
  decideTutorRoute,
  DIRECT_FALLBACK_MODEL_ID,
  DIRECT_MODEL_ID,
  DIRECT_MODEL_NAME,
  DIRECT_PROVIDER_ID,
  makeDirectTitle,
  startReplyServer,
  type ReplyServer,
  type TutorTurnState,
} from './direct.js';
import { liveIntentClassifier } from './jev.js';
import { Tutor, TUTOR_REVISION, type HighlightResult } from './tutor.js';

export const format = (r: HighlightResult) => {
  const comp = r.selection?.companion
    ? `companion(exact=${r.selection.companion.exactInNamed.toFixed(2)}, hidden=${r.selection.companion.isHiddenSubcontrol.toFixed(2)}, visual=${r.selection.companion.likelyVisualTarget.toFixed(2)}); `
    : '';
  const boxInfo = r.selection?.box
    ? `box(tile=${r.selection.box.tile} ${r.selection.box.tileProbability.toFixed(2)}, p=${r.selection.box.boxProbability.toFixed(2)}${r.selection.box.zoomed ? ', zoomed' : ''}` +
      (r.selection.box.verified
        ? `, verify=${r.selection.box.verified.clickable.toFixed(2)}/${r.selection.box.verified.matches.toFixed(2)}/${r.selection.box.verified.exact.toFixed(2)}`
        : '') +
      (r.selection.box.reason ? `, ${r.selection.box.reason}` : '') +
      '); '
    : '';
  return (
    `${r.message}\n(${r.candidates} controls in ${r.app ?? 'no app'}${r.window ? ` — "${r.window}"` : ''}; ` +
    (r.target ? `pointer (${r.target.point.x}, ${r.target.point.y}) [${r.target.source}], p=${r.target.probability.toFixed(2)}; ` : '') +
    comp +
    boxInfo +
    (!r.ok && r.selection && r.selection.alternatives.length
      ? `model selected ${r.selection.selectedId} p=${r.selection.probability.toFixed(2)}, margin=${r.selection.margin.toFixed(2)}; alternatives: ` +
        r.selection.alternatives
          .slice(0, 4)
          .map((a) => `${a.label} ${a.probability.toFixed(2)}`)
          .join(', ') +
        '; '
      : '') +
    (r.cursorReadback ? `own-connection cursor target confirmed (${r.cursorReadback.position.x}, ${r.cursorReadback.position.y}); ` : '') +
    (r.observation
      ? `AX ${r.observation.elements} elements, coverage ${r.observation.status}, pending ${r.observation.nodesPending ?? 'unknown'}, bounds ${r.observation.boundsSource}, pid/window ${r.observation.pid}/${r.observation.windowId}; `
      : '') +
    `observe ${r.timingsMs.observe ?? '-'} ms, decide ${r.timingsMs.decide ?? '-'} ms, verify ${r.timingsMs.verify ?? '-'} ms; ` +
    `${r.jev?.provider ?? 'unavailable'}/${r.jev?.path ?? '-'} (${r.jev?.models.join(', ') || 'no model response'}); ${r.jev?.requests ?? 0} HTTP requests, ` +
    `${r.jev?.imageRequests ?? 0} image opt-ins, ${r.jev?.multipartRequests ?? 0} multipart uploads, ${r.screenshotRequests} screenshot requests; reported input tokens ${r.jev?.inputTokens ?? 0} ` +
    `from ${r.jev?.usageResponses ?? 0} responses; ${r.cursorReadbackRequests} cursor readbacks (${r.timingsMs.cursorReadback ?? '-'} ms); cursor session ${r.cursorSession}; ${r.revision})`
  );
};

export default Plugin.define({
  id: 'opencode-cua-tutor',
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const config = loadConfig(options);

    const tutors = new Map<string, Tutor>();
    const sessionApps = new Map<string, string>();
    const tutorTurns = new Map<string, TutorTurnState>();
    let hasFallbackModel = false;
    let replyServer: ReplyServer | undefined;

    const getTutor = (sessionID: string) => {
      let tutor = tutors.get(sessionID);
      if (!tutor) {
        tutor = new Tutor(config);
        tutors.set(sessionID, tutor);
      }
      return tutor;
    };

    const currentAppFor = (sessionID: string) => sessionApps.get(sessionID) ?? config.defaultApp;

    const providerID = Provider.ID.make(DIRECT_PROVIDER_ID);
    const tutorModelID = Model.ID.make(DIRECT_MODEL_ID);
    const fallbackModelID = Model.ID.make(DIRECT_FALLBACK_MODEL_ID);
    const fallbackRef = config.fallbackModel;

    // 1. Register `tutor_set_app` and `tutor_highlight` (strictly hidden on all non-Tutor models below)
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'tutor',
        description: 'Teach the user a macOS app by setting the active app and pointing at controls (never clicks)',
      });

      editor.add({
        name: 'set_app',
        description:
          'Set the current macOS application the user is working in for this Tutor session. ' +
          'MUST be called before `tutor_highlight` can be used. Validates against installed macOS apps' +
          (config.autoLaunch ? ' and automatically launches the app if it is not open yet.' : '.') +
          ' Only call this when the user explicitly names or switches the app they are learning — never on comparison mentions.',
        input: {
          type: 'object',
          properties: {
            app: {
              type: 'string',
              description: 'Exact macOS app name or bundle id the user wants to learn, e.g. "FilmCraft", "Keynote", or "Finder".',
            },
          },
          required: ['app'],
          additionalProperties: false,
        },
        options: { namespace: 'tutor', codemode: false },
        execute: async (input, context) => {
          if (!tutorTurns.has(context.sessionID)) {
            return { content: 'Tutor tools are only active when the Tutor model is selected.' };
          }
          const { app } = input as { app: string };
          const tutor = getTutor(context.sessionID);
          try {
            const res = await tutor.setApp(app, context.signal);
            context.signal.throwIfAborted();
            if (res.ok && res.appName) {
              sessionApps.set(context.sessionID, res.appName);
            }
            return { content: res.message };
          } catch (error) {
            context.signal.throwIfAborted();
            return { content: `Tutor error: ${(error as Error).message}` };
          }
        },
      });

      editor.add({
        name: 'highlight',
        description:
          'Point the on-screen agent cursor at ONE currently-visible control or canvas item in the session’s current app. ' +
          'It NEVER clicks; the user clicks. Requires `tutor_set_app` to have been called first for this session. ' +
          `Tutor revision: ${TUTOR_REVISION}.`,
        input: {
          type: 'object',
          properties: {
            step: {
              type: 'string',
              description: 'The one next step in plain words, e.g. "open the export dialog" or "switch to the razor tool"',
            },
            visualCue: {
              type: 'string',
              description:
                'Optional concrete visual description of an unlabeled icon or canvas target (e.g. "upload arrow icon in top-right header"). Used only if visual Box fallback runs.',
            },
          },
          required: ['step'],
          additionalProperties: false,
        },
        options: { namespace: 'tutor', codemode: false },
        execute: async (input, context) => {
          if (!tutorTurns.has(context.sessionID)) {
            return { content: 'Tutor tools are only active when the Tutor model is selected.' };
          }
          const targetApp = currentAppFor(context.sessionID);
          if (!targetApp) {
            return {
              content:
                'No current application is set for this session. Ask the user which macOS app they want to work in, then call `tutor_set_app` first.',
            };
          }
          const { step, visualCue } = input as { step: string; visualCue?: string };
          const tutor = getTutor(context.sessionID);
          try {
            const result = await tutor.highlight(step, targetApp, context.signal, visualCue);
            context.signal.throwIfAborted();
            if (result.ok && result.app) sessionApps.set(context.sessionID, result.app);
            return { content: format(result) };
          } catch (error) {
            context.signal.throwIfAborted();
            return { content: `Tutor error: ${(error as Error).message}` };
          }
        },
      });
    });

    // 2. Register `CUA Tutor` (`cua-tutor`) provider with visible `cua-tutor/tutor` + hidden `cua-tutor/fallback`
    if (config.directModel) {
      replyServer = startReplyServer({
        consumePendingText: (sessionID) => {
          const turn = tutorTurns.get(sessionID);
          if (!turn?.pendingText) return undefined;
          const text = turn.pendingText;
          turn.pendingText = undefined;
          return text;
        },
      });
      const replyBaseURL = replyServer.baseURL;
      const replyToken = replyServer.token;

      await ctx.provider.transform((editor) => {
        const source = fallbackRef ? editor.get(fallbackRef.providerID) : undefined;
        const sourceModel = source && fallbackRef ? source.models.get(fallbackRef.id) : undefined;
        hasFallbackModel = Boolean(source && sourceModel);

        const baseTutor = Model.Info.default(providerID, tutorModelID);
        const tutorModel: Model.Info = {
          ...baseTutor,
          name: DIRECT_MODEL_NAME,
          enabled: true,
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: replyBaseURL, apiKey: false },
          headers: { 'x-tutor-token': replyToken },
          ...(sourceModel
            ? {
                limit: sourceModel.limit,
                capabilities: { ...sourceModel.capabilities, tools: true },
              }
            : {
                capabilities: { ...baseTutor.capabilities, tools: false, input: ['text'], output: ['text'] },
              }),
        };

        const models: Model.Info[] = [tutorModel];
        if (source && sourceModel) {
          models.push({
            ...sourceModel,
            id: fallbackModelID,
            providerID,
            package: sourceModel.package ?? source.provider.package,
            name: `${sourceModel.name} (Tutor Fallback)`,
            enabled: false, // Hidden from picker; routed to internally via experimental.model.resolve
          });
        }

        const providerInfo: Provider.Info = source
          ? {
              ...source.provider,
              id: providerID,
              canonical: source.provider.canonical ?? source.provider.id,
              name: 'CUA Tutor',
              activation: 'enabled',
            }
          : {
              ...Provider.Info.empty(providerID),
              name: 'CUA Tutor',
              activation: 'enabled',
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: replyBaseURL, apiKey: false },
              headers: { 'x-tutor-token': replyToken },
            };

        editor.add({
          info: providerInfo,
          models,
          ...(source?.sourceConnection ? { sourceConnection: source.sourceConnection } : {}),
        });
      });

      await ctx.session.hook(
        'model.request',
        (event) => {
          if (event.model.id === DIRECT_MODEL_ID) {
            event.baseURL = replyBaseURL;
            event.headers['x-tutor-token'] = replyToken;
            event.headers['x-tutor-session-id'] = event.sessionID;
            event.headers['x-tutor-kind'] = event.kind;
          }
        },
        { providerID: DIRECT_PROVIDER_ID }
      );

      await ctx.session.hook(
        'title',
        (event) => {
          const firstUser = event.messages.find((m) => m.role === 'user');
          let text = '';
          if (firstUser && Array.isArray(firstUser.content)) {
            text = firstUser.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join(' ');
          }
          event.result = makeDirectTitle(text);
        },
        { providerID: DIRECT_PROVIDER_ID }
      );

      const intentClassifier =
        config.provider === 'live' ? liveIntentClassifier(config.jevModel ?? config.boxModel) : undefined;

      // Unscoped resolve hook: tracks whether THIS session's active turn is Tutor, and routes System 1 vs System 2.
      await ctx.session.hook('experimental.model.resolve', async (event) => {
        if (event.model.providerID !== DIRECT_PROVIDER_ID) {
          tutorTurns.delete(event.sessionID);
          return;
        }
        if (event.kind !== 'primary') {
          return;
        }
        if (event.model.id !== DIRECT_MODEL_ID) {
          return;
        }

        const prevTurn = tutorTurns.get(event.sessionID);
        let messages: readonly unknown[] = [];
        try {
          messages = await ctx.session.context({ sessionID: event.sessionID });
        } catch {
          messages = [];
        }

        const decision = await decideTutorRoute({
          messages,
          lastRoutedUserMessageID: prevTurn?.mode === 'system2' ? prevTurn.userMessageID : undefined,
          sessionApp: currentAppFor(event.sessionID),
          onSessionApp: (app) => {
            if (app) sessionApps.set(event.sessionID, app);
            else sessionApps.delete(event.sessionID);
          },
          tutor: getTutor(event.sessionID),
          intentClassifier,
          hasFallbackModel,
        });

        if (decision.target === 'fallback' && hasFallbackModel) {
          tutorTurns.set(event.sessionID, {
            mode: 'system2',
            userMessageID: decision.userMessageID,
            miss: decision.miss,
          });
          event.model = {
            providerID,
            id: fallbackModelID,
            ...(fallbackRef?.variant ? { variant: Model.VariantID.make(fallbackRef.variant) } : {}),
          };
          return;
        }

        tutorTurns.set(event.sessionID, {
          mode: 'system1',
          userMessageID: decision.userMessageID,
          pendingText: decision.target === 'system1' ? decision.text : 'System-2 fallback is unavailable.',
        });
      });
    }

    // 3. Strictly isolate Tutor tools & guidance to ONLY active Tutor System-2 turns
    await ctx.session.hook('context', (event) => {
      const isTutorSystem2 =
        event.model.providerID === DIRECT_PROVIDER_ID && event.model.id === DIRECT_FALLBACK_MODEL_ID;
      if (!isTutorSystem2) {
        delete event.tools.tutor_set_app;
        delete event.tools.tutor_highlight;
        return;
      }
      const turn = tutorTurns.get(event.sessionID);
      if (config.injectGuidance) {
        event.system.push({
          type: 'text',
          text: buildTutorGuidance({
            sessionApp: currentAppFor(event.sessionID),
            autoLaunch: config.autoLaunch,
            miss: turn?.miss,
          }),
        });
      }
      if (turn?.miss) turn.miss = undefined;
    });

    // 4. Optional global cua-driver MCP (default OFF so zero tools leak outside Tutor)
    if (config.declareMcp) {
      await ctx.mcp.transform((editor) => {
        if (!editor.get('cua-driver')) {
          editor.set('cua-driver', { type: 'local', command: [config.driverBinary, 'mcp'] });
        }
      });
    }

    return async () => {
      replyServer?.close();
      await Promise.all([...tutors.values()].map((tutor) => tutor.close()));
      tutors.clear();
      sessionApps.clear();
      tutorTurns.clear();
    };
  },
});
