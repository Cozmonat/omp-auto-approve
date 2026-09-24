/**
 * Config tests: defaults, enum parsing, host-settings precedence
 * (project overrides > user lockfile > config file > defaults), selective
 * persist (only runtime-touched keys are written back), and the display
 * surface mapping.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigStore,
  DEFAULT_CONFIG,
  displaySurfaces,
  getConfigDir,
  HOST_SETTING_KEYS,
  readHostPluginSettings,
} from "./config";

/** Temp HOME with an .omp/agent dir; returns { home, agent, cwd, cleanup }. */
function isolatedHome(): { home: string; agent: string; cwd: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-cfg-"));
  const agent = path.join(home, ".omp", "agent");
  fs.mkdirSync(agent, { recursive: true });
  const cwd = path.join(home, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  return { home, agent, cwd, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

describe("defaults", () => {
  test("a store with no config file and no host settings yields defaults", () => {
    const env = isolatedHome();
    try {
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config).toEqual(DEFAULT_CONFIG);
    } finally {
      env.cleanup();
    }
  });

  test("DEFAULT_CONFIG pins the documented defaults", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.display).toBe("both");
    expect(DEFAULT_CONFIG.blockRisk).toBe("high");
    expect(DEFAULT_CONFIG.model).toBe("@judge");
    expect(DEFAULT_CONFIG.timeoutMs).toBe(30_000);
    expect(DEFAULT_CONFIG.idleMs).toBe(600_000);
    expect(DEFAULT_CONFIG.subjectMaxChars).toBe(4_000);
  });
});

describe("file parsing", () => {
  test("valid enum values load; invalid values fall back to defaults", () => {
    const env = isolatedHome();
    try {
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ display: "marker", blockRisk: "medium", model: "local/lfm2-1.2b" }),
      );
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.display).toBe("marker");
      expect(store.config.blockRisk).toBe("medium");
      expect(store.config.model).toBe("local/lfm2-1.2b");
    } finally {
      env.cleanup();
    }
  });

  test("garbage enum values keep the defaults", () => {
    const env = isolatedHome();
    try {
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ display: "verbose", blockRisk: "critical", model: "  " }),
      );
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.display).toBe("both");
      expect(store.config.blockRisk).toBe("high");
      expect(store.config.model).toBe("@judge");
    } finally {
      env.cleanup();
    }
  });

  test("enabled=false and timeout/subject caps load from the file", () => {
    const env = isolatedHome();
    try {
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ enabled: false, timeoutMs: 0, subjectMaxChars: 1200 }),
      );
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.enabled).toBe(false);
      expect(store.config.timeoutMs).toBe(0);
      expect(store.config.subjectMaxChars).toBe(1200);
    } finally {
      env.cleanup();
    }
  });
});

describe("displaySurfaces", () => {
  test("off hides every surface", () => {
    expect(displaySurfaces({ display: "off" })).toEqual({ marker: false, notify: false });
  });
  test("marker shows only the in-tool marker", () => {
    expect(displaySurfaces({ display: "marker" })).toEqual({ marker: true, notify: false });
  });
  test("both shows the marker and the assessment toast", () => {
    expect(displaySurfaces({ display: "both" })).toEqual({ marker: true, notify: true });
  });
});

describe("host plugin settings", () => {
  test("project overrides win over the user lockfile, which wins over the config file", () => {
    const env = isolatedHome();
    try {
      // Config file says display=marker.
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ display: "marker" }),
      );
      // User lockfile says display=both, enabled=false.
      const pluginsDir = path.join(env.home, ".omp", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, "omp-plugins.lock.json"),
        JSON.stringify({ settings: { "auto-approve": { display: "both", enabled: false } } }),
      );
      // Project override wins: display=off.
      const proj = path.join(env.cwd, ".omp");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(
        path.join(proj, "plugin-overrides.json"),
        JSON.stringify({ settings: { "auto-approve": { display: "off" } } }),
      );

      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.display).toBe("off");
      // Lockfile value still applies where the project override is silent.
      expect(store.config.enabled).toBe(false);

      // readHostPluginSettings returns the merged store view (override on top).
      const host = readHostPluginSettings(env.cwd, env.home);
      expect(host.display).toBe("off");
      expect(host.enabled).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("host settings win over the config file for the three schema keys", () => {
    const env = isolatedHome();
    try {
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ display: "marker", blockRisk: "medium", enabled: true }),
      );
      const pluginsDir = path.join(env.home, ".omp", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, "omp-plugins.lock.json"),
        JSON.stringify({
          settings: { "auto-approve": { display: "off", blockRisk: "medium", enabled: false } },
        }),
      );
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.display).toBe("off");
      expect(store.config.enabled).toBe(false);
      expect(store.config.blockRisk).toBe("medium");
    } finally {
      env.cleanup();
    }
  });

  test("malformed host stores are ignored, never fatal", () => {
    const env = isolatedHome();
    try {
      const pluginsDir = path.join(env.home, ".omp", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, "omp-plugins.lock.json"), "{not json");
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      expect(store.config.display).toBe("both");
    } finally {
      env.cleanup();
    }
  });
});

