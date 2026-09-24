# Plan — omp-auto-approve: judge-model auto-approval plugin for OMP

Status: **implemented** (2026-09-24, shipped as v1.0.0). Delivery deltas vs. this plan: §9.
Reference: `omp-smart-approve` (sibling project, v3.11.0).

## 1. Goal

An Oh My Pi (OMP) / pi-agent extension that **auto-approves** agent tool
operations by running a one-shot risk assessment through OMP's **`@judge`
model role**, with no dialogs:

- Judge says low risk (or `allow`) → the operation runs (delegated to the
  native tool).
- Judge says medium/high risk (or `deny`) → the operation is blocked.
- Judge unusable (no model, child crash, timeout, unparseable verdict) →
  **block, fail-closed** (no `ask` fallback, no dialogs at all).

### Display option (the only display surface knob)

`display: "off" | "marker" | "both"` (default `"both"`):

| value   | approval marker inside the tool call | assessment-result toast (checkmark) |
| ------- | ------------------------------------ | ----------------------------------- |
| `off`   | no                                   | no                                  |
| `marker` | yes (`onUpdate` streamed into the tool card) | no                              |
| `both`  | yes                                  | yes (`✅ Approved (low): …` / `🚫 Blocked (high): …`) |

Blocked verdicts are **always visible** regardless of `display` (same rule as
the reference's auto-mode verdicts) — a silent block is a trap.

### Non-goals (deliberately removed vs smart-approve)

- No interactive/manual approval modes, no confirmation dialogs, no
  "Allow for this session" remember/allowlist, no protected-path interception,
  no write/edit gate, no eval/hub coverage, no risk-assessment *cards*, no
  `riskAssessmentMin`, no per-surface overrides, no LLM data scopes, no
  script-evidence collection, no model pool/queue (one judge child).
- The plugin covers the **bash** surface only (the operation class where
  auto-approval has the most value and where a judge verdict is meaningful).

## 2. How the judge model is invoked

Same transport pattern as the reference (`src/host.ts` + `src/rpc-invoker.ts`),
simplified:

1. **Host resolution** (`judge.ts`): `process.argv[1]` + `process.execPath`
   (script-hosted OMP/pi), else `process.execPath` (bundled binary), else
   `command -v omp` / `command -v pi`. Memoized.
2. **Child**: one persistent `omp --mode rpc --model <spec>` child, spawned
   lazily on first assessment, with the reference's arg set
   (`--system-prompt=… --no-tools --no-session --no-lsp --no-skills --no-rules
   --no-title --no-prewalk --no-pty --no-extensions --thinking=off
   --max-time=300 --config=<overlay>`), `PI_MEMORY_BACKEND=off`. A small
   `--config` overlay (materialized in the agent config dir) disables context
   files + unexpected-stop detection so the child's system prompt stays a few
   hundred tokens — the reference measured a 34k-token context-file bloat that
   pushed local-model verdicts past the timeout.
3. **Protocol** (docs/rpc.md): ready frame → per assessment: `new_session`
   + ack (stateless reset) → `prompt` → `agent_end` messages → extract the
   final assistant text. A crashed child is respawned on the next assessment;
   the child is killed on `session_shutdown`; an idle timeout (default 10 min,
   0 = keep alive) reaps it.
4. **Model spec** (`model` config, default `"@judge"`): the CLI `--model`
   flag accepts a role alias, so the child session runs with whatever OMP's
   `judge` model role resolves to (a TypeSafe `jev` judge, a local tiny
   model, or a chat model via the role's fallback chain).

### Verdict contract

System prompt (fixed, byte-stable):

> You are the auto-approve risk judge. Reply with exactly one JSON object
> and nothing else.

User prompt per assessment (i18n rubric, locale-fixed English like the
reference's analyst prompt):

- risk rubric (high/medium/low definitions, copied and tightened from the
  reference's `promptRubric`),
- working directory,
- the command, truncated to `subjectMaxChars` (default 4000),
- required reply: `{"risk":"low|medium|high","recommend":"allow|deny"}`
  — **no summary field is required** (the judge model may not produce
  prose). If the judge includes a one-line `summary`, the display surfaces
  use it; otherwise a localized generic label is used.

Parsing: first `{...}` JSON object in the final assistant text
(`extractJson`, same helper shape as the reference's `analysis-policy.ts`);
`risk`/`recommend` normalized to the enum vocabulary (reference's
`normalizeRisk`/`normalizeRecommend`, including `approve/yes`/`block/no`).
Bare `yes`/`no`-style answers are accepted as `recommend` only. Anything
else → no verdict → fail-closed.

### Known limitation (documented in README)

`judge` models of kind `judge` (e.g. `typesafe/jev-latest`) are **judgment
APIs, not chat transports** (System One / `noul` requests). The RPC `prompt`
path is a chat prompt, so a session pinned to a native System One judge will
generally not produce a parseable chat verdict. The plugin treats that as
"judge unusable" → blocks, fail-closed. Users with a native judge should set
`model` to a chat/tiny model that answers the rubric (e.g. `@smol`,
`@tiny`, `local/lfm2-1.2b`). The `judge` role also accepts tiny and chat
models, so `@judge` out of the box works whenever the role resolves that way.

## 3. Architecture (files)

Mirrors the reference's layering, minus the removed surfaces.

```
package.json         manifest: omp.extensions/pi.extensions ./dist/index.js,
                     omp.settings schema, scripts (typecheck/build/dev/test)
tsconfig.json        same as reference (bun target, strict)
.gitignore           dist/ + node_modules
LICENSE              MIT
AGENTS.md            adapted slash-command authoring notes (6-layer pattern)
README.md            user docs: install, config table, display modes,
                     /auto-approve command, judge-model notes, troubleshooting
docs/plans/          this plan
src/
  types.ts           extension API surface (ExtensionAPI/ExtensionCtx/
                     AutocompleteItem/ToolCallEvent/zod), JudgeVerdict,
                     AnalysisOutcome (text|empty|error), LoggerLike
  logger.ts          Logger → rotating file log in the agent config dir
                     (reference's utils/rotating-log pattern, trimmed)
  config.ts          AutoApproveConfig + DEFAULT_CONFIG, ConfigStore
                     (load/update/persist), getConfigDir, getPluginsDir,
                     readHostPluginSettings, applyHostSettings,
                     displaySurfaces() pure mapper, HOST_SETTING_KEYS
  policy.ts          pure decision: JudgeVerdict|null + blockRisk →
                     allow|block (reference AutoDecisionPolicy, no `ask`)
  i18n.ts            I18n interface, en + zh, detectLang/getI18n; verdict
                     strings (✅/❌ toasts), marker strings, status strings,
                     judge prompt rubric (English-only, like the reference)
  mode-manager.ts    runtime switches: setEnabled/display/blockRisk,
                     getters, status() block
  judge.ts           HostResolver + JudgeInvoker (single RPC child):
                     spawn args builder, ready handshake, per-assessment
                     new_session reset + prompt, timeout/abort, outcome
                     classification (verdict|error|empty|unavailable)
  gate.ts            BashGate (custom "bash" tool shadowing the built-in):
                     execute() → subject check → judge assessment → policy →
                     delegate (ctx.invokeTool) or deny; display surfaces
                     (marker via onUpdate, toast via ctx.ui.notify);
                     shutdown latch racing nothing (no dialogs)
  index.ts           extension factory: wires config/mode-manager/judge/gate,
                     registers the bash tool + /auto-approve command +
                     completions, session_shutdown dispose; default export
test/
  fakes/rpc-child.ts scripted fake RPC child (same NDJSON contract as the
                     reference's fake; emits ready, acks new_session/prompt,
                     scripted assistant text)
  integration/       (optional) real-child smoke against the installed omp
src/*.test.ts        unit suites (see §6)
```

### Config (file `~/.omp/agent/auto-approve.json`, host settings win)

| key          | type    | default    | notes                                  |
| ------------ | ------- | ---------- | -------------------------------------- |
| `enabled`    | boolean | `true`     | master switch; false = pass-through    |
| `display`    | enum    | `both`     | `off` \| `marker` \| `both`            |
| `blockRisk`  | enum    | `high`     | `medium` \| `high` — min risk that blocks |
| `model`      | string  | `@judge`   | judge model spec (file-only, like the reference's `model`) |
| `timeoutMs`  | number  | `30000`    | per-assessment window (0 = none)       |
| `idleMs`     | number  | `600000`   | judge-child idle lifetime (0 = until shutdown) |
| `subjectMaxChars` | number | `4000`  | command-text cap for the judge prompt  |

Host settings schema (`omp.settings` in package.json, and `HOST_SETTING_KEYS`
+ parse/merge in config.ts, and the schema-parity test — the reference's
pattern for keys that are also slash-switchable): `enabled`, `display`,
`blockRisk`. `model`, timeouts, subject cap are config-file only.

Runtime-persistable (slash) keys: `enabled`, `display`, `blockRisk` —
`ConfigStore.update()` marks only these dirty; `persist()` writes them back
without clobbering user-edited fields.

### Decision policy (`policy.ts`, pure)

```
verdict == null                          → block (fail-closed)
recommend == "deny"                      → block
risk == "high"                           → block
risk == "medium" && blockRisk == "medium" → block
risk == "high" but recommend == "allow"  → block (stricter signal wins)
otherwise                                → allow
```

### `execute()` flow (BashGate)

1. `enabled == false` or empty command → delegate/passthrough (native).
2. Build the judge prompt (rubric + cwd + truncated command).
3. `onUpdate(⟨analyzing⟩)` (progress line, always shown while running —
   same as the reference's `analyzing` streaming text; it is a status, not
   an assessment surface).
4. `judge.assess(prompt, signal, timeoutMs)` → `verdict | issue`.
5. Aborted mid-assessment → return `(aborted)`, no decision.
6. `displaySurfaces(display)`:
   - `marker` → `onUpdate(✅/🚫 marker line)` (risk + finding/label).
   - `notify` → `ctx.ui.notify(toast, "info"|"warning")`.
   Blocked verdicts bypass the display gate (always shown).
7. Policy → `allow` ⇒ `ctx.invokeTool(params, {signal, onUpdate})` (native
   bash); `block` ⇒ tool result `isError` with structured, localized text
   (never echoing the raw command twice; reference's `deny()` shape).

### Slash command `/auto-approve`

| args                | effect                                  |
| ------------------- | --------------------------------------- |
| *(none)*            | toggle `enabled` on/off                 |
| `on` / `off`        | set `enabled`                           |
| `display`           | show current `display`                  |
| `display off\|marker\|both` | set `display`                   |
| `risk medium\|high` | set `blockRisk`                         |
| `status`            | full status block (mode manager)        |
| anything else       | help line                               |

Completions: root items in alphabetical `value` order (`display`, `off`,
`on`, `risk`, `status`), nested `display …` and `risk …` items, with
`startsWith("display ")` / `startsWith("risk ")` matchers — exactly the
reference's completion-provider shape.

### i18n

`en` + `zh` parity (parity test, reference pattern). Key groups:

- `cmdDescription`, `cmdHelp`, per-subcommand descriptions
  (`cmdDisplayDescription`, `cmdDisplayOffDescription`, `cmdDisplayMarkerDescription`,
  `cmdDisplayBothDescription`, `cmdRiskMediumDescription`, `cmdRiskHighDescription`,
  `cmdOnDescription`, `cmdOffDescription`, `cmdStatusDescription`)
- status/switched strings (`enabledSwitched`, `displaySwitched`, `riskSwitched`,
  `enabledStatus`, `displayStatus`)
- gate strings: `analyzing`, `verdictApproved(label, risk, finding?)`,
  `verdictBlocked(label, risk, finding?)`, `markerApproved(risk, finding?)`,
  `markerBlocked(risk, finding?)`, `blockedNoUi`, `analysisUnavailable(issue)`
- judge prompt: `judgeIntro`, `judgeRubric` (English-only constant pair,
  like the reference's `promptRubric`)

## 4. What is intentionally NOT in v1

- write/edit/eval/hub surfaces, allowlist/remember, protected paths,
  behavior classifiers (regex deny tier), risk-assessment cards, min
  floors, shell overrides, `llmAnalysis` toggle, `llmDataScope`, model
  fallback chains, v1 protocol chunk reassembly (v1 is sufficient for
  verdicts; oversized frames simply fail the assessment → fail-closed).

## 5. Phases

1. **Scaffold** — package.json, tsconfig, .gitignore, LICENSE, AGENTS.md.
2. **Core modules, test-first** — types → logger → config (+tests) →
   policy (+tests) → i18n (+parity test) → mode-manager (+tests).
3. **Judge invoker** — fake-child contract test, then invoker (spawn args,
   handshake, reset, prompt, timeout, abort, dispose); unit-tested against
   `test/fakes/rpc-child.ts`.
4. **Gate + index wiring** — gate decision matrix tests (allow/block/
   display surfaces/abort/fail-closed), command handler + completions
   tests, extension factory.
5. **Docs** — README (install via `omp plugin`, config table, display
   modes, command reference, judge-model limitation, troubleshooting),
   AGENTS.md.
6. **Verify** — `bun run typecheck`, `bun test src`, `bun run build`
   (dist/index.js), fresh-clone smoke: point OMP at the built plugin and
   confirm the bash tool is shadowed (see §7).

## 6. Test plan (each test guards a real contract)

- **config.test.ts**: defaults; `display` enum parse (invalid → default);
  `blockRisk` parse; host settings override file (enabled/display/blockRisk);
  `update+persist` round-trip writes only the touched keys and preserves
  user-edited siblings; config-dir resolution honors `HOME` env.
- **policy.test.ts**: the full decision matrix, including the
  `risk=high ∧ recommend=allow` contradiction and the null-verdict
  fail-closed row for both `blockRisk` values.
- **i18n-parity.test.ts**: every key in `en` exists in `zh` (same function
  arity); verdict/marker templates produce checkmark/cross glyphs.
- **mode-manager.test.ts**: `setDisplay`/`setBlockRisk`/`setEnabled`
  persist exactly their key to disk; `status()` lines.
- **judge.test.ts** (fake child): verdict JSON parsed to
  `risk/recommend(/summary)`; empty completion → `empty`; child crash →
  `error(unavailable)`; timeout → `error(timeout)`; abort → `error(abort)`;
  `new_session` without ack never authorizes the prompt (reference's
  fail-closed reset rule); bare `yes`/`no` normalization.
- **gate.test.ts** (fake judge + scripted ctx): low-risk allow delegates to
  `ctx.invokeTool` and emits marker/notify per `display` (all three modes ×
  allow/block); block returns `isError` and is visible even with
  `display: off`; judge down → block + warning toast; abort during
  assessment returns the aborted shape; `enabled: false` passes through
  without touching the judge.
- **index.test.ts**: completions arrays (en + zh) and the handler
  persist round-trips (`display marker`, `risk medium`, `on`/`off`),
  mirroring the reference's command tests.

## 7. Verification

1. `bun install` (dev deps: typescript, @types/bun) — clean.
2. `bun run typecheck` — exit 0.
3. `bun test src` — all suites green, no warnings.
4. `bun run build` — `dist/index.js` emitted, exit 0.
5. Smoke in a scratch project:
   - `omp plugin install <abs path to project>` (or the reference's local
     install flow) — or run `bun run src/index.ts` under a pi session for
     a load check.
   - Confirm the `bash` tool is the plugin's shadow (tool description
     text), the judge child spawns lazily, a low-risk command runs with the
     `✅` marker/toast per `display`, and a disabled judge blocks.
   - If no judge model is configured on this machine, the smoke asserts the
     fail-closed path (block + warning) — which is itself a contract.

## 8. Risks

| risk | mitigation |
| ---- | ---------- |
| Native System One judge role can't answer a chat `prompt` | documented; `model` override; fail-closed default keeps safety; README troubleshooting row |
| Judge child slower than `timeoutMs` (local models) | default 30s matches reference; `timeoutMs` configurable; per-assessment `new_session` keeps the prompt prefix tiny |
| RPC protocol drift across OMP versions | protocol is stable/documented (ready frame + prompt + agent_end); invoker ignores unknown noise frames like the reference |
| `dist/` must be rebuilt before the host sees source changes | AGENTS.md documents the `bun run build` step (reference pattern) |

## 9. Delivery notes (2026-09-24, v1.0.0)

Implemented as planned, with these deliberate additions discovered during
adversarial review of the shipped code:

- **`fallback: "ask"`** (config, slash: `/auto-approve fallback ask`,
  Settings UI): when the judge blocks, a user dialog shows the full command
  plus a second-model (deep-analysis) read; "Allow once" delegates, anything
  else denies. Without it the non-goal "no dialogs" is honored by default.
  Headless sessions always degrade to a plain block.
- **Truncation rule**: a command longer than `subjectMaxChars` is never
  auto-approved (the judge would only see a prefix) — blocked as
  "too long to assess in full", or shown in full in the user dialog under
  `fallback: "ask"`. The cap is still sent to the prompts.
- **`cwd` restored** in both judge and deep prompts (rubric + prompt include
  the working directory).
- **Bare `/auto-approve display` and `/auto-approve risk`** print the current
  value (mirroring `on`/`off` status parity), not the help.
- **Denial text distinguishes failure modes**: judge error names the category
  (`no-verdict` vs timeout/crash/unavailable) and says *nothing executed,
  not assessed as dangerous*; an empty completion from a non-chat judge role
  is "no usable verdict", not "unavailable".
- **Failures are logged** (`~/.omp/logs/auto-approve.log`, redacting,
  rotating) so a user blocked by a misconfigured judge role can diagnose it
  without a TUI.

Verified: `bun test src` green, `bun run typecheck` clean,
`bun run build` emits `dist/index.js`; live contract proven with a real
`omp --mode rpc` child (allow / deny / non-chat-judge empty-verdict paths).

## 10. Post-1.2.3 deltas (2026-09-24, v1.2.4)

Two changes after the 1.2.3 release, both user-requested:

- **Script analysis** (`src/scripts.ts`, new `scriptMaxChars` key,
  default 4000): both rubrics now state that a multi-line shell command
  counts as the full script it would execute, and the gate extracts
  script-path tokens from the command (`.sh/.bash/.zsh/.ksh/.fish/.py/.js/
  .mjs/.cjs/.ts/.mts/.cts/.rb/.pl/.php/.lua/.ps1`, up to three files,
  each capped at `scriptMaxChars`), resolves them against the execution
  cwd, and feeds the contents into both prompts fenced as untrusted data.
  The section header notes the snapshot is taken before execution.
  `scriptMaxChars: 0` disables file reads (file-only).
- **Model roles fixed to the host**: the `model` and `deepModel` config
  keys are removed (user decision). Stage 1 always uses the `@judge` role
  and stage 2 always uses the fixed `@tiny` → `@smol` chain, both
  resolved from the main OMP model config (`models.yml` / `config.yml`).
  The status line and denial texts now point at the OMP-config `judge`
  role instead of the plugin's own `model` setting. Existing
  `auto-approve.json` files keep unknown keys on disk (preserved, ignored).

Verified: `bun test src` green (192 tests), `bun run typecheck` clean,
`bun run build` emits `dist/index.js`.