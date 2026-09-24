/**
 * Auto Approve — native System One judge (stage 1, in-process).
 *
 * When the host's `judge` role resolves to a native judgment backend
 * (`api: typesafe` / `openrouter-decisions`: TypeSafe `jev`, a local
 * decider), stage 1 asks it one typed `risk` choice over a JSON state
 * instead of a chat prompt it cannot answer.  The judgment runs through the
 * host's own judge-role chain (credentials and rotation, retries,
 * native-only fallthrough), loaded from the running OMP.  A host without
 * those modules, or a non-native judge role, has no native lane: stage 1
 * stays on the RPC chat judge (judge.ts).
 *
 * Only the `risk` choice gates.  A yes/no "run it unattended?" probe
 * measured ~0.5 for routine commands on a local decider (`bun test src`
 * 0.488, `ls -la` 0.512), so any threshold on it would block ordinary
 * work; the choice separates the levels cleanly.
 */

import { JUDGE_FRAMING, JUDGE_RISK_LEVELS, truncateSubject, type SubjectInfo } from "./judge";
import { redactForLog } from "./rpc-protocol";
import type { ExtensionCtx, JudgeOutcome, JudgeVerdict, LoggerLike } from "./types";

type RiskLevel = NonNullable<JudgeVerdict["risk"]>;

/** System One judgment request (pi-ai `JudgmentRequest`), narrowed to
 *  the single question stage 1 asks. */
export interface NativeJudgmentRequest {
  state: Readonly<Record<string, string>>;
  questions: {
    risk: { type: "choice"; instructions: string; criteria: Readonly<Record<RiskLevel, string>> };
  };
}

/** The slice of pi-ai's `JudgmentResult` the verdict mapping reads. */
export interface NativeJudgmentResult {
  provider: string;
  model: string;
  answers: Readonly<Record<string, unknown>>;
}

/** One live native judge for the current call. */
export interface NativeLane {
  judge(request: NativeJudgmentRequest, signal: AbortSignal): Promise<NativeJudgmentResult>;
}

/** Decides per call whether stage 1 runs natively. */
export interface NativeJudge {
  /** The native lane, or undefined when the judge role is not native or
   *  the host lacks the judgment surface.  Never throws. */
  resolve(ctx: ExtensionCtx): Promise<NativeLane | undefined>;
}

export interface NativeJudgmentOptions {
  subjectMaxChars: number;
  cwd?: string;
  /** Session-context section (untrusted conversation excerpts). */
  context?: string;
  /** Referenced-script contents section. */
  script?: string;
  subject?: SubjectInfo;
}

/** Build the judgment for one subject: the same inputs, rubric levels,
 *  and guidance as the chat prompt, as a typed state + `risk` choice.
 *  The subject is capped at subjectMaxChars like the chat prompt. */
export function buildNativeJudgment(command: string, opts: NativeJudgmentOptions): NativeJudgmentRequest {
  const kind = opts.subject?.kind ?? "shell";
  const framing = JUDGE_FRAMING[kind];
  const state: Record<string, string> = {
    [kind === "eval" ? "code" : "command"]: truncateSubject(command, opts.subjectMaxChars),
  };
  if (opts.cwd) state.cwd = opts.cwd;
  if (kind === "eval" && opts.subject?.language) state.language = opts.subject.language;
  if (opts.context) state.context = opts.context;
  if (opts.script) state.scripts = opts.script;
  return {
    state,
    questions: {
      risk: {
        type: "choice",
        instructions: [framing.task, "Rate the risk of running it unattended.", ...framing.guidance].join(" "),
        criteria: JUDGE_RISK_LEVELS[kind],
      },
    },
  };
}

function riskChoice(answer: unknown): RiskLevel | undefined {
  if (!answer || typeof answer !== "object" || !("type" in answer) || answer.type !== "choice") return undefined;
  const choice = "choice" in answer ? answer.choice : undefined;
  return choice === "low" || choice === "medium" || choice === "high" ? choice : undefined;
}

/** Run one native judgment, bounded by timeoutMs (0 = no window) and the
 *  caller's signal.  A caller abort dominates, then the window; any other
 *  failure is a `provider` error carrying the host's message.  An answer
 *  without a usable risk choice is a `protocol` error, never a verdict. */
