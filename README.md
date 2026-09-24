# auto-approve

Judge-model auto-approval for **oh-my-pi (OMP)**: a persistent `omp --mode rpc` child runs the `@judge` model role as a one-shot risk assessor for every bash command. Low-risk commands execute with zero interruption; everything at or above the risk threshold fails closed — or, with `fallback: "ask"`, a second (deeper, cheaper) model re-analyzes a command the first-pass judge *actually flagged*: one that model clears is auto-approved, and only one it flags as genuinely risky is shown in a dialog for the user to decide. When the judge cannot verdict at all (unavailable, or no usable reply), commands block under every fallback — the deep model never substitutes for a broken judge.

Covered execution surface:

| Tool | Mechanism | Decision |
|---|---|---|
| `bash` | Custom tool shadowing the built-in | judge verdict + risk threshold (+ deep analysis under `fallback: "ask"`) |

Every other tool is untouched. With `enabled: false` the shadowed tool delegates straight to the native bash tool — no model is consulted.

## How it works

```
LLM calls bash
   │
BashGate.execute()
   ├─ enabled: false ────────────────────────────────► delegate to native bash
   │
   ├─ Stage 1: judge verdict (config.model, default @judge)
  │     one-shot prompt: fixed rubric + working directory + session context
  │     (conversation excerpts, capped at contextMaxChars) + command subject
  │     (capped at subjectMaxChars) → JSON { risk: low|medium|high, recommend: allow|deny }
   │     run by a persistent `omp --mode rpc` child (spawned lazily,
   │     per-assessment session reset, idle-reaped, respawned on model change)
   │
   ├─ verdict allow and risk below blockRisk ────────► delegate + display surfaces
   │
   └─ block (the judge flagged it: recommend deny / risk ≥ blockRisk)
         (judge unavailable or no usable verdict → always block, under every
          fallback: the deep model is never a substitute for the first-pass judge)
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
                     persistent RPC child re-analyzes and returns a verdict)
                     ├─ deep model clears it (no real risk) ─► auto-approve +
                     │                                          display surfaces
                     └─ deep model flags a real risk (or no verdict)
                           → dialog: "⚠️ Dangerous command review"
                                 [ ✅ Allow once | ❌ Deny ]
                                 (degrades to a two-way confirm when ui.select
                                 is unavailable)
                           ├─ Allow once ───────────────────► delegate + display surfaces
                           └─ Deny / unresolvable answer ───► fail-closed block +
                                                              "user denied" toast
```

Stage 2 is only ever paid when a verdict the judge actually produced crosses the threshold (or the command is over budget) and `fallback: "ask"` coincides — the common `block` path never launches the deep model, and neither does a broken or verdict-less judge.

## Judge model

Stage-1 verdicts run on the `@judge` model role by default (`model` config). Two caveats matter in practice:

- **A non-chat judge role cannot produce verdicts.** A TypeSafe-only `@judge` role answers typed-choice probes, not chat prompts; the RPC child then returns no assistant text and the plugin fails closed (`no-verdict`). Set `model` to a chat-capable role (`@smol`, `@tiny`, or a local chat endpoint). The local Decider server at `~/Documents/decider/decider_server.py` now exposes an OpenAI-compatible chat lane alongside its TypeSafe lane; configure an OMP chat model with base URL `http://127.0.0.1:8000/v1` and model `decider-2b-mlx-4bit`, then select it in the plugin config file. Its risk scores are uncalibrated: test representative commands before relying on unattended approvals. Do not use its TypeSafe-only role for this plugin.
- **The command text and conversation excerpts are model-facing input to both models.** The judge — and, under `fallback: "ask"`, the deep analyst — is a different model from the one that proposed the command, so self-deception is bounded; but both read the command and compact conversation context, and small models can be manipulated by instructions embedded in either. Both rubrics tell the models to treat that text as untrusted, and any verdict a model cannot express is a block. With `fallback: "ask"` this means a command the deep model *clears* is auto-approved **without a dialog** — a human only sees commands the deep model flags or cannot verdict. If you want no auto-execution of judge-flagged commands, use `fallback: "block"`; `blockRisk: "medium"` reduces how many commands are auto-approved at all.

**Troubleshooting**

