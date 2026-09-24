/**
 * Auto Approve — pure auto-approve decision policy.
 *
 * Applies the configured risk threshold to a judge verdict and resolves
 * missing or unusable verdicts to the fail-closed block.  Kept pure so the
 * decision matrix is unit-testable without spawning omp.
 */

import type { BlockRisk } from "./config";
import type { JudgeVerdict } from "./types";

/** One resolved auto-approve verdict. */
export interface PolicyDecision {
  verdict: "allow" | "block";
  /** Stable machine id for logging; not user-facing. */
  reason: "ai-risk" | "ai-recommend" | "fallback";
}

/**
 * Decision rules (strictest signal wins):
 *  - no verdict (judge unusable)         -> block (fail-closed)
 *  - recommend = deny                    -> block (explicit model veto)
 *  - risk = high                         -> block, even when recommend says
 *                                           allow (the command text is
 *                                           untrusted input)
 *  - risk = medium and blockRisk = medium -> block
 *  - anything else                       -> allow (auto-approve)
 */
export function decide(analysis: JudgeVerdict | null, blockRisk: BlockRisk): PolicyDecision {
  if (analysis?.recommend === "deny") {
    return { verdict: "block", reason: "ai-recommend" };
  }
  if (analysis?.risk === "high") {
    return { verdict: "block", reason: "ai-risk" };
  }
  if (analysis?.risk === "medium" && blockRisk === "medium") {
    return { verdict: "block", reason: "ai-risk" };
  }
  // Any parseable verdict that survives the block rows (recommend=allow or
  // a risk below the threshold) permits execution.
  if (analysis?.recommend === "allow" || analysis?.risk !== undefined) {
    return { verdict: "allow", reason: "ai-risk" };
  }
  // No usable verdict at all — fail closed.
  return { verdict: "block", reason: "fallback" };
}