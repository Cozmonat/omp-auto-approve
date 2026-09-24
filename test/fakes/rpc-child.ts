/**
 * Scripted fake omp RPC child for RpcModelInvoker / ModelInvoker unit tests.
 *
 * Frame contract captured live from omp 18.0.11 (bin /Users/cozmonat/.bun/bin/omp)
 * on this machine, 2026-09-01:
 *
 *   bin --mode rpc --model @smol --no-tools --no-session --no-lsp --no-skills
 *       --no-rules --no-title --no-prewalk --no-pty --no-extensions
 *       --thinking=off --max-time=300
 *   env PI_MEMORY_BACKEND=off
 *
 *   IN  {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 *        "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
 *   OUT {"type":"new_session","id":"<uuid>"}
 *   IN  {"id":"<uuid>","type":"response","command":"new_session","success":true,
 *        "data":{"cancelled":false}}
 *   OUT {"type":"prompt","id":"<uuid>","message":"..."}
 *   IN  {"id":"<uuid>","type":"response","command":"prompt","success":true}
 *   IN  {"type":"agent_start"}
 *   IN  {"type":"turn_start"}
 *   IN  {"type":"message_start","message":{"role":"user",...}}
 *   IN  {"type":"message_end","message":{"role":"user",...}}
 *   IN  {"type":"message_start","message":{"role":"assistant",...}}
 *   IN  {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
 *   IN  {"type":"agent_end","messages":[{"role":"user",...},{"role":"assistant",
 *        "content":[{"type":"text","text":"..."}]}]}
 *
 *   Noise frames (must be ignored by the invoker):
 *     extension_ui_request, available_commands_update
 *
 *   Statelessness behavior: prompt #1 ("remember 4242") answered "REMEMBERED";
 *   after a SECOND new_session (id cap-3) + ack, prompt #2
 *   ("what was the secret code") answered "NONE" — the child carries no
 *   session state across new_session, and a missing ack must never be
 *   treated as a completed reset.
 *
 *   SIGTERM -> exit 143 (128 + 15). SIGKILL -> immediate exit.
 *
 * The fake mirrors the RpcChild surface the invoker uses (src/rpc-invoker.ts):
 * stdout/stdin streams + kill/on/exitCode/signalCode. It emits the real
 * NDJSON `ready` frame as its first stdout line, exactly like the live child,
 * so the invoker's ready handling is exercised unchanged.
 */

import { PassThrough } from "node:stream";

interface FakeFrame {
  type?: string;
  [k: string]: unknown;
}

export interface FakeRpcChildOptions {
  /** Default true: emit the ready frame (first stdout line) on construction. */
  ready?: boolean;
  /** Delay (ms) before the ready frame is emitted. */
  readyDelayMs?: number;
  /** Child dies before ready (exits 1; ready frame never arrives). */
  dead?: boolean;
  /** Default true: new_session requests are answered with a matching-id ack. */
  ackNewSession?: boolean;
  /** Delay (ms) before the new_session ack is emitted (late-ack tests). */
  ackDelayMs?: number;
  /** Emit an ack for new_session carrying this id instead of the request id. */
  ackMismatchedId?: string;
  /** Ack new_session with success:false (child refused the reset). */
  ackFailure?: boolean;
  /** Ack new_session with success:true but data.cancelled:true (session
   *  already cancelled: the reset may resolve but must NOT authorize a
   *  prompt). */
  ackCancelled?: boolean;
  respondToPrompt?: boolean;
  /** Reject the prompt frame with this error (provider-side failure). */
  promptRejectError?: string;
  /** Delay (ms) before the prompt response + agent_end are emitted. */
  promptDelayMs?: number;
  /** Assistant text in the agent_end messages. Null yields empty messages. */
  replyText?: string | null;
  /** Assistant texts delivered per prompt in order (last one sticks after
   *  exhaustion). Lets one persistent child answer successive prompts
   *  differently. Takes precedence over replyText when set. */
  replies?: string[];
  /** Stream these text_delta message_update frames before agent_end (reasoning-only when replyText is null). */
  reasoningDeltas?: string[];
  /** Emit an empty stale agent_end before the current prompt's agent_start. */
  staleAgentEndBeforeAgentStart?: boolean;
  /** Emit a stale agent_start/agent_end pair before this prompt is acknowledged. */
  staleLifecycleBeforePromptAck?: boolean;
  /** Child ignores SIGTERM; only SIGKILL terminates it. */
  ignoreSigterm?: boolean;
  /** Delay (ms) before the exit event after a successful kill. */
  exitDelayMs?: number;
  /** Hold a prompt in-flight for this long (in-flight abort tests). */
  inFlightTurnMs?: number;
  /** Kill the child with SIGKILL once a frame of this type is handled
   *  (mid-turn crash tests, deterministic — no wall-clock timers). */
  killOnFrame?: string;
  /** Verdict delivered by an in-flight turn that is never aborted. */
  inFlightReply?: string;
  /** Observe every frame the invoker writes (request-side assertions). */
  onFrame?: (frame: FakeFrame) => void;
  /** Scripted frames emitted in order after the ready frame. */
  scripted?: FakeFrame[];
}

