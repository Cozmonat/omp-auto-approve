# auto-approve

Judge-model auto-approval for **oh-my-pi (OMP)**: a persistent `omp --mode rpc` child runs the `@judge` model role as a one-shot risk assessor for every bash command and every `eval` (in-process Python/JavaScript). Low-risk calls execute with zero interruption; everything at or above the risk threshold fails closed — or, with `fallback: "ask"`, a second (deeper, cheaper) model re-analyzes a command the first-pass judge *actually flagged*: one that model clears is auto-approved, and only one it flags as genuinely risky is shown in a dialog for the user to decide. When the judge produces no output at all (a broken judge lane), the gate re-runs the judge prompt on the `@tiny → @smol` chain and keeps warning `judge produced no output`; when the judge is unavailable or answers without a usable verdict, commands block under every fallback — the deep model never substitutes for a broken judge.

Covered execution surfaces:

| Tool | Mechanism | Decision |
|---|---|---|
| `bash` | Custom tool shadowing the built-in | judge verdict + risk threshold (+ deep analysis under `fallback: "ask"`) |
| `eval` | Custom tool shadowing the built-in (in-process Python/JavaScript) | judge verdict + risk threshold (+ deep analysis under `fallback: "ask"`) |

Every other tool is untouched. With `enabled: false` the shadowed tools delegate straight to the native tools — no model is consulted.

## How it works

```
LLM calls bash or eval
   │
ToolGate.execute()
   ├─ enabled: false ────────────────────────────────► delegate to the native tool
   │
   ├─ Stage 1: judge verdict (the host's @judge role, resolved from your OMP model config;
  │     shell command or eval code, judged by a rubric framed for that kind)
  │     one-shot prompt: fixed rubric + working directory + session context
  │     (conversation excerpts, capped at contextMaxChars) + referenced script
  │     file contents (each capped at scriptMaxChars) + command subject
  │     (capped at subjectMaxChars) → JSON { risk: low|medium|high, recommend: allow|deny }
   │     run by a persistent `omp --mode rpc` child (spawned lazily,
   │     per-assessment session reset, idle-reaped, respawned on model change)
   │     (judge silent — no output at all: re-run the judge prompt on the
   │      @tiny → @smol chain, keeping the "judge produced no output" warning)
   │
   ├─ verdict allow and risk below blockRisk ────────► delegate + display surfaces
   │
   └─ block (the judge flagged it: recommend deny / risk ≥ blockRisk)
         (judge unavailable, or silent after the @tiny → @smol fallback →
          always block, under every fallback: the deep model is never a substitute)
         │
         ├─ fallback: "block" (default)
         │     no second model call — marker line (if display is marker/both),
         │     a warning toast (UI sessions), and model-facing denial prose
         │
         └─ fallback: "ask"
               ├─ no UI (headless session) ───────────► plain block (never asks)
               │
               └─ UI available
                    Stage 2: deep analysis (the fixed @tiny role, retrying @smol
                    when unavailable; a separate persistent RPC child re-analyzes
                    and returns a verdict)
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

Stage 2 is only ever paid when a verdict the judge actually produced — or that its silent-judge fallback produced — crosses the threshold (or the subject is over budget) and `fallback: "ask"` coincides — the common `block` path never launches the deep model, and neither does a judge that is unavailable or still silent after the `@tiny → @smol` fallback.

## Judge model

Stage-1 verdicts run on the host's `@judge` model role, resolved from your OMP model config (`~/.omp/agent/models.yml` / `config.yml`) — the plugin has no model key of its own, whatever the role resolves to is what judges. Two caveats matter in practice:

- **A non-chat (native judgment) model cannot produce verdicts.** Stage 1 is a chat prompt, but a native System One / TypeSafe judge model only answers typed-choice probes — a judge role that resolves to one returns no assistant text. The gate warns on every call (`judge produced no output`) and re-runs the judge prompt on the `@tiny → @smol` chain, so a misresolved judge role degrades to small-model judgement instead of blocking everything; calls still fail closed when both fallback models produce no usable verdict. As of OMP 18.3.0 the `judge` role resolves to **native candidates only**: once any credentialed `api: typesafe` provider exists (including a local decider), chat models drop out of the role's chain, so a plain `@judge` default lands on that wall on such hosts. Make the `judge` role resolve to a **chat-lane** entry instead (repoint it in `config.yml`, or add a chat-lane provider to `models.yml`) — e.g. a second provider entry for the same local Decider server (`~/Documents/decider/decider_server.py` serves both lanes: `api: typesafe` for the host's built-in judgment and `api: openai-completions` for this plugin's chat prompts; base URL `http://127.0.0.1:8000`, model `decider-2b-mlx-4bit`). Its risk scores are uncalibrated: test representative commands before relying on unattended approvals.
- **The command text and conversation excerpts are model-facing input to both models.** The judge — and, under `fallback: "ask"`, the deep analyst — is a different model from the one that proposed the command, so self-deception is bounded; but both read the command and compact conversation context, and small models can be manipulated by instructions embedded in either. Both rubrics tell the models to treat that text as untrusted, and any verdict a model cannot express is a block. With `fallback: "ask"` this means a command the deep model *clears* is auto-approved **without a dialog** — a human only sees commands the deep model flags or cannot verdict. If you want no auto-execution of judge-flagged commands, use `fallback: "block"`; `blockRisk: "medium"` reduces how many commands are auto-approved at all.

