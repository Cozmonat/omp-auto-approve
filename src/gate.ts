/**
 * Auto Approve — bash gate.
 *
 * BashGate shadows the native `bash` built-in via registerTool.  Two-stage
 * decision: a first-pass risk verdict from the judge model through the
 * persistent RPC child (judge.ts), then pure policy (policy.ts).  Below the
 * threshold the call delegates to the native tool via ctx.invokeTool
 * (inheriting shell path resolution, env hardening, PTY and output
 * truncation).  Above the threshold: fallback=block denies; fallback=ask
 * consults a deep-analysis model (tiny, then smol), whose verdict either
 * auto-approves a cleared command or, on real risk, is reviewed by the user
 * in a dialog.  Headless sessions (no UI) never prompt — even with
 * fallback=ask they block, and the denial text tells the model
 * why (judge declined / risk rating / judge unavailable, plus a headless
 * note) so it can choose a safer alternative.
 *
 * Surfaces per display setting: marker = streamed tool-card line,
 * notify = chat toast (UI sessions only).  Blocked verdicts are always
 * toasted regardless of the display setting.
 */
import {
  buildJudgePrompt,
  runDeepAnalysis,
  type JudgeInvoker,
} from "./judge";
import { SessionContextGatherer } from "./context";
import { displaySurfaces } from "./config";
import type { AutoApproveConfig, ConfigStore } from "./config";
import type { I18n } from "./i18n";
import { decide } from "./policy";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCtx,
  JudgeOutcome,
  JudgeVerdict,
  LoggerLike,
  ZodLike,
} from "./types";

export interface BashGateDeps {
  /** Runtime config store (enabled / display / blockRisk / fallback / models / timeouts). */
  config: ConfigStore;
  /** Session-context gatherer: compact conversation excerpts given to both
   *  models as untrusted background for WHY the command runs. */
  contextGatherer: SessionContextGatherer;
  i18n: I18n;
  logger: LoggerLike;
  /** Persistent judge child driver (verdict pass, JSON). */
  invoker: JudgeInvoker;
  /** Persistent deep-analysis child driver (verdict pass, tiny→smol). */
  deepInvoker: JudgeInvoker;
}

/** Tool update callback, matching ToolDefinition.execute's onUpdate. */
export type ToolUpdateCallback =
  ((update: { content: unknown[]; details?: unknown }) => void) | undefined;

/** bash tool parameter schema (mirrors the native built-in). */
function buildSchema(zod: ZodLike): unknown {
  return zod.object({
    command: zod.string(),
    timeout: zod.number().optional(),
    cwd: zod.string().optional(),
    pty: zod.boolean().optional(),
    async: zod.boolean().optional(),
  });
}

/** Localized label for a judge risk rating. */
function riskLabel(t: I18n, risk: JudgeVerdict["risk"] | undefined): string {
  if (!risk) return t.format("riskLow");
  const key = "risk" + risk.charAt(0).toUpperCase() + risk.slice(1);
  return t.format(key);
}

/** Localized human reason for a blocked verdict. */
function blockReasonText(
  t: I18n,
  decisionReason: "ai-risk" | "ai-recommend" | "fallback" | "truncated",
  verdict: JudgeVerdict | null,
  outcome: JudgeOutcome,
): string {
  if (decisionReason === "truncated") return t.format("reasonTruncated");
  if (decisionReason === "fallback") {
    // Empty means the judge answered but produced no usable verdict —
    // saying "unavailable" would mislead the model (and the user) about
    // why the block happened.
    return outcome.kind === "empty" ? t.format("reasonNoVerdict") : t.format("reasonFallback");
  }
  if (decisionReason === "ai-recommend") return t.format("reasonDeny");
  return verdict?.risk === "high" ? t.format("reasonHighRisk") : t.format("reasonMediumRisk");
}

export class BashGate {
  readonly toolName = "bash";
  private readonly deps: BashGateDeps;

  constructor(deps: BashGateDeps) {
    this.deps = deps;
  }

