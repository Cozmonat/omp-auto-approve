/**
 * Judge layer tests: prompt construction, verdict parsing, outcome
 * classification, and the persistent RPC child lifecycle driven by the
 * scripted fake child (test/fakes/rpc-child.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { FakeRpcChild, fakeChildFactory } from "../test/fakes/rpc-child";
import { HostResolver } from "./host";
import {
  buildDeepPrompt,
  buildJudgeArgs,
  buildJudgePrompt,
  DEEP_MODELS,
  JUDGE_CONFIG_OVERLAY,
  JUDGE_DEEP_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  JudgeInvoker,
  outcomeFromPrompt,
  parseJudgeVerdict,
  runDeepAnalysis,
  writeJudgeOverlay,
  type JudgeInvokerOptions,
} from "./judge";
import type { LoggerLike } from "./types";

const quietLogger: LoggerLike = { log: () => {} };

function makeInvoker(
  factory: (model: string) => FakeRpcChild,
  overrides: Partial<JudgeInvokerOptions> = {},
): JudgeInvoker {
  return new JudgeInvoker(
    { command: "omp", prefixArgs: [] },
    quietLogger,
    overrides,
    factory,
  );
}

describe("buildJudgeArgs", () => {
  test("emits the isolated judge child argv", () => {
    expect(buildJudgeArgs("@judge", "/tmp/overlay.yml")).toEqual([
      "--mode", "rpc",
      "--model", "@judge",
      "--config=/tmp/overlay.yml",
      `--system-prompt=${JUDGE_SYSTEM_PROMPT}`,
      "--no-tools",
      "--no-session",
      "--no-lsp",
      "--no-skills",
      "--no-rules",
      "--no-title",
      "--no-prewalk",
      "--no-pty",
      "--no-extensions",
      "--thinking=off",
      "--max-time=300",
    ]);
  });
});

describe("writeJudgeOverlay", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-overlay-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("materializes the overlay file with the expected content", () => {
    const file = writeJudgeOverlay(tmp);
    expect(fs.readFileSync(file, "utf-8")).toBe(JUDGE_CONFIG_OVERLAY);
    expect(file.endsWith("auto-approve-judge.yml")).toBe(true);
  });

  test("restores a hand-edited copy on the next write", () => {
    const file = writeJudgeOverlay(tmp);
    fs.writeFileSync(file, "rogue: true\n");
    const again = writeJudgeOverlay(tmp);
    expect(fs.readFileSync(again, "utf-8")).toBe(JUDGE_CONFIG_OVERLAY);
  });

  test("overlay disables every context file source and stop detection", () => {
    expect(JUDGE_CONFIG_OVERLAY).toContain("unexpectedStopDetection: none");
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "copilot-instructions.md"]) {
      expect(JUDGE_CONFIG_OVERLAY).toContain(`context-file:user:${name}`);
      expect(JUDGE_CONFIG_OVERLAY).toContain(`context-file:project:${name}`);
    }
  });
});

describe("parseJudgeVerdict", () => {
  test("parses a bare verdict object", () => {
    expect(parseJudgeVerdict('{"risk":"low","recommend":"allow"}')).toEqual({
      risk: "low",
      recommend: "allow",
    });
  });

  test("parses a fenced verdict with summary", () => {
    expect(parseJudgeVerdict('```json\n{"risk":"high","recommend":"deny","summary":"rm -rf"}\n```')).toEqual({
      risk: "high",
      recommend: "deny",
      summary: "rm -rf",
    });
  });

  test("accepts verdicts with only one of the two signals", () => {
    expect(parseJudgeVerdict('{"risk":"medium"}')).toEqual({ risk: "medium" });
    expect(parseJudgeVerdict('{"recommend":"deny"}')).toEqual({ recommend: "deny" });
  });

  test("normalizes case and surrounding prose", () => {
    expect(parseJudgeVerdict('Sure! {"risk":"LOW","recommend":"ALLOW"}')).toEqual({
      risk: "low",
      recommend: "allow",
    });
  });

  test("returns null for non-verdict output", () => {
    expect(parseJudgeVerdict("I would allow this")).toBeNull();
    expect(parseJudgeVerdict('{"risk":"catastrophic"}')).toBeNull();
    expect(parseJudgeVerdict("[]")).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
    expect(parseJudgeVerdict("{}")).toBeNull();
  });
});

describe("buildJudgePrompt", () => {
  test("wraps the command as untrusted text with the risk rubric", () => {
    const prompt = buildJudgePrompt("git push origin main");
    expect(prompt).toContain("git push origin main");
    expect(prompt).toContain("low");
    expect(prompt).toContain("high");
    expect(prompt).toMatch(/untrusted/i);
  });

  test("truncates commands over subjectMaxChars", () => {
    const long = "a".repeat(5000);
    const bounded = buildJudgePrompt(long, 100);
    const unbounded = buildJudgePrompt(long, 100_000);
    expect(bounded).not.toContain(long);
    expect(bounded).toContain("truncated");
    expect(bounded.length).toBeLessThan(unbounded.length);
  });

  test("includes the working directory when provided, omits it otherwise", () => {
    expect(buildJudgePrompt("ls", 4000, "/work/repo")).toContain("Working directory: /work/repo");
    expect(buildJudgePrompt("ls", 4000)).not.toContain("Working directory");
  });

  test("inserts the session-context section before the command, omits it otherwise", () => {
    const prompt = buildJudgePrompt("ls", 4000, "/work", "CONTEXT_SECTION");
    expect(prompt).toContain("CONTEXT_SECTION");
    expect(prompt.indexOf("CONTEXT_SECTION")).toBeLessThan(prompt.indexOf("Command to judge:"));
    expect(buildJudgePrompt("ls", 4000, "/work")).not.toContain("CONTEXT_SECTION");
  });

  test("inserts the script-contents section before the command, omits it otherwise", () => {
    const prompt = buildJudgePrompt("bash run.sh", 4000, "/work", undefined, "SCRIPT_SECTION");
    expect(prompt).toContain("SCRIPT_SECTION");
    expect(prompt.indexOf("SCRIPT_SECTION")).toBeLessThan(prompt.indexOf("Command to judge:"));
    expect(buildJudgePrompt("bash run.sh", 4000, "/work")).not.toContain("SCRIPT_SECTION");
  });

  test("rubric tells the judge to analyse multi-line scripts and provided script contents", () => {
    const prompt = buildJudgePrompt("ls");
    expect(prompt).toMatch(/multi-line shell script/i);
    expect(prompt).toMatch(/script file/i);
  });

});

describe("outcomeFromPrompt", () => {
  test("text that parses as a verdict becomes a verdict outcome", () => {
    expect(outcomeFromPrompt({ kind: "text", text: '{"risk":"low"}' })).toEqual({
      kind: "verdict",
      verdict: { risk: "low" },
    });
  });

  test("unparseable text is an empty outcome (fail closed)", () => {
    const out = outcomeFromPrompt({ kind: "text", text: "no json here" });
    expect(out.kind).toBe("empty");
  });

  test("null (disposed or pre-aborted) is unavailable", () => {
    expect(outcomeFromPrompt(null)).toEqual({ kind: "unavailable", reason: "judge unavailable" });
  });

  test("error categories map to judge categories", () => {
    expect(outcomeFromPrompt({ kind: "error", reason: "x", category: "exit" })).toEqual(
      { kind: "error", reason: "x", category: "crash" },
    );
    expect(outcomeFromPrompt({ kind: "error", reason: "x", category: "timeout" })).toEqual(
      { kind: "error", reason: "x", category: "timeout" },
    );
  });

  test("empty outcomes pass through", () => {
    expect(outcomeFromPrompt({ kind: "empty", reason: "empty completion" })).toEqual({
      kind: "empty",
      reason: "empty completion",
    });
  });
});

describe("JudgeInvoker lifecycle", () => {
  let disposed: JudgeInvoker[] = [];

  afterEach(async () => {
    for (const inv of disposed.splice(0)) await inv.dispose();
  });

  test("happy path: one child serves a verdict end to end", async () => {
    const { factory, children } = fakeChildFactory(
      [{ replyText: '{"risk":"low","recommend":"allow","summary":"reads a file"}' }],
      { replyText: "{}" },
    );
    const invoker = makeInvoker(factory);
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "buildJudgePrompt('cat foo.txt')", { timeoutMs: 2000 });
    expect(outcome).toEqual({
      kind: "verdict",
      verdict: { risk: "low", recommend: "allow", summary: "reads a file" },
    });
    expect(children).toHaveLength(1);
    expect(invoker.isAlive).toBe(true);
  });

  test("child dying before ready classifies as spawn error", async () => {
    const { factory } = fakeChildFactory([{ dead: true }], { dead: true });
    const invoker = makeInvoker(factory, { idleMs: 0 });
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 500 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.category).toBe("spawn");
  });

  test("child exiting before ready carries its stderr in the failure reason", async () => {
    const { factory } = fakeChildFactory([{ dead: true, deadStderr: 'Model "nope/none" not found\n' }], { dead: true });
    const invoker = makeInvoker(factory, { idleMs: 0 });
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 500 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.category).toBe("spawn");
      expect(outcome.reason).toContain('Model "nope/none" not found');
    }
  });

  test("missing new_session ack fails closed to a timeout error", async () => {
    const { factory } = fakeChildFactory([{ ackNewSession: false }], {});
    const invoker = makeInvoker(factory, { analysisTimeoutMs: 60 });
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 1000 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.category).toBe("timeout");
  });

  test("a cancelled-session ack never authorizes the prompt", async () => {
    const { factory } = fakeChildFactory([{ ackCancelled: true }], {});
    const invoker = makeInvoker(factory, { analysisTimeoutMs: 200 });
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 1000 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.category).toBe("timeout");
  });

  test("child exiting mid-prompt classifies as crash", async () => {
    // The child acks nothing: it receives the prompt and kills itself
    // (killOnFrame), so the invoker's in-flight prompt fails on process
    // exit — deterministically, with no wall-clock timer.
    const { factory } = fakeChildFactory([{ respondToPrompt: false, killOnFrame: "prompt" }], {});
    const invoker = makeInvoker(factory);
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 5000 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.category).toBe("crash");
  });

  test("a pre-aborted signal fails without spawning", async () => {
    const { factory, children } = fakeChildFactory([{}], {});
    const invoker = makeInvoker(factory);
    disposed.push(invoker);
    const controller = new AbortController();
    controller.abort();
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 1000, signal: controller.signal });
    expect(outcome.kind).toBe("unavailable");
    expect(children).toHaveLength(0);
  });

  test("prompt timeout retires the child and classifies timeout", async () => {
    const { factory } = fakeChildFactory([{ inFlightTurnMs: 10_000 }], {});
    const invoker = makeInvoker(factory);
    disposed.push(invoker);
    const outcome = await invoker.assess("@judge", "p", { timeoutMs: 50 });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.category).toBe("timeout");
  });

  test("a model spec change respawns the child", async () => {
    const { factory, children } = fakeChildFactory(
      [{ replyText: '{"risk":"low"}' }, { replyText: '{"risk":"low"}' }],
      { replyText: '{"risk":"low"}' },
    );
    const invoker = makeInvoker(factory);
    disposed.push(invoker);
    await invoker.assess("@judge", "p", { timeoutMs: 2000 });
    await invoker.assess("@smol", "p", { timeoutMs: 2000 });
    expect(children).toHaveLength(2);
  });

  test("idle reap kills the child after the quiet window", async () => {
    const { factory, children } = fakeChildFactory([{ replyText: '{"risk":"low"}' }], {});
    const invoker = makeInvoker(factory, { idleMs: 40 });
    disposed.push(invoker);
    await invoker.assess("@judge", "p", { timeoutMs: 2000 });
    expect(invoker.isAlive).toBe(true);
    // Real delay: the idle reaper is a platform-clock setTimeout — the
    // behavior under test; deterministic time control cannot fire it.
    await Bun.sleep(120);
    expect(invoker.isAlive).toBe(false);
    expect(children[0]?.signals).toContain("SIGTERM");
  });

  test("dispose kills the child and latches further prompts", async () => {
    const { factory, children } = fakeChildFactory([{ replyText: '{"risk":"low"}' }], {});
    const invoker = makeInvoker(factory, { idleMs: 0 });
    await invoker.assess("@judge", "p", { timeoutMs: 2000 });
    await invoker.dispose();
    expect(children[0]?.signals).toContain("SIGTERM");
    const after = await invoker.assess("@judge", "p", { timeoutMs: 2000 });
    expect(after.kind).toBe("unavailable");
  });

  test("two consecutive verdicts reuse one child (serialization)", async () => {
    const { factory, children } = fakeChildFactory(
      [{ replies: ['{"risk":"low"}', '{"risk":"high","recommend":"deny"}'] }],
      { replies: ['{"risk":"low"}'] },
    );
    const invoker = makeInvoker(factory, { idleMs: 0 });
    disposed.push(invoker);
    const first = await invoker.assess("@judge", "p1", { timeoutMs: 2000 });
    const second = await invoker.assess("@judge", "p2", { timeoutMs: 2000 });
    expect(first.kind === "verdict" && first.verdict.risk).toBe("low");
    expect(second.kind === "verdict" && second.verdict.risk).toBe("high");
    expect(children).toHaveLength(1);
  });
});

describe("HostResolver", () => {
  test("argv1 + execPath strategy wins when both resolve", () => {
    const realScript = decodeURIComponent(new URL("./judge.ts", import.meta.url).pathname);
    const resolver = new HostResolver(quietLogger, {
      execPath: process.execPath,
      argv1: realScript,
    });
    const spec = resolver.resolve();
    expect(spec).not.toBeNull();
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.prefixArgs).toEqual([fs.realpathSync(realScript)]);
  });

  test("bundled binary: argv1 unusable falls back to execPath alone", () => {
    const resolver = new HostResolver(quietLogger, {
      execPath: process.execPath,
      argv1: "/$bunfs/root/index.js", // virtual path, not real
    });
    const spec = resolver.resolve();
    expect(spec).not.toBeNull();
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.prefixArgs).toEqual([]);
  });

  test("resolution is memoized", () => {
    const resolver = new HostResolver(quietLogger, {
      execPath: process.execPath,
      argv1: new URL("./judge.ts", import.meta.url).pathname,
    });
    expect(resolver.resolve()).toBe(resolver.resolve());
  });

  test("falls back to PATH lookup when process paths are bogus", () => {
    const resolver = new HostResolver(quietLogger, {
      execPath: "/nonexistent-host-binary",
      argv1: "/nonexistent-script.js",
    });
    // The last-resort strategy shells out to `command -v omp|pi`; mirror it
    // so the expectation is exact on any machine.
    let pathBin: string | null = null;
    for (const bin of ["omp", "pi"]) {
      try {
        const out = execSync(`command -v ${bin}`, {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 2000,
          encoding: "utf-8",
        }).trim();
        if (out.includes("/")) {
          pathBin = out;
          break;
        }
      } catch {
        // not found
      }
    }
    const spec = resolver.resolve();
    if (pathBin === null) expect(spec).toBeNull();
    else expect(spec).toEqual({ command: pathBin, prefixArgs: [] });
  });
});

describe("deep analysis", () => {
  test("buildDeepPrompt wraps the command with the deep-analysis rubric", () => {
    const prompt = buildDeepPrompt("rm -rf /tmp/x");
    expect(prompt).toContain("rm -rf /tmp/x");
    expect(prompt).toContain("single JSON object");
    expect(prompt).toMatch(/untrusted/i);
  });

  test("deep child contract: system prompt and rubric both require a JSON verdict", () => {
    // The deep child is spawned with JUDGE_DEEP_SYSTEM_PROMPT and prompted
    // with the deep rubric per call: the two surfaces must agree on the
    // output shape, or a small model follows the prose instruction and
    // deep-clear auto-approval silently stops working (regressed in 1.1.0
    // when the rubric moved to JSON but the system prompt stayed prose).
    const system = JUDGE_DEEP_SYSTEM_PROMPT.toLowerCase();
    expect(system).toContain("json object");
    expect(system).not.toContain("never json");
    expect(system).not.toContain("prose");
    expect(buildDeepPrompt("ls")).toContain("single JSON object");
  });

  test("buildDeepPrompt truncates commands over subjectMaxChars", () => {
    const long = "b".repeat(5000);
    const bounded = buildDeepPrompt(long, 100);
    expect(bounded).not.toContain(long);
    expect(bounded).toContain("truncated");
  });

  test("includes the working directory when provided, omits it otherwise", () => {
    expect(buildDeepPrompt("rm -rf /tmp/x", 4000, "/scratch")).toContain("Working directory: /scratch");
    expect(buildDeepPrompt("rm -rf /tmp/x")).not.toContain("Working directory");
  });

  test("inserts the session-context section before the command, omits it otherwise", () => {
    const prompt = buildDeepPrompt("ls", 4000, "/scratch", "CONTEXT_SECTION");
    expect(prompt).toContain("CONTEXT_SECTION");
    expect(prompt.indexOf("CONTEXT_SECTION")).toBeLessThan(prompt.indexOf("Command to analyze:"));
    expect(buildDeepPrompt("ls", 4000, "/scratch")).not.toContain("CONTEXT_SECTION");
  });

  test("inserts the script-contents section before the command, omits it otherwise", () => {
    const prompt = buildDeepPrompt("bash run.sh", 4000, "/scratch", undefined, "SCRIPT_SECTION");
    expect(prompt).toContain("SCRIPT_SECTION");
    expect(prompt.indexOf("SCRIPT_SECTION")).toBeLessThan(prompt.indexOf("Command to analyze:"));
    expect(buildDeepPrompt("bash run.sh", 4000, "/scratch")).not.toContain("SCRIPT_SECTION");
  });

  test("rubric tells the analyst to analyse multi-line scripts and provided script contents", () => {
    const prompt = buildDeepPrompt("ls");
    expect(prompt).toMatch(/multi-line shell script/i);
    expect(prompt).toMatch(/script file/i);
  });

  test("buildJudgeArgs accepts a system-prompt override for the deep child", () => {
    const args = buildJudgeArgs("@tiny", "/tmp/overlay.yml", { systemPrompt: JUDGE_DEEP_SYSTEM_PROMPT });
    expect(args).toContain(`--system-prompt=${JUDGE_DEEP_SYSTEM_PROMPT}`);
    expect(args).not.toContain(`--system-prompt=${JUDGE_SYSTEM_PROMPT}`);
    // The default stays the verdict prompt.
    expect(buildJudgeArgs("@judge", "/tmp/overlay.yml")).toContain(`--system-prompt=${JUDGE_SYSTEM_PROMPT}`);
  });

  test("DEEP_MODELS is the fixed host-role chain (@tiny, then @smol)", () => {
    expect(DEEP_MODELS).toEqual(["@tiny", "@smol"]);
  });

  test("runDeepAnalysis uses the @tiny role when it answers", async () => {
    const factory = (model: string) => new FakeRpcChild({ replyText: `Deep analysis for ${model}` });
    const invoker = makeInvoker(factory);
    const out = await runDeepAnalysis(invoker, "rm -rf /tmp/x", { timeoutMs: 5000 }, quietLogger);
    expect(out).toEqual({ text: "Deep analysis for @tiny", model: "@tiny", verdict: null });
    await invoker.dispose();
  });

  test("runDeepAnalysis parses a JSON verdict so the caller can auto-approve a cleared command", async () => {
    const reply = '{"risk":"low","recommend":"allow","summary":"reads a file"}';
    const factory = () => new FakeRpcChild({ replyText: reply });
    const invoker = makeInvoker(factory);
    const out = await runDeepAnalysis(invoker, "cat foo", { timeoutMs: 5000 }, quietLogger);
    expect(out).toEqual({
      text: reply,
      model: "@tiny",
      verdict: { risk: "low", recommend: "allow", summary: "reads a file" },
    });
    await invoker.dispose();
  });

  test("runDeepAnalysis falls back to @smol when @tiny is unavailable", async () => {
    const factory = (model: string) =>
      model === "@tiny" ? new FakeRpcChild({ dead: true }) : new FakeRpcChild({ replyText: "smol says: risky" });
    const invoker = makeInvoker(factory);
    const out = await runDeepAnalysis(invoker, "rm -rf /tmp/x", { timeoutMs: 5000 }, quietLogger);
    expect(out).toEqual({ text: "smol says: risky", model: "@smol", verdict: null });
    await invoker.dispose();
  });

  test("runDeepAnalysis returns null when no candidate answers", async () => {
    const factory = () => new FakeRpcChild({ dead: true });
    const invoker = makeInvoker(factory);
    const out = await runDeepAnalysis(invoker, "rm -rf /tmp/x", { timeoutMs: 5000 }, quietLogger);
    expect(out).toBeNull();
    await invoker.dispose();
  });
});