export class FakeRpcChild {
  readonly pid: number;
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  readonly stderr: PassThrough;
  readonly signals: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  private alive = true;
  private readonly exits: Array<(code: number, signal: string | null) => void> = [];
  private readonly errors: Array<(...args: unknown[]) => void> = [];
  private inFlightTurn: { settle: (text: string | null) => void; timer: NodeJS.Timeout | null } | null = null;
  private replySeq = 0;

  constructor(
    private readonly options: FakeRpcChildOptions = {},
    private readonly nextPid = 424_242,
  ) {
    this.pid = nextPid;
    this.stdout = new PassThrough();
    this.stdin = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.on("data", (chunk: Buffer) => {
      if (!this.alive) return;
      for (const raw of String(chunk).split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as FakeFrame;
          this.options.onFrame?.(frame);
          this.handleFrame(frame);
        } catch {
          // Non-JSON line from the invoker: ignore like the real child would.
        }
      }
    });

    if (options.dead === true) {
      // Defer so the invoker's exit listener (registered after the factory
      // returns) is attached before the event fires.
      queueMicrotask(() => this.exit(1, null));
      return;
    }

    const fireReady = () => {
      if (!this.alive) return;
      this.pushFrame({ type: "ready", protocolVersion: 1 });
      for (const frame of options.scripted ?? []) this.pushFrame(frame);
    };
    if (options.ready !== false) {
      const delay = options.readyDelayMs ?? 0;
      if (delay > 0) setTimeout(fireReady, delay).unref?.();
      else queueMicrotask(fireReady);
    }
  }

  get aliveNow(): boolean {
    return this.alive;
  }

  private handleFrame(frame: FakeFrame): void {
    if (frame.type === "new_session") {
      if (this.options.ackNewSession !== false) {
        const ack: FakeFrame = {
          id: this.options.ackMismatchedId ?? (frame.id as string),
          type: "response",
          command: "new_session",
          success: this.options.ackFailure !== true,
          ...(this.options.ackFailure
            ? { error: "scripted refusal" }
            : { data: { cancelled: this.options.ackCancelled === true } }),
        };
        const delay = this.options.ackDelayMs ?? 0;
        if (delay > 0) setTimeout(() => this.pushFrame(ack), delay).unref?.();
        else this.pushFrame(ack);
      }
    } else if (frame.type === "prompt") {
      if (this.options.respondToPrompt !== false) {
        const inFlightMs = this.options.inFlightTurnMs ?? 0;
        if (inFlightMs > 0) {
          // Real in-flight turn: complete after the window, or complete empty
          // immediately when the invoker aborts (mirrors omp's aborted turn).
          const { promise: settlePromise, resolve } = Promise.withResolvers<string | null>();
          const timer = setTimeout(() => resolve(this.options.inFlightReply ?? null), inFlightMs);
          timer.unref?.();
          this.inFlightTurn = { settle: resolve, timer };
          this.pushFrame({ id: frame.id, type: "response", command: "prompt", success: true });
          void settlePromise.then((text) => {
            if (!this.alive) return;
            this.pushFrame({ type: "agent_start" });
            this.pushFrame({
              type: "agent_end",
              messages: text
                ? [
                    { role: "user", content: [{ type: "text", text: String(frame.message ?? "") }] },
                    { role: "assistant", content: [{ type: "text", text }] },
                  ]
                : [],
            });
          });
          return;
        }
        const answer = () => {
          if (!this.alive) return;
          if (this.options.staleLifecycleBeforePromptAck) {
            this.pushFrame({ type: "agent_start" });
            this.pushFrame({ type: "agent_end", messages: [] });
          }
          if (this.options.promptRejectError !== undefined) {
            this.pushFrame({ id: frame.id, type: "response", command: "prompt", success: false, error: this.options.promptRejectError });
            return;
          }
          this.pushFrame({ id: frame.id, type: "response", command: "prompt", success: true });
          if (this.options.staleAgentEndBeforeAgentStart) {
            this.pushFrame({ type: "agent_end", messages: [] });
          }
          this.pushFrame({ type: "agent_start" });
          for (const delta of this.options.reasoningDeltas ?? []) {
            this.pushFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
          }
          const text = this.options.replies
            ? (this.options.replies[this.replySeq] ?? this.options.replies[this.options.replies.length - 1])
            : (this.options.replyText === undefined ? "OK" : this.options.replyText);
          this.replySeq += 1;
          this.pushFrame({
            type: "agent_end",
            messages: text
              ? [
                  { role: "user", content: [{ type: "text", text: String(frame.message ?? "") }] },
                  { role: "assistant", content: [{ type: "text", text }] },
                ]
              : [],
          });
        };
        const delay = this.options.promptDelayMs ?? 0;
        if (delay > 0) setTimeout(answer, delay).unref?.();
        else answer();
      }
    } else if (frame.type === "abort") {
      const turn = this.inFlightTurn;
      if (turn) {
        this.inFlightTurn = null;
        if (turn.timer) clearTimeout(turn.timer);
        turn.settle(null);
      }
    }
    if (this.options.killOnFrame && frame.type === this.options.killOnFrame) {
      this.kill("SIGKILL");
    }
  }

  /** Push a child -> invoker frame as a stdout NDJSON line. */
  pushFrame(frame: FakeFrame): void {
    queueMicrotask(() => {
      if (this.alive && !this.stdout.destroyed) {
        this.stdout.write(JSON.stringify(frame) + "\n");
      }
    });
  }

  kill(signal?: number | string): boolean {
    if (!this.alive) return false;
    const sig = signal ?? "SIGTERM";
    this.signals.push(String(sig));
    if (sig === "SIGKILL" || (sig === "SIGTERM" && this.options.ignoreSigterm !== true)) {
      const die = () => this.exit(143, String(sig));
      const delay = this.options.exitDelayMs ?? 0;
      if (delay > 0) setTimeout(die, delay).unref?.();
      else queueMicrotask(die);
    }
    return true;
  }

  /** Fire the child's "error" event (invoker-side error-path coverage). */
  emitError(err: Error): void {
    if (!this.alive) return;
    queueMicrotask(() => {
      for (const cb of this.errors.splice(0)) cb(err);
    });
  }

  private exit(code: number, signal: string | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    for (const cb of this.exits.splice(0)) cb(code, signal);
  }

  on(event: "error" | "exit", handler: (...args: unknown[]) => void): this {
    if (event === "exit") this.exits.push(handler as (code: number, signal: string | null) => void);
    else if (event === "error") this.errors.push(handler);
    return this;
  }
}

/** Sequential fake-child factory helper for tests (tracks created children). */
export function fakeChildFactory(
  opts: Array<FakeRpcChildOptions | (() => FakeRpcChildOptions)> = [],
  fallback: FakeRpcChildOptions = {},
): { factory: (model: string) => FakeRpcChild; children: FakeRpcChild[] } {
  const children: FakeRpcChild[] = [];
  let seq = 0;
  const factory = (model: string): FakeRpcChild => {
    const def = seq < opts.length ? opts[seq] : fallback;
    seq += 1;
    const o = typeof def === "function" ? def() : def;
    const child = new FakeRpcChild(o, 424_200 + seq);
    children.push(child);
    return child;
  };
  return { factory, children };
}
