/**
 * Native judge tests: the System One judgment request built for a subject,
 * the answer → verdict mapping, failure classification (provider error,
 * timeout, abort), and the host-module lane resolution that decides
 * whether stage 1 runs natively at all.
 */

import { describe, expect, test } from "bun:test";
import {
  assessNative,
  buildNativeJudgment,
  HostNativeJudge,
  type HostChainJudge,
  type HostJudgeModules,
  type NativeJudgmentRequest,
  type NativeJudgmentResult,
  type NativeLane,
} from "./native-judge";
import type { ExtensionCtx, LoggerLike } from "./types";

const quietLogger: LoggerLike = { log: () => {} };

function riskResult(choice: string): NativeJudgmentResult {
  return {
    provider: "remote-judge-typesafe",
    model: "decider-v10",
    answers: {
      risk: { type: "choice", choice, probabilities: { low: 0.1, medium: 0.2, high: 0.7 }, confidence: 0.9 },
    },
  };
}

function laneReturning(result: NativeJudgmentResult): NativeLane {
  return { judge: async () => result };
}

/** A lane that settles only when its signal aborts. */
const hangingLane: NativeLane = {
  judge: (_request, signal) => {
    const { promise, reject } = Promise.withResolvers<NativeJudgmentResult>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    return promise;
  },
};
const request = buildNativeJudgment("ls -la", { cwd: "/w" });

describe("buildNativeJudgment", () => {
  test("shell subject: state carries the command and cwd, empty sections are omitted", () => {
    const req = buildNativeJudgment("ls -la", { cwd: "/w", context: "", script: "" });
    expect(req.state).toEqual({ command: "ls -la", cwd: "/w" });
    expect(req.questions.risk.type).toBe("choice");
    expect(Object.keys(req.questions.risk.criteria).sort()).toEqual(["high", "low", "medium"]);
  });

  test("eval subject is framed as code with its language", () => {
    const req = buildNativeJudgment("print(1)", {
      cwd: "/w",
      subject: { kind: "eval", language: "python" },
    });
    expect(req.state).toEqual({ code: "print(1)", cwd: "/w", language: "python" });
  });

  test("session context and referenced scripts ride along in the state", () => {
    const req = buildNativeJudgment("./run.sh", { context: "CTX\n", script: "SCR\n" });
    expect(req.state).toEqual({ command: "./run.sh", context: "CTX\n", scripts: "SCR\n" });
  });

});

describe("assessNative", () => {
  test.each(["low", "medium", "high"] as const)("a %s risk choice becomes a risk-only verdict", async (choice) => {
    const outcome = await assessNative(laneReturning(riskResult(choice)), request, { timeoutMs: 1000 }, quietLogger);
    expect(outcome).toEqual({ kind: "verdict", verdict: { risk: choice } });
  });

  test("a missing risk answer is a protocol error, not a verdict", async () => {
    const result: NativeJudgmentResult = { provider: "p", model: "m", answers: {} };
    const outcome = await assessNative(laneReturning(result), request, { timeoutMs: 1000 }, quietLogger);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.category).toBe("protocol");
  });

  test("a choice outside the risk vocabulary is a protocol error", async () => {
    const outcome = await assessNative(laneReturning(riskResult("maybe")), request, { timeoutMs: 1000 }, quietLogger);
    expect(outcome.kind === "error" && outcome.category).toBe("protocol");
  });

  test("a backend failure is a provider error carrying the host's message", async () => {
    const lane: NativeLane = {
      judge: async () => {
        throw new Error("judgment: every judge candidate failed: HTTP 503");
      },
    };
    const outcome = await assessNative(lane, request, { timeoutMs: 1000 }, quietLogger);
    expect(outcome).toEqual({
      kind: "error",
      category: "provider",
      reason: "judgment: every judge candidate failed: HTTP 503",
    });
  });

  test("a backend failure is redacted like every chat-lane reason before it is logged or returned", async () => {
    const logs: string[] = [];
    const lane: NativeLane = {
      judge: async () => {
        throw new Error("API error (401) at http://judge.internal:8002/v1/systemone: key sk-abcdefghijklmnop1234 rejected");
      },
    };
    const outcome = await assessNative(lane, request, { timeoutMs: 1000 }, { log: (m) => logs.push(m) });
    expect(outcome.kind === "error" && outcome.reason).toBe("API error (401) at <url> key [redacted] rejected");
    expect(logs.join("\n")).not.toContain("sk-abcdefghijklmnop1234");
    expect(logs.join("\n")).not.toContain("judge.internal");
  });

  test("a protocol error echoing backend fields is redacted too", async () => {
    const logs: string[] = [];
    const result: NativeJudgmentResult = {
      provider: "p",
      model: "m http://judge.internal:8002 sk-abcdefghijklmnop1234",
      answers: { risk: { type: "choice", choice: "maybe" } },
    };
    const outcome = await assessNative(laneReturning(result), request, { timeoutMs: 1000 }, { log: (m) => logs.push(m) });
    const reason = outcome.kind === "error" ? outcome.reason : "";
    for (const text of [reason, logs.join("\n")]) {
      expect(text).not.toContain("sk-abcdefghijklmnop1234");
      expect(text).not.toContain("judge.internal");
    }
  });

  test("the assessment window bounds the call and classifies as timeout", async () => {
    const outcome = await assessNative(hangingLane, request, { timeoutMs: 20 }, quietLogger);
    expect(outcome.kind === "error" && outcome.category).toBe("timeout");
  });

  test("a caller abort classifies as abort, not timeout", async () => {
    const controller = new AbortController();
    const pending = assessNative(hangingLane, request, { timeoutMs: 5000, signal: controller.signal }, quietLogger);
    controller.abort();
    const outcome = await pending;
    expect(outcome.kind === "error" && outcome.category).toBe("abort");
  });

  test("the lane receives the built request", async () => {
    const seen: NativeJudgmentRequest[] = [];
    const lane: NativeLane = {
      judge: async (req) => {
        seen.push(req);
        return riskResult("low");
      },
    };
    await assessNative(lane, request, { timeoutMs: 1000 }, quietLogger);
    expect(seen).toEqual([request]);
  });
});

