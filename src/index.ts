/**
 * Auto Approve — extension entry point.
 *
 * Orchestrator: wires the collaborators (config store, host resolver,
 * judge invoker, gate, mode manager) and registers:
 *
 *   - BashGate — custom "bash" tool (shadows the built-in, delegates via
 *     ctx.invokeTool when the judge allows)
 *   - /auto-approve slash command (runtime enabled/display/risk switching)
 *
 * The custom-tool execute() path is not subject to the 30s extension
 * handler budget, so judge analysis has no wall-clock pressure.
 */

import type { AutocompleteItem, ExtensionAPI, ExtensionCtx, LoggerLike } from "./types";
import type { RpcChildFactory } from "./rpc-protocol";
import { Logger } from "./logger";
import { createI18n, detectLang } from "./i18n";
import type { I18n } from "./i18n";
import { ConfigStore } from "./config";
import { HostResolver, type HostLaunchSpec } from "./host";
import { JudgeInvoker, makeDeepChildFactory } from "./judge";
import { ModeManager, DISPLAY_VALUES, BLOCK_RISK_VALUES, FALLBACK_VALUES } from "./mode-manager";
import { BashGate } from "./gate";

/** Test seams for the extension factory. */
export interface AutoApproveOptions {
  logger?: LoggerLike;
  i18n?: I18n;
  /** Override the config directory (tests isolate $HOME here). */
  configDir?: string;
  home?: string;
  cwd?: string;
  /** Injectable host runtime paths for HostResolver. */
  hostRuntime?: { execPath: string; argv1: string | undefined };
  /** Injectable judge child factory (tests use a fake RPC child). */
  childFactory?: RpcChildFactory;
  /** Injectable deep-analysis child factory (tests). */
  deepChildFactory?: RpcChildFactory;
}

type ScheduleStatusClear = (callback: () => void) => void;

let commandStatusVersion = 0;

/** Show slash-command output without requiring a persistent status row. */
export function showCommandResult(
  ctx: ExtensionCtx,
  message: string,
  scheduleClear: ScheduleStatusClear = (callback) => {
    const timeout = setTimeout(callback, 5_000);
    timeout.unref?.();
  },
): void {
  if (ctx.ui.notify) {
    ctx.ui.notify(message, "info");
    return;
  }
  const statusId = "auto-approve-command";
  const version = ++commandStatusVersion;
  ctx.ui.setStatus(statusId, message);
  scheduleClear(() => {
    if (commandStatusVersion === version) {
      ctx.ui.setStatus(statusId, undefined);
    }
  });
}

