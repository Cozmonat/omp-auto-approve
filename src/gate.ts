/**
 * Auto Approve — tool gate.
 *
 * ToolGate shadows a native built-in tool (bash, eval) via registerTool.
 * Two-stage decision: a first-pass risk verdict, then pure policy
 * (policy.ts).  Stage 1 runs natively (native-judge.ts: one typed `risk`
 * judgment through the host's judge-role chain) when the host `judge` role
 * resolves to a System One backend, else on the judge model through the
 * persistent RPC child (judge.ts).  A failed native judgment, or a chat
 * judge that produces no output at all, falls back to the @tiny → @smol
 * chain re-running the judge's chat prompt, keeping a lane warning.  Below
 * the threshold the call delegates to the native tool via ctx.invokeTool
 * (inheriting shell path resolution, env hardening, PTY and output
 * truncation for bash; in-process execution for eval).  Above the
 * threshold a deep-analysis model (tiny, then smol) re-analyzes the
 * subject in every session and under every fallback: a cleared subject is
 * auto-approved; a confirmed risk blocks (fallback=block, or any headless
 * session) or is reviewed by the user in a dialog (fallback=ask with a
 * UI).  Headless sessions never prompt, and the denial text tells the
 * model why (judge declined / risk rating, plus the second review's
 * finding / judge unavailable, and a headless note) so it can choose a
 * safer alternative.
 *
 * Surfaces per display setting: marker = streamed tool-card line,
 * notify = chat toast (UI sessions only).  Blocked verdicts are always
 * toasted regardless of the display setting.
 */
import {
  buildJudgePrompt,
  DEEP_MODELS,
  JUDGE_MODEL,
  runDeepAnalysis,
  runJudgeFallback,
  type DeepAnalysis,
  type JudgeInvoker,
  type SubjectInfo,
} from "./judge";
import { assessNative, buildNativeJudgment, type NativeJudge } from "./native-judge";
import { SessionContextGatherer } from "./context";
import { collectScriptContents, formatScriptSection } from "./scripts";
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

export interface ToolGateDeps {
  /** Runtime config store (enabled / display / blockRisk / fallback / models / timeouts). */
  config: ConfigStore;
  /** Session-context gatherer: compact conversation excerpts given to both
   *  models as untrusted background for WHY the subject runs. */
  contextGatherer: SessionContextGatherer;
  i18n: I18n;
  logger: LoggerLike;
  /** Persistent judge child driver (verdict pass, JSON). */
  invoker: JudgeInvoker;
  /** Persistent deep-analysis child driver (verdict pass, tiny→smol). */
  deepInvoker: JudgeInvoker;
  /** Native System One stage-1 lane (resolved per call; no lane = the RPC
   *  chat judge decides). */
  nativeJudge: NativeJudge;
}

/** Tool update callback, matching ToolDefinition.execute's onUpdate. */
export type ToolUpdateCallback =
  ((update: { content: unknown[]; details?: unknown }) => void) | undefined;

/** Per-tool description of a shadowed built-in: how the gate registers it,
 *  what it judges, and where the subject executes. */
export interface ToolSpec {
  /** Built-in tool name this gate shadows (the delegation target). */
  name: "bash" | "eval";
  /** Display label of the shadowed tool. */
  label: string;
  /** Tool description shown to the model. */
  description: string;
  /** Parameter schema (mirrors the native built-in). */
  schema: (zod: ZodLike) => unknown;
  /** The judged subject of one call ("" → pass through unjudged). */
  extractSubject: (params: unknown) => string;
  /** Working directory in which the subject executes: a per-call `cwd`
   *  param (bash) or the session cwd (eval). */
  executionCwd: (params: unknown, sessionCwd: string | undefined) => string | undefined;
  /** Prompt framing for the judged subject (shell command vs. eval code). */
  subject: (params: unknown) => SubjectInfo;
}

/** bash tool parameter schema (mirrors the native built-in). */
function buildBashSchema(zod: ZodLike): unknown {
  return zod.object({
    command: zod.string(),
    timeout: zod.number().optional(),
    cwd: zod.string().optional(),
    pty: zod.boolean().optional(),
    async: zod.boolean().optional(),
  });
}

/** eval tool parameter schema (mirrors the native built-in). */
function buildEvalSchema(zod: ZodLike): unknown {
  return zod.object({
    language: zod.enum(["py", "js"]),
    code: zod.string(),
    title: zod.string().optional(),
    timeout: zod.number().optional(),
    reset: zod.boolean().optional(),
  });
}

