/**
 * Auto Approve — pure protocol helpers for the judge RPC child.
 *
 * Extraction of smart-approve's analysis-policy helpers that the invoker
 * needs: frame-gating predicates, serialized queueing, text extraction from
 * agent_end frames, and bounded redacted log rendering.  Kept pure so the
 * protocol behavior is unit-testable without spawning omp.
 */

import { findCredentials } from "./redactor";
import type { JudgeErrorCategory } from "./types";

/** Serialize one RPC prompt behind the previous one. A rejected prior
 *  spawn (e.g. a role alias the host cannot resolve) must not poison
 *  later prompts — swallow it and run the next one. */
export function enqueueSerialized<T>(
  chain: Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return chain.catch(() => undefined).then(() => run());
}

/** Whether an exiting child's handler may clear the invoker's proc ref.
 *  The exit/error of a superseded child must not clobber a newer one. */
export function shouldClearProcRef(
  current: object | null,
  exiting: object,
): boolean {
  return current === exiting;
}

/** Error categories emitted by the judge RPC protocol layer. */
export type ProtocolErrorCategory =
  | "provider" // prompt rejected on the provider side
  | "timeout"
  | "abort"
  | "spawn"
  | "exit"
  | "stale" // log-only: a stale lifecycle frame was ignored
  | "invalid";

/** Map a protocol category to the user-facing JudgeErrorCategory. */
export function toJudgeErrorCategory(category: ProtocolErrorCategory): JudgeErrorCategory {
  switch (category) {
    case "timeout": return "timeout";
    case "abort": return "abort";
    case "spawn": return "spawn";
    case "exit": return "crash";
    case "provider":
    case "stale":
    case "invalid":
      return "protocol";
  }
}

/** Bounded, redacted one-line rendering of an error for diagnostics: URLs
 *  and every credential-shaped span (tokens, JWTs, AWS secrets, private
 *  keys, high-entropy blobs) stripped before the 100-char bound so no
 *  secret-bearing log line is emitted. Redaction happens on the
 *  complete message BEFORE truncation: a cut can otherwise expose a
 *  credential prefix too short for the credential regex to recognize.
 *  Detection reuses the single credential vocabulary in redactor.ts. */
export function redactForLog(message: string): string {
  const normalized = (message ?? "").replace(/https?:\/\/\S+/g, "<url>");
  return redactCredentials(normalized).slice(0, 100);
}

/** Replace every credential-shaped span (per redactor.ts) with an opaque
 *  marker; collapses runs of whitespace for a single diagnostic line. */
function redactCredentials(text: string): string {
  const spans = findCredentials(text);
  if (spans.length === 0) return text.replace(/\s+/g, " ").trim();
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += text.slice(cursor, s.start) + "[redacted]";
    cursor = s.end;
  }
  return (out + text.slice(cursor)).replace(/\s+/g, " ").trim();
}

/** Whether this agent_end should resolve the in-flight prompt.
 *  isTerminal: false means maintenance/async delivery scheduled more
 *  work; only isTerminal !== false is a true run completion. */
export function shouldSettleAgentEnd(frame: { isTerminal?: unknown }): boolean {
  return frame.isTerminal !== false;
}

/** Whether an agent_end with no usable assistant text was a truly empty
 *  completion (no streamed deltas either) or reasoning-only output (deltas
 *  streamed but none surfaced as assistant text). Both settle null; the
 *  diagnostic reason differs. */
export function emptyCompletionReason(deltaArrived: boolean): string {
  return deltaArrived ? "reasoning-only output" : "empty completion";
}

/** Concatenate text blocks from an RPC message content array. */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const c = (msg as Record<string, unknown>).content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const block of c) {
    if (block && typeof block === "object" && "type" in block && "text" in block) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/**
 * Last assistant text from the agent_end messages array ONLY. The
 * canonical verdict for an agent turn is its final assistant message;
 * deltas are a diagnostic/recovery signal, never the source of truth.
 */
export function extractFinalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant") {
      const t = messageText(m);
      if (t.trim()) return t;
    }
  }
  return "";
}

/** The child-process surface the invoker drives for judge prompts.
 *  node:child_process's ChildProcess satisfies this structurally;
 *  tests inject a scripted fake (test/fakes/rpc-child.ts) emitting the
 *  same NDJSON frame contract, so reset correlation, kill and dispose
 *  logic are covered without spawning omp. */
export interface RpcChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  kill(signal?: number | string): boolean;
  on(event: "error" | "exit", handler: (...args: unknown[]) => void): this;
  readonly stderr?: NodeJS.ReadableStream;
}

/** Launch shape for spawning the judge child. */
export interface RpcLaunchSpec {
  command: string;
  prefixArgs: readonly string[];
}

/** Injectable child factory (test seam); the default spawns `omp --mode rpc`. */
export type RpcChildFactory = (model: string) => RpcChild;

/**
 * The classified result of one prompt attempt. Lets consumers distinguish
 * a completed verdict from infrastructure failure without raw
 * secret-bearing logs. `category` is set only for `error`; `reason` is a
 * bounded, redacted descriptor — never the prompt, command, or conversation.
 */
export type PromptOutcome =
  | { kind: "text"; text: string }
  | { kind: "empty"; reason: string }
  | { kind: "error"; reason: string; category: ProtocolErrorCategory };