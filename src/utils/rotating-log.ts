/**
 * Rotating file logger — size-based rotation with retention cap.
 *
 * On each write, checks the current file size. When it exceeds
 * `maxBytes`, the file is renamed to `<name>.1.log` (bumping any
 * existing `.1` → `.2`, etc.) and a fresh file is started.
 * Files beyond `maxFiles` are deleted.
 *
 * A startup sweep removes files older than `maxAgeMs` regardless
 * of the rotation count — a safety net for long-running processes
 * that rarely hit the size threshold.
 *
 * All operations are synchronous (appendFileSync / renameSync) to
 * match the existing logger patterns in OMP plugins.  Rotation
 * overhead is negligible: one statSync per write, a rename chain
 * only when the threshold is crossed.
 */

import { appendFileSync, statSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export interface RotatingLogOptions {
  /** Full path to the active log file. */
  filePath: string;
  /** Max file size before rotation (default 5 MB). */
  maxBytes?: number;
  /** Max number of rotated files to keep (default 3). */
  maxFiles?: number;
  /** Max age in ms for any log file; older files are deleted on startup (default 30 days). */
  maxAgeMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class RotatingLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly baseName: string;
  private readonly dir: string;

  constructor(opts: RotatingLogOptions) {
    this.filePath = opts.filePath;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.baseName = basename(opts.filePath, ".log");
    this.dir = dirname(opts.filePath);
  }

  /**
   * Append a line to the log file, rotating if needed.
   * Never throws: on any FS error the line is dropped (diagnostics
   * are best-effort; a log failure must not take down the caller).
   */
  write(line: string): void {
    try {
      this.maybeRotate();
      appendFileSync(this.filePath, line, "utf-8");
    } catch {
      // Diagnostics are best-effort; never propagate.
    }
  }

  /**
   * Remove log files older than `maxAgeMs`.
   * Call once at startup.
   */
  cleanStale(): void {
    try {
      const files = readdirSync(this.dir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith(this.baseName + ".") || !file.endsWith(".log")) continue;
        const full = join(this.dir, file);
        try {
          const st = statSync(full);
          if (now - st.mtimeMs > this.maxAgeMs) unlinkSync(full);
        } catch {
          // skip unreadable/rotating entries
        }
      }
    } catch {
      // Directory may not exist yet; nothing to clean.
    }
  }

  /** Check file size and rotate if the threshold is exceeded. */
  private maybeRotate(): void {
    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return; // No active file yet — nothing to rotate.
    }
    if (size <= this.maxBytes) return;

    // Bump existing rotations: .N -> .(N+1), up to maxFiles.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      const to = this.rotatedPath(i + 1);
      try {
        if (statSync(from).isFile()) {
          if (i + 1 > this.maxFiles) {
            try { unlinkSync(from); } catch {}
            continue;
          }
          renameSync(from, to);
        }
      } catch {
        // No file at this slot — continue.
      }
    }
    // Move the active file into slot .1 and start fresh.
    try {
      renameSync(this.filePath, this.rotatedPath(1));
    } catch {
      // If the rename fails (permissions, race), keep writing to the
      // oversized file; the next write retries rotation.
    }
  }

  private rotatedPath(index: number): string {
    return join(this.dir, `${this.baseName}.${index}.log`);
  }
}