/**
 * Policy tests: the pure auto-approve decision matrix.  A missing verdict
 * (judge down, timeout, unparseable output) must always fail closed.
 */

import { describe, expect, test } from "bun:test";
import { decide, type PolicyDecision } from "./policy";
import type { JudgeVerdict } from "./types";

describe("decide — fail-closed rows", () => {
  test("no verdict at all blocks (judge unusable)", () => {
    expect(decide(null, "high")).toEqual({ verdict: "block", reason: "fallback" });
    expect(decide(null, "medium")).toEqual({ verdict: "block", reason: "fallback" });
  });

  test("an empty verdict object blocks like no verdict", () => {
    expect(decide({}, "high")).toEqual({ verdict: "block", reason: "fallback" });
  });
});

describe("decide — explicit model signals", () => {
  test("recommend deny always blocks, even at low risk", () => {
    expect(decide({ risk: "low", recommend: "deny" }, "high")).toEqual({ verdict: "block", reason: "ai-recommend" });
  });

  test("high risk always blocks", () => {
    expect(decide({ risk: "high" }, "high")).toEqual({ verdict: "block", reason: "ai-risk" });
    expect(decide({ risk: "high" }, "medium")).toEqual({ verdict: "block", reason: "ai-risk" });
  });

  test("high risk wins over a contradicting allow recommendation", () => {
    const d: PolicyDecision = decide({ risk: "high", recommend: "allow" }, "high");
    expect(d.verdict).toBe("block");
    expect(d.reason).toBe("ai-risk");
  });

  test("medium risk blocks only when blockRisk is medium", () => {
    expect(decide({ risk: "medium", recommend: "allow" }, "high")).toEqual({ verdict: "allow", reason: "ai-risk" });
    expect(decide({ risk: "medium", recommend: "allow" }, "medium")).toEqual({ verdict: "block", reason: "ai-risk" });
  });
});

describe("decide — auto-approval rows", () => {
  test("low risk auto-approves under both thresholds", () => {
    expect(decide({ risk: "low" }, "high")).toEqual({ verdict: "allow", reason: "ai-risk" });
    expect(decide({ risk: "low" }, "medium")).toEqual({ verdict: "allow", reason: "ai-risk" });
  });

  test("an allow recommendation with no risk rating auto-approves", () => {
    expect(decide({ recommend: "allow" }, "high")).toEqual({ verdict: "allow", reason: "ai-risk" });
  });

  test("low risk with an allow recommendation auto-approves", () => {
    const v: JudgeVerdict = { risk: "low", recommend: "allow", summary: "pushes a feature branch" };
    expect(decide(v, "medium").verdict).toBe("allow");
  });
});