// ── host lane resolution ─────────────────────────────────────────────

interface HostRig {
  modules: HostJudgeModules;
  resolveDeps: unknown[];
  hasNativeCalls: number;
}

function hostRig(opts: { native?: boolean; kind?: string; settingsThrows?: boolean } = {}): HostRig {
  const rig: HostRig = { modules: undefined as unknown as HostJudgeModules, resolveDeps: [], hasNativeCalls: 0 };
  const chain: HostChainJudge = {
    withCandidate: (run, _options) =>
      run({ label: "remote-judge-typesafe/decider-2b", judge: async () => riskResult("low") }, opts.kind ?? "native"),
  };
  rig.modules = {
    settings: () => {
      if (opts.settingsThrows) throw new Error("Settings not initialized. Call Settings.init() first.");
      return { tag: "settings" };
    },
    hasNativeJudge: () => {
      rig.hasNativeCalls++;
      return opts.native ?? true;
    },
    resolveJudge: (deps) => {
      rig.resolveDeps.push(deps);
      return chain;
    },
  };
  return rig;
}

function hostCtx(extra: Partial<ExtensionCtx> = {}): ExtensionCtx {
  const ctx = {
    hasUI: false,
    ui: { confirm: async () => false, setStatus: () => {} },
    modelRegistry: { tag: "registry" },
    sessionManager: { getSessionId: () => "session-1" },
    ...extra,
  };
  return ctx as ExtensionCtx;
}

describe("HostNativeJudge", () => {
  test("a native judge role yields a lane that judges through the host chain", async () => {
    const rig = hostRig();
    const judge = new HostNativeJudge(quietLogger, async () => rig.modules);
    const lane = await judge.resolve(hostCtx());
    expect(lane).toBeDefined();
    const result = await lane!.judge(request, new AbortController().signal);
    expect(result.answers.risk).toEqual(riskResult("low").answers.risk);
    expect(rig.resolveDeps).toEqual([
      { settings: { tag: "settings" }, registry: { tag: "registry" }, sessionId: "session-1" },
    ]);
  });

  test("a non-native judge role leaves stage 1 on the chat lane", async () => {
    const rig = hostRig({ native: false });
    const judge = new HostNativeJudge(quietLogger, async () => rig.modules);
    expect(await judge.resolve(hostCtx())).toBeUndefined();
    expect(rig.resolveDeps).toHaveLength(0);
  });

  test("a prompted candidate is never accepted as a native verdict", async () => {
    const rig = hostRig({ kind: "online" });
    const judge = new HostNativeJudge(quietLogger, async () => rig.modules);
    const lane = await judge.resolve(hostCtx());
    await expect(lane!.judge(request, new AbortController().signal)).rejects.toThrow("not native");
  });

  test("a host without the judgment modules has no native lane, and loads only once", async () => {
    let loads = 0;
    const judge = new HostNativeJudge(quietLogger, async () => {
      loads++;
      return undefined;
    });
    expect(await judge.resolve(hostCtx())).toBeUndefined();
    expect(await judge.resolve(hostCtx())).toBeUndefined();
    expect(loads).toBe(1);
  });

  test("a failing module load degrades to no native lane", async () => {
    const logs: string[] = [];
    const judge = new HostNativeJudge({ log: (m) => logs.push(m) }, async () => {
      throw new Error("Cannot find module '@oh-my-pi/pi-coding-agent/judgment'");
    });
    expect(await judge.resolve(hostCtx())).toBeUndefined();
    expect(logs.some((m) => m.includes("Cannot find module"))).toBe(true);
  });

  test("uninitialized host settings degrade to no native lane", async () => {
    const rig = hostRig({ settingsThrows: true });
    const judge = new HostNativeJudge(quietLogger, async () => rig.modules);
    expect(await judge.resolve(hostCtx())).toBeUndefined();
  });

  test("a context without a model registry has no native lane", async () => {
    const rig = hostRig();
    const judge = new HostNativeJudge(quietLogger, async () => rig.modules);
    expect(await judge.resolve(hostCtx({ modelRegistry: undefined }))).toBeUndefined();
    expect(rig.hasNativeCalls).toBe(0);
  });
});
