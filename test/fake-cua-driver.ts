#!/usr/bin/env bun
/**
 * Fake `cua-driver mcp` for tests. Four apps on screen: a terminal (frontmost, where OpenCode runs),
 * "DemoEditor" (a video-editor-like window), "Notes", and "EguiCraft" (an egui/AccessKit-style app:
 * every control is AXUnknown with an AXPress action and no name, like FilmCraft; its window is
 * 1600x1000 pt at (100,50) and its screenshot is downscaled to 800x500 px, so element frames are
 * screen points and screenshot_frame is half that). Logs every call to FAKE_DRIVER_LOG.
 * FAKE_ACTIVE_APP sets which app list_apps reports as active (default: Ghostty).
 */
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PNG } from 'pngjs';
import { z } from 'zod';

const log = process.env.FAKE_DRIVER_LOG!;
if (process.env.FAKE_DRIVER_PID_LOG) appendFileSync(process.env.FAKE_DRIVER_PID_LOG, `${process.pid}\n`);
const active = process.env.FAKE_ACTIVE_APP ?? 'Ghostty';
const server = new McpServer({ name: 'fake-cua-driver', version: '0' });
const record = (name: string, args: unknown) => appendFileSync(log, JSON.stringify({ name, args }) + '\n');
const ok = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data });

const el = (i: number, role: string, label: string, x: number, y: number, parent = 0) => ({
  element_index: i, element_token: `s1:${i}`, role, label, frame: { x, y, w: 40, h: 20 }, parent_index: parent, depth: 1,
});

const apps = [
  { name: 'Ghostty', bundle_id: 'com.mitchellh.ghostty', pid: 10, window_id: 1, z: 9, x: 0, controls: [el(1, 'AXButton', 'New Tab', 20, 20)] },
  {
    name: 'DemoEditor', bundle_id: 'dev.example.demoeditor', pid: 42, window_id: 7, z: 3, x: 0,
    controls: [
      el(1, 'AXButton', 'Razor Tool', 100, 200),
      el(2, 'AXButton', 'Selection Tool', 150, 200),
      el(3, 'AXButton', 'Export Media', 900, 40),
      el(4, 'AXButton', 'Add Transition', 400, 200),
      el(5, 'AXButton', 'Import Media', 960, 40),
    ],
  },
  {
    name: 'Notes', bundle_id: 'com.apple.Notes', pid: 55, window_id: 9, z: 2, x: 200,
    controls: [el(1, 'AXButton', 'New Note', 300, 60), el(2, 'AXButton', 'Share Note', 500, 60)],
  },
];

// EguiCraft: three unnamed AXUnknown buttons + a container wrapping them + traffic lights + a menu bar.
const unk = (i: number, x: number, y: number, w = 28, h = 28) => ({
  element_index: i, element_token: `s1:${i}`, role: 'AXUnknown', subrole: 'AXUnknown', actions: ['AXPress'], enabled: true,
  frame: { x, y, w, h }, screenshot_frame: { x: (x - 100) / 2, y: (y - 50) / 2, w: w / 2, h: h / 2 }, parent_index: 0, depth: 1,
});
const egui = {
  name: 'EguiCraft', bundle_id: 'dev.example.eguicraft', pid: 77, window_id: 11, z: 1, x: 100,
  controls: [
    unk(1, 100, 50, 1600, 40), // header bar container (wraps 2 and 3)
    unk(2, 200, 56), unk(3, 240, 56),
    unk(4, 900, 600),
    { element_index: 5, element_token: 's1:5', role: 'AXButton', subrole: 'AXCloseButton', actions: ['AXPress'], frame: { x: 108, y: 58, w: 16, h: 16 }, parent_index: 0, depth: 1 },
    { element_index: 6, element_token: 's1:6', role: 'AXUnknown', actions: [], frame: { x: 300, y: 300, w: 50, h: 50 }, parent_index: 0, depth: 1 },
    { element_index: 7, element_token: 's1:7', role: 'AXMenuBar', actions: ['AXCancel'], frame: { x: 0, y: 0, w: 2560, h: 30 }, depth: 0 },
    { element_index: 8, element_token: 's1:8', role: 'AXMenuBarItem', title: 'File', actions: ['AXPress', 'AXPick'], frame: { x: 120, y: 0, w: 40, h: 30 }, parent_index: 7, depth: 1 },
    { element_index: 9, element_token: 's1:9', role: 'AXUnknown', description: 'Play', actions: ['AXPress'], enabled: true, frame: { x: 700, y: 400, w: 20, h: 20 }, parent_index: 0, depth: 1 },
  ],
};
const shotPng = (() => {
  const p = new PNG({ width: 800, height: 500 });
  p.data.fill(60);
  return PNG.sync.write(p).toString('base64');
})();

