/**
 * index tests: /auto-approve command handler behavior (toggle / on / off /
 * status / display / risk / help), completion arrays in both locales,
 * runtime persistence round-trips, and factory registration.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import autoApprove, {
  AutoApprove,
  createAutoApproveCompletionProvider,
  registerAutoApproveCommand,
  showCommandResult,
} from "./index";
import { ConfigStore } from "./config";
import { ModeManager } from "./mode-manager";
import { createI18n } from "./i18n";
import type { I18n } from "./i18n";
import type { AutocompleteItem, ExtensionAPI, ExtensionCtx, LoggerLike } from "./types";

const quietLogger: LoggerLike = { log: () => {} };
const t = createI18n("en");

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-index-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface RegisteredCommand {
  name: string;
  description: string;
  getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: unknown, ctx: ExtensionCtx) => void | Promise<void>;
}

function makeCommandPi(): {
  pi: ExtensionAPI;
  command: () => RegisteredCommand;
} {
  let command: RegisteredCommand | null = null;
  const pi = {
    on: () => {},
    sendMessage: () => {},
    registerCommand: (name: string, def: RegisteredCommand) => {
      command = { ...def, name };
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    registerTool: () => {},
    zod: {
      object: (spec: unknown) => spec,
      string: () => ({ describe: () => ({}), optional: () => ({}) } as unknown as never),
      number: () => ({ describe: () => ({}), optional: () => ({}) } as unknown as never),
      boolean: () => ({ describe: () => ({}), optional: () => ({}) } as unknown as never),
      enum: (values: readonly string[]) => values,
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    command: () => {
      if (!command) throw new Error("command not registered");
      return command;
    },
  };
}

interface CmdCtx {
  ctx: ExtensionCtx;
  messages: string[];
}

function makeCommandCtx(): CmdCtx {
  const messages: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      confirm: async () => false,
      setStatus: () => {},
      notify: (msg: string) => {
        messages.push(msg);
      },
    },
  } as unknown as ExtensionCtx;
  return { ctx, messages };
}

function makeModeManager(configDir: string): ModeManager {
  return new ModeManager(new ConfigStore(quietLogger, configDir));
}

async function runCommand(
  modeManager: ModeManager,
  handler: RegisteredCommand["handler"],
  args: string,
  ctx: ExtensionCtx,
): Promise<void> {
  await handler(args, ctx);
}

// ── command handler: toggling and explicit states ───────────────────

describe("/auto-approve handler", () => {
  test("no argument toggles enabled and persists the switch", async () => {
    const configDir = tmpDir();
    const modeManager = makeModeManager(configDir);
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();
    expect(cmd.name).toBe("auto-approve");

    const { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "", ctx);
    expect(messages).toEqual(["auto-approve disabled."]);
    expect(fs.readFileSync(path.join(configDir, "auto-approve.json"), "utf-8")).toContain('"enabled": false');

    // A fresh store in the same directory sees the persisted state.
    const reloaded = new ConfigStore(quietLogger, configDir);
    expect(reloaded.config.enabled).toBe(false);

    // Second no-arg call toggles back on.
    const second = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "", second.ctx);
    expect(second.messages).toEqual(["auto-approve enabled."]);
    const reloaded2 = new ConfigStore(quietLogger, configDir);
    expect(reloaded2.config.enabled).toBe(true);
  });

  test("on / off set explicitly", async () => {
    const modeManager = makeModeManager(tmpDir());
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    modeManager.setEnabled(false);
    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "on", ctx);
    expect(messages).toEqual(["auto-approve enabled."]);
    expect(modeManager.isEnabled()).toBe(true);

    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "off", ctx);
    expect(messages).toEqual(["auto-approve disabled."]);
    expect(modeManager.isEnabled()).toBe(false);
  });

  test("status reflects enabled state with model, display, and risk", async () => {
    const modeManager = makeModeManager(tmpDir());
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "status", ctx);
    expect(messages).toEqual([
      "auto-approve: ON (model @judge, display both, blocks risk high and above)",
    ]);

    modeManager.setEnabled(false);
    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "status", ctx);
    expect(messages).toEqual(["auto-approve: OFF (bash passes through natively)"]);
  });

  test("display <mode> validates, switches, and persists", async () => {
    const configDir = tmpDir();
    const modeManager = makeModeManager(configDir);
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "display marker", ctx);
    expect(messages).toEqual(["display set to marker."]);
    expect(fs.readFileSync(path.join(configDir, "auto-approve.json"), "utf-8")).toContain('"display": "marker"');
    expect(new ConfigStore(quietLogger, configDir).config.display).toBe("marker");

    // An unknown display value does not throw — it shows the help.
    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "display loud", ctx);
    expect(messages[0]).toContain("usage: /auto-approve");
  });

  test("risk <level> validates, switches, and persists", async () => {
    const configDir = tmpDir();
    const modeManager = makeModeManager(configDir);
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "risk medium", ctx);
    expect(messages).toEqual(["block risk set to medium."]);
    expect(fs.readFileSync(path.join(configDir, "auto-approve.json"), "utf-8")).toContain('"blockRisk": "medium"');
    expect(new ConfigStore(quietLogger, configDir).config.blockRisk).toBe("medium");

    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "risk extreme", ctx);
    expect(messages[0]).toContain("usage: /auto-approve");
  });

  test("unknown arguments show the help, never throw", async () => {
    const modeManager = makeModeManager(tmpDir());
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    const { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "bogus", ctx);
    expect(messages[0]).toContain("usage: /auto-approve");
  });

  test("fallback <mode> validates, switches, and persists", async () => {
    const configDir = tmpDir();
    const modeManager = makeModeManager(configDir);
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "fallback ask", ctx);
    expect(messages).toEqual(["fallback policy set to ask."]);
    expect(fs.readFileSync(path.join(configDir, "auto-approve.json"), "utf-8")).toContain('"fallback": "ask"');
    expect(new ConfigStore(quietLogger, configDir).config.fallback).toBe("ask");

    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "fallback yolo", ctx);
    expect(messages[0]).toContain("usage: /auto-approve");
  });

  test("bare fallback reports the current policy", async () => {
    const modeManager = makeModeManager(tmpDir());
    const { pi, command } = makeCommandPi();
    registerAutoApproveCommand(pi, modeManager, t);
    const cmd = command();

    let { ctx, messages } = makeCommandCtx();
    await runCommand(modeManager, cmd.handler, "fallback", ctx);
    expect(messages).toEqual(["fallback policy: block"]); // default

    modeManager.setFallback("ask");
    ({ ctx, messages } = makeCommandCtx());
    await runCommand(modeManager, cmd.handler, "fallback", ctx);
    expect(messages).toEqual(["fallback policy: ask"]);
  });

});

// ── completions: both locales ────────────────────────────────────────

describe("completion provider", () => {
  test("empty prefix lists root items alphabetically (en)", () => {
    const items = createAutoApproveCompletionProvider(createI18n("en"))("");
    expect(items?.map((i) => i.value)).toEqual(["display", "fallback", "off", "on", "risk", "status"]);
    expect(items?.[0]?.description).toBe("set where approval markers appear (off|marker|both)");
  });

  test("empty prefix lists root items alphabetically (zh)", () => {
    const items = createAutoApproveCompletionProvider(createI18n("zh"))("");
    expect(items?.map((i) => i.value)).toEqual(["display", "fallback", "off", "on", "risk", "status"]);
    expect(items?.find((i) => i.value === "on")?.description).toBe("启用 auto-approve");
  });

  test("root prefix filters by value prefix", () => {
    const provider = createAutoApproveCompletionProvider(t);
    expect(provider("on")?.map((i) => i.value)).toEqual(["on"]);
    expect(provider("off")?.map((i) => i.value)).toEqual(["off"]);
    expect(provider("zzz")).toBeNull();
  });

  test("display <prefix> lists the three display values", () => {
    const provider = createAutoApproveCompletionProvider(t);
    expect(provider("display ")?.map((i) => i.value)).toEqual(["display off", "display marker", "display both"]);
    expect(provider("display ma")?.map((i) => i.value)).toEqual(["display marker"]);
    expect(provider("display nope")).toBeNull();
  });

  test("risk <prefix> lists the two risk levels", () => {
    const provider = createAutoApproveCompletionProvider(t);
    expect(provider("risk ")?.map((i) => i.value)).toEqual(["risk medium", "risk high"]);
    expect(provider("risk h")?.map((i) => i.value)).toEqual(["risk high"]);
  });

  test("fallback <prefix> lists the two fallback policies", () => {
    const provider = createAutoApproveCompletionProvider(t);
    expect(provider("fallback ")?.map((i) => i.value)).toEqual(["fallback ask", "fallback block"]);
    expect(provider("fallback a")?.map((i) => i.value)).toEqual(["fallback ask"]);
    expect(provider("fallback nope")).toBeNull();
  });

  test("two-word prefixes that are not display/risk return null", () => {
    const provider = createAutoApproveCompletionProvider(t);
    expect(provider("on extra")).toBeNull();
    expect(provider("status extra")).toBeNull();
  });
});

// ── factory registration ─────────────────────────────────────────────

function makeZodStub() {
  const field = { describe: () => field, optional: () => field };
  return {
    object: (spec: unknown) => spec,
    string: () => field,
    number: () => field,
    boolean: () => field,
    enum: (values: readonly string[]) => values,
  };
}

describe("AutoApprove factory", () => {
  test("register() exposes the bash shadow, the command, and the shutdown hook", async () => {
    const configDir = tmpDir();
    const tools: Array<{ name: string; approval?: string; description: string }> = [];
    const commands: Array<{ name: string; description: string; hasCompletions: boolean }> = [];
    const events: string[] = [];
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const pi = {
      on: (event: string, handler: () => Promise<void>) => {
        events.push(event);
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      },
      sendMessage: () => {},
      registerCommand: (name: string, def: { description: string; getArgumentCompletions?: unknown }) => {
        commands.push({ name, description: def.description, hasCompletions: typeof def.getArgumentCompletions === "function" });
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      registerTool: (tool: { name: string; approval?: string; description: string }) => tools.push(tool),
      zod: makeZodStub(),
    } as unknown as ExtensionAPI;

    // No host binary: host resolution fails and the plugin must still
    // register (judge then fails closed per call).
    const plugin = new AutoApprove(pi, {
      logger: quietLogger,
      i18n: t,
      configDir,
      home: configDir,
      cwd: configDir,
      hostRuntime: { execPath: path.join(configDir, "no-such-host"), argv1: undefined },
      childFactory: () => {
        throw new Error("no child in this test");
      },
    });
    plugin.register();

    expect(tools.map((x) => x.name)).toEqual(["bash"]);
    expect(tools[0]?.approval).toBe("exec");
    expect(commands).toEqual([
      { name: "auto-approve", description: "Auto-approve low-risk operations with a judge model", hasCompletions: true },
    ]);
    expect(events).toEqual(["session_shutdown"]);
    // The shutdown hook disposes the judge invoker without throwing.
    await shutdownHandlers[0]?.();
  });

  test("the default export constructs and registers", () => {
    const configDir = tmpDir();
    const pi = {
      on: () => {},
      sendMessage: () => {},
      registerCommand: () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      registerTool: () => {},
      zod: makeZodStub(),
    } as unknown as ExtensionAPI;
    // The default export is not injectable (host paths); it must still
    // construct with the real HOME isolated to the temp dir.
    const realHome = process.env.HOME;
    process.env.HOME = configDir;
    try {
      autoApprove(pi);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });
});

// ── showCommandResult: notify prefers setStatus fallback ─────────────

describe("showCommandResult", () => {
  test("uses ui.notify when present", () => {
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async () => false,
        setStatus: () => {},
        notify: (msg: string) => notifications.push(msg),
      },
    } as unknown as ExtensionCtx;
    showCommandResult(ctx, "hello");
    expect(notifications).toEqual(["hello"]);
  });

  test("falls back to a status row that is cleared after the schedule", () => {
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async () => false,
        setStatus: (id: string, text: string | undefined) => statuses.push([id, text]),
      },
    } as unknown as ExtensionCtx;
    showCommandResult(ctx, "hello", (callback) => callback());
    expect(statuses[0]?.[1]).toBe("hello");
    expect(statuses.at(-1)?.[1]).toBeUndefined();
  });
});