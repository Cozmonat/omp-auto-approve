# auto-approve

Judge-model auto-approval for **oh-my-pi (OMP)**: a persistent `omp --mode rpc` child runs the `@judge` model role as a one-shot risk assessor for every bash command. Low-risk commands execute with zero interruption; everything at or above the risk threshold fails closed — or, with `fallback: "ask"`, a second (deeper, cheaper) model analysis is shown in a dialog so the user decides.

Covered execution surface:

| Tool | Mechanism | Decision |
|---|---|---|
| `bash` | Custom tool shadowing the built-in | judge verdict + risk threshold (+ optional deep-analysis dialog) |

Every other tool is untouched. With `enabled: false` the shadowed tool delegates straight to the native bash tool — no model is consulted.

## How it works

```
LLM calls bash
   │
BashGate.execute()
   ├─ enabled: false ────────────────────────────────► delegate to native bash
   │
   ├─ Stage 1: judge verdict (config.model, default @judge)
  │     one-shot prompt: fixed rubric + working directory + command subject
  │     (capped at subjectMaxChars) → JSON { risk: low|medium|high, recommend: allow|deny }
   │     run by a persistent `omp --mode rpc` child (spawned lazily,
   │     per-assessment session reset, idle-reaped, respawned on model change)
   │
   ├─ verdict allow and risk below blockRisk ────────► delegate + display surfaces
   │
   └─ block (recommend deny / risk ≥ blockRisk / no usable verdict)
         │
         ├─ fallback: "block" (default)
         │     no second model call — marker line (if display is marker/both),
         │     a warning toast (UI sessions), and model-facing denial prose
         │
         └─ fallback: "ask"
               ├─ no UI (headless session) ───────────► plain block (never asks)
               │
               └─ UI available
                     Stage 2: deep analysis (config.deepModel, default @tiny;
                     retries @smol when @tiny is unavailable; a separate
                     persistent RPC child runs the prose analyst)
                     → one-paragraph summary + what the command will do
                     → dialog: "⚠️ Dangerous command review"
                           [ ✅ Allow once | ❌ Deny ]
                           (degrades to a two-way confirm when ui.select
                           is unavailable)
                     ├─ Allow once ───────────────────► delegate + display surfaces
                     └─ Deny / unresolvable answer ───► fail-closed block +
                                                        "user denied" toast
```

Stage 2 is only ever paid when a blocked verdict and `fallback: "ask"` coincide — the common `block` path never launches the deep model.

## Judge model

Stage-1 verdicts run on the `@judge` model role by default (`model` config). Two caveats matter in practice:

- **A non-chat judge role cannot produce verdicts.** Some hosts resolve the `judge` role to a *scoring* model (a "typesafe" judgment endpoint such as a local Decider) that answers typed-choice probes instead of chat prompts. The RPC `prompt` path is a chat prompt, so such a model completes with **no assistant text** — the plugin reads that as *no usable verdict* and fails closed: **every** command is blocked, with a denial that names the category (`no-verdict`). If that describes your `@judge` role, set `model` to a chat model that can answer the rubric (`@smol`, `@tiny`, or a local chat model) and everything works with no other change. (The `judge` role also accepts chat models, so `@judge` is fine whenever the host resolves it that way.)
- **The command text is model-facing input to the judge.** The judge is a different model from the one that proposed the command, so self-deception is bounded — but the judge still reads the command, and small models can be manipulated by instructions embedded in it. The rubric tells the judge to treat the command text as untrusted, and any verdict the judge cannot express is a block. For sensitive work prefer `fallback: "ask"` (a human sees the full command and the deep analysis) or `blockRisk: "medium"` (fewer commands are auto-approved at all).

**Troubleshooting**

| Symptom | Likely cause | Fix |
|---|---|---|
| Every command blocked — "judge unavailable" | Host `omp` binary unresolved (see Host support) | Install `omp` on `PATH`, or run the session under the host it ships with |
| Every command blocked — "no usable verdict" | `model` points at a non-chat judgment role | Set `model` to a chat model (e.g. `@smol`, `@tiny`) |
| Every command blocked — timeout | Judge child slower than `timeoutMs` (small local models) | Raise `timeoutMs`, or use a faster `model` |
| A long command is blocked as "too long to assess in full" | Command exceeds `subjectMaxChars`; the judge would only see a prefix | Split the command, or raise `subjectMaxChars` |

## Headless sessions

Headless sessions (subagents, no UI) run the same two-stage judge — the RPC child needs no UI — but `fallback: "ask"` degrades to `block`: no dialog is ever shown and the deep-analysis model is never launched. Blocked commands simply do not execute, and the denial text tells the model why — judge declined, the risk rating, or judge unavailable (fail-closed) — plus an explicit note that no confirmation dialog was shown, so a headless denial is never mistaken for a user decision. Low-risk verdicts are auto-approved and execute headlessly.