export async function assessNative(
  lane: NativeLane,
  request: NativeJudgmentRequest,
  opts: { timeoutMs: number; signal?: AbortSignal },
  logger?: LoggerLike,
): Promise<JudgeOutcome> {
  const window = opts.timeoutMs > 0 ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const bounds = [opts.signal, window].filter((s): s is AbortSignal => s !== undefined);
  const signal = bounds.length > 0 ? AbortSignal.any(bounds) : new AbortController().signal;
  const classifyAbort = (): JudgeOutcome | undefined => {
    if (opts.signal?.aborted) return { kind: "error", category: "abort", reason: "native judgment aborted" };
    if (window?.aborted) {
      return { kind: "error", category: "timeout", reason: `native judgment exceeded ${opts.timeoutMs}ms` };
    }
    return undefined;
  };
  const started = performance.now();
  const elapsed = () => `+${Math.round(performance.now() - started)}ms`;
  const preAborted = classifyAbort();
  if (preAborted) return preAborted;

  // The race enforces the bound even against a backend that ignores its
  // signal; the listener is removed on settlement, so the losing rejection
  // can never fire unobserved.
  const abort = Promise.withResolvers<never>();
  const onAbort = () => abort.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let result: NativeJudgmentResult;
  try {
    result = await Promise.race([lane.judge(request, signal), abort.promise]);
  } catch (e) {
    const bounded = classifyAbort();
    if (bounded) {
      logger?.log(`native: ${bounded.kind === "error" ? bounded.category : "error"} ${elapsed()}`);
      return bounded;
    }
    // Host messages embed upstream response bodies: redact them exactly
    // like chat-lane reasons (credentials, URLs, bounded) before the log
    // and the model-facing denial text see them.
    const reason = redactForLog(e instanceof Error ? e.message : String(e));
    logger?.log(`native: failed ${elapsed()}: ${reason}`);
    return { kind: "error", category: "provider", reason };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const answer = result.answers.risk;
  const risk = riskChoice(answer);
  const label = `${result.provider}/${result.model}`;
  if (!risk) {
    logger?.log(`native: ${label} returned no usable risk choice ${elapsed()}`);
    return { kind: "error", category: "protocol", reason: `native judge ${label} returned no usable risk choice` };
  }
  const probabilities =
    answer && typeof answer === "object" && "probabilities" in answer ? JSON.stringify(answer.probabilities) : "n/a";
  logger?.log(`native: ${label} risk=${risk} p=${probabilities} ${elapsed()}`);
  return { kind: "verdict", verdict: { risk } };
}

// ── host lane ────────────────────────────────────────────────────────

/** One candidate judge of the host chain (pi-ai `Judge`). */
export interface HostCandidateJudge {
  label: string;
  judge(request: NativeJudgmentRequest, options?: { signal?: AbortSignal }): Promise<NativeJudgmentResult>;
}

/** The host's judge-role chain (pi-coding-agent `ChainJudge`). */
export interface HostChainJudge {
  withCandidate<T>(
    run: (judge: HostCandidateJudge, kind: string) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

/** The host surface the native lane needs (pi-coding-agent `judgment` and
 *  `config/settings`), validated at load. */
export interface HostJudgeModules {
  /** The host's live settings (throws when the host has not initialized them). */
  settings(): unknown;
  hasNativeJudge(settings: unknown, registry: unknown): boolean;
  resolveJudge(deps: { settings: unknown; registry: unknown; sessionId?: string }): HostChainJudge;
}

/** Load the host's judgment surface from the running OMP; undefined when
 *  an export is missing or has the wrong kind. */
export async function loadHostJudgeModules(): Promise<HostJudgeModules | undefined> {
  // Dynamic import: these modules exist only inside a running OMP host,
  // which remaps plugin `@oh-my-pi/*` imports to its own module graph (the
  // build marks them external).  Upstream pi and unit tests have no such
  // module; a static import would fail the whole extension load instead of
  // degrading to the chat lane.
  const [judgment, settingsModule] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/judgment"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
  ]);
  const { hasNativeJudge, resolveJudge } = judgment;
  const { Settings } = settingsModule;
  if (typeof hasNativeJudge !== "function" || typeof resolveJudge !== "function" || typeof Settings !== "function") {
    return undefined;
  }
  // Unchecked casts, shapes per omp 18.3 `judgment/index.ts` and
  // `config/settings.ts`; the typeof checks above are the runtime guard.
  const hasNative = hasNativeJudge as (settings: unknown, registry: unknown) => unknown;
  const resolve = resolveJudge as HostJudgeModules["resolveJudge"];
  const settingsClass = Settings as unknown as { readonly instance: unknown };
  return {
    settings: () => settingsClass.instance,
    hasNativeJudge: (settings, registry) => hasNative(settings, registry) === true,
    resolveJudge: (deps) => resolve(deps),
  };
}

/** The native lane backed by the running OMP host.  The modules load once
 *  per instance; the judge-role decision is re-made per call so role edits
 *  and catalog discovery take effect without a restart. */
export class HostNativeJudge implements NativeJudge {
  #modules: Promise<HostJudgeModules | undefined> | undefined;

  constructor(
    private readonly logger: LoggerLike,
    private readonly load: () => Promise<HostJudgeModules | undefined> = loadHostJudgeModules,
  ) {}

  async resolve(ctx: ExtensionCtx): Promise<NativeLane | undefined> {
    const registry = ctx.modelRegistry;
    if (!registry) return undefined;
    const modules = await (this.#modules ??= this.#loadOnce());
    if (!modules) return undefined;
    let chain: HostChainJudge;
    try {
      const settings = modules.settings();
      if (!modules.hasNativeJudge(settings, registry)) return undefined;
      chain = modules.resolveJudge({ settings, registry, sessionId: ctx.sessionManager?.getSessionId?.() });
    } catch (e) {
      this.logger.log(`native: judge role resolution failed (${redactForLog(e instanceof Error ? e.message : String(e))})`);
      return undefined;
    }
    return {
      judge: (request, signal) =>
        chain.withCandidate(
          async (judge, kind) => {
            // A prompted candidate cannot stand in for a native judgment:
            // its keyword answer carries none of the calibrated levels.
            if (kind !== "native") throw new Error(`judge candidate ${judge.label} is ${kind}, not native`);
            return judge.judge(request, { signal });
          },
          { signal },
        ),
    };
  }

  async #loadOnce(): Promise<HostJudgeModules | undefined> {
    try {
      const modules = await this.load();
      if (!modules) this.logger.log("native: host judgment surface has an unexpected shape; stage 1 uses the @judge chat lane");
      return modules;
    } catch (e) {
      this.logger.log(
        `native: host judgment modules unavailable (${redactForLog(e instanceof Error ? e.message : String(e))}); stage 1 uses the @judge chat lane`,
      );
      return undefined;
    }
  }
}
