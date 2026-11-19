/** Runtime configuration. Every value can come from plugin options or the environment (CUA_TUTOR_*). */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Apps that are never "the app you're learning": where you talk to OpenCode or dictate.
 * When no app is named, the tutor uses the frontmost on-screen window of any other app.
 */
export const DEFAULT_IGNORED_APPS = [
  'OpenCode',
  'Terminal',
  'iTerm2',
  'Ghostty',
  'WezTerm',
  'Alacritty',
  'kitty',
  'Warp',
];

export type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

/** Default System-2 fallback when Direct Tutor Mode (`cua-tutor/tutor`) misses on System 1. */
export const DEFAULT_FALLBACK_MODEL = 'opencode-go/glm-5.3-flash#high';

/** Parse `"provider/model#variant"` or `{ providerID, id, variant? }`; `"none"` / `"false"` / `false` disables. */
export function parseModelRef(value: unknown): ModelRef | undefined {
  if (value === false || value === null || value === undefined) return undefined;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const providerID = typeof o.providerID === 'string' ? o.providerID.trim() : '';
    const id = typeof o.id === 'string' ? o.id.trim() : typeof o.model === 'string' ? o.model.trim() : '';
    const variant = typeof o.variant === 'string' && o.variant.trim() ? o.variant.trim() : undefined;
    return providerID && id ? { providerID, id, ...(variant ? { variant } : {}) } : undefined;
  }
  const raw = String(value).trim();
  if (!raw || ['0', 'false', 'off', 'none'].includes(raw.toLowerCase())) return undefined;
  const hash = raw.indexOf('#');
  const base = hash >= 0 ? raw.slice(0, hash).trim() : raw;
  const variant = hash >= 0 ? raw.slice(hash + 1).trim() || undefined : undefined;
  const slash = base.indexOf('/');
  if (slash <= 0 || slash === base.length - 1) {
    throw new Error(`Invalid model reference "${raw}"; expected "providerID/modelID" or "providerID/modelID#variant".`);
  }
  return {
    providerID: base.slice(0, slash).trim(),
    id: base.slice(slash + 1).trim(),
    ...(variant ? { variant } : {}),
  };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}

export type TutorConfig = {
  /** Pin the tutor to one app (name or bundle id). Unset = frontmost app that isn't ignored. */
  defaultApp?: string;
  /** App names skipped when picking the frontmost app (case-insensitive exact match). */
  ignoreApps: string[];
  /** Absolute cua-driver binary (the OpenCode background service may not have ~/.local/bin on PATH). */
  driverBinary: string;
  /** Public Cua Driver session label that owns the agent cursor. */
  driverSession: string;
  /** `mock` is an explicitly selected development-only word matcher. */
  provider: 'live' | 'mock';
  jevModel?: string;
  minProbability: number;
  minMargin: number;
  deadlineMs: number;
  maxRequests: number;
  concurrency: number;
  /**
   * Allow Jev visual fallback via coarse-to-fine Tile -> Zoom Box when no named AX control fits
   * (unlabeled controls, painted text tabs, or canvas-drawn elements with no AX node). Uses
   * TypeSafe's experimental image + Box input (`TypeSafe-Danger-Zone-Images: true`).
   * Off = text-only named AX controls only.
   */
  visual: boolean;
  /** Model for Box/visual fallback (Box requires Jev 1.14+; defaults to `jev-latest`). */
  boxModel: string;
  /** Run a 3-Noul red-box self-verification check after Box localization to catch drifts onto neighbors. */
  verifyBox: boolean;
  /** Companion Noul threshold for accepting a direct named AX match without visual fallback. */
  minExactInNamed: number;
  /** Legacy alias kept for compatibility; coarse-to-fine Box runs automatically on visual fallback. */
  locate: boolean;
  locateModel: string;
  /** Register the direct System-1 virtual model `Tutor` (`cua-tutor/tutor`) in OpenCode's model picker. */
  directModel: boolean;
  /** Optional System-2 fallback model invoked only when `Tutor` (System 1) misses (reobserve/abstain/unsure). */
  fallbackModel?: ModelRef;
  /** Inject the tutor guidance into every agent-loop system prompt. */
  injectGuidance: boolean;
  /** Declare the `cua-driver` MCP server (only if you haven't defined one). */
  declareMcp: boolean;
};

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const list = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
};

