/**
 * Auto Approve — subject redactor.
 *
 * The single chokepoint for credential redaction: a fixed shape vocabulary
 * (private keys, known token prefixes, JWTs, AWS-style secrets, credential
 * URLs) plus two heuristics (high-entropy blobs, userinfo-bearing URLs).
 * Pure string functions — no filesystem, no host, no state. Best-effort by
 * design: the README states the residual risk honestly; callers must never
 * treat a redacted subject as a security guarantee.
 *
 * The classifier consumes `findCredentials` as its credential-shape signal,
 * so detection lives in exactly one place.
 */

export type CredentialKind =
  | "private-key"
  | "token"
  | "jwt"
  | "aws-secret"
  | "credential-url"
  | "high-entropy";

export interface CredentialMatch {
  kind: CredentialKind;
  start: number;
  end: number;
  text: string;
}

/** PEM private key blocks, header through footer. */
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/** scheme://user:pass@ — the whole span up to and including "@". */
const CREDENTIAL_URL = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g;

/** Known token prefixes (GitHub, GitLab, Slack, Stripe, AWS key id, Google). */
const TOKEN =
  /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|xoxb-[A-Za-z0-9-]{10,}|xoxp-[A-Za-z0-9-]{10,}|xoxa-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g;

/** JWT-shaped header.payload.signature triplets. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/** AWS-style secret keys: exactly 40 chars of base64 alphabet. */
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;

/** High-entropy heuristic candidates: long dense tokens. */
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/_\-.=]{20,}/g;

/** Shannon entropy in bits per character. */
function shannonBits(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function collect(
  text: string,
  re: RegExp,
  kind: CredentialKind,
  guard: (match: string) => boolean,
  out: CredentialMatch[],
): void {
  for (const m of text.matchAll(re)) {
    const match = m[0];
    if (!guard(match)) continue;
    const start = m.index;
    const end = start + match.length;
    if (out.some((span) => start < span.end && end > span.start)) continue;
    out.push({ kind, start, end, text: match });
  }
}

/** All credential-shaped spans, longest-priority order, non-overlapping,
 *  sorted by position.  Pure. */
export function findCredentials(text: string): CredentialMatch[] {
  const spans: CredentialMatch[] = [];
  collect(text, PRIVATE_KEY, "private-key", () => true, spans);
  collect(text, CREDENTIAL_URL, "credential-url", () => true, spans);
  collect(text, TOKEN, "token", () => true, spans);
  collect(text, JWT, "jwt", () => true, spans);
  collect(text, AWS_SECRET, "aws-secret", (m) => shannonBits(m) >= 4, spans);
  collect(
    text,
    ENTROPY_CANDIDATE,
    "high-entropy",
    (m) => m.length >= 20 && /[0-9]/.test(m) && /[A-Za-z]/.test(m) && shannonBits(m) >= 4.3,
    spans,
  );
  return spans.sort((a, b) => a.start - b.start);
}

export interface RedactionResult {
  /** The text with every matched span replaced by `[redacted:<kind>]`. */
  text: string;
  /** Kinds actually redacted, first-occurrence order, deduped. */
  found: CredentialKind[];
}

/** Replace every credential-shaped span with an opaque marker.  Pure. */
export function redact(text: string): RedactionResult {
  const matches = findCredentials(text);
  if (matches.length === 0) return { text, found: [] };
  let out = "";
  let cursor = 0;
  const found: CredentialKind[] = [];
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[redacted:${m.kind}]`;
    cursor = m.end;
    if (!found.includes(m.kind)) found.push(m.kind);
  }
  return { text: out + text.slice(cursor), found };
}
