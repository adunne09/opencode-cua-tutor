/**
 * Candidate table for tutor mode. Each candidate is something the user could click, with the screen
 * point (macOS screen points, top-left origin) where the agent cursor should point.
 *
 * Starts from the jev-use recipe's native path (one get_window_state call, the recipe's vendored
 * `parseWindowState` and role table), but is deliberately more permissive than the recipe's
 * `eligibleControls`, because tutor mode only POINTS and never acts:
 *
 * - Elements whose raw role is outside the recipe's closed table (e.g. `AXUnknown`, which is what
 *   egui/AccessKit apps, many custom-drawn UIs and games report) are kept when they expose an
 *   actionable AX action (AXPress, AXPick, AXShowMenu, AXIncrement, ...). They get role class
 *   `control` (or `slider`, `tab`, ... when the role says so).
 * - Labels fall back from `label` to `title`, `description`, `help`, `placeholder`.
 * - Actionable elements with NO label are kept as `visual` candidates when a screenshot is
 *   available: Jev sees a crop of each one (see visual.ts). Without a screenshot they are dropped.
 * - Unlabeled actionable containers that wrap two or more other candidates are dropped (the
 *   children are the real targets), as are the macOS traffic-light window buttons.
 *
 * Coordinates (verified live on macOS with Cua Driver 0.49.11): element `frame` and
 * `window_bounds` are global screen points, top-left origin; `screenshot_frame` is the same rect
 * in screenshot pixels (screenshot may be downscaled, e.g. 1600pt window -> 1366px image). The
 * agent cursor is moved with `move_cursor` WITHOUT a target, which takes screen points, so the
 * pointing target is the frame centre in points.
 */
import { parseWindowState, slug, type NativeObservation } from './vendor/cua/native.js';
import { normalizedRole, roleClass } from './vendor/cua/native_roles.js';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type TutorCandidate = Readonly<{
  id: string;
  /** Accessible name, or '' for a visual-only candidate. */
  label: string;
  /** Short text Jev reads (role class, label, rough position). */
  description: string;
  point: Point;
  /** `ax` = labelled accessibility element; `visual` = unlabeled, identified from its screenshot crop. */
  source: 'ax' | 'visual';
  /** Rough position in words ("top left of the window"), for telling the user where to look. */
  where?: string;
  /** Element rect in screenshot pixels, when known (used to crop). */
  shot?: Rect;
  elementIndex?: number;
  /** Visible frame, retained to validate a later observation before pointing. */
  frame?: Rect;
  role?: string;
  /** Local-only state used by the freshness check (never a cross-snapshot identity). */
  state?: string;
  enabled?: boolean;
  subrole?: string;
}>;

export const RESERVED = ['abstain', 'reobserve', 'inspect'] as const;

/** AX actions that mean "a person can click/operate this". */
export const ACTIONABLE_ACTIONS = new Set([
  'AXPress',
  'AXPick',
  'AXShowMenu',
  'AXConfirm',
  'AXOpen',
  'AXIncrement',
  'AXDecrement',
]);

/** Extra role classes for roles outside the recipe's table, keyed by normalizedRole. */
const EXTRA_ROLE_CLASSES: Readonly<Record<string, string>> = {
  slider: 'slider',
  tab: 'tab',
  tabgroup: 'tab',
  disclosuretriangle: 'disclosure',
  stepper: 'stepper',
  incrementor: 'stepper',
  colorwell: 'color_well',
  cell: 'cell',
  row: 'row',
  outlinerow: 'row',
  image: 'image',
  statictext: 'text',
};

const MACOS_WINDOW_BUTTON_SUBROLES = new Set([
  'AXCloseButton',
  'AXMinimizeButton',
  'AXFullScreenButton',
  'AXZoomButton',
]);
const ROOT_ROLES = new Set(['window', 'application', 'frame', 'menubar']);
const MAX_LABEL = 80;

const str = (v: unknown) => (typeof v === 'string' ? v.split(/\s+/).filter(Boolean).join(' ') : '');

function rectOf(value: unknown): Rect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const f = value as Record<string, unknown>;
  const w = (f.w ?? f.width) as number;
  const h = (f.h ?? f.height) as number;
  if ([f.x, f.y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) && w > 0 && h > 0) {
    return { x: f.x as number, y: f.y as number, w, h };
  }
  return undefined;
}

export const center = (f: Rect): Point => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
const intersects = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
const contains = (r: Rect, p: Point) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  if (!intersects(a, b)) return undefined;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

/** First non-empty accessible name. */
export function labelOf(el: Record<string, unknown>): string {
  for (const key of ['label', 'title', 'description', 'help', 'placeholder']) {
    const v = str(el[key]);
    if (v) return v.slice(0, MAX_LABEL);
  }
  return '';
}

export function isActionable(el: Record<string, unknown>): boolean {
  return Array.isArray(el.actions) && el.actions.some((a) => typeof a === 'string' && ACTIONABLE_ACTIONS.has(a));
}

