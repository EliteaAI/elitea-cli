import { confirm } from "@inquirer/prompts";
import { ctx } from "./context.js";
import { CliError, EXIT } from "./errors.js";
import { isInteractive } from "./session.js";

/** Only one option per command may read stdin (AC-21b). */
export function claimStdin(option: string): void {
  if (ctx.stdinOwner !== undefined && ctx.stdinOwner !== option) throw new CliError("Only one option can read stdin", EXIT.usage);
  ctx.stdinOwner = option;
}

export async function readStdin(option: string): Promise<string> {
  claimStdin(option);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export interface Destructive {
  /** Verb, lower case: delete, remove, revoke, overwrite. */
  action: string;
  /** What is changed: agent, environment, credential… */
  type: string;
  name: string;
  /** Id (or url) shown in brackets. */
  id: string | number;
  /** A second line explaining the consequence, shown before the question. */
  note?: string;
  /** The command's own --yes (the global one is in ctx). */
  yes?: boolean;
}

/**
 * Confirm a delete/remove/revoke/overwrite (AC-14): "<Action> <type> '<name>' (<id>)? (y/N)".
 * --yes skips it; outside a terminal without --yes it fails with exit 2 and nothing is changed.
 * Returns false when the user said no.
 */
export async function confirmDestructive(d: Destructive): Promise<boolean> {
  if (d.yes || ctx.yes) return true;
  const what = `${d.type} '${d.name}'`;
  if (!isInteractive()) throw new CliError(`Refusing to ${d.action} ${what} without --yes in a non-interactive shell`, EXIT.usage);
  if (d.note) console.error(d.note);
  const verb = d.action.charAt(0).toUpperCase() + d.action.slice(1);
  return confirm({ message: `${verb} ${what} (${d.id})?`, default: false });
}
