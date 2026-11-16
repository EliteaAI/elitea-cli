import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";

/** $VISUAL, else $EDITOR, else vi (notepad on Windows) (AC-10). May carry arguments ("code --wait"). */
export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === "win32" ? "notepad" : "vi");
}

/** A new file only the user can read (AC-10b): mode 0600 in the OS temp folder, never an existing one. */
export async function createTempFile(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), `elitea-cli-${randomBytes(4).toString("hex")}-${name}`);
  await writeFile(path, content, { mode: 0o600, flag: "wx" });
  return path;
}

export async function removeTempFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

const quote = (s: string) => (process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/** Opens the editor on `path` with the terminal attached; resolves with its exit code. */
export function runEditor(path: string, command = editorCommand()): Promise<number> {
  return new Promise((resolve, reject) => {
    // Through the shell, like git: EDITOR may be "code --wait" or "vim -u NONE".
    const child = spawn(`${command} ${quote(path)}`, { stdio: "inherit", shell: true });
    child.on("error", (err) => reject(new CliError(`Cannot start the editor (${command}): ${err.message}`)));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Opens the editor and returns what was saved; an editor failing exits 1 and nothing is saved (AC-10a). */
export async function editFile(path: string, run: (path: string) => Promise<number> = runEditor): Promise<string> {
  const code = await run(path);
  if (code !== 0) throw new CliError(`Editor exited with code ${code}; nothing saved`, EXIT.general);
  return readFile(path, "utf8");
}