/** Role class: the recipe's table first, then our extras, then `control` for anything actionable. */
export function classify(el: Record<string, unknown>): string | null {
  const raw = typeof el.role === 'string' ? el.role : '';
  const known = roleClass(raw, 'macos');
  if (known) return known;
  const extra = EXTRA_ROLE_CLASSES[normalizedRole(raw)];
  if (extra && (isActionable(el) || extra === 'slider' || extra === 'tab')) return extra;
  return isActionable(el) ? 'control' : null;
}

/** Window position in words, so text-only Jev can tell "the button top right" from "bottom left". */
function whereIn(p: Point, win?: Rect): string {
  if (!win) return '';
  const fx = (p.x - win.x) / win.w;
  const fy = (p.y - win.y) / win.h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return 'outside the window (menu bar)';
  const v = fy < 0.2 ? 'top' : fy > 0.8 ? 'bottom' : 'middle';
  const h = fx < 0.33 ? 'left' : fx > 0.67 ? 'right' : 'centre';
  return `${v} ${h} of the window`;
}

export type CandidateTable = {
  candidates: TutorCandidate[];
  observation: NativeObservation;
  excluded: Record<string, number>;
  labelled: number;
  visual: number;
  coverage: {
    status: 'complete' | 'unknown' | 'partial';
    reasons: string[];
    nodesPending?: number;
    nodesVisited?: number;
    boundsSource: 'window_bounds' | 'window_root' | 'missing';
  };
};

/**
 * Build the candidate table from one get_window_state payload.
 * @param opts.visual keep unlabeled actionable elements (needs a screenshot for Jev to look at)
 */