const window = (a: (typeof apps)[number]) => ({
  window_id: a.window_id, pid: a.pid, app_name: a.name, title: `${a.name} window`, layer: 0,
  bounds: { x: a.x, y: 0, width: 1600, height: 1000 }, z_index: a.z, is_on_screen: true, on_current_space: true,
});

apps.push(egui as never);

const session = { session: z.string().optional() };
const cursors = new Map<string, { enabled?: boolean; position?: { x: number; y: number } }>();
const schemas: Record<string, any> = {
  list_apps: z.object({ ...session }).strict(),
  list_windows: z.object({ app: z.string().optional(), pid: z.number().optional(), on_screen_only: z.boolean().optional(), ...session }).strict(),
  get_window_state: z.object({
    pid: z.number(), window_id: z.number(), tree_format: z.literal('elements'),
    max_elements: z.number(), timeout_ms: z.number(), include_screenshot: z.boolean(),
    full_output: z.literal(true), max_depth: z.number(),
    max_dimension: z.number().optional(), max_image_dimension: z.number().optional(), screenshot_format: z.literal('png').optional(), ...session,
  }).strict(),
  move_cursor: z.object({ x: z.number(), y: z.number(), session: z.string() }).strict(),
  set_agent_cursor_enabled: z.object({ session: z.string(), enabled: z.boolean() }).strict(),
  start_session: z.object({ session: z.string() }).strict(),
  get_agent_cursor_state: z.object({ session: z.string() }).strict(),
  click: z.object({}).strict(),
};
for (const name of ['list_apps', 'list_windows', 'get_window_state', 'move_cursor', 'set_agent_cursor_enabled', 'start_session', 'get_agent_cursor_state', 'click']) {
  server.registerTool(name, { inputSchema: schemas[name] }, async (args: any) => {
    record(name, args);
    if (name === 'set_agent_cursor_enabled') cursors.set(args.session, { ...cursors.get(args.session), enabled: args.enabled });
    if (name === 'move_cursor') cursors.set(args.session, { ...cursors.get(args.session), position: { x: args.x, y: args.y } });
    if (name === 'get_agent_cursor_state') return ok({ session: args.session, ...cursors.get(args.session) });
    if (name === 'list_apps') {
      return ok({ apps: apps.map((a) => ({ name: a.name, bundle_id: a.bundle_id, pid: a.pid, running: true, active: a.name === active })) });
    }
    if (name === 'list_windows') {
      const q = typeof args.app === 'string' ? args.app.toLowerCase() : undefined;
      const hits = apps.filter((a) => (!args.pid || a.pid === args.pid) && (!q || a.name.toLowerCase().includes(q) || a.bundle_id.toLowerCase() === q));
      return ok({ windows: hits.map(window) });
    }
    if (name === 'get_window_state') {
      const a = apps.find((x) => x.pid === args.pid)!;
      if (a.name === 'EguiCraft') {
        const data = {
          pid: a.pid, window_id: a.window_id, snapshot_id: 's1', capture_id: 'c1', elements_complete: true,
          window_bounds: { x: 100, y: 50, width: 1600, height: 1000 }, screenshot_width: 800, screenshot_height: 500,
          elements: [{ element_index: 0, role: 'AXWindow', label: a.name, actions: ['AXRaise'], frame: { x: 100, y: 50, w: 1600, h: 1000 }, depth: 0 }, ...a.controls],
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }, ...(args.include_screenshot ? [{ type: 'image' as const, data: shotPng, mimeType: 'image/png' }] : [])], structuredContent: data };
      }
      return ok({
        pid: a.pid, window_id: a.window_id, snapshot_id: 's1', capture_id: 'c1', elements_complete: true,
        window_bounds: { x: a.x, y: 0, width: 1600, height: 1000 },
        elements: [{ element_index: 0, role: 'AXWindow', label: a.name, frame: { x: a.x, y: 0, w: 1600, h: 1000 }, depth: 0 }, ...a.controls],
      });
    }
    return ok({ ok: true });
  });
}
await server.connect(new StdioServerTransport());
