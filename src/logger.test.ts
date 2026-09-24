/**
 * Logger tests: the single diagnostic sink appends timestamped lines and
 * rotates by size so a plugin that logs every tool call cannot grow the
 * file without bound.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger } from "./logger";
import { RotatingLog } from "./utils/rotating-log";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-log-"));
}

describe("RotatingLog", () => {
  test("appends lines to the active file", () => {
    const dir = tmpdir();
    const file = path.join(dir, "test.log");
    const log = new RotatingLog({ filePath: file, maxBytes: 1024 });
    log.write("alpha\n");
    log.write("beta\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("alpha\nbeta\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rotates the active file into .1 when the size cap is crossed", () => {
    const dir = tmpdir();
    const file = path.join(dir, "test.log");
    const log = new RotatingLog({ filePath: file, maxBytes: 32, maxFiles: 2 });
    log.write("x".repeat(64) + "\n");
    // The first write starts the file; the next write sees size > cap and rotates.
    log.write("y\n");
    const rotated = path.join(dir, "test.1.log");
    expect(fs.existsSync(rotated), "rotated file exists").toBe(true);
    expect(fs.readFileSync(rotated, "utf-8").length).toBeGreaterThan(64);
    // Fresh active file holds only the line that triggered rotation.
    expect(fs.readFileSync(file, "utf-8")).toBe("y\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("drops writes on FS failure instead of throwing", () => {
    const log = new RotatingLog({ filePath: "/nonexistent/auto-approve-root/test.log" });
    expect(() => log.write("never throws\n")).not.toThrow();
  });
});

describe("Logger", () => {
  test("writes timestamped lines to the plugin log file", () => {
    const dir = tmpdir();
    const logger = new Logger(dir);
    logger.log("hello world");
    const file = path.join(dir, "auto-approve.log");
    const content = fs.readFileSync(file, "utf-8");
    expect(content.endsWith("hello world\n")).toBe(true);
    const line = content.trim();
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello world$/.test(line)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("creates the log directory when absent", () => {
    const dir = path.join(tmpdir(), "nested", "logs");
    const logger = new Logger(dir);
    logger.log("bootstrap");
    expect(fs.existsSync(path.join(dir, "auto-approve.log"))).toBe(true);
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  });
});