import { AccessDeniedError, AuthError, EliteaError } from "./elitea.js";

/** Process exit codes (AC-7). */
export const EXIT = {
  ok: 0,
  general: 1,
  /** Unknown flag, missing argument, bad value, confirmation needed outside a terminal. */
  usage: 2,
  /** Not logged in, or the token was rejected or expired (401, redirect to login). */
  auth: 3,
  /** The token is valid but lacks access (HTTP 403). */
  denied: 4,
  /** Unknown or ambiguous name, or not found on EliteA (404). */
  notFound: 5,
  /** Validation or conflict (400, 409, 413, 422). */
  conflict: 6,
  /** A limit or budget was reached (429). */
  limit: 7,
  /** Stopped waiting: the run goes on on EliteA (timeout, waiting for input). */
  timeout: 8,
  interrupted: 130,
} as const;

/** Help text for the exit codes; shown by `--help` and kept in the README. */
export const EXIT_CODES_HELP = `
Exit codes:
  0  success                      5  not found (404, or a name that matches nothing)
  1  other error                  6  validation or conflict (400, 409, 422)
  2  usage error                  7  limit or budget reached (429)
  3  not logged in / token rejected  8  still running on EliteA (a run passed --timeout)
  4  forbidden (403)            130  cancelled with Ctrl-C`;

/** An error with the process exit code it should end with (cli.ts). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.general,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);
export const notFoundError = (message: string) => new CliError(message, EXIT.notFound);

/** AC-21c: "<command> needs a terminal; <non-interactive alternative>". */
export const needsTerminal = (command: string, alternative: string) => usageError(`${command} needs a terminal; ${alternative}`);

/** HTTP status → exit code (AC-7). */
export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT.auth;
  if (status === 403) return EXIT.denied;
  if (status === 404) return EXIT.notFound;
  if ([400, 409, 413, 422].includes(status)) return EXIT.conflict;
  if (status === 429) return EXIT.limit;
  return EXIT.general;
}

export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof AuthError) return EXIT.auth;
  if (err instanceof AccessDeniedError) return EXIT.denied;
  if (err instanceof EliteaError) return exitCodeForStatus(err.status);
  if ((err as Error | undefined)?.name === "ExitPromptError") return EXIT.interrupted;
  return EXIT.general;
}

/** AC-7c: the one JSON line printed on stderr for an error in JSON mode. */
export function errorJson(err: unknown): string {
  const status = err instanceof EliteaError && err.status > 0 ? err.status : err instanceof AuthError ? 401 : null;
  const code = err instanceof EliteaError ? (err.code ?? null) : null;
  return JSON.stringify({ error: { status, code, message: (err as Error).message, exit: exitCodeOf(err) } });
}
