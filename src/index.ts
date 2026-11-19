/**
 * OpenCode V2 plugin: computer-use tutor mode for any macOS app. Add it to your OpenCode config;
 * nothing else to run (plugins hot reload).
 *
 * While the plugin is active it:
 * 1. registers the tool `tutor_highlight({ step, app?, visualCue? })` in every session: Cua Driver
 *    reads the accessibility tree of the app you're in (frontmost by default), TypeSafe Jev picks
 *    the control using Companion Nouls + clean Choice (or falls back to Coarse-to-Fine Tile -> Zoom
 *    Box for unnamed controls and canvas items), and the Cua agent cursor glides to it. Never clicks.
 * 2. registers the direct System-1 virtual model `Tutor` (`cua-tutor/tutor`) via `ctx.provider.transform`:
 *    select it in any OpenCode client (Desktop, TUI, Web, Mobile) to send plain text straight to
 *    Jev with zero System-2 inference, escalating only on System-1 misses (`reobserve`/`abstain`/
 *    `unsure`/`partial`) to the configured System-2 fallback model (default `opencode-go/glm-5.3-flash#high`).
 * 3. injects tutor guidance into normal System-2 agent loops (`session.hook("context")`), so the
 *    agent points by default and only operates apps when asked. No AGENTS.md needed.
 * 4. declares the `cua-driver` MCP server (`ctx.mcp.transform`), unless you already defined one,
 *    for when you ask the agent to do things for you.
 *
 * API: anomalyco/opencode services/site/src/docs/content/build/plugins/server.mdx
 */
import { Model, Plugin, Provider } from '@opencode/plugin';

import { loadConfig } from './config.js';
import {
  DIRECT_MODEL_ID,
  DIRECT_MODEL_NAME,
  DIRECT_PROVIDER_ID,
  makeDirectTitle,
  startDirectServer,
  type DirectServer,
} from './direct.js';
import { liveIntentClassifier } from './jev.js';
import { Tutor, TUTOR_REVISION, type HighlightResult } from './tutor.js';

export const GUIDANCE = [
  'Tutor mode is on. The user is LEARNING to use apps on this Mac and wants to do the clicking themselves.',
  '- When they ask how or where to do something in an app, call `tutor_highlight` with ONE concrete step.',
  '  It moves an on-screen pointer to the control (including unlabeled icons or canvas elements) in that app;',
  '  it never clicks. Pass `app` when they name the app or it is clear from context; otherwise it uses the',
  '  frontmost app. When you know what an unlabeled icon or canvas target looks like, pass a short concrete',
  '  `visualCue` (e.g. "upload arrow icon in top-right header" or "clip labeled Intro.mp4 on track 1").',
  '  Then tell them in one or two short sentences what to click and why, and wait for them to do it before',
  '  highlighting the next step.',
  '- For a multi-step task, plan the steps, then highlight them one at a time.',
  "- If the tool says the control is not on screen, tell them what to open first (menu, panel, tab) and highlight that.",
  '- Only operate apps yourself (cua-driver or other tools) when they explicitly ask you to do it for them.',
  '- Never delete, overwrite, send, or export over their files without asking first.',
].join('\n');

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
    const getTutor = (sessionID: string) => {
      let tutor = tutors.get(sessionID);
      if (!tutor) {
        tutor = new Tutor(config);
        tutors.set(sessionID, tutor);
      }
      return tutor;
    };

    let directServer: DirectServer | undefined;

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'tutor',
        description: 'Teach the user an app by pointing at controls instead of clicking them',
      });
      editor.add({
        name: 'highlight',
        description:
          'Point the on-screen agent cursor at the control or canvas item the user should click next to do one step in an app. ' +
          'It NEVER clicks; the user clicks. Use it whenever the user asks how or where to do something in an app. ' +
          `Tutor revision: ${TUTOR_REVISION}.`,
        input: {
          type: 'object',
          properties: {
            step: {
              type: 'string',
              description: 'The one next step in plain words, e.g. "open the export dialog" or "switch to the razor tool"',
            },
            app: {
              type: 'string',
              description: 'Optional app name or bundle id, e.g. "Keynote" or "com.apple.Notes". Defaults to the frontmost app.',
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
          const { step, app, visualCue } = input as { step: string; app?: string; visualCue?: string };
          const tutor = getTutor(context.sessionID);
          try {
            const result = await tutor.highlight(step, app, context.signal, visualCue);
            context.signal.throwIfAborted();
            return { content: format(result) };
          } catch (error) {
            context.signal.throwIfAborted();
            return { content: `Tutor error: ${(error as Error).message}` };
          }
        },
      });
    });

    if (config.directModel) {
      const fallbackModel = config.fallbackModel;
      const fallback = fallbackModel
        ? async (prompt: string, signal?: AbortSignal) => {
            const res = await ctx.experimental.generate.text(
              { model: fallbackModel, prompt },
              signal ? { signal } : undefined
            );
            return res.text;
          }
        : undefined;

      const intentClassifier =
        config.provider === 'live' ? liveIntentClassifier(config.jevModel ?? config.boxModel) : undefined;
      directServer = startDirectServer({
        getTutor,
        defaultApp: config.defaultApp,
        intentClassifier,
        fallback,
        fallbackModel,
      });

      const providerID = Provider.ID.make(DIRECT_PROVIDER_ID);
      const modelID = Model.ID.make(DIRECT_MODEL_ID);
      const baseModel = Model.Info.default(providerID, modelID);
      const tutorModel: Model.Info = {
        ...baseModel,
        name: DIRECT_MODEL_NAME,
        capabilities: {
          ...baseModel.capabilities,
          tools: false,
          input: ['text'],
          output: ['text'],
        },
      };

      const baseURL = directServer.baseURL;
      const authHeader = `Bearer ${directServer.token}`;
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: 'CUA Tutor',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL, apiKey: false },
            headers: { Authorization: authHeader },
          },
          models: [tutorModel],
        });
      });

      await ctx.session.hook(
        'model.request',
        (event) => {
          event.headers['x-tutor-session-id'] = event.sessionID;
          event.headers['x-tutor-kind'] = event.kind;
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
    }

    if (config.injectGuidance) {
      await ctx.session.hook('context', (event) => {
        if (event.model.providerID === DIRECT_PROVIDER_ID) return;
        event.system.push({ type: 'text', text: GUIDANCE });
      });
    }

    if (config.declareMcp) {
      await ctx.mcp.transform((editor) => {
        // Respect a user-defined server with the same name.
        if (!editor.get('cua-driver')) {
          editor.set('cua-driver', { type: 'local', command: [config.driverBinary, 'mcp'] });
        }
      });
    }

    return async () => {
      directServer?.close();
      await Promise.all([...tutors.values()].map((tutor) => tutor.close()));
      tutors.clear();
    };
  },
});