/** Completion provider for /auto-approve (root items alphabetical). */
export function createAutoApproveCompletionProvider(
  t: I18n,
): (argumentPrefix: string) => AutocompleteItem[] | null {
  const commandCompletions: readonly AutocompleteItem[] = [
    { value: "display", label: "display", description: t.format("cmdDisplayDescription") },
    { value: "fallback", label: "fallback", description: t.format("cmdFallbackDescription") },
    { value: "off", label: "off", description: t.format("cmdOffDescription") },
    { value: "on", label: "on", description: t.format("cmdOnDescription") },
    { value: "risk", label: "risk", description: t.format("cmdRiskDescription") },
    { value: "status", label: "status", description: t.format("cmdStatusDescription") },
  ];
  const displayCompletions: readonly AutocompleteItem[] = [
    { value: "display off", label: "off", description: t.format("cmdDisplayOffDescription") },
    { value: "display marker", label: "marker", description: t.format("cmdDisplayMarkerDescription") },
    { value: "display both", label: "both", description: t.format("cmdDisplayBothDescription") },
  ];
  const riskCompletions: readonly AutocompleteItem[] = [
    { value: "risk medium", label: "medium", description: t.format("cmdRiskMediumDescription") },
    { value: "risk high", label: "high", description: t.format("cmdRiskHighDescription") },
  ];
  const fallbackCompletions: readonly AutocompleteItem[] = [
    { value: "fallback ask", label: "ask", description: t.format("cmdFallbackAskDescription") },
    { value: "fallback block", label: "block", description: t.format("cmdFallbackBlockDescription") },
  ];

  return (argumentPrefix: string): AutocompleteItem[] | null => {
    const normalized = argumentPrefix.trimStart().toLowerCase();
    if (normalized.startsWith("display ")) {
      const prefix = normalized.slice("display ".length).trimStart();
      const matches = displayCompletions.filter((item) => item.label.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    }
    if (normalized.startsWith("fallback ")) {
      const prefix = normalized.slice("fallback ".length).trimStart();
      const matches = fallbackCompletions.filter((item) => item.label.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    }
    if (normalized.startsWith("risk ")) {
      const prefix = normalized.slice("risk ".length).trimStart();
      const matches = riskCompletions.filter((item) => item.label.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    }
    if (normalized.includes(" ")) return null;
    const matches = commandCompletions.filter((item) => item.value.startsWith(normalized));
    return matches.length > 0 ? matches : null;
  };
}

/** The current settings as one localized line for the status command. */
function statusText(modeManager: ModeManager, t: I18n): string {
  if (!modeManager.isEnabled()) return t.format("statusDisabled");
  return t.format("statusEnabled", modeManager.getModel(), modeManager.getDisplay(), modeManager.getBlockRisk());
}

/** Register the /auto-approve slash command. */
export function registerAutoApproveCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  modeManager: ModeManager,
  t: I18n,
): void {
  pi.registerCommand("auto-approve", {
    description: t.format("cmdDescription"),
    getArgumentCompletions: createAutoApproveCompletionProvider(t),
    handler: (args: unknown, ctx: ExtensionCtx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "") {
        const next = !modeManager.isEnabled();
        modeManager.setEnabled(next);
        showCommandResult(ctx, next ? t.format("switchEnabled") : t.format("switchDisabled"));
      } else if (arg === "on") {
        modeManager.setEnabled(true);
        showCommandResult(ctx, t.format("switchEnabled"));
      } else if (arg === "off") {
        modeManager.setEnabled(false);
        showCommandResult(ctx, t.format("switchDisabled"));
      } else if (arg === "status") {
        showCommandResult(ctx, statusText(modeManager, t));
      } else if (arg === "display") {
        showCommandResult(ctx, t.format("displayStatus", modeManager.getDisplay()));
      } else if (arg === "risk") {
        showCommandResult(ctx, t.format("riskStatus", modeManager.getBlockRisk()));
      } else if (arg.startsWith("display ")) {
        const value = arg.slice("display ".length).trim();
        if (!(DISPLAY_VALUES as readonly string[]).includes(value)) {
          showCommandResult(ctx, t.format("help"));
          return;
        }
        modeManager.setDisplay(value);
        showCommandResult(ctx, t.format("switchDisplay", value));
      } else if (arg.startsWith("risk ")) {
        const value = arg.slice("risk ".length).trim();
        if (!(BLOCK_RISK_VALUES as readonly string[]).includes(value)) {
          showCommandResult(ctx, t.format("help"));
          return;
        }
        modeManager.setBlockRisk(value);
        showCommandResult(ctx, t.format("switchRisk", value));
      } else if (arg === "fallback") {
        showCommandResult(ctx, t.format("fallbackStatus", modeManager.getFallback()));
      } else if (arg.startsWith("fallback ")) {
        const value = arg.slice("fallback ".length).trim();
        if (!(FALLBACK_VALUES as readonly string[]).includes(value)) {
          showCommandResult(ctx, t.format("help"));
          return;
        }
        modeManager.setFallback(value);
        showCommandResult(ctx, t.format("fallbackSwitched", value));
      } else {
        showCommandResult(ctx, t.format("help"));
      }
    },
  });
}

/**
 * Auto Approve extension orchestrator.
 *
 * Thin by design: each concern lives in its own module; this class only
 * constructs the collaborators and registers the shadowed bash tool, the
 * slash command, and the session-shutdown hook.  It ALWAYS registers — the
 * enabled flag gates behavior per call, so `/auto-approve` can toggle it
 * at runtime in a host that loaded the plugin with enabled=false.
 */
export class AutoApprove {
  readonly configStore: ConfigStore;
  readonly modeManager: ModeManager;
  readonly invoker: JudgeInvoker;
  readonly deepInvoker: JudgeInvoker;
  private readonly logger: LoggerLike;
  private readonly t: I18n;
  private readonly gate: BashGate;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    options: AutoApproveOptions = {},
  ) {
    this.logger = options.logger ?? new Logger();
    this.t = options.i18n ?? createI18n(detectLang());
    this.configStore = new ConfigStore(this.logger, options.configDir, options.home, options.cwd);
    const modeManager = new ModeManager(this.configStore);
    this.modeManager = modeManager;

    const host = new HostResolver(this.logger, options.hostRuntime);
    const launch: HostLaunchSpec =
      host.resolve() ??
      (this.logger.log("auto-approve: host unresolved; judge assessments will fail closed"),
      { command: "auto-approve-unavailable", prefixArgs: [] });
    const invokerOptions = {
      idleMs: this.configStore.config.idleMs,
      analysisTimeoutMs: this.configStore.config.timeoutMs,
    };
    this.invoker = new JudgeInvoker(launch, this.logger, invokerOptions, options.childFactory);
    this.deepInvoker = new JudgeInvoker(
      launch,
      this.logger,
      invokerOptions,
      options.deepChildFactory ?? makeDeepChildFactory(launch),
    );
    this.gate = new BashGate({
      config: this.configStore,
      i18n: this.t,
      logger: this.logger,
      invoker: this.invoker,
      deepInvoker: this.deepInvoker,
    });
  }

  /** Register the shadowed bash tool, slash command, and shutdown hook. */
  register(): void {
    this.gate.register(this.pi);
    registerAutoApproveCommand(this.pi, this.modeManager, this.t);
    this.pi.on("session_shutdown", async () => {
      if (this.disposed) return;
      this.disposed = true;
      await this.invoker.dispose();
      await this.deepInvoker.dispose();
    });
  }
}

// Extension host expects a default export: (pi) => void, registering hooks.
export default function autoApprove(pi: ExtensionAPI): void {
  new AutoApprove(pi).register();
}