# auto-approve

Judge-model auto-approval for **oh-my-pi (OMP)**: the host's `@judge` model role runs a one-shot risk assessment of every bash command and every `eval` (in-process Python/JavaScript). When the role resolves to a native System One judgment model (TypeSafe `jev`, a local decider on `api: typesafe`), the plugin asks it one typed risk question in-process through the host's own judge chain; otherwise a persistent `omp --mode rpc` child sends the role a chat prompt. Low-risk calls execute with zero interruption. A command at or above the risk threshold gets a second, deeper review (`@tiny`, then `@smol`) in every session, UI or headless: one that model clears is auto-approved; one it also flags is blocked — or, with `fallback: "ask"` in a UI session, shown in a dialog for the user to decide. When the native judgment fails, or a chat judge produces no output at all (a broken judge lane), the gate re-runs the judge prompt on the `@tiny → @smol` chain and keeps warning (`native judge failed` / `judge produced no output`); when a chat judge is unavailable or answers without a usable verdict, commands block under every fallback — the deep model never substitutes for a broken judge.

Covered execution surfaces:

| Tool | Mechanism | Decision |
|---|---|---|
| `bash` | Custom tool shadowing the built-in | judge verdict + risk threshold + deep review of flagged commands |
| `eval` | Custom tool shadowing the built-in (in-process Python/JavaScript) | judge verdict + risk threshold + deep review of flagged commands |

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
  │     inputs: working directory + session context (conversation excerpts,
  │     capped at contextMaxChars) + referenced script file contents (each
  │     capped at scriptMaxChars) + command subject (capped at subjectMaxChars)
   │
   │     role resolves to a native System One model:
   │       one typed judgment in-process via the host's judge-role chain —
   │       state { command|code, cwd, context, scripts } + a `risk` choice
   │       (low|medium|high, criteria from the rubric); no child process
   │       (native judgment fails — provider error, timeout, no usable answer:
   │        the @judge chat step is skipped; re-run the judge prompt on the
   │        @tiny → @smol chain, keeping the "native judge failed" warning)
   │
   │     otherwise (chat role, or a host without the native judgment modules):
   │       one-shot chat prompt: fixed rubric + the inputs above →
   │       JSON { risk: low|medium|high, recommend: allow|deny }
   │       run by a persistent `omp --mode rpc` child (spawned lazily,
   │       per-assessment session reset, idle-reaped, respawned on model change)
   │       (judge silent — no output at all: re-run the judge prompt on the
   │        @tiny → @smol chain, keeping the "judge produced no output" warning)
   │
   ├─ verdict allow and risk below blockRisk ────────► delegate + display surfaces
   │
   └─ threshold crossed (the judge flagged it: recommend deny / risk ≥ blockRisk)
         (chat judge unavailable, or a failed lane with no @tiny → @smol verdict →
          always block, under every fallback: the deep model is never a substitute)
         │
         Stage 2: deep review — every session, UI or headless, every fallback
         (the fixed @tiny role, retrying @smol when unavailable; a separate
         persistent RPC child re-analyzes and returns a verdict; skipped for an
         over-budget subject unless a dialog can follow)
         ├─ deep model clears it (no real risk) ──► auto-approve + display surfaces
         │
         └─ deep model flags a real risk (or no verdict)
               ├─ fallback: "block" (default), or no UI (headless session)
               │     block without asking — marker line (if display is
               │     marker/both), a warning toast (UI sessions), and
               │     model-facing denial prose naming the second review
               │
               └─ fallback: "ask" with a UI
                     → dialog: "⚠️ Dangerous command review"
                           [ ✅ Allow once | ❌ Deny ]
                           (degrades to a two-way confirm when ui.select
                           is unavailable)
                     ├─ Allow once ───────────────────► delegate + display surfaces
                     └─ Deny / unresolvable answer ───► fail-closed block +
                                                        "user denied" toast