| Symptom | Likely cause | Fix |
|---|---|---|
| Every command blocked — "judge unavailable" | Host `omp` binary unresolved (see Host support) | Install `omp` on `PATH`, or run the session under the host it ships with |
| Every command blocked — "no usable verdict" | `model` points at a non-chat judgment role | Set `model` to a chat model (e.g. `@smol`, `@tiny`, or the Decider chat lane) |
| Every command blocked — timeout | Judge child slower than `timeoutMs` (small local models) | Raise `timeoutMs`, or use a faster `model` |
| A long command is blocked as "too long to assess in full" | Command exceeds `subjectMaxChars`; the judge would only see a prefix | Split the command, or raise `subjectMaxChars` |
| Every command blocked — provider error about context length | The judge model's context window is smaller than the full prompt (rubric + session context + command); small local models are prone to this | Lower `subjectMaxChars` and/or `contextMaxChars` until the prompt fits the model's window, or use a judge with a larger window; commands fail closed until then |

## Session context

Both models also judge the command's *scope*: compact excerpts of the conversation — the original user task, the latest user request, and the agent's newest plan text — so a verdict reflects why the command runs, not just what it does. The excerpts are credential-redacted, capped at `contextMaxChars` characters total (messages dropped by the budget are reported inside the prompt), and fenced as untrusted data with an explicit instruction not to follow anything inside them. The latest user excerpt is contextual intent, never a new authorization: a mid-conversation message cannot expand what the risk rubric permits. Set `contextMaxChars: 0` for command-only judgements (useful with small-window judge models).
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
| `fallback` | `block` | yes | yes | `block` \| `ask` — policy when the risk threshold is crossed; `ask` runs a deep-analysis model over commands the first-pass judge flagged, auto-approving a cleared one or opening a dialog for a risky one (degrades to `block` without a UI; a judge that never verdicts always blocks, never consulting the deep model) |
| `model` | `@judge` | — | — | Judge model role for stage-1 verdicts (file-only) |
| `deepModel` | `@tiny` | — | — | Deep-analysis model for stage 2; `@smol` is tried automatically when it is unavailable (file-only) |
| `timeoutMs` | `30000` | — | — | Per-attempt timeout for judge and deep-analysis prompts (`0` = none) |
| `idleMs` | `600000` | — | — | Both RPC children are reaped after this idle period and respawn lazily |
| `subjectMaxChars` | `4000` | — | — | Command length sent to the prompts; a command longer than this is **never auto-approved** (the judge only sees the first N characters, so the full command would run unassessed) — it blocks, or escalates to the user dialog with `fallback: "ask"` |
| `contextMaxChars` | `3000` | — | — | Session-context budget: characters of conversation excerpts (original task, latest request, recent plan text) the models see as the judgement's scope; `0` = command-only judgement (file-only) |

The four slash-switchable keys (`enabled`, `display`, `blockRisk`, `fallback`) are also exposed through the host Settings UI (`omp.settings` in `package.json`) and `omp plugin config get|set`; a parity test keeps the schema in sync with the slash surface.

## Architecture

Dependency-injected, unit-testable without a running host:

```
AutoApprove (orchestrator — registers tool, command, shutdown hook)
 ├─ ConfigStore     — config load + runtime update + selective write-back
 ├─ ModeManager     — runtime switching (enabled / display / blockRisk / fallback)
 ├─ ContextGatherer — session-context excerpts for the prompts (redacted,
 │                    budget-capped, fenced as untrusted in the prompt)
 ├─ HostResolver    — resolves the host `omp` binary (execPath / argv1)
 ├─ JudgeInvoker ×2 — persistent `omp --mode rpc` children: one per model role
 │                    (stage-1 judge, stage-2 deep analysis); JSONL stdio
 │                    protocol, per-assessment session reset, abort forwarding,
 │                    model-switch respawn, idle reaping
 └─ BashGate        — shadows the built-in `bash` tool; decision pipeline;
                      execution is delegated via ctx.invokeTool, never run
                      by the extension itself
```

Both RPC children run with a `--config` overlay that disables discovered context files, so a verdict costs rubric + working directory + session-context + command tokens, not the project's `AGENTS.md`. Logs go to a redacting rotating log (`~/.omp/logs/auto-approve.log`): identifiers and verdicts only — never the raw command.

**Fail-closed everywhere**: host binary unresolved, child crash, prompt timeout, or an unreadable verdict all produce a block — under every `fallback`, with a UI or headless. The deep pass only re-analyzes commands the first-pass judge *actually flagged*; when the judge itself is unavailable or produced no usable verdict, the command blocks and the deep model is never consulted, so a broken judge can never become the approver. The only other path that runs a flagged command is `fallback: "ask"` with a UI, where it runs only when the deep model clears it or the user affirms it in the dialog. Nothing executes on uncertainty.

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