  /** Register this gate as a custom tool shadowing the native built-in. */
  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: this.toolName,
      label: "Bash",
      description:
        "Executes a bash command. Auto Approve judges each command with a " +
        "risk model: low-risk commands run without review; blocked commands " +
        "are denied and never executed. In a headless session a denial is " +
        "final (no confirmation dialog) and explains its reason.",
      parameters: buildSchema(pi.zod),
      approval: "exec",
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        this.execute(params, signal, onUpdate, ctx),
    });
  }

  /** The decision pipeline for one bash call. */
  async execute(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    const { config, i18n: t, logger, invoker } = this.deps;
    const cfg: AutoApproveConfig = config.config;

    const command = this.extractSubject(params);
    if (!command.trim()) {
      logger.log("bash: empty command, passing through");
      return this.delegate(params, signal, onUpdate, ctx);
    }

    if (!cfg.enabled) {
      logger.log("bash: auto-approve disabled, passing through");
      return this.delegate(params, signal, onUpdate, ctx);
    }

    if (!ctx.invokeTool) {
      logger.log("bash: ctx.invokeTool unavailable — cannot delegate");
      return this.textError("Error: native bash tool delegation unavailable in this host", {
        error: "invokeTool-unavailable",
      });
    }

    const surfaces = displaySurfaces(cfg);
    if (surfaces.marker || surfaces.notify) {
      onUpdate?.({ content: [{ type: "text", text: t.format("analyzing") }] });
    }

    // The prompts must describe where the command executes: a per-call
    // `cwd` param wins over the session cwd — delegate() runs the native
    // tool with the original params, so relative paths resolve against
    // params.cwd, not the session root.
    const execCwd = this.executionCwd(params, ctx.cwd);
    // Compact conversation excerpts as untrusted background: the models judge
    // WHY the command runs, not just what it does. "" when there is no
    // session history or the budget is 0 (command-only judgement).
    const contextSection = this.deps.contextGatherer.section(ctx, cfg.contextMaxChars);
    let outcome: JudgeOutcome;
    try {
      outcome = await invoker.assess(
        cfg.model,
        buildJudgePrompt(command, cfg.subjectMaxChars, execCwd, contextSection),
        { timeoutMs: cfg.timeoutMs, signal },
      );
    } catch (e) {
      // assess() classifies all known failure paths; this guard keeps an
      // unexpected throw from escaping the tool handler as an unclassified
      // crash.
      const message = e instanceof Error ? e.message : String(e);
      logger.log(`bash: judge assess threw (${message})`);
      outcome = { kind: "error", reason: message, category: "protocol" };
    }

    // Interrupted while analyzing → abort, no decision.
    if (signal?.aborted) {
      logger.log("bash: aborted during assessment");
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }
    // An explicit abort of the judge request classifies as an abort, not
    // as a judge failure.
    if (outcome.kind === "error" && outcome.category === "abort") {
      logger.log("bash: assessment aborted by signal");
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }

    const verdict = outcome.kind === "verdict" ? outcome.verdict : null;
    let decision = decide(verdict, cfg.blockRisk);
    // The judge only ever sees the first subjectMaxChars of the command. A
    // command longer than that window may hide a payload past the judged
    // prefix, so no "allow" verdict can authorize it: over-budget commands
    // block as "truncated" (or escalate to the user dialog when
    // fallback=ask and a UI is available).
    if (decision.verdict === "allow" && command.length > cfg.subjectMaxChars) {
      decision = { verdict: "block", reason: "truncated" };
      logger.log(`bash: command exceeds assessment window (${command.length} > ${cfg.subjectMaxChars}), overriding allow verdict`);
    }
    logger.log(`bash: decision=${decision.verdict} reason=${decision.reason} outcome=${outcome.kind}`);

    if (decision.verdict === "allow") {
      const label = riskLabel(t, verdict?.risk);
      const summary = verdict?.summary;
      if (surfaces.marker) {
        onUpdate?.({
          content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }],
        });
      }
      if (surfaces.notify) {
        this.notify(ctx, t.format("notifyApproved", label, summary ? `: ${summary}` : ""), "info");
      }
      return this.delegate(params, signal, onUpdate, ctx);
    }

    // Risk threshold crossed (or no usable verdict).  fallback=ask with a UI
    // consults the deep model: when it re-analyzes and clears the command
    // (no real risk at the configured threshold) it is auto-approved;
    // otherwise a user dialog is shown. Every other path blocks without
    // asking. The toast is always emitted regardless of the display setting;
    // the tool card carries the model-visible denial text, which never
    // repeats the raw command.
    if (cfg.fallback === "ask" && ctx.hasUI) {
      const { deepInvoker } = this.deps;
      const deep = await runDeepAnalysis(
        deepInvoker,
        cfg.deepModel,
        command,
        { subjectMaxChars: cfg.subjectMaxChars, cwd: execCwd, context: contextSection, timeoutMs: cfg.timeoutMs, signal },
        logger,
      );
      if (signal?.aborted) {
        logger.log("bash: aborted during deep analysis");
        return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
      }
      const overBudget = command.length > cfg.subjectMaxChars;
      const deepDecision = decide(deep?.verdict ?? null, cfg.blockRisk);
      if (!overBudget && deepDecision.verdict === "allow") {
        // The deeper analysis re-checked the command and cleared it: no real
        // risk at the configured threshold, so approve without a dialog.
        if (signal?.aborted) {
          logger.log("bash: aborted after deep analysis, not executing");
          return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
        }
        const label = t.format("riskDeep");
        const summary = deep?.verdict?.summary;
        if (surfaces.marker) {
          onUpdate?.({ content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }] });
        }
        if (surfaces.notify) {
          this.notify(ctx, t.format("notifyApproved", label, summary ? `: ${summary}` : ""), "info");
        }
        logger.log(`bash: deep analysis cleared the command, auto-approving (risk=${deep?.verdict?.risk ?? "unknown"})`);
        return this.delegate(params, signal, onUpdate, ctx);
      }
      // The deep model flagged a real risk, produced no usable verdict, or the
      // command is over budget (only a human can review the full command):
      // show the user dialog.
      const detail = deep ? (deep.verdict?.summary || deep.text) : "";
      const body =
        (deep ? detail : t.format("analysisUnavailable")) +
        `\n\n────────\n${t.format("commandLabel")}: ${command}\n\n${t.format("allowPrompt")}`;
      const choice = await this.confirmDialog(ctx, t.format("confirmTitle"), body);
      if (choice === "allow") {
        // Interrupted after approval → do not execute.
        if (signal?.aborted) {
          logger.log("bash: aborted after user approval, not executing");
          return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
        }
        const label = t.format("riskUser");
        const summary = verdict?.summary;
        if (surfaces.marker) {
          onUpdate?.({ content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }] });
        }
        if (surfaces.notify) {
          this.notify(ctx, t.format("notifyApproved", label, summary ? `: ${summary}` : ""), "info");
        }
        logger.log("bash: user approved, delegating to native");
        return this.delegate(params, signal, onUpdate, ctx);
      }
      const denied = t.format("userDenied");
      this.notify(ctx, t.format("notifyBlocked", denied), "warning");
      return this.textError(t.format("deniedUserDenied"), {
        blocked: true,
        reason: "user-denied",
        executed: false,
        ...(verdict?.risk ? { risk: verdict.risk } : {}),
        ...(deep ? { analysis: deep.text, deepModel: deep.model } : {}),
      });
    }
    const reasonText = blockReasonText(t, decision.reason, verdict, outcome);
    const denialText = this.denialText(t, decision.reason, verdict, outcome, ctx.hasUI, command.length, cfg.subjectMaxChars);
    if (surfaces.marker) {
      onUpdate?.({ content: [{ type: "text", text: t.format("markerBlocked", reasonText) }] });
    }
    if (ctx.hasUI) {
      this.notify(ctx, t.format("notifyBlocked", reasonText), "warning");
    }
    return this.textError(denialText, {
      blocked: true,
      reason: decision.reason,
      executed: false,
      ...(ctx.hasUI ? {} : { headless: true }),
      ...(verdict?.risk ? { risk: verdict.risk } : {}),
      ...(verdict?.summary ? { finding: verdict.summary } : {}),
      ...(outcome.kind === "error" ? { category: outcome.category } : {}),
      ...(decision.reason === "truncated"
        ? { length: command.length, subjectMaxChars: cfg.subjectMaxChars }
        : {}),
    });
  }

  /** The user-approval dialog: two-choice select when the host offers
   *  ui.select, a plain confirm otherwise.  Any unresolvable answer fails
   *  closed to "deny". */
  private async confirmDialog(ctx: ExtensionCtx, title: string, body: string): Promise<"allow" | "deny"> {
    const allow = "✅ Allow once";
    const deny = "❌ Deny";
    if (typeof ctx.ui.select === "function") {
      const choice = await ctx.ui.select(`${title}\n\n${body}`, [allow, deny]);
      if (choice === allow || choice === 0) return "allow";
      if (choice === deny || choice === 1) return "deny";
      return "deny"; // undefined / unexpected → fail closed
    }
    return (await ctx.ui.confirm(title, body)) ? "allow" : "deny";
  }

  /** Best-effort toast; a broken ui surface must never fail the tool call. */
  private notify(ctx: ExtensionCtx, msg: string, level: "info" | "warning"): void {
    try {
      ctx.ui.notify?.(msg, level);
    } catch {
      try {
        this.deps.logger.log("bash: verdict notification failed");
      } catch {}
    }
  }

  /** Model-facing denial prose: explains why the command was not executed.
   *  Headless sessions append a note that no dialog was shown, so the
   *  model never mistakes a fail-closed block for a user decision. */
  private denialText(
    t: I18n,
    decisionReason: "ai-risk" | "ai-recommend" | "fallback" | "truncated",
    verdict: JudgeVerdict | null,
    outcome: JudgeOutcome,
    hasUI: boolean,
    commandLength?: number,
    subjectMaxChars?: number,
  ): string {
    let text: string;
    if (decisionReason === "ai-recommend") {
      text = t.format("deniedJudgeDeclined", verdict?.summary ? `: ${verdict.summary}` : "");
    } else if (decisionReason === "ai-risk") {
      text = t.format(
        "deniedJudgeRisk",
        riskLabel(t, verdict?.risk),
        verdict?.summary ? `: ${verdict.summary}` : "",
      );
    } else if (decisionReason === "truncated") {
      text = t.format("deniedTooLong", String(commandLength ?? ""), String(subjectMaxChars ?? ""));
    } else if (outcome.kind === "empty") {
      // The judge responded but produced no usable verdict — distinct from
      // "could not be consulted": retrying helps, re-asking does not.
      text = t.format("deniedNoVerdict");
    } else {
      const category = outcome.kind === "error" ? outcome.category : "unavailable";
      text = t.format("deniedJudgeUnavailable", category);
    }
    return hasUI ? text : text + t.format("headlessNote");
  }

  /** The analysis subject: the raw command string. */
  private extractSubject(params: unknown): string {
    const p = params as { command?: unknown } | null;
    return p && typeof p.command === "string" ? p.command : "";
  }

  /** The working directory in which the command will actually execute: a
   *  non-empty per-call `cwd` param wins over the session cwd. The judge
   *  and deep prompts must describe this context, because a relative path
   *  in the command resolves against it. */
  private executionCwd(params: unknown, sessionCwd: string | undefined): string | undefined {
    const p = params as { cwd?: unknown } | null;
    const cwd = p && typeof p.cwd === "string" ? p.cwd : "";
    return cwd.trim() ? cwd : sessionCwd;
  }

  /** Run the native tool with the original params. */
  private delegate(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    if (!ctx.invokeTool) {
      this.deps.logger.log("bash: ctx.invokeTool unavailable — cannot delegate");
      return Promise.resolve(
        this.textError("Error: native bash tool delegation unavailable in this host", {
          error: "invokeTool-unavailable",
        }),
      );
    }
    return ctx.invokeTool(params as Record<string, unknown>, { signal, onUpdate });
  }

  private textError(text: string, details: Record<string, unknown>): AgentToolResult {
    return { content: [{ type: "text", text }], details, isError: true };
  }
}