**Troubleshooting**

| Symptom | Likely cause | Fix |
|---|---|---|
| Every command blocked — "judge unavailable" | Host `omp` binary unresolved (see Host support) | Install `omp` on `PATH`, or run the session under the host it ships with |
| Every command blocked — "judge unavailable (spawn)" | The judge child exited at startup — most often a `judge` role that resolves to nothing (renamed/removed provider, e.g. a stale `local-judge-chat/…`). The denial quotes the child's stderr (e.g. `Model "…" not found`), so the cause is visible in the tool result | Make the `judge` role resolve in the host's model config: a role alias in `~/.omp/agent/config.yml`, or a `provider/model` present in `~/.omp/agent/models.yml` |
| Every command blocked — "no usable verdict" | The judge answered but its text was not a parseable verdict (a chat model not following the JSON contract) | Point the `judge` role at a model that follows the rubric (e.g. `@smol`, `@tiny`, or the Decider chat lane) |
| Every command warns `judge produced no output` (the `@tiny → @smol` fallback judges instead) | The `judge` role resolves to a native System One / `api: typesafe` model, which cannot answer a chat prompt (OMP 18.3.0+ resolves the role to native candidates only — common right after a host update, or once a local decider registers a typesafe provider) | Make `judge` resolve to a chat-lane entry, e.g. a second provider entry for the same server with `api: openai-completions` (see Judge model) |
| Every command blocked — timeout | Judge child slower than `timeoutMs` (small local models) | Raise `timeoutMs`, or point `judge` at a faster model |
| A long command (including a multi-line script) is blocked as "too long to assess in full" | Command exceeds `subjectMaxChars`; the judge would only see a prefix | Split the command, or raise `subjectMaxChars` (see Script analysis) |
| Every command blocked — provider error about context length | The judge model's context window is smaller than the full prompt (rubric + session context + command); small local models are prone to this | Lower `subjectMaxChars` and/or `contextMaxChars` until the prompt fits the model's window, or use a judge with a larger window; commands fail closed until then |

## Session context

Both models also judge the command's *scope*: compact excerpts of the conversation — the original user task, the latest user request, and the agent's newest plan text — so a verdict reflects why the command runs, not just what it does. The excerpts are credential-redacted, capped at `contextMaxChars` characters total (messages dropped by the budget are reported inside the prompt), and fenced as untrusted data with an explicit instruction not to follow anything inside them. The latest user excerpt is contextual intent, never a new authorization: a mid-conversation message cannot expand what the risk rubric permits. Set `contextMaxChars: 0` for command-only judgements (useful with small-window judge models).

## Script analysis

Newer models (e.g. GPT-6-Sol) often run multi-step work through shell scripts rather than single one-liners — either a multi-line script inside the `command` string, or a script file it wrote earlier (`bash run.sh`, `python script.py`). Judging only the invocation line makes every such call look like "runs unreviewed code", so the prompts handle both shapes:

