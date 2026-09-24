/**
 * Auto Approve — host resolution.
 *
 * Resolves the host binary (the process that launched this extension) so
 * the plugin can spawn `omp --mode rpc` judge children.  Ported from
 * smart-approve's HostResolver; the one-shot pool machinery is not needed
 * here (single persistent child).
 */

import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { LoggerLike } from "./types";

export interface HostLaunchSpec {
  command: string;
  prefixArgs: readonly string[];
}

interface HostRuntimePaths {
  execPath: string;
  argv1: string | undefined;
}

/**
 * Resolves how to launch the host for one-shot judge invocation.
 *
 * Strategy (in priority order):
 *  1. process.argv[1] + process.execPath — script-hosted OMP/pi. The CLI
 *     script must be passed to its absolute runtime because sanitized PATH
 *     cannot satisfy a `#!/usr/bin/env bun` or Node shebang.
 *  2. process.execPath — the host executable for bundled OMP binaries.
 *     Used when process.argv[1] is a virtual path like /$bunfs/root/...
 *     that cannot be realpath'd.
 *  3. PATH lookup via `command -v omp` / `command -v pi` — last resort.
 *     May fail if the extension process inherits a sanitized PATH.
 *
 * Memoized after first resolution.
 */
export class HostResolver {
  private resolved: HostLaunchSpec | null | undefined;
  private readonly logger: LoggerLike;

  constructor(
    logger: LoggerLike,
    private readonly runtime: HostRuntimePaths = {
      execPath: process.execPath,
      argv1: process.argv[1],
    },
  ) {
    this.logger = logger;
  }

  /** Resolve and memoize the host launch command and fixed arguments. */
  resolve(): HostLaunchSpec | null {
    if (this.resolved !== undefined) return this.resolved;

    const launcher = this.tryResolve("process.argv[1]", this.runtime.argv1);
    if (launcher) {
      const runtime = this.tryResolve("process.execPath", this.runtime.execPath);
      if (runtime) {
        this.resolved = { command: runtime, prefixArgs: [launcher] };
        return this.resolved;
      }
    }

    // Bundled hosts expose the OMP/pi executable as process.execPath.
    const executable = this.tryResolve("process.execPath", this.runtime.execPath);
    if (executable) {
      this.resolved = { command: executable, prefixArgs: [] };
      return this.resolved;
    }

    // PATH lookup — last resort
    const pathExecutable = this.tryPathLookup();
    if (pathExecutable) {
      this.resolved = { command: pathExecutable, prefixArgs: [] };
      return this.resolved;
    }

    this.logger.log("host: all resolution strategies failed");
    this.resolved = null;
    return null;
  }

  /** Try to realpath a candidate; log + return null on failure. */
  private tryResolve(strategy: string, candidate: string | undefined): string | null {
    if (!candidate) {
      this.logger.log(`host: ${strategy} is empty`);
      return null;
    }
    try {
      const resolved = fs.realpathSync(candidate);
      this.logger.log(`host: ${strategy} resolved ${resolved}`);
      return resolved;
    } catch (e) {
      this.logger.log(`host: ${strategy} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** PATH lookup via `command -v omp` / `command -v pi`. */
  private tryPathLookup(): string | null {
    for (const bin of ["omp", "pi"]) {
      try {
        const out = execSync(`command -v ${bin}`, {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 2000,
          encoding: "utf-8",
        });
        const resolved = out.trim();
        // Resolve to an absolute path — a bare name would fail to spawn
        // in worker processes with an incomplete PATH (posix_spawn ENOENT).
        if (resolved && resolved.includes("/")) {
          this.logger.log(`host: PATH lookup resolved ${resolved}`);
          return resolved;
        }
      } catch {
        // not found
      }
    }
    this.logger.log("host: PATH lookup failed for omp and pi");
    return null;
  }
}