/**
 * Auto Approve — type definitions.
 *
 * Minimal extension API surface (no host import) plus the plugin's domain
 * value objects.  Shapes mirror the pi/omp extension contract as consumed
 * by this plugin.
 */

// ── Extension API surface (minimal; no host import) ──────────────────

/** One slash-command argument completion rendered by the host TUI. */
export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/** The pi/omp extension API surface used by this extension. */
export interface ExtensionAPI {
  on(
    event: "tool_call" | "session_shutdown",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionCtx,
    ) => Promise<void | { block: true; reason: string }>,
  ): void;
  /** Agent-loop lifecycle: fires once per prompt when the loop ends. */
  on(
    event: "agent_end",
    handler: (
      event: { type: "agent_end"; willContinue?: boolean },
      ctx: ExtensionCtx,
    ) => void | Promise<void>,
  ): void;
  /** Append/display a persistent custom session message. */
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
      attribution?: "agent" | "user";
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  /** Register a slash command callable from the TUI/RPC host. */
  registerCommand(
    name: string,
    def: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
      handler: (args: unknown, ctx: ExtensionCtx) => void | Promise<void>;
    },
  ): void;
  /** Execute a shell command. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Register a custom tool callable by the LLM. */
  registerTool<TParams = unknown, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
  /** Injected zod module for tool parameter schemas (runtime-injected by
   *  host); structurally narrowed to the surface this plugin builds with. */
  zod: ZodLike;
}

/** Minimal exec options (subset of Node/Bun exec). */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

/** Minimal exec result. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** Tool definition for registerTool. */
export interface ToolDefinition<TParams = unknown, TDetails = unknown> {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  approval?: string;
  deferrable?: boolean;
  hidden?: boolean;
  strict?: boolean;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: unknown[]; details?: unknown }) => void) | undefined,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult<TDetails>>;
  onSession?: (event: { reason: string }, ctx: ExtensionCtx) => void | Promise<void>;
}

/** Tool result returned by custom tool execute(). */
export interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details?: TDetails;
  isError?: boolean;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: { command?: string; path?: string; [k: string]: unknown };
}

export interface ExtensionCtx {
  hasUI: boolean;
  cwd?: string;
  lang?: string;
  sessionManager?: {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
    getSessionId?: () => string;
  };
  /** Host model registry (opaque here): handed to the host's judge-role
   *  chain by the native judge lane (native-judge.ts). */
  modelRegistry?: unknown;
  ui: {
    confirm: (title: string, body: string) => Promise<boolean>;
    /** OMP's ui.select resolves with the chosen option's label (string), not
     *  a numeric index. In no-UI/headless contexts it resolves with undefined. */
    select?: (title: string, choices: string[]) => Promise<string | number | undefined>;
    setStatus: (id: string, text: string | undefined) => void;
    notify?: (msg: string, level: "info" | "warning") => void;
  };
  /** True when the agent loop is idle (no turn in progress). */
  isIdle?: () => boolean;
  /** Managed timer; falls back to global setTimeout when absent. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Delegate to the native built-in tool of the same name. */
  invokeTool?: <TDetails = unknown>(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: unknown },
  ) => Promise<AgentToolResult<TDetails>>;
}

/** Minimal chainable zod surface used by gate tool schemas. */
export interface ZodFieldBuilder {
  describe(text: string): ZodFieldBuilder;
  optional(): ZodFieldBuilder;
}

/** The host-injected zod builder, narrowed to what gates need. */
export interface ZodLike {
  object(spec: Record<string, unknown>): unknown;
  string(): ZodFieldBuilder;
  number(): ZodFieldBuilder;
  boolean(): ZodFieldBuilder;
  enum(values: readonly string[]): unknown;
}

/** Minimal logger contract for dependency injection (tests, stubs). */
export interface LoggerLike {
  log(message: string): void;
}

// ── Domain value objects ─────────────────────────────────────────────

/**
 * One-shot verdict from the judge model.  `summary` is optional: the judge
 * model may not produce prose, so display falls back to a localized label.
 */
export interface JudgeVerdict {
  risk?: "low" | "medium" | "high";
  recommend?: "allow" | "deny";
  summary?: string;
}

/** Classified infrastructure failure of a judge assessment. */
export type JudgeErrorCategory =
  | "spawn" // host binary or child spawn failed
  | "timeout" // per-assessment window exhausted
  | "abort" // request aborted by its signal
  | "crash" // child exited mid-assessment
  | "protocol" // RPC handshake/ack rejected or malformed
  | "provider"; // native judgment backend failed the request

/** The classified result of one judge assessment. */
export type JudgeOutcome =
  | { kind: "verdict"; verdict: JudgeVerdict }
  | { kind: "empty"; reason: string }
  | { kind: "error"; reason: string; category: JudgeErrorCategory }
  | { kind: "unavailable"; reason: string };
/** Bounded, redacted conversation excerpts fed to the judge prompts:
 *  lets the models reason about why a command runs, not just what it
 *  does. Selection order and per-slot character budgets are owned by
 *  SessionContextGatherer.collect: the latest user request first, then the
 *  original task, the preceding correction, then the newest assistant plan
 *  text with the remainder of the budget. Identical original/latest
 *  messages are deduplicated; the omitted-message counts keep budget
 *  omissions visible. Latest-user excerpts are contextual intent, never a
 *  new permission authority; assistant text is a claim, not authorization. */
export interface SessionContext {
  /** Most recent non-empty user message (the latest correction/authorization). */
  latestUser: string | null;
  /** First user message (original task). Null when identical to latestUser. */
  originalUser: string | null;
  /** The user message immediately before the latest one, when it exists and
   *  is distinct from both latestUser and originalUser (a mid-conversation
   *  correction). */
  precedingUserCorrection: string | null;
  /** Newest assistant plan text (a claim, never an authorization). */
  newestAssistant: string | null;
  /** User messages whose content is not represented in any slot (deduplicated
   *  or dropped by the character budget). */
  omittedUserMessages: number;
  /** Assistant messages dropped by the character budget (only the newest is
   *  included). */
  omittedAssistantMessages: number;
}

/** A bounded, redaction-free command excerpt for logs (operator-facing). */
export type LogMessage = string;