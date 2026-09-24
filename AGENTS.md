# Agent notes

## Slash commands (`/auto-approve`)

Slash commands are **not** declared in `package.json`. The host never reads an `omp.commands` list for this plugin. They exist only because the extension factory calls `pi.registerCommand("auto-approve", …)` at load time (`src/index.ts` → `registerAutoApproveCommand`).

The host loads `omp.extensions[0]` → `./dist/index.js`. `dist/` is gitignored. Source changes are invisible in a running session until:

```sh
bun run build
```

Then restart the host (or reload extensions).

### Adding an `/auto-approve` subcommand

Touch every layer; skip none.

1. **i18n** (`src/i18n.ts`) — `I18nLang` keys plus **both** `zh` and `en`:
   - `cmd<Name>Description` (and per-argument descriptions)
   - status / switched strings
   - `cmdDescription` and `cmdHelp` so the new args appear in the help line
2. **ModeManager** (`src/mode-manager.ts`) — getter + setter that `update` + `persist` only the changed key. Add a persist round-trip test in `src/mode-manager.test.ts`.
3. **Completions** (`createAutoApproveCompletionProvider` in `src/index.ts`) — root item in alphabetical `value` order; nested items for arguments; a `startsWith("<name> ")` matcher.
4. **Handler** (`registerAutoApproveCommand`) — no-arg shows/toggles the current value; explicit args call the setter. Unknown args stay on `t.cmdHelp`.
5. **Tests** (`src/index.test.ts`) — autocomplete `value` + `description` arrays (en and zh), plus a handler persist round-trip.
6. **README** — command list under “Modes and runtime switching”, and the config-table row if the key is documented there.

### Settings UI is a different surface

`package.json` `omp.settings` is the host Settings UI and `omp plugin config get|set`. It does **not** register slash commands.

A persistable runtime-switchable key needs **both**:

- slash path above, and
- `omp.settings` schema (`type` / `values` / `default` / `description`), `HOST_SETTING_KEYS`, parse/merge in `src/config.ts`, and the schema-parity test in `src/config.test.ts`.

`enabled`, `display`, and `blockRisk` are those keys: `/auto-approve on|off`, `/auto-approve display off|marker|both`, and `/auto-approve risk medium|high` are the slash surfaces; the same keys appear in `omp.settings`.

Do not add `omp.commands`. Command files in the plugin manifest are a different OMP discovery path; this plugin registers commands from the extension factory.