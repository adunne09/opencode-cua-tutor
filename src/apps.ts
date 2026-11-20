/**
 * Safe macOS application discovery and auto-launch for Tutor mode.
 *
 * SAFETY: Never executes shell strings or arbitrary LLM-supplied command names. Every launch
 * resolves strictly against existing `.app` bundles in standard macOS application directories
 * and spawns `open -a <verified-bundle-path>` with array arguments only.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type InstalledApp = {
  /** Display name derived from `<Name>.app` (without `.app`). */
  name: string;
  /** Verified absolute path to the `.app` bundle on disk. */
  path: string;
  /** Lowercased alphanumeric-only key for fuzzy punctuation/space matching. */
  normalized: string;
};

export type AppLauncher = {
  resolve(query: string): InstalledApp | undefined;
  launch(appPath: string, signal?: AbortSignal): Promise<void>;
};

const APP_ALIASES: Record<string, string> = {
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
  chrome: 'Google Chrome',
  iterm: 'iTerm',
  iterm2: 'iTerm',
  quicktime: 'QuickTime Player',
  activitymonitor: 'Activity Monitor',
  systemsettings: 'System Settings',
  systempreferences: 'System Settings',
  davinci: 'DaVinci Resolve',
  resolve: 'DaVinci Resolve',
  fcp: 'Final Cut Pro',
  fcpx: 'Final Cut Pro',
  premiere: 'Adobe Premiere Pro',
  photoshop: 'Adobe Photoshop',
  aftereffects: 'Adobe After Effects',
};

export const normalizeAppKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^a-z0-9]+/g, '');

export function defaultAppDirs(home = homedir()): string[] {
  return [
    join(home, 'Applications'),
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
  ];
}

/** Discover installed `.app` bundles (up to 2 directory levels deep, never descending inside `.app`). */
export function discoverInstalledApps(dirs = defaultAppDirs()): InstalledApp[] {
  const seen = new Map<string, InstalledApp>();
  const scan = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.name.toLowerCase().endsWith('.app')) {
        const name = entry.name.slice(0, -4);
        const normalized = normalizeAppKey(name);
        if (normalized && !seen.has(normalized)) {
          seen.set(normalized, { name, path: full, normalized });
        }
        continue;
      }
      if (depth > 0 && entry.isDirectory()) {
        scan(full, depth - 1);
      }
    }
  };
  for (const dir of dirs) scan(dir, 1);
  return [...seen.values()];
}

/**
 * Resolve a user/LLM app query strictly against installed macOS `.app` bundles.
 * Matching order: exact case-insensitive -> normalized alphanumeric -> common alias -> unique prefix.
 */
export function resolveInstalledApp(query: string, installed = discoverInstalledApps()): InstalledApp | undefined {
  const clean = query.trim().replace(/\.app$/i, '');
  if (!clean) return undefined;

  const lower = clean.toLowerCase();
  const exact = installed.find((a) => a.name.toLowerCase() === lower);
  if (exact) return exact;

  const norm = normalizeAppKey(clean);
  if (!norm) return undefined;
  const byNorm = installed.find((a) => a.normalized === norm);
  if (byNorm) return byNorm;

  const aliasTarget = APP_ALIASES[norm];
  if (aliasTarget) {
    const aliasNorm = normalizeAppKey(aliasTarget);
    const byAlias = installed.find((a) => a.normalized === aliasNorm || a.normalized.startsWith(aliasNorm));
    if (byAlias) return byAlias;
  }

  // Unique prefix match (e.g. "Adobe Premiere Pro" matching "Adobe Premiere Pro 2026")
  if (norm.length >= 4) {
    const prefixes = installed.filter((a) => a.normalized.startsWith(norm));
    if (prefixes.length === 1) return prefixes[0];
  }

  return undefined;
}

/** Launch a verified `.app` bundle via `open -a <path>` with array args only (no shell). */
export async function launchInstalledApp(appPath: string, signal?: AbortSignal): Promise<void> {
  if (!appPath.endsWith('.app') || !existsSync(appPath)) {
    throw new Error(`Refusing to launch unverified application path: ${appPath}`);
  }
  signal?.throwIfAborted();
  const proc = Bun.spawn(['open', '-a', appPath], { stdout: 'ignore', stderr: 'pipe' });
  const onAbort = () => {
    try {
      proc.kill('SIGTERM');
    } catch {}
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await proc.exited;
    signal?.throwIfAborted();
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      throw new Error(`Failed to open ${appPath}: ${err || `exit ${code}`}`);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function defaultAppLauncher(): AppLauncher {
  return {
    resolve: (query) => resolveInstalledApp(query),
    launch: (appPath, signal) => launchInstalledApp(appPath, signal),
  };
}
