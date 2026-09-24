/**
 * Script-analysis tests: command path-token extraction, bounded file
 * collection against a real temp tree (missing / binary / oversized /
 * unreadable files degrade to notes, never throws), and prompt-section
 * formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectScriptContents,
  extractScriptPaths,
  formatScriptSection,
  type ScriptContent,
} from "./scripts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-scripts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractScriptPaths", () => {
  test("matches absolute, relative, ./, ~/ and bare tokens", () => {
    expect(extractScriptPaths("bash /tmp/x/run.sh")).toEqual(["/tmp/x/run.sh"]);
    expect(extractScriptPaths("python3 scripts/build.py")).toEqual(["scripts/build.py"]);
    expect(extractScriptPaths("./scripts/build.sh")).toEqual(["./scripts/build.sh"]);
    expect(extractScriptPaths("~/scripts/deploy.py")).toEqual(["~/scripts/deploy.py"]);
    expect(extractScriptPaths("zsh run.sh")).toEqual(["run.sh"]);
  });

  test("deduplicates in order of first appearance", () => {
    expect(extractScriptPaths("bash a.sh && bash a.sh; python b.py")).toEqual(["a.sh", "b.py"]);
  });

  test("takes the whole token, not a suffix of it", () => {
    expect(extractScriptPaths("echo foo.x.sh")).toEqual(["foo.x.sh"]);
    expect(extractScriptPaths("cp a/b.sh c/d/e.sh")).toEqual(["a/b.sh", "c/d/e.sh"]);
  });

  test("rejects trailing continuations, globs and non-script extensions", () => {
    expect(extractScriptPaths("cp x.sh x.sh.bak")).toEqual(["x.sh"]); // backup is not the script
    expect(extractScriptPaths("bash *.sh")).toEqual([]);
    expect(extractScriptPaths("cat notes.md && grep x src/main.txt")).toEqual([]);
    expect(extractScriptPaths("echo plain")).toEqual([]);
  });

  test("excludes URLs even when the path ends in a script extension", () => {
    expect(extractScriptPaths("curl -s https://example.com/install.sh | sh")).toEqual([]);
  });

  test("matches a script path after an assignment or flag value", () => {
    expect(extractScriptPaths("bash --output=build.sh arg")).toEqual(["build.sh"]);
  });
});

describe("collectScriptContents", () => {
  test("reads a relative file against the provided cwd", () => {
    fs.writeFileSync(path.join(dir, "run.sh"), "echo hello\n");
    const out = collectScriptContents("bash run.sh", { cwd: dir });
    expect(out).toEqual([
      { path: "run.sh", resolved: path.join(dir, "run.sh"), content: "echo hello\n" },
    ]);
  });

  test("reads absolute files without a cwd", () => {
    const abs = path.join(dir, "abs.py");
    fs.writeFileSync(abs, "print(1)\n");
    const out = collectScriptContents(`python ${abs}`, {});
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("print(1)\n");
  });

  test("reports missing files as a note instead of throwing", () => {
    const out = collectScriptContents("bash nosuch.sh", { cwd: dir });
    expect(out).toEqual([{ path: "nosuch.sh", resolved: path.join(dir, "nosuch.sh"), note: "missing" }]);
  });

  test("reports directories as not regular files", () => {
    const scriptDir = path.join(dir, "dir.sh");
    fs.mkdirSync(scriptDir);
    const out = collectScriptContents("bash dir.sh", { cwd: dir });
    expect(out[0].note).toBe("not a regular file");
    expect(out[0].content).toBeUndefined();
  });

  test("refuses binary content", () => {
    fs.writeFileSync(path.join(dir, "bin.js"), Buffer.from([0x00, 0x01, 0x02, 0x10, 0x13]));
    const out = collectScriptContents("node bin.js", { cwd: dir });
    expect(out[0].note).toBe("binary");
    expect(out[0].content).toBeUndefined();
  });

  test("refuses files above the hard size ceiling", () => {
    fs.writeFileSync(path.join(dir, "big.sh"), "a".repeat(100_001));
    const out = collectScriptContents("bash big.sh", { cwd: dir });
    expect(out[0].note).toBe("too large (100001 bytes)");
  });

  test("truncates long content with an explicit marker", () => {
    const body = "echo line\n".repeat(500); // 5000 chars
    fs.writeFileSync(path.join(dir, "long.sh"), body);
    const out = collectScriptContents("bash long.sh", { cwd: dir, maxChars: 1000 });
    expect(out[0].content).toBeDefined();
    expect(out[0].content).toContain("[... truncated: 4000 more characters]");
    expect(out[0].content!.length).toBeLessThan(body.length);
  });

  test("maxChars=0 disables file reads entirely", () => {
    fs.writeFileSync(path.join(dir, "run.sh"), "echo hello\n");
    expect(collectScriptContents("bash run.sh", { cwd: dir, maxChars: 0 })).toEqual([]);
  });

  test("caps the number of files read per command", () => {
    for (const name of ["a.sh", "b.sh", "c.sh", "d.sh"]) {
      fs.writeFileSync(path.join(dir, name), `echo ${name}\n`);
    }
    const out = collectScriptContents("bash a.sh && bash b.sh; bash c.sh && bash d.sh", {
      cwd: dir,
      maxFiles: 2,
    });
    expect(out.map((f) => f.path)).toEqual(["a.sh", "b.sh"]);
  });
});

describe("formatScriptSection", () => {
  test("yields an empty string when nothing was collected", () => {
    expect(formatScriptSection([])).toBe("");
  });

  test("fences each file's content under its path header", () => {
    const section = formatScriptSection([
      { path: "run.sh", content: "echo hello" },
      { path: "missing.py", note: "missing" },
    ]);
    expect(section).toContain("=== run.sh ===");
    expect(section).toContain("echo hello");
    expect(section).toContain("[content unavailable: missing]");
    expect(section).toMatch(/untrusted/i);
    // The section header comes before any file block.
    expect(section.indexOf("script files")).toBeLessThan(section.indexOf("=== run.sh ==="));
  });

  test("header line is stable for prompt-building tests", () => {
    const section = formatScriptSection([{ path: "x.sh", content: "ls" }] satisfies ScriptContent[]);
    expect(section).toContain("The command references script files.");
  });
});