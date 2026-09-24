/**
 * Auto Approve — runtime mode management.
 *
 * Thin validation layer over ConfigStore for the keys a slash command may
 * switch at runtime (enabled / display / blockRisk).  Setters validate the
 * value, apply it in memory immediately, and persist only the changed key.
 */

import type { BlockRisk, ConfigStore, DisplayMode, FallbackMode } from "./config";

export const DISPLAY_VALUES: readonly DisplayMode[] = ["off", "marker", "both"];
export const BLOCK_RISK_VALUES: readonly BlockRisk[] = ["medium", "high"];
export const FALLBACK_VALUES: readonly FallbackMode[] = ["ask", "block"];

export class ModeManager {
  constructor(private readonly configStore: ConfigStore) {}

  isEnabled(): boolean {
    return this.configStore.config.enabled;
  }

  setEnabled(value: boolean): void {
    this.configStore.update({ enabled: value });
    this.configStore.persist();
  }

  getFallback(): FallbackMode {
    return this.configStore.config.fallback;
  }

  setFallback(value: string): void {
    if (!(FALLBACK_VALUES as readonly string[]).includes(value)) {
      throw new Error(`invalid fallback value: ${value} (expected ${FALLBACK_VALUES.join("|")})`);
    }
    this.configStore.update({ fallback: value as FallbackMode });
    this.configStore.persist();
  }

  getDisplay(): DisplayMode {
    return this.configStore.config.display;
  }

  setDisplay(value: string): void {
    if (!(DISPLAY_VALUES as readonly string[]).includes(value)) {
      throw new Error(`invalid display value: ${value} (expected ${DISPLAY_VALUES.join("|")})`);
    }
    this.configStore.update({ display: value as DisplayMode });
    this.configStore.persist();
  }

  getBlockRisk(): BlockRisk {
    return this.configStore.config.blockRisk;
  }

  setBlockRisk(value: string): void {
    if (!(BLOCK_RISK_VALUES as readonly string[]).includes(value)) {
      throw new Error(`invalid block risk: ${value} (expected ${BLOCK_RISK_VALUES.join("|")})`);
    }
    this.configStore.update({ blockRisk: value as BlockRisk });
    this.configStore.persist();
  }
}