/** cua-driver's installer puts the binary in ~/.local/bin by default (or /usr/local/bin). */
export function resolveDriverBinary(explicit: unknown, home = homedir()): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  for (const candidate of [join(home, '.local/bin/cua-driver'), '/usr/local/bin/cua-driver', '/opt/homebrew/bin/cua-driver']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cua-driver';
}

export function loadConfig(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): TutorConfig {
  const pick = (key: string, envKey: string) => options[key] ?? env[envKey];
  const provider = String(pick('provider', 'CUA_TUTOR_PROVIDER') ?? 'live');
  if (provider !== 'live' && provider !== 'mock') throw new Error('CUA Tutor provider must be live or explicitly mock (development only).');
  const bounded = (key: string, envKey: string, fallback: number, low: number, high: number) => {
    const value = num(pick(key, envKey)) ?? fallback;
    if (value < low || value > high) throw new Error(`${key} must be between ${low} and ${high}`);
    return value;
  };
  const app = pick('app', 'CUA_TUTOR_APP');
  return {
    defaultApp: typeof app === 'string' && app.trim() ? app.trim() : undefined,
    ignoreApps: list(pick('ignoreApps', 'CUA_TUTOR_IGNORE_APPS')) ?? DEFAULT_IGNORED_APPS,
    driverBinary: resolveDriverBinary(pick('driverBinary', 'CUA_DRIVER_BIN'), env.HOME || homedir()),
    driverSession: String(pick('driverSession', 'CUA_TUTOR_DRIVER_SESSION') ?? 'cua-tutor'),
    provider,
    jevModel: (pick('jevModel', 'CUA_TUTOR_JEV_MODEL') as string | undefined) || undefined,
    // Conservative operating defaults, not a calibrated accuracy guarantee.
    minProbability: bounded('minProbability', 'CUA_TUTOR_MIN_PROBABILITY', 0.7, 0, 1),
    minMargin: bounded('minMargin', 'CUA_TUTOR_MIN_MARGIN', 0.1, 0, 1),
    deadlineMs: bounded('deadlineMs', 'CUA_TUTOR_DEADLINE_MS', 20_000, 100, 60_000),
    maxRequests: Math.floor(bounded('maxRequests', 'CUA_TUTOR_MAX_REQUESTS', 12, 1, 64)),
    concurrency: Math.floor(bounded('concurrency', 'CUA_TUTOR_CONCURRENCY', 3, 1, 8)),
    visual: !['0', 'false', 'off'].includes(String(pick('visual', 'CUA_TUTOR_VISUAL') ?? 'true').toLowerCase()),
    boxModel: String(pick('boxModel', 'CUA_TUTOR_BOX_MODEL') ?? pick('locateModel', 'CUA_TUTOR_LOCATE_MODEL') ?? pick('jevModel', 'CUA_TUTOR_JEV_MODEL') ?? 'jev-1.14.0'),
    verifyBox: !['0', 'false', 'off'].includes(String(pick('verifyBox', 'CUA_TUTOR_VERIFY_BOX') ?? 'true').toLowerCase()),
    minExactInNamed: bounded('minExactInNamed', 'CUA_TUTOR_MIN_EXACT', 0.65, 0, 1),
    locate: !['0', 'false', 'off'].includes(String(pick('locate', 'CUA_TUTOR_LOCATE') ?? 'false').toLowerCase()),
    locateModel: String(pick('locateModel', 'CUA_TUTOR_LOCATE_MODEL') ?? 'jev-1.14.0'),
    directModel: !['0', 'false', 'off'].includes(String(pick('directModel', 'CUA_TUTOR_DIRECT_MODEL') ?? 'true').toLowerCase()),
    fallbackModel: parseModelRef(pick('fallbackModel', 'CUA_TUTOR_FALLBACK_MODEL') ?? DEFAULT_FALLBACK_MODEL),
    injectGuidance: options.injectGuidance !== false,
    declareMcp: options.declareMcp !== false,
  };
}