## Modes and runtime switching

Switch at runtime from the TUI (or RPC client) — no restart needed; changes persist:

```
/auto-approve              # toggle enabled (also shows current settings when enabled)
/auto-approve on           # enable
/auto-approve off          # disable (pass-through to native bash)
/auto-approve status       # show enabled state, model, display, block risk
/auto-approve display             # show the current display mode
/auto-approve display off       # silent approvals (marker + toast hidden)
/auto-approve display marker    # marker line inside the tool call only
/auto-approve display both      # marker + assessment-result toast (default)
/auto-approve risk               # show the current block risk level
/auto-approve risk medium       # block medium and high risk
/auto-approve risk high         # block high risk only (default)
/auto-approve fallback          # show the current fallback policy
/auto-approve fallback ask      # threshold crossings open the deep-analysis dialog
/auto-approve fallback block    # threshold crossings block without asking (default)
```

Use `/auto-approve status` to inspect the current settings without a persistent status-bar row. Results use host notifications when available, otherwise a temporary status row that clears after five seconds. Slash-command arguments autocomplete with a description of each action.

## Configuration

File: `~/.omp/agent/auto-approve.json` (created on first write-back). Runtime switches write only the changed key; every other user-edited field is preserved.

| Key | Default | Slash command | Settings UI | Notes |
|---|---|---|---|---|
| `enabled` | `true` | yes | yes | Master switch; `false` delegates every bash call to the native tool |
| `display` | `both` | yes | yes | `off` \| `marker` \| `both` — where approval markers appear; blocked verdicts are always visible |
| `blockRisk` | `high` | yes | yes | `medium` \| `high` — minimum judge risk level that blocks |
| `fallback` | `block` | yes | yes | `block` \| `ask` — policy when the risk threshold is crossed or no usable verdict arrives; `ask` opens the deep-analysis dialog and degrades to `block` without a UI |
| `model` | `@judge` | — | — | Judge model role for stage-1 verdicts (file-only) |
| `deepModel` | `@tiny` | — | — | Deep-analysis model for stage 2; `@smol` is tried automatically when it is unavailable (file-only) |
| `timeoutMs` | `30000` | — | — | Per-attempt timeout for judge and deep-analysis prompts (`0` = none) |
| `idleMs` | `600000` | — | — | Both RPC children are reaped after this idle period and respawn lazily |
| `subjectMaxChars` | `4000` | — | — | Command length sent to the prompts; a command longer than this is **never auto-approved** (the judge only sees the first N characters, so the full command would run unassessed) — it blocks, or escalates to the user dialog with `fallback: "ask"` |

The four slash-switchable keys (`enabled`, `display`, `blockRisk`, `fallback`) are also exposed through the host Settings UI (`omp.settings` in `package.json`) and `omp plugin config get|set`; a parity test keeps the schema in sync with the slash surface.

## Architecture

Dependency-injected, unit-testable without a running host:

```
AutoApprove (orchestrator — registers tool, command, shutdown hook)
 ├─ ConfigStore     — config load + runtime update + selective write-back
 ├─ ModeManager     — runtime switching (enabled / display / blockRisk / fallback)
 ├─ HostResolver    — resolves the host `omp` binary (execPath / argv1)
 ├─ JudgeInvoker ×2 — persistent `omp --mode rpc` children: one per model role
 │                    (stage-1 judge, stage-2 deep analysis); JSONL stdio
 │                    protocol, per-assessment session reset, abort forwarding,
 │                    model-switch respawn, idle reaping
 └─ BashGate        — shadows the built-in `bash` tool; decision pipeline;
                      execution is delegated via ctx.invokeTool, never run
                      by the extension itself
```

Both RPC children run with a `--config` overlay that disables discovered context files, so a verdict costs rubric + command tokens, not the project's `AGENTS.md`. Logs go to a redacting rotating log (`~/.omp/logs/auto-approve.log`): identifiers and verdicts only — never the raw command.

**Fail-closed everywhere**: host binary unresolved, child crash, prompt timeout, or an unreadable verdict all produce a block (or, under `fallback: "ask"` with a UI, a dialog the user must affirm). Nothing executes on uncertainty.

## Install

```sh
npm install auto-approve
```

Then configure OMP to load the extension:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - auto-approve
tools:
  approvalMode: yolo
```

- `tools.approvalMode: yolo` — the host approves tool calls; this extension is the sole gate for bash risk
- `extensions: [auto-approve]` — load the extension from `node_modules`

The custom `bash` tool shadows the built-in by name — no `bash.enabled` change is needed. From this repository, run `bun run build` after source changes (the host loads `dist/index.js`) and restart the host.

## Host support

- **OMP** — supported; the extension resolves the host binary from its own runtime paths.
- A host it cannot resolve fails closed per call (judge unavailable → block), but registration itself always succeeds, so `/auto-approve` remains usable.

MIT.