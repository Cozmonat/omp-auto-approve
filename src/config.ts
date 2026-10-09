/**
 * Auto Approve — configuration.
 *
 * Loads JSON config from ~/.omp/agent/auto-approve.json (or ~/.pi/agent/...)
 * and deep-merges over defaults.  OMP plugin settings (omp plugin config /
 * the settings UI) win over the config file; the config file wins over
 * defaults.  Encapsulates config + paths so callers don't repeat
 * directory-resolution logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LoggerLike } from "./types";

/** Where approval markers appear for auto-approved operations.
 *  Blocked verdicts are always visible regardless of this setting. */
export type DisplayMode = "off" | "marker" | "both";
/** Minimum judge risk level that blocks an operation. */
export type BlockRisk = "medium" | "high";
/** Policy for crossed risk thresholds and unusable verdicts. */
export type FallbackMode = "ask" | "block";

export interface AutoApproveConfig {
  /** Master switch. false = pass-through to the native bash tool. */
  enabled: boolean;
  /** Where approval markers appear: off | marker | both. */
  display: DisplayMode;
  /** Judge risk level at or above which an operation is blocked. */
  blockRisk: BlockRisk;
  /** Policy when the risk threshold is crossed or no usable verdict
   *  arrives: "ask" presents a dialog with the deep-analysis summary only
   *  when the full subject was assessed and a summary exists (otherwise
   *  blocks); "block" denies without asking (fail-closed default). */
  fallback: FallbackMode;
  /** Per-assessment window in ms. 0 = no timeout. Default 30s. */
  timeoutMs: number;
  /** Idle lifetime of the persistent judge child, in ms.
   *  0 = keep alive until session end. Default 10 minutes. */
  idleMs: number;
  /** Session-context budget for the judge prompts: how many characters of
   *  conversation excerpts (original task, latest request, recent plan
   *  text) the models see as background for WHY the command runs.
   *  0 = command-only judgement (no conversation context).  Default 3000. */
  contextMaxChars: number;
  /** Budget for script analysis: max characters of each referenced script
   *  file's contents sent to the judge prompts, so the models judge what
   *  a script the command runs actually does. 0 = no script files read.
   *  Default 4000. */
  scriptMaxChars: number;
}

export const DEFAULT_CONFIG: AutoApproveConfig = {
  enabled: true,
  display: "both",
  blockRisk: "high",
  fallback: "block",
  timeoutMs: 30_000,
  idleMs: 600_000,
  contextMaxChars: 3_000,
  scriptMaxChars: 4_000,
};

/** Merge user config over defaults; every key falls back to its default
 *  when absent or malformed, so a hand-edited file can never produce an
 *  invalid runtime config. */
export function mergeConfig(user: unknown): AutoApproveConfig {
  if (!user || typeof user !== "object") return { ...DEFAULT_CONFIG };
  const u = user as Record<string, unknown>;
  return {
    enabled: typeof u.enabled === "boolean" ? u.enabled : DEFAULT_CONFIG.enabled,
    display:
      u.display === "off" || u.display === "marker" || u.display === "both"
        ? u.display
        : DEFAULT_CONFIG.display,
    blockRisk: u.blockRisk === "medium" ? "medium" : DEFAULT_CONFIG.blockRisk,
    fallback: u.fallback === "ask" || u.fallback === "block" ? u.fallback : DEFAULT_CONFIG.fallback,
    timeoutMs: typeof u.timeoutMs === "number" && u.timeoutMs >= 0 ? u.timeoutMs : DEFAULT_CONFIG.timeoutMs,
    idleMs: typeof u.idleMs === "number" && u.idleMs >= 0 ? u.idleMs : DEFAULT_CONFIG.idleMs,
    contextMaxChars:
      typeof u.contextMaxChars === "number" && u.contextMaxChars >= 0
        ? u.contextMaxChars
        : DEFAULT_CONFIG.contextMaxChars,
    scriptMaxChars:
      typeof u.scriptMaxChars === "number" && u.scriptMaxChars >= 0
        ? u.scriptMaxChars
        : DEFAULT_CONFIG.scriptMaxChars,
  };
}

/** Package name under which OMP stores this plugin's settings
 *  (omp-plugins.lock.json / plugin-overrides.json). */
const OMP_PLUGIN_NAME = "auto-approve";

/** Setting keys this plugin honors from OMP's plugin-settings stores.
 *  Must stay in sync with the `omp.settings` schema in package.json. */
export const HOST_SETTING_KEYS: readonly string[] = ["enabled", "display", "blockRisk", "fallback"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and parse a JSON file; undefined when absent or unreadable. */
function readJsonFile(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** OMP plugins data root (~/.omp/plugins, or $XDG_DATA_HOME/omp/plugins once
 *  the XDG `omp` root exists).  Mirrors the host's plugins-dir resolution.
 *  The optional `home` parameter is for test isolation. */
export function getPluginsDir(home?: string): string {
  const base = home ?? process.env.HOME ?? os.homedir();
  if (process.platform === "linux" || process.platform === "darwin") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) {
      const appRoot = path.join(xdg, "omp");
      if (fs.existsSync(appRoot)) return path.join(appRoot, "plugins");
    }
  }
  return path.join(base, ".omp", "plugins");
}

/** Read OMP's plugin settings for this package (host-owned stores, read-only).
 *  Project overrides (<cwd>/.omp/plugin-overrides.json, then .pi) win over
 *  the user lockfile (<plugins dir>/omp-plugins.lock.json).  Never throws;
 *  returns {} when the stores are absent or unreadable. */
