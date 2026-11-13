/** Scoped-token operation a command needs (AC-9); undefined = the platform names none. */
export type TokenOperation = "build" | "run";

/**
 * Per-invocation state set by the cli.ts preAction hook: global flags, CLI settings and what the
 * command is about, for error texts and output defaults. One process runs one command.
 * No imports: every module may read it.
 */
export interface RunContext {
  debug: boolean;
  quiet: boolean;
  yes: boolean;
  /** False with --no-color (NO_COLOR and `settings.color` are read by colorEnabled). */
  color: boolean;
  /** The command prints JSON: errors go to stderr as one JSON line (AC-7c). */
  json: boolean;
  /** `settings` of the config file (config.ts). */
  settings: Record<string, unknown>;
  /** The project the command works in, once known (for 403 texts). */
  projectId?: number;
  operation?: TokenOperation;
  /** Extra exact key names masked in --debug output (fields a type schema marks secret). */
  secretKeys: string[];
  /** The option that reads stdin in this command (AC-21b). */
  stdinOwner?: string;
}

function fresh(): RunContext {
  return { debug: false, quiet: false, yes: false, color: true, json: false, settings: {}, secretKeys: [] };
}

export const ctx: RunContext = fresh();

/** Back to defaults (tests). */
export function resetContext(): void {
  for (const key of Object.keys(ctx)) delete (ctx as unknown as Record<string, unknown>)[key];
  Object.assign(ctx, fresh());
}

export function isDebug(): boolean {
  return ctx.debug || Boolean(process.env.ELITEA_CLI_DEBUG);
}

/** Colours allowed: not disabled by --no-color, NO_COLOR or `settings.color: never`. */
export function colorEnabled(): boolean {
  return ctx.color && !process.env.NO_COLOR && ctx.settings.color !== "never";
}

const RUN_COMMANDS = ["agents run", "agents chat", "pipelines run", "chats send", "toolkits test", "credentials test"];
const BUILD_COMMANDS = [
  ...["agents", "pipelines"].flatMap((r) => ["create", "update", "edit", "delete", "version create", "version default"].map((v) => `${r} ${v}`)),
  "agents toolkits add",
  "agents toolkits remove",
  ...["toolkits", "credentials"].flatMap((r) => ["create", "update", "delete"].map((v) => `${r} ${v}`)),
];

/** The scoped-token operation for a command path like "agents run" (AC-9 table). */
export function operationFor(path: string): TokenOperation | undefined {
  if (RUN_COMMANDS.includes(path)) return "run";
  if (BUILD_COMMANDS.includes(path)) return "build";
  return undefined;
}