describe("selective persist", () => {
  test("update+persist writes only the touched keys and preserves sibling keys", () => {
    const env = isolatedHome();
    try {
      fs.writeFileSync(
        path.join(env.agent, "auto-approve.json"),
        JSON.stringify({ model: "local/lfm2-1.2b", display: "marker", blockRisk: "high" }),
      );
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      store.update({ display: "off" });
      store.persist();

      const onDisk = JSON.parse(fs.readFileSync(path.join(env.agent, "auto-approve.json"), "utf-8"));
      expect(onDisk.display).toBe("off");
      expect(onDisk.model).toBe("local/lfm2-1.2b"); // untouched user key preserved
      expect(onDisk.blockRisk).toBe("high"); // untouched enum key preserved
      expect(store.config.display).toBe("off");
    } finally {
      env.cleanup();
    }
  });

  test("persist with no dirty keys does not rewrite the file", () => {
    const env = isolatedHome();
    try {
      const file = path.join(env.agent, "auto-approve.json");
      const original = JSON.stringify({ model: "x" }, null, 2);
      fs.writeFileSync(file, original);
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      store.persist();
      expect(fs.readFileSync(file, "utf-8")).toBe(original);
    } finally {
      env.cleanup();
    }
  });

  test("only the runtime keys are persistable", () => {
    const env = isolatedHome();
    try {
      const store = new ConfigStore(undefined, env.agent, env.home, env.cwd);
      store.update({ model: "@smol" }); // not persistable
      expect(store.config.model).toBe("@judge"); // non-persistable keys are not applied at runtime
      store.update({ enabled: false });
      store.persist();
      const onDisk = JSON.parse(fs.readFileSync(path.join(env.agent, "auto-approve.json"), "utf-8"));
      expect(onDisk.enabled).toBe(false);
      expect(onDisk.model, "file keeps its value when the runtime-only write is ignored").toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});

describe("config dir resolution", () => {
  test("prefers ~/.omp/agent over ~/.pi/agent under the runtime HOME env", () => {
    const env = isolatedHome();
    const piAgent = path.join(env.home, ".pi", "agent");
    fs.mkdirSync(piAgent, { recursive: true });
    try {
      const saved = process.env.HOME;
      process.env.HOME = env.home;
      try {
        expect(getConfigDir()).toBe(env.agent);
      } finally {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
      }
    } finally {
      env.cleanup();
    }
  });

  test("falls back to the .pi dir when only it exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "auto-approve-pi-"));
    const piAgent = path.join(home, ".pi", "agent");
    fs.mkdirSync(piAgent, { recursive: true });
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(getConfigDir()).toBe(piAgent);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("package.json settings schema parity", () => {
  test("omp.settings keys and defaults match the runtime config", () => {
    const file = new URL("../package.json", import.meta.url);
    const manifest: { omp?: { settings?: Record<string, { default?: unknown; type?: string; values?: unknown[] }> } } =
      JSON.parse(fs.readFileSync(fileURLToPath(file), "utf-8"));
    const settings = manifest.omp?.settings;
    expect(settings).toBeDefined();
    if (!settings) return;
    const schemaKeys = Object.keys(settings).sort();
    expect(schemaKeys).toEqual([...HOST_SETTING_KEYS].sort());
    for (const key of Object.keys(settings)) {
      const spec = settings[key as "enabled"];
      const runtimeDefault = (DEFAULT_CONFIG[key as "enabled" | "display" | "blockRisk" | "fallback"]) as string | boolean;
      expect(spec?.default).toBe(runtimeDefault);
    }
    // Enum specs must list exactly the values the merge accepts.
    expect(settings.display?.values).toEqual(["off", "marker", "both"]);
    expect(settings.blockRisk?.values).toEqual(["medium", "high"]);
    expect(settings.fallback?.values).toEqual(["ask", "block"]);
    expect(settings.enabled?.type).toBe("boolean");
  });
});