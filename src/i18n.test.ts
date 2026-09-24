/**
 * i18n tests: every user-facing string exists in both locales with the
 * same {n} placeholder shape, so formatting can never break on one locale.
 */

import { describe, expect, test } from "bun:test";
import { createI18n } from "./i18n";
import type { I18nLang } from "./i18n";

function keySet(lang: I18nLang): Set<string> {
  const i18n = createI18n(lang);
  // Reflect the dictionary via a format pass over the known keys is not
  // possible from the outside; the module exports its key list for this.
  return new Set(i18n.keys());
}

/** The complete key contract. A key dropped from either locale's
 *  dictionary (caught here at test time, not only by tsc) makes
 *  format() pass the raw key through as user-facing text. */
const EXPECTED_KEYS = [
  "allowPrompt", "analysisUnavailable", "analyzing", "blocked",
  "cmdDescription", "cmdDisplayBothDescription", "cmdDisplayDescription",
  "cmdDisplayMarkerDescription", "cmdDisplayOffDescription",
  "cmdFallbackAskDescription", "cmdFallbackBlockDescription", "cmdFallbackDescription",
  "cmdOffDescription", "cmdOnDescription", "cmdRiskDescription",
  "cmdRiskHighDescription", "cmdRiskMediumDescription", "cmdStatusDescription",
  "commandLabel", "confirmTitle", "deniedJudgeDeclined", "deniedJudgeRisk",
  "deniedJudgeUnavailable", "deniedNoVerdict", "deniedTooLong", "deniedUserDenied",
  "displayStatus", "fallbackStatus", "fallbackSwitched", "headlessNote", "help",
  "markerApproved", "markerBlocked", "notifyApproved", "notifyBlocked",
  "reasonDeny", "reasonFallback", "reasonHighRisk", "reasonMediumRisk", "reasonNoVerdict",
  "reasonTruncated",
  "riskDeep", "riskHigh", "riskLow", "riskMedium", "riskStatus", "riskUser",
  "statusDisabled", "statusEnabled", "switchDisplay", "switchEnabled", "switchDisabled",
  "switchRisk", "userDenied",
].sort();

describe("key completeness", () => {
  test("both locales expose the full key contract", () => {
    for (const lang of ["en", "zh"] as const) {
      expect([...createI18n(lang).keys()].sort()).toEqual(EXPECTED_KEYS);
    }
  });
});

describe("locale parity", () => {
  test("en and zh expose the identical key set", () => {
    const en = keySet("en");
    const zh = keySet("zh");
    const missingInZh = [...en].filter((k) => !zh.has(k));
    const missingInEn = [...zh].filter((k) => !en.has(k));
    expect(missingInZh).toEqual([]);
    expect(missingInEn).toEqual([]);
  });

  test("matching keys use the same {n} placeholders", () => {
    const en = createI18n("en");
    const zh = createI18n("zh");
    for (const key of en.keys()) {
      const enPlaceholders = (en.format(key).match(/\{\d+\}/g) ?? []).sort().join(",");
      const zhPlaceholders = (zh.format(key).match(/\{\d+\}/g) ?? []).sort().join(",");
      expect(zhPlaceholders).toBe(enPlaceholders);
    }
  });

  test("format substitutes numbered placeholders in order", () => {
    const en = createI18n("en");
    expect(en.format("notifyApproved", "low", ": does a git push")).toBe(
      "✅ Auto-approved (low): does a git push",
    );
  });

  test("unknown keys return the key itself (never crash)", () => {
    const i18n = createI18n("en");
    expect(i18n.format("definitely_not_a_key")).toBe("definitely_not_a_key");
  });
});