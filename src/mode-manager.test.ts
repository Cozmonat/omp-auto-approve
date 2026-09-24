/**
 * ModeManager tests: runtime switches validate their enums, apply in memory
 * immediately, and persist only the changed key to the config file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "./config";
import { ModeManager } from "./mode-manager";

describe("ModeManager", () => {
  let tmp: string;
  let store: ConfigStore;
  let manager: ModeManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-mode-"));
    store = new ConfigStore(undefined, path.join(tmp, "agent"), tmp, tmp);
    manager = new ModeManager(store);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("getters reflect the loaded config", () => {
    expect(manager.isEnabled()).toBe(true);
    expect(manager.getDisplay()).toBe("both");
    expect(manager.getBlockRisk()).toBe("high");
    expect(manager.getFallback()).toBe("block");
  });

  test("setEnabled applies and persists only the enabled key", () => {
    manager.setEnabled(false);
    expect(manager.isEnabled()).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(store.configPath, "utf-8"));
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.display).toBeUndefined(); // untouched key not written
  });

  test("setDisplay applies and persists", () => {
    manager.setDisplay("marker");
    expect(manager.getDisplay()).toBe("marker");
    const onDisk = JSON.parse(fs.readFileSync(store.configPath, "utf-8"));
    expect(onDisk.display).toBe("marker");
  });

  test("setBlockRisk applies and persists", () => {
    manager.setBlockRisk("medium");
    expect(manager.getBlockRisk()).toBe("medium");
    const onDisk = JSON.parse(fs.readFileSync(store.configPath, "utf-8"));
    expect(onDisk.blockRisk).toBe("medium");
  });

  test("setFallback applies and persists", () => {
    manager.setFallback("ask");
    expect(manager.getFallback()).toBe("ask");
    const onDisk = JSON.parse(fs.readFileSync(store.configPath, "utf-8"));
    expect(onDisk.fallback).toBe("ask");
  });

  test("invalid enum values are rejected before touching state or disk", () => {
    expect(() => manager.setDisplay("loud")).toThrow();
    expect(() => manager.setBlockRisk("critical" as never)).toThrow();
    expect(() => manager.setFallback("loud")).toThrow();
    expect(manager.getDisplay()).toBe("both");
    expect(manager.getBlockRisk()).toBe("high");
    expect(manager.getFallback()).toBe("block");
    expect(fs.existsSync(store.configPath)).toBe(false); // nothing persisted
  });

  test("multiple switches batch into a single persist of the changed keys", () => {
    manager.setEnabled(false);
    manager.setDisplay("off");
    const onDisk = JSON.parse(fs.readFileSync(store.configPath, "utf-8"));
    expect(onDisk).toEqual({ enabled: false, display: "off" });
  });

  test("persisted values survive a reload", () => {
    manager.setEnabled(false);
    manager.setBlockRisk("medium");
    store.persist();
    const reloaded = new ModeManager(new ConfigStore(undefined, path.join(tmp, "agent"), tmp, tmp));
    expect(reloaded.isEnabled()).toBe(false);
    expect(reloaded.getBlockRisk()).toBe("medium");
  });
});