/** The bash surface: shell commands run in a shell. */
export const BASH_TOOL_SPEC: ToolSpec = {
  name: "bash",
  label: "Bash",
  description:
    "Executes a bash command. Auto Approve judges each command with a " +
    "risk model: low-risk commands run without review; blocked commands " +
    "are denied and never executed. In a headless session a denial is " +
    "final (no confirmation dialog) and explains its reason.",
  schema: buildBashSchema,
  extractSubject: (params) => {
    const p = params as { command?: unknown } | null;
    return p && typeof p.command === "string" ? p.command : "";
  },
  executionCwd: (params, sessionCwd) => {
    const p = params as { cwd?: unknown } | null;
    const cwd = p && typeof p.cwd === "string" ? p.cwd : "";
    return cwd.trim() ? cwd : sessionCwd;
  },
  subject: () => ({ kind: "shell" }),
};

/** The eval surface: Python/JavaScript code executed in the session
 *  process. */
export const EVAL_TOOL_SPEC: ToolSpec = {
  name: "eval",
  label: "Eval",
  description:
    "Executes Python or JavaScript code in the session process. Auto " +
    "Approve judges each evaluation with a risk model: low-risk code runs " +
    "without review; blocked code is denied and never executed. In a " +
    "headless session a denial is final (no confirmation dialog) and " +
    "explains its reason.",
  schema: buildEvalSchema,
  extractSubject: (params) => {
    const p = params as { code?: unknown } | null;
    return p && typeof p.code === "string" ? p.code : "";
  },
  executionCwd: (_params, sessionCwd) => sessionCwd,
  subject: (params) => {
    const p = params as { language?: unknown } | null;
    return { kind: "eval", language: p?.language === "js" ? "javascript" : "python" };
  },
};

/** Cap on the deep reviewer's summary quoted in a model-facing denial. */
const DEEP_SUMMARY_MAX_CHARS = 300;

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
    // why the block happened. Two distinct empties: unparseable text (the
    // model did respond) versus no output at all, which usually signals a
    // broken judge/provider lane (e.g. a native System One / typesafe judge
    // model that cannot answer a chat prompt after a host update).
    if (outcome.kind === "empty") {
      return outcome.reason === "unparseable verdict"
        ? t.format("reasonNoVerdict")
        : t.format("reasonJudgeSilent");
    }
    return t.format("reasonFallback");
  }
  if (decisionReason === "ai-recommend") return t.format("reasonDeny");
  return verdict?.risk === "high" ? t.format("reasonHighRisk") : t.format("reasonMediumRisk");
}

export class ToolGate {
  readonly toolName: string;
  private readonly deps: ToolGateDeps;
  private readonly spec: ToolSpec;

  constructor(deps: ToolGateDeps, spec: ToolSpec) {
    this.deps = deps;
    this.spec = spec;
    this.toolName = spec.name;
  }

