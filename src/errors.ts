/**
 * An error with the process exit code it should end with (cli.ts).
 * 1 general, 2 usage, 3 not logged in / token rejected, 5 unknown name, 6 conflict.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
