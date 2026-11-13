import { AccessDeniedError, AuthError, EliteaError } from "./elitea.js";

/** Process exit codes (cli.ts). */
export const EXIT = {
  general: 1,
  usage: 2,
  /** Not logged in, or the token was rejected. */
  auth: 3,
  /** The token is valid but lacks access (HTTP 403). */
  denied: 4,
  /** Unknown or ambiguous name, or not found on EliteA. */
  notFound: 5,
  /** Conflict, or the platform refused the input (e.g. too large). */
  conflict: 6,
  /** Stopped waiting: the run goes on on EliteA (timeout, waiting for input). */
  timeout: 8,
  interrupted: 130,
} as const;

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

/** HTTP status → exit code for platform errors (401/302 are AuthError). */
export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof AuthError) return EXIT.auth;
  if (err instanceof AccessDeniedError) return EXIT.denied;
  if (err instanceof EliteaError) {
    if (err.status === 404) return EXIT.notFound;
    if (err.status === 409 || err.status === 413 || err.status === 422) return EXIT.conflict;
  }
  return EXIT.general;
}