export function readHostPluginSettings(cwd: string = process.cwd(), home?: string): Record<string, unknown> {
  let user: Record<string, unknown> = {};
  const lock = readJsonFile(path.join(getPluginsDir(home), "omp-plugins.lock.json"));
  if (isPlainObject(lock) && isPlainObject(lock.settings) && isPlainObject(lock.settings[OMP_PLUGIN_NAME])) {
    user = lock.settings[OMP_PLUGIN_NAME];
  }
  for (const base of [".omp", ".pi"]) {
    const overrides = readJsonFile(path.join(cwd, base, "plugin-overrides.json"));
    if (!isPlainObject(overrides) || !isPlainObject(overrides.settings)) continue;
    if (isPlainObject(overrides.settings[OMP_PLUGIN_NAME])) {
      return { ...user, ...overrides.settings[OMP_PLUGIN_NAME] };
    }
  }
  return user;
}

/** Apply OMP plugin settings over a merged config (host settings win).
 *  Values failing the type/enum check are ignored, so a stale or
 *  mistyped store entry can never break config loading. */
function applyHostSettings(
  config: AutoApproveConfig,
  host: Record<string, unknown>,
  logger?: LoggerLike,
): AutoApproveConfig {
  const applied: string[] = [];
  if (typeof host.enabled === "boolean") {
    config.enabled = host.enabled;
    applied.push("enabled");
  }
  if (host.display === "off" || host.display === "marker" || host.display === "both") {
    config.display = host.display;
    applied.push("display");
  }
  if (host.blockRisk === "medium" || host.blockRisk === "high") {
    config.blockRisk = host.blockRisk;
    applied.push("blockRisk");
  }
  if (host.fallback === "ask" || host.fallback === "block") {
    config.fallback = host.fallback;
    applied.push("fallback");
  }
  if (applied.length > 0) logger?.log(`host plugin settings applied: ${applied.join(", ")}`);
  return config;
}

/** Which surfaces show an auto-approval marker for a completed assessment.
 *  Blocked verdicts bypass this mapping entirely (always visible). */
export function displaySurfaces(
  config: Pick<AutoApproveConfig, "display">,
): { marker: boolean; notify: boolean } {
  if (config.display === "off") return { marker: false, notify: false };
  if (config.display === "marker") return { marker: true, notify: false };
  return { marker: true, notify: true };
}

/** Resolve config directory: $HOME/.omp/agent or $HOME/.pi/agent.
 *  Reads the runtime HOME env (falling back to os.homedir()) so a test
 *  that swaps process.env.HOME is isolated from the developer's real
 *  config — os.homedir() is cached at process start and would leak it. */
export function getConfigDir(): string {
  const home = process.env.HOME || os.homedir();
  const ompDir = path.join(home, ".omp", "agent");
  const piDir = path.join(home, ".pi", "agent");
  if (fs.existsSync(ompDir)) return ompDir;
  if (fs.existsSync(piDir)) return piDir;
  return ompDir;
}

/** Keys that may be changed at runtime (written back to disk on persist). */
const PERSISTABLE_KEYS: readonly (keyof AutoApproveConfig)[] = [
  "enabled", "display", "blockRisk", "fallback",
];

/**
 * Configuration store.  Loads once at construction; exposes typed accessors,
 * runtime mutation (update) and selective write-back (persist) so slash
 * commands can change approval settings without clobbering user-edited
 * fields in the config file.
 */
export class ConfigStore {
  readonly config: AutoApproveConfig;
  readonly configPath: string;
  /** Runtime-changed persistable keys: string-keyed membership table. */
  private dirty: Record<string, true> = {};

  constructor(
    private readonly logger?: LoggerLike,
    configDir?: string,
    private readonly home?: string,
    private readonly cwd?: string,
  ) {
    const dir = configDir ?? getConfigDir();
    this.configPath = path.join(dir, "auto-approve.json");
    this.config = this.load();
  }

  private load(): AutoApproveConfig {
    let raw: unknown;
    try {
      if (fs.existsSync(this.configPath)) {
        raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
        this.logger?.log(`config loaded: ${this.configPath}`);
      } else {
        raw = undefined;
      }
    } catch (e) {
      this.logger?.log(`config load failed, using defaults: ${e instanceof Error ? e.message : String(e)}`);
      raw = undefined;
    }
    return applyHostSettings(mergeConfig(raw), readHostPluginSettings(this.cwd, this.home), this.logger);
  }

  /** Apply a partial change to the in-memory config (immediate effect).
   *  Only persistable keys are remembered; anything else is ignored so a
   *  runtime write can never silently persist a file-only field. */
  update(partial: Partial<AutoApproveConfig>): void {
    for (const key of PERSISTABLE_KEYS) {
      const value = partial[key];
      if (value === undefined) continue;
      this.dirty[key] = true;
      Object.assign(this.config, { [key]: value });
    }
    this.logger?.log(`config updated: ${Object.keys(this.dirty).join(",")}`);
  }

  /** Write dirty runtime changes back to the config file, preserving every
   *  other user-authored key.  Never throws — persistence is best-effort. */
  persist(): void {
    if (Object.keys(this.dirty).length === 0) return;
    try {
      let raw: Record<string, unknown> = {};
      if (fs.existsSync(this.configPath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
        if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
      }
      for (const key of Object.keys(this.dirty)) raw[key] = this.config[key as keyof AutoApproveConfig];
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2), "utf-8");
      this.dirty = {};
      this.logger?.log(`config persisted: ${this.configPath}`);
    } catch (e) {
      this.logger?.log(`config persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}