- **Inline scripts:** both rubrics tell the models the command may be a multi-line shell script and that every statement it would execute — functions, loops, conditionals, command substitutions, heredocs — counts as the command's action.
- **Referenced script files:** the gate extracts script-path tokens from the command (`.sh`, `.bash`, `.zsh`, `.ksh`, `.fish`, `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.rb`, `.pl`, `.php`, `.lua`, `.ps1`), resolves them against the execution working directory, and feeds up to three files' contents (each capped at `scriptMaxChars`) into both prompts, fenced as untrusted data. Paths containing spaces (even when quoted) are not detected. Files that cannot be read are reported in the prompt as `missing`, `unreadable`, `binary`, or `too large`, so the judge knows a missing body is not a missing risk. Fetch URLs are ignored (a remote target is not a file to read). Set `scriptMaxChars: 0` to disable file reads and fall back to judging the invocation line only.

Long inline scripts still obey `subjectMaxChars`: a script longer than the assessment window is never auto-approved (blocks as "too long", or reaches the dialog under `fallback: "ask"`). If your model habitually writes long scripts and you trust the judge to read them, raise `subjectMaxChars` accordingly.

## Headless sessions

Headless sessions (subagents, no UI) run the same two-stage judge over bash and eval — the RPC child needs no UI — but `fallback: "ask"` degrades to `block`: no dialog is ever shown and the deep-analysis model is never launched. Blocked commands simply do not execute, and the denial text tells the model why — judge declined, the risk rating, or judge unavailable (fail-closed) — plus an explicit note that no confirmation dialog was shown, so a headless denial is never mistaken for a user decision. Low-risk verdicts are auto-approved and execute headlessly.

## Modes and runtime switching

Switch at runtime from the TUI (or RPC client) — no restart needed; changes persist:

```
/auto-approve              # toggle enabled (also shows current settings when enabled)
/auto-approve on           # enable
/auto-approve off          # disable (pass-through to native bash)
/auto-approve status       # show enabled state, display, block risk, fallback
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
| `fallback` | `block` | yes | yes | `block` \| `ask` — policy when the risk threshold is crossed; `ask` runs a deep-analysis model over commands the first-pass judge flagged, auto-approving a cleared one or opening a dialog for a risky one (degrades to `block` without a UI; a judge that is unavailable — or silent after the `@tiny → @smol` fallback — always blocks, never consulting the deep model) |
| `timeoutMs` | `30000` | — | — | Per-attempt timeout for judge and deep-analysis prompts (`0` = none) |
| `idleMs` | `600000` | — | — | Both RPC children are reaped after this idle period and respawn lazily |
| `subjectMaxChars` | `4000` | — | — | Subject length (command or code) sent to the prompts; a subject longer than this is **never auto-approved** (the judge only sees the first N characters, so the full subject would run unassessed) — it blocks, or escalates to the user dialog with `fallback: "ask"` |
| `contextMaxChars` | `3000` | — | — | Session-context budget: characters of conversation excerpts (original task, latest request, recent plan text) the models see as the judgement's scope; `0` = command-only judgement (file-only) |
| `scriptMaxChars` | `4000` | — | — | Per-file budget for script analysis: characters of each referenced script file's contents sent to the prompts, so the models judge what a script the command runs actually does; `0` = no script files read (file-only) |

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
                      reads referenced script files into the prompts (script
                      analysis); execution is delegated via ctx.invokeTool,
                      never run by the extension itself
```

Both RPC children run with a `--config` overlay that disables discovered context files, so a verdict costs rubric + working directory + session-context + command tokens, not the project's `AGENTS.md`. Logs go to a redacting rotating log (`~/.omp/logs/auto-approve.log`): identifiers and verdicts only — never the raw command.

**Fail-closed everywhere**: host binary unresolved, child crash, prompt timeout, or an unreadable verdict all produce a block — under every `fallback`, with a UI or headless. The deep pass only re-analyzes commands the first-pass judge *actually flagged*; when the judge is silent it falls back to the `@tiny → @smol` chain (the no-output warning is kept); when the judge is unavailable or still silent after that fallback, the call blocks and the deep model is never consulted, so a broken judge lane can never become the approver. The only other path that runs a flagged command is `fallback: "ask"` with a UI, where it runs only when the deep model clears it or the user affirms it in the dialog. Nothing executes on uncertainty.

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