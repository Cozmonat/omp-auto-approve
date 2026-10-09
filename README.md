# auto-approve

Model-based approval for **oh-my-pi (OMP)**. Reviews bash commands and Python/JavaScript `eval` calls before they run, automatically approves low-risk work, and gives flagged operations a second review.

Based on the work of [mentalfl0w/smart-approve](https://github.com/mentalfl0w/smart-approve), originally released under the MIT license.

## Install

```sh
npm install auto-approve
```

Add the extension to your OMP configuration:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - auto-approve
tools:
  approvalMode: yolo
```

Restart OMP, then run `/auto-approve status` to check that the extension is loaded and inspect its settings.

The extension uses OMP's `@judge` model role for the initial assessment and `@tiny` / `@smol` for additional review. Configure these roles in your OMP model settings (`~/.omp/agent/models.yml` or `config.yml`). There is no separate model setting in this plugin.

**Important:** `approvalMode: yolo` disables the host's approval prompts. This extension reviews only `bash` and `eval`; other tools are not protected by it. Choose your host approval settings accordingly.

## How approval works

1. **Initial assessment.** The judge reviews the command or code, its working directory, relevant conversation excerpts, and detected script files.
2. **Automatic approval.** An allow verdict below the configured risk threshold runs immediately.
3. **Second review.** A deny verdict or a risk rating at or above the threshold triggers a deeper assessment with `@tiny`, falling back to `@smol` when unavailable. If that review clears the operation, it runs automatically.
4. **Block or ask.** If the second review still flags a risk, the operation is blocked by default. With `fallback: "ask"`, an interactive session can show a risk summary and let you allow it once or deny it.

An operation that cannot be assessed is blocked, not silently approved. A failed native judge or a chat judge that produces no output gets an initial-assessment fallback through `@tiny` → `@smol`; if no usable verdict is available, the operation stays blocked. A missing risk summary or an over-length command cannot be approved through the confirmation dialog.

The second review adds model latency only to flagged operations. After approval, execution is delegated to OMP's built-in tool, preserving its normal shell, output, cancellation, and eval behavior.

Normal, non-forced pushes to the intended repository's feature or PR branch are **medium risk**, not high solely because they reach a remote. A checkout or worktree under `/tmp` (including `/private/tmp`) is still a project; its location alone does not raise push risk. At the default `blockRisk: "high"`, these pushes are eligible for automatic approval. The models still assess the destination, user intent, refspec, secret exposure, and production impact. Force-pushes, shared-history rewrites, and remote branch/tag deletions are not covered by this ordinary-push guidance.

GitHub permissions and branch protection reduce risk but do not replace this assessment: a writable wrong branch can accept a push, and CI checks often gate merging rather than prevent pushes. Pushes can also publish secrets or trigger deployments.

### Headless sessions

Subagents and sessions without a UI use the same two-stage review. Operations cleared by either stage can run automatically. Operations that remain flagged are blocked; `fallback: "ask"` never opens a dialog in a headless session.

## Modes and runtime switching

Use these commands without restarting OMP. Changes persist, and command arguments autocomplete.

```text
/auto-approve                   # toggle approval on/off
/auto-approve on                # enable review
/auto-approve off               # bypass review for bash and eval
/auto-approve status            # show settings and judge backend

/auto-approve display           # show the current display mode
/auto-approve display off       # hide approval markers and toasts
/auto-approve display marker    # show a marker inside the tool call
/auto-approve display both      # show a marker and result toast (default)

/auto-approve risk              # show the current risk threshold
/auto-approve risk medium       # send medium- and high-risk calls to second review
/auto-approve risk high         # send high-risk calls to second review (default)

/auto-approve fallback          # show the current fallback policy
/auto-approve fallback block    # block operations still flagged after review (default)
/auto-approve fallback ask      # offer allow-once/deny when a UI and summary are available
```

Blocked results remain visible even with `display: "off"`. Turning the extension off bypasses all model review; it does not make commands safer.

## Configuration

Optional settings live in `~/.omp/agent/auto-approve.json`. Missing values use the defaults below. Runtime commands create the file when needed and update only the changed key.

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable review of bash and eval. `false` passes through to the built-in tools. |
| `display` | `"both"` | Approval feedback: `"off"`, `"marker"`, or `"both"`. Blocked results are always visible. |
| `blockRisk` | `"high"` | Minimum risk rating that triggers second review: `"medium"` or `"high"`. |
| `fallback` | `"block"` | For operations still flagged after second review: `"block"` denies; `"ask"` offers confirmation when an interactive UI and risk summary are available. |
| `timeoutMs` | `30000` | Timeout in milliseconds for each model attempt. `0` disables the timeout. |
| `idleMs` | `600000` | Idle time in milliseconds before review subprocesses are stopped. `0` keeps them alive until the session ends. |
| `subjectMaxChars` | `4000` | Maximum command or code length that can be fully assessed. Longer inputs are blocked without a dialog. |
| `contextMaxChars` | `3000` | Total character budget for conversation excerpts. `0` omits conversation context. |
| `scriptMaxChars` | `4000` | Per-file character budget for referenced scripts. `0` disables script-file reads. |

`enabled`, `display`, `blockRisk`, and `fallback` are also available in the OMP Settings UI and through `omp plugin config get|set`. Host plugin settings take precedence over the JSON file.

### What the models see

The review includes the original task, latest user request, and recent agent plan, subject to `contextMaxChars`. These excerpts are credential-redacted and marked as untrusted input, not additional authorization.

For bash commands, the extension reviews inline scripts and reads up to three detected script files relative to the execution directory. Common shell, Python, JavaScript/TypeScript, and other script extensions are recognized. Each file is capped at `scriptMaxChars`; missing, unreadable, binary, or oversized files are reported to the model. Remote URLs are not fetched, and script paths containing spaces are not detected, even when quoted.

Choose budgets that fit your review models' context windows. Increasing a budget allows more input to be assessed, but can increase latency, cost, and context-limit failures.

## Safety and limitations

- **An approval gate, not a sandbox.** Model assessments can be wrong. Test representative commands with your chosen models before relying on unattended approvals.
- **Only bash and eval are covered.** File-editing tools, browser tools, MCP tools, and other execution surfaces are outside this extension's scope.
- **Flagged does not mean permanently blocked.** A second review can automatically approve an operation in any session, even with `fallback: "block"`. No setting disables this second-stage auto-approval.
- **Confirmation shows a model-generated summary**, not the raw command or code. It is available only when the full input was assessed and the second review provides a risk summary.
- **Model input can contain hostile instructions.** Commands, scripts, and conversation excerpts are treated as untrusted data, but prompt-injection defenses are not a guarantee.
- **Review data goes to your configured model providers.** Commands, code, conversation excerpts, and script contents may contain sensitive information. Credential redaction of conversation excerpts does not replace reviewing what you send to a provider.
- **Assessment failures block execution.** Unavailable models, timeouts, and unusable verdicts do not grant permission. Oversized commands are also blocked, including with `fallback: "ask"`.

## Host support

OMP is the supported host. Native judgment models are used directly when OMP exposes its judgment integration; otherwise the extension uses chat-based assessment through an OMP subprocess. `/auto-approve status` shows which backend is selected.

The extension must be able to resolve the OMP executable for subprocess-based reviews. If it cannot, those assessments fail closed, but `/auto-approve` remains available.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `judge unavailable` | Make sure OMP is installed and its executable is available to the running session. |
| `judge unavailable (spawn)` | Read the error in the tool result. Check that the configured `judge` role resolves to an available provider/model. |
| `no usable verdict` | Use a chat judge that can follow the structured response format. |
| `native judge failed` | Check the judgment provider's availability and credentials. The initial assessment falls back to `@tiny` → `@smol`. |
| `judge produced no output` | A judgment-only model may have been used without native integration. Update OMP or configure a chat-capable judge. |
| Model timeout | Increase `timeoutMs` or choose a faster model. |
| `too long to assess in full` | Split the command or increase `subjectMaxChars` within your model's context limit. |
| Provider context-length error | Reduce input budgets or use a model with a larger context window. |
| Routine commands repeatedly trigger review | Check the judge model's risk ratings and your `blockRisk` setting. Risk ratings vary between models. |

Diagnostic logs are written to `~/.omp/logs/auto-approve.log`. The rotating log records identifiers and verdicts rather than raw commands, with failure details redacted.

## Development

Install dependencies and build the extension with Bun:

```sh
bun install
bun run build
```

The host loads `dist/index.js`, not the TypeScript source. Rebuild after source changes, then restart OMP or reload extensions.

Available checks:

```sh
bun run typecheck
bun test src
```

## License

[MIT](LICENSE). The upstream MIT notice is preserved in this repository.