```

Stage 2 is paid only when a verdict the judge actually produced — or that its `@tiny → @smol` lane fallback produced — crosses the threshold (or the subject is over budget under `fallback: "ask"` with a UI). Low-risk commands never launch the deep model, and neither does a judge lane that is broken with no fallback verdict. Expect the deep model's latency (seconds on a small local model) on every flagged command.

## Judge model

Stage-1 verdicts run on the host's `@judge` model role, resolved from your OMP model config (`~/.omp/agent/models.yml` / `config.yml`) — the plugin has no model key of its own, whatever the role resolves to is what judges. `/auto-approve status` names the lane the next assessment uses (`judge native System One` or `judge @judge chat`). Two caveats matter in practice:

- **Native judgment models are used natively.** As of OMP 18.3.0 the `judge` role resolves to **native candidates only** once any credentialed `api: typesafe` / `openrouter-decisions` provider exists (including a local decider). When the host's judge role resolves natively, stage 1 calls OMP's own judge-role chain in-process (`@oh-my-pi/pi-coding-agent/judgment`, credentials and retries owned by the host): the model answers one `risk` choice over the command's state, typically in tens of milliseconds, and only that choice gates — a yes/no "run it unattended?" probe was measured at ~0.5 for routine commands on a local decider, so thresholding it would block ordinary work. If the native judgment fails, the chat `@judge` step is skipped (it would reach the same judgment-only model) and the judge prompt is re-run on `@tiny → @smol` with a `native judge failed` warning; with no fallback verdict the call blocks. A host that does not expose the judgment modules (upstream pi, or an OMP build without them) keeps the chat lane: a native role then returns no text, the gate warns `judge produced no output`, and the same `@tiny → @smol` fallback applies. Decider-class risk scores are uncalibrated: test representative commands before relying on unattended approvals (a local decider rated `git status` medium, so `blockRisk: "medium"` would block it).
- **The command text and conversation excerpts are model-facing input to both models.** The judge and the deep analyst are different models from the one that proposed the command, so self-deception is bounded; but both read the command and compact conversation context, and small models can be manipulated by instructions embedded in either. Both rubrics tell the models to treat that text as untrusted, and any verdict a model cannot express is a block. Because the deep review runs under every `fallback` and in headless sessions, a command the deep model *clears* is auto-approved **without a dialog** in every mode — a human only sees commands the deep model flags or cannot verdict, and only with `fallback: "ask"` in a UI session. No setting turns off deep auto-approval of judge-flagged commands; `blockRisk: "medium"` only changes which commands reach the deep review.

**Troubleshooting**

| Symptom | Likely cause | Fix |
|---|---|---|
| Every command blocked — "judge unavailable" | Host `omp` binary unresolved (see Host support) | Install `omp` on `PATH`, or run the session under the host it ships with |
| Every command blocked — "judge unavailable (spawn)" | The judge child exited at startup — most often a `judge` role that resolves to nothing (renamed/removed provider, e.g. a stale `local-judge-chat/…`). The denial quotes the child's stderr (e.g. `Model "…" not found`), so the cause is visible in the tool result | Make the `judge` role resolve in the host's model config: a role alias in `~/.omp/agent/config.yml`, or a `provider/model` present in `~/.omp/agent/models.yml` |
| Every command blocked — "no usable verdict" | The judge answered but its text was not a parseable verdict (a chat model not following the JSON contract) | Point the `judge` role at a model that follows the rubric (e.g. `@smol`, `@tiny`, or the Decider chat lane) |
| Every command warns `native judge failed` (the `@tiny → @smol` fallback judges instead) | The native judgment backend errors or times out — the denial and log quote the host's message, redacted like every judge failure (credentials masked, URLs replaced, first 100 characters; e.g. `every judge candidate failed: … API error (503)`) | Fix the judgment server or its credentials, or point `judge` at a chat-lane entry |
| Every command warns `judge produced no output` (the `@tiny → @smol` fallback judges instead) | The `judge` role resolves to a native System One / `api: typesafe` model, but this host does not expose OMP's native judgment modules, so the plugin sent it a chat prompt it cannot answer | Update OMP so the native lane is used, or make `judge` resolve to a chat-lane entry, e.g. a second provider entry for the same server with `api: openai-completions` |
| Every command blocked — timeout | Judge child slower than `timeoutMs` (small local models) | Raise `timeoutMs`, or point `judge` at a faster model |
| A long command (including a multi-line script) is blocked as "too long to assess in full" | Command exceeds `subjectMaxChars`; the judge would only see a prefix | Split the command, or raise `subjectMaxChars` (see Script analysis) |
| Every command blocked — provider error about context length | The judge model's context window is smaller than the full prompt (rubric + session context + command); small local models are prone to this | Lower `subjectMaxChars` and/or `contextMaxChars` until the prompt fits the model's window, or use a judge with a larger window; commands fail closed until then |

## Session context

Both models also judge the command's *scope*: compact excerpts of the conversation — the original user task, the latest user request, and the agent's newest plan text — so a verdict reflects why the command runs, not just what it does. The excerpts are credential-redacted, capped at `contextMaxChars` characters total (messages dropped by the budget are reported inside the prompt), and fenced as untrusted data with an explicit instruction not to follow anything inside them. The latest user excerpt is contextual intent, never a new authorization: a mid-conversation message cannot expand what the risk rubric permits. Set `contextMaxChars: 0` for command-only judgements (useful with small-window judge models).

## Script analysis

Newer models (e.g. GPT-6-Sol) often run multi-step work through shell scripts rather than single one-liners — either a multi-line script inside the `command` string, or a script file it wrote earlier (`bash run.sh`, `python script.py`). Judging only the invocation line makes every such call look like "runs unreviewed code", so the prompts handle both shapes:

- **Inline scripts:** both rubrics tell the models the command may be a multi-line shell script and that every statement it would execute — functions, loops, conditionals, command substitutions, heredocs — counts as the command's action.
- **Referenced script files:** the gate extracts script-path tokens from the command (`.sh`, `.bash`, `.zsh`, `.ksh`, `.fish`, `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.rb`, `.pl`, `.php`, `.lua`, `.ps1`), resolves them against the execution working directory, and feeds up to three files' contents (each capped at `scriptMaxChars`) into both prompts, fenced as untrusted data. Paths containing spaces (even when quoted) are not detected. Files that cannot be read are reported in the prompt as `missing`, `unreadable`, `binary`, or `too large`, so the judge knows a missing body is not a missing risk. Fetch URLs are ignored (a remote target is not a file to read). Set `scriptMaxChars: 0` to disable file reads and fall back to judging the invocation line only.

Long inline scripts still obey `subjectMaxChars`: a script longer than the assessment window is never auto-approved, not even by the deep review (blocks as "too long", or reaches the dialog under `fallback: "ask"` in a UI session). If your model habitually writes long scripts and you trust the judge to read them, raise `subjectMaxChars` accordingly.

## Headless sessions

Headless sessions (subagents, no UI) run the same two-stage review over bash and eval — the RPC children need no UI. A flagged command gets the deep review there too: a cleared one runs, a confirmed one is blocked, and `fallback: "ask"` never opens a dialog (it behaves like `block`). Blocked commands simply do not execute, and the denial text tells the model why — judge declined, the risk rating (plus the second review's finding when it confirmed the risk), or judge unavailable (fail-closed) — with an explicit note that no confirmation dialog was shown, so a headless denial is never mistaken for a user decision. Low-risk verdicts are auto-approved and execute headlessly.

## Modes and runtime switching

Switch at runtime from the TUI (or RPC client) — no restart needed; changes persist:

```
/auto-approve              # toggle enabled (also shows current settings when enabled)
/auto-approve on           # enable
/auto-approve off          # disable (pass-through to native bash)
/auto-approve status       # show enabled state, display, block risk, fallback, stage-1 judge lane
/auto-approve display             # show the current display mode
/auto-approve display off       # silent approvals (marker + toast hidden)
/auto-approve display marker    # marker line inside the tool call only
/auto-approve display both      # marker + assessment-result toast (default)
/auto-approve risk               # show the current block risk level
/auto-approve risk medium       # block medium and high risk
/auto-approve risk high         # block high risk only (default)
/auto-approve fallback          # show the current fallback policy
/auto-approve fallback ask      # deep-flagged commands open a dialog (UI sessions)
/auto-approve fallback block    # deep-flagged commands block without asking (default)
```

Use `/auto-approve status` to inspect the current settings without a persistent status-bar row. Results use host notifications when available, otherwise a temporary status row that clears after five seconds. Slash-command arguments autocomplete with a description of each action.

## Configuration

File: `~/.omp/agent/auto-approve.json` (created on first write-back). Runtime switches write only the changed key; every other user-edited field is preserved.

| Key | Default | Slash command | Settings UI | Notes |
|---|---|---|---|---|
| `enabled` | `true` | yes | yes | Master switch; `false` delegates every bash call to the native tool |
| `display` | `both` | yes | yes | `off` \| `marker` \| `both` — where approval markers appear; blocked verdicts are always visible |
| `blockRisk` | `high` | yes | yes | `medium` \| `high` — minimum judge risk level that blocks |
| `fallback` | `block` | yes | yes | `block` \| `ask` — what happens to a command the deep review also flags (the deep review itself runs for every threshold crossing, UI or headless, and auto-approves a command it clears): `block` denies without asking; `ask` opens a dialog in UI sessions and blocks headlessly. A chat judge that is unavailable — or a failed lane with no `@tiny → @smol` verdict — always blocks, never consulting the deep model |
| `timeoutMs` | `30000` | — | — | Per-attempt timeout for the native judgment and for judge and deep-analysis prompts (`0` = none) |
| `idleMs` | `600000` | — | — | Both RPC children are reaped after this idle period and respawn lazily |
| `subjectMaxChars` | `4000` | — | — | Subject length (command or code) sent to the prompts; a subject longer than this is **never auto-approved** (the judge only sees the first N characters, so the full subject would run unassessed) — it blocks, or escalates to the user dialog with `fallback: "ask"` in a UI session |
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
 ├─ HostNativeJudge — loads the host's judgment modules once; per call decides
 │                    whether the judge role is native and, if so, runs one
 │                    typed `risk` judgment through the host's judge-role chain
 ├─ JudgeInvoker ×2 — persistent `omp --mode rpc` children: one per model role
 │                    (stage-1 chat judge and @tiny/@smol fallback, stage-2 deep
 │                    analysis); JSONL stdio protocol, per-assessment session
 │                    reset, abort forwarding, model-switch respawn, idle reaping
 └─ BashGate/EvalGate — shadow the built-in `bash` / `eval` tools; decision
                      pipeline; reads referenced script files into the prompts
                      (script analysis); execution is delegated via
                      ctx.invokeTool, never run by the extension itself
```

Both RPC children run with a `--config` overlay that disables discovered context files, so a verdict costs rubric + working directory + session-context + command tokens, not the project's `AGENTS.md`. Logs go to a redacting rotating log (`~/.omp/logs/auto-approve.log`): identifiers and verdicts only — never the raw command.

**Fail-closed everywhere**: host binary unresolved, child crash, prompt timeout, or an unreadable verdict all produce a block — under every `fallback`, with a UI or headless. The deep review only re-analyzes commands the first-pass judge *actually flagged*; when the native judgment fails or the chat judge is silent, stage 1 falls back to the `@tiny → @smol` chain (the lane warning is kept); when that fallback yields no verdict, or the chat judge is unavailable, the call blocks and the deep model is never consulted, so a broken judge lane can never become the approver. A flagged command runs only when the deep model clears it (any session, any fallback) or the user affirms it in the dialog (`fallback: "ask"` with a UI). Nothing executes on uncertainty.

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

- **OMP** — supported; the extension resolves the host binary from its own runtime paths. The native judge lane needs a host that exposes `@oh-my-pi/pi-coding-agent/judgment` and `config/settings` to plugins (verified on OMP 18.3.0 run from its npm install); any other host keeps the chat lane.
- A host it cannot resolve fails closed per call (judge unavailable → block), but registration itself always succeeds, so `/auto-approve` remains usable.

MIT.