export function axCandidates(
  payload: Record<string, unknown>,
  pid: number,
  windowId: number,
  opts: { visual?: boolean } = {}
): CandidateTable {
  const parsed = parseWindowState(payload, pid, windowId);
  // Tree-only Cua reads omit window_bounds. Use this snapshot's single AXWindow root,
  // never a prior screenshot or discovery frame. parseWindowState already checks pid/id.
  const roots = parsed.elements.filter((e) => normalizedRole(String(e.role)) === 'window' && e.parent_index === undefined);
  const explicitBounds = rectOf(payload.window_bounds);
  const rootBounds = roots.length === 1 ? rectOf(roots[0].frame) : undefined;
  const bounds = explicitBounds ?? rootBounds;
  const observation: NativeObservation = { ...parsed,
    windowBounds: bounds ? [bounds.x, bounds.y, bounds.w, bounds.h] : undefined };
  const reasons: string[] = [];
  if (parsed.truncated) reasons.push(String(payload.truncation_reason || 'truncated'));
  if (typeof payload.nodes_pending === 'number' && payload.nodes_pending > 0) reasons.push('nodes_pending');
  const degraded = typeof payload.degraded_reason === 'string' ? payload.degraded_reason : undefined;
  if (degraded || payload.degraded === true) reasons.push(degraded || 'degraded');
  if (!bounds) reasons.push('window_geometry_missing');
  const coverage: CandidateTable['coverage'] = {
    status: reasons.length ? 'partial' : parsed.complete ? 'complete' : 'unknown',
    reasons,
    nodesPending: typeof payload.nodes_pending === 'number' ? payload.nodes_pending : undefined,
    nodesVisited: typeof payload.nodes_visited === 'number' ? payload.nodes_visited : undefined,
    boundsSource: explicitBounds ? 'window_bounds' : rootBounds ? 'window_root' : 'missing',
  };
  const win = observation.windowBounds
    ? { x: observation.windowBounds[0], y: observation.windowBounds[1], w: observation.windowBounds[2], h: observation.windowBounds[3] }
    : undefined;
  const shotW = typeof payload.screenshot_width === 'number' ? payload.screenshot_width : undefined;
  const scale = win && shotW ? shotW / win.w : undefined;
  const scaleY = win && typeof payload.screenshot_height === 'number' ? payload.screenshot_height / win.h : scale;
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => (excluded[reason] = (excluded[reason] ?? 0) + 1);

  const byIndex = new Map<number, Record<string, unknown>>();
  for (const e of observation.elements) if (Number.isInteger(e.element_index)) byIndex.set(e.element_index as number, e as Record<string, unknown>);
  type Pending = { el: Record<string, unknown>; klass: string; label: string; frame: Rect; shot?: Rect; context: string[] };
  const pending: Pending[] = [];
  for (const item of observation.elements) {
    const el = item as Record<string, unknown>;
    const role = normalizedRole(typeof el.role === 'string' ? el.role : '');
    if (ROOT_ROLES.has(role)) continue; // containers, not targets
    if (typeof el.subrole === 'string' && MACOS_WINDOW_BUTTON_SUBROLES.has(el.subrole)) {
      exclude('window_chrome');
      continue;
    }
    const klass = classify(el);
    if (!klass) {
      exclude('not_actionable');
      continue;
    }
    const ancestors: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    let parentIndex = el.parent_index;
    while (Number.isInteger(parentIndex) && !seen.has(parentIndex as number)) {
      seen.add(parentIndex as number);
      const parent = byIndex.get(parentIndex as number);
      if (!parent) break;
      ancestors.push(parent);
      parentIndex = parent.parent_index;
    }
    if ([el, ...ancestors].some((e) => e.enabled === false)) {
      exclude('disabled');
      continue;
    }
    if ([el, ...ancestors].some((e) => e.hidden === true || e.visible === false)) {
      exclude('off_screen');
      continue;
    }
    const originalFrame = rectOf(el.frame);
    // Menu bar items sit outside the window rect but are on screen and clickable.
    const inMenuBar = ancestors.some((p) => normalizedRole(String(p.role ?? '')) === 'menubar');
    let frame = originalFrame && (inMenuBar ? originalFrame : win ? intersectRect(originalFrame, win) : undefined);
    for (const ancestor of ancestors) {
      if (!frame) break;
      if (['scrollarea', 'clipview'].includes(normalizedRole(String(ancestor.role ?? '')))) {
        const bounds = rectOf(ancestor.frame);
        if (bounds) frame = intersectRect(frame, bounds);
      }
    }
    if (!frame || !originalFrame) {
      exclude('off_screen');
      continue;
    }
    if (el.in_web_content === true && !labelOf(el)) {
      exclude('web_content');
      continue;
    }
    const label = labelOf(el);
    if (!label && !opts.visual) {
      exclude('unlabeled');
      continue;
    }
    let shot = rectOf(el.screenshot_frame);
    if (shot) {
      const sx = shot.w / originalFrame.w, sy = shot.h / originalFrame.h;
      shot = { x: shot.x + (frame.x - originalFrame.x) * sx, y: shot.y + (frame.y - originalFrame.y) * sy, w: frame.w * sx, h: frame.h * sy };
    } else if (scale && scaleY && win && !inMenuBar) {
      shot = { x: (frame.x - win.x) * scale, y: (frame.y - win.y) * scaleY, w: frame.w * scale, h: frame.h * scaleY };
    }
    if (!label && !shot) {
      exclude('unlabeled');
      continue;
    }
    const context = ancestors.filter(a => !ROOT_ROLES.has(normalizedRole(String(a.role))))
      .map(a => labelOf(a)).filter(Boolean).slice(0, 3).reverse();
    pending.push({ el, klass, label, frame, shot, context });
  }

  // Unlabeled containers wrapping >= 2 other candidates: the children are the real targets.
  const kept = pending.filter((p) => {
    if (p.label) return true;
    const inside = pending.filter((q) => q !== p && contains(p.frame, center(q.frame))).length;
    if (inside >= 2) {
      exclude('container');
      return false;
    }
    return true;
  });

  const counts = new Map<string, number>();
  const baseOf = (p: Pending) => (p.label ? `ax:${p.klass}:${slug(p.label)}` : `vis:${p.klass}`);
  for (const p of kept) counts.set(baseOf(p), (counts.get(baseOf(p)) ?? 0) + 1);
  const candidates = kept.map((p): TutorCandidate => {
    const base = baseOf(p);
    const index = p.el.element_index as number;
    const id = p.label && counts.get(base) === 1 ? base : `${base}:e${index}`;
    const point = center(p.frame);
    const where = whereIn(point, win);
    const value = typeof p.el.value === 'boolean' || typeof p.el.value === 'number' ? String(p.el.value) : str(p.el.value);
    const subrole = str(p.el.subrole);
    const semanticRole = subrole === 'AXTabButton' ? 'tab (switches view)'
      : subrole === 'AXToggle' ? 'toggle button' : p.klass;
    const state = [
      typeof p.el.enabled === 'boolean' ? `enabled=${p.el.enabled}` : '',
      typeof p.el.selected === 'boolean' ? `selected=${p.el.selected}` : '',
      typeof p.el.checked === 'boolean' ? `checked=${p.el.checked}` : '',
      value && value !== p.label ? `value="${value.slice(0, 40)}"` : '',
    ].filter(Boolean).join(', ');
    const help = str(p.el.help);
    return {
      id: id.slice(0, 64),
      label: p.label,
      description: p.label
        ? `${semanticRole} "${p.label}" [${p.el.role}${subrole ? `/${subrole}` : ''}]${state ? ` (${state})` : ''}` +
          `${p.context.length ? `, inside ${p.context.join(' > ')}` : ''}` +
          `${help && help !== p.label ? `; help: ${help.slice(0, 160)}` : ''}${where ? `, ${where}` : ''}`
        : `unlabeled ${p.klass === 'control' ? 'clickable control' : p.klass}${where ? `, ${where}` : ''}; see its picture`,
      point,
      ...(where ? { where } : {}),
      source: p.label ? 'ax' : 'visual',
      shot: p.shot,
      elementIndex: index,
      frame: p.frame,
      role: String(p.el.role ?? ''),
      state: JSON.stringify({ value: p.el.value, selected: p.el.selected, checked: p.el.checked, expanded: p.el.expanded }),
      enabled: typeof p.el.enabled === 'boolean' ? p.el.enabled : undefined,
      subrole,
    };
  });
  return {
    candidates,
    observation,
    excluded,
    labelled: candidates.filter((c) => c.source === 'ax').length,
    visual: candidates.filter((c) => c.source === 'visual').length,
    coverage,
  };
}