  /** Register this gate as a custom tool shadowing the native built-in. */
  register(pi: ExtensionAPI): void {
    const { spec } = this;
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.schema(pi.zod),
      approval: "exec",
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        this.execute(params, signal, onUpdate, ctx),
    });
  }

  /** The decision pipeline for one call to the shadowed tool. */
  async execute(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    const { config, i18n: t, logger, invoker } = this.deps;
    const spec = this.spec;
    const log = (message: string) => logger.log(`${spec.name}: ${message}`);
    const cfg: AutoApproveConfig = config.config;

    const subject = spec.extractSubject(params);
    const subjectInfo = spec.subject(params);
    if (!subject.trim()) {
      log("empty subject, passing through");
      return this.delegate(params, signal, onUpdate, ctx);
    }

    if (!cfg.enabled) {
      log("auto-approve disabled, passing through");
      return this.delegate(params, signal, onUpdate, ctx);
    }

    if (!ctx.invokeTool) {
      log("ctx.invokeTool unavailable — cannot delegate");
      return this.textError("Error: native tool delegation unavailable in this host", {
        error: "invokeTool-unavailable",
      });
    }

    const surfaces = displaySurfaces(cfg);
    if (surfaces.marker || surfaces.notify) {
      onUpdate?.({
        content: [{ type: "text", text: t.format(subjectInfo.kind === "eval" ? "analyzingEval" : "analyzing") }],
      });
    }

    // The prompts must describe where the subject executes: a per-call
    // `cwd` param (bash) wins over the session cwd — delegate() runs the
    // native tool with the original params, so relative paths resolve
    // against params.cwd, not the session root. Eval code runs in the
    // session process, so it always resolves against the session cwd.
    const execCwd = spec.executionCwd(params, ctx.cwd);
    // Compact conversation excerpts as untrusted background: the models judge
    // WHY the subject runs, not just what it does. "" when there is no
    // session history or the budget is 0 (subject-only judgement).
    const contextSection = this.deps.contextGatherer.section(ctx, cfg.contextMaxChars);
    // Referenced script files are read so both models judge what the subject
    // actually executes; multi-line inline scripts are covered by the rubric.
    const scriptSection = this.scriptSection(subject, execCwd, cfg);
    // Stage 1 runs natively when the host's `judge` role resolves to a
    // System One judgment backend; otherwise on the RPC chat judge.
    const lane = await this.deps.nativeJudge.resolve(ctx);
    let outcome: JudgeOutcome;
    if (lane) {
      outcome = await assessNative(
        lane,
        buildNativeJudgment(subject, {
          subjectMaxChars: cfg.subjectMaxChars,
          cwd: execCwd,
          context: contextSection,
          script: scriptSection,
          subject: subjectInfo,
        }),
        { timeoutMs: cfg.timeoutMs, signal },
        logger,
      );
    } else {
      try {
        outcome = await invoker.assess(
          JUDGE_MODEL,
          buildJudgePrompt(subject, cfg.subjectMaxChars, execCwd, contextSection, scriptSection, subjectInfo),
          { timeoutMs: cfg.timeoutMs, signal },
        );
      } catch (e) {
        // assess() classifies all known failure paths; this guard keeps an
        // unexpected throw from escaping the tool handler as an unclassified
        // crash.
        const message = e instanceof Error ? e.message : String(e);
        log(`judge assess threw (${message})`);
        outcome = { kind: "error", reason: message, category: "protocol" };
      }
    }

    // Interrupted while analyzing → abort, no decision.
    if (signal?.aborted) {
      log("aborted during assessment");
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }
    // An explicit abort of the judge request classifies as an abort, not
    // as a judge failure.
    if (outcome.kind === "error" && outcome.category === "abort") {
      log("assessment aborted by signal");
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }

    // A broken stage-1 lane (not the command) falls back to DEEP_MODELS
    // (@tiny → @smol) re-running the judge's chat prompt and JSON verdict
    // contract, and keeps warning that the lane failed:
    //  - "native": the native judgment failed (provider error, timeout, no
    //    usable answer).  The chat @judge is skipped — it would resolve to
    //    the same judgment-only model and return no text.
    //  - "silent": the chat judge produced no output at all.
    // An unparseable chat reply or a chat-child failure keeps failing closed.
    let laneFailure: "native" | "silent" | undefined;
    if (outcome.kind !== "verdict") {
      if (lane) laneFailure = "native";
      else if (outcome.kind === "empty" && outcome.reason !== "unparseable verdict") laneFailure = "silent";
    }
    let fallbackModel: string | undefined;
    if (laneFailure && outcome.kind !== "verdict") {
      log(
        `${laneFailure === "native" ? "native judge failed" : "judge silent"} (${outcome.reason}); falling back to ${[...DEEP_MODELS].join(", ")}`,
      );
      const fallback = await runJudgeFallback(
        invoker,
        subject,
        { subjectMaxChars: cfg.subjectMaxChars, cwd: execCwd, context: contextSection, script: scriptSection, timeoutMs: cfg.timeoutMs, signal, subject: subjectInfo },
        logger,
      );
      if (signal?.aborted) {
        log("aborted during judge fallback");
        return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
      }
      if (fallback) {
        outcome = { kind: "verdict", verdict: fallback.verdict };
        fallbackModel = fallback.model;
        log(`fallback verdict from ${fallback.model}`);
      } else {
        log("judge fallback produced no usable verdict; failing closed");
      }
    }

    const verdict = outcome.kind === "verdict" ? outcome.verdict : null;
    let decision = decide(verdict, cfg.blockRisk);
    // The judge only ever sees the first subjectMaxChars of the subject. A
    // subject longer than that window may hide a payload past the judged
    // prefix, so no "allow" verdict can authorize it: over-budget subjects
    // block as "truncated" (or escalate to the user dialog when
    // fallback=ask and a UI is available).
    if (decision.verdict === "allow" && subject.length > cfg.subjectMaxChars) {
      decision = { verdict: "block", reason: "truncated" };
      log(`subject exceeds assessment window (${subject.length} > ${cfg.subjectMaxChars}), overriding allow verdict`);
    }
    log(`decision=${decision.verdict} reason=${decision.reason} outcome=${outcome.kind}`);

    // Kept lane note: the verdict came from a fallback model because the
    // stage-1 lane failed — the operator should fix the judge role.  It goes
    // out at info level (the host prefixes warning toasts with "Warning:";
    // the ⚠️ carries the signal) and rides on whichever approval toast
    // follows, since consecutive info toasts collapse into one status line.
    const laneNote =
      laneFailure && ctx.hasUI
        ? t.format(laneFailure === "native" ? "notifyNativeFailed" : "notifyJudgeSilent", fallbackModel ?? "")
        : undefined;
    const notifyApproval = (label: string, summary: string | undefined): void => {
      const approved = surfaces.notify ? t.format("notifyApproved", label, summary ? `: ${summary}` : "") : undefined;
      const toast = [approved, laneNote].filter((line) => line !== undefined).join("\n");
      if (toast) this.notify(ctx, toast, "info");
    };

    if (decision.verdict === "allow") {
      const label = riskLabel(t, verdict?.risk);
      const summary = verdict?.summary;
      if (surfaces.marker) {
        onUpdate?.({
          content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }],
        });
      }
      notifyApproval(label, summary);
      return this.delegate(params, signal, onUpdate, ctx);
    }

    // Deep review: a real first-pass verdict — or a lane-fallback
    // (@tiny → @smol) verdict — that crossed the threshold is re-analyzed in
    // every session and under every fallback.  A deep "clear" auto-approves
    // (headless too); a deep flag blocks, except fallback=ask with a UI,
    // where the user decides in a dialog.  When the judge is unavailable, or
    // its lane failed with no fallback verdict, there is nothing to review:
    // a deep-model "clear" must not authorize execution (the deep model is
    // the weakest in the stack), so a broken judge lane fails closed.  An
    // over-budget subject can never be deep-approved, so it is only reviewed
    // when a dialog can follow.
    const overBudget = subject.length > cfg.subjectMaxChars;
    const canAsk = cfg.fallback === "ask" && ctx.hasUI;
    const deepEscalation = outcome.kind === "verdict" && (canAsk || !overBudget);
    if (outcome.kind !== "verdict") {
      log(`first pass produced no verdict (outcome=${outcome.kind}); blocking without deep analysis`);
    }
    let deep: DeepAnalysis | null = null;
    if (deepEscalation) {
      const { deepInvoker } = this.deps;
      deep = await runDeepAnalysis(
        deepInvoker,
        subject,
        { subjectMaxChars: cfg.subjectMaxChars, cwd: execCwd, context: contextSection, script: scriptSection, timeoutMs: cfg.timeoutMs, signal, subject: subjectInfo },
        logger,
      );
      if (signal?.aborted) {
        log("aborted during deep analysis");
        return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
      }
      const deepDecision = decide(deep?.verdict ?? null, cfg.blockRisk);
      if (!overBudget && deepDecision.verdict === "allow") {
        // The deeper analysis re-checked the subject and cleared it: no real
        // risk at the configured threshold, so approve without a dialog.
        const label = t.format("riskDeep");
        const summary = deep?.verdict?.summary;
        if (surfaces.marker) {
          onUpdate?.({ content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }] });
        }
        notifyApproval(label, summary);
        log(`deep analysis cleared the subject, auto-approving (risk=${deep?.verdict?.risk ?? "unknown"})`);
        return this.delegate(params, signal, onUpdate, ctx);
      }
    }
    if (deepEscalation && canAsk) {
      // The deep model flagged a real risk, produced no usable verdict, or the
      // subject is over budget (only a human can review the full subject):
      // show the user dialog.
      const detail = deep ? (deep.verdict?.summary || deep.text) : "";
      const body =
        (deep ? detail : t.format("analysisUnavailable")) +
        `\n\n────────\n${spec.name === "eval" ? t.format("codeLabel") : t.format("commandLabel")}: ${subject}\n\n${t.format("allowPrompt")}`;
      const choice = await this.confirmDialog(ctx, t.format("confirmTitle"), body);
      if (choice === "allow") {
        // Interrupted after approval → do not execute.
        if (signal?.aborted) {
          log("aborted after user approval, not executing");
          return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
        }
        const label = t.format("riskUser");
        const summary = verdict?.summary;
        if (surfaces.marker) {
          onUpdate?.({ content: [{ type: "text", text: t.format("markerApproved", label, summary ? `: ${summary}` : "") }] });
        }
        notifyApproval(label, summary);
        log("user approved, delegating to native");
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
    // A failed stage-1 lane keeps its lane reason on the user-facing
    // surfaces (the operator must fix the judge lane); the model-facing
    // denial text below still carries the fallback verdict's reason when
    // one exists.
    const reasonText =
      laneFailure && decision.reason !== "truncated"
        ? t.format(laneFailure === "native" ? "reasonNativeFailed" : "reasonJudgeSilent")
        : blockReasonText(t, decision.reason, verdict, outcome);
    // A deep review that also flagged the subject is named in the denial, so
    // the agent knows a second model confirmed the risk.  The template ends
    // the sentence itself, so the summary's own final punctuation is dropped;
    // the summary is model output fed back to the agent, so it is bounded.
    const trimmed = deep?.verdict?.summary?.replace(/[.!?。]+$/u, "");
    const deepSummary =
      trimmed && trimmed.length > DEEP_SUMMARY_MAX_CHARS ? `${trimmed.slice(0, DEEP_SUMMARY_MAX_CHARS)}…` : trimmed;
    const deepNote = deep?.verdict
      ? t.format("deniedDeepConfirmed", deep.model, deepSummary ? `: ${deepSummary}` : "")
      : "";
    if (deep) {
      log(`deep analysis (${deep.model}) did not clear the subject (risk=${deep.verdict?.risk ?? "unknown"}); blocking`);
    }
    const denialText = this.denialText(t, decision.reason, verdict, outcome, ctx.hasUI, subject.length, cfg.subjectMaxChars, deepNote);
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
        ? { length: subject.length, subjectMaxChars: cfg.subjectMaxChars }
        : {}),
      ...(deep ? { analysis: deep.text, deepModel: deep.model } : {}),
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
        this.deps.logger.log(`${this.spec.name}: verdict notification failed`);
      } catch {}
    }
  }

  /** Model-facing denial prose: explains why the subject was not executed.
   *  Headless sessions append a note that no dialog was shown, so the
   *  model never mistakes a fail-closed block for a user decision. */
  private denialText(
    t: I18n,
    decisionReason: "ai-risk" | "ai-recommend" | "fallback" | "truncated",
    verdict: JudgeVerdict | null,
    outcome: JudgeOutcome,
    hasUI: boolean,
    subjectLength?: number,
    subjectMaxChars?: number,
    deepNote: string = "",
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
      text = t.format("deniedTooLong", String(subjectLength ?? ""), String(subjectMaxChars ?? ""));
    } else if (outcome.kind === "empty") {
      // Two distinct failures: the model answered but the text was
      // unparseable (retrying may help), or the model produced no text at
      // all (a broken judge/provider lane — "responded but unusable" would
      // misdirect diagnosis, as a native System One / typesafe judge model
      // pointed at a chat prompt after a host update).
      text =
        outcome.reason === "unparseable verdict"
          ? t.format("deniedNoVerdict")
          : t.format("deniedJudgeSilent", outcome.reason);
    } else {
      const category = outcome.kind === "error" ? outcome.category : "unavailable";
      // Surface the classified failure detail (e.g.
      // 'spawn: judge process exited before ready (code 1): Model "x" not
      // found') so a broken model spec is self-diagnosing instead of an
      // opaque category.
      const detail =
        outcome.kind === "error" && outcome.reason
          ? `${category}: ${outcome.reason}`
          : category;
      text = t.format("deniedJudgeUnavailable", detail);
    }
    text += deepNote;
    return hasUI ? text : text + t.format("headlessNote");
  }

  /** Build the referenced-script contents section for the prompts.  The
   *  per-file budget comes from config (0 disables file reads); failures
   *  degrade to per-file notes, never to a tool-call crash. */
  private scriptSection(subject: string, cwd: string | undefined, cfg: AutoApproveConfig): string {
    const contents = collectScriptContents(subject, { cwd, maxChars: cfg.scriptMaxChars, logger: this.deps.logger });
    if (contents.length > 0) {
      this.deps.logger.log(`${this.spec.name}: script analysis: ${contents.length} referenced file(s) sent to the prompts`);
    }
    return formatScriptSection(contents);
  }

  /** Run the native tool with the original params. */
  private delegate(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    if (!ctx.invokeTool) {
      this.deps.logger.log(`${this.spec.name}: ctx.invokeTool unavailable — cannot delegate`);
      return Promise.resolve(
        this.textError("Error: native tool delegation unavailable in this host", {
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

/** The bash surface: shadows the native `bash` built-in. */
export class BashGate extends ToolGate {
  constructor(deps: ToolGateDeps) {
    super(deps, BASH_TOOL_SPEC);
  }
}

/** The eval surface: shadows the native `eval` built-in (Python/JavaScript
 *  executed in the session process). */
export class EvalGate extends ToolGate {
  constructor(deps: ToolGateDeps) {
    super(deps, EVAL_TOOL_SPEC);
  }
}