import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable from PATH, then from known install locations. */
export function findExecutable(name: string, fallbacks: string[] = [], pathEnv = process.env.PATH ?? ""): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return fallbacks.find(isExecutable);
}

/** Overlay env changes; undefined removes a variable. */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Run the agent in the foreground with the terminal attached and resolve with
 * its exit code. Ctrl-C reaches the child directly (same process group), so the
 * parent ignores it while waiting.
 */
export function runForeground(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const ignore = () => {};
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGQUIT"];
    for (const s of signals) process.on(s, ignore);
    const forwardTerm = () => child.kill("SIGTERM");
    process.on("SIGTERM", forwardTerm);
    const cleanup = () => {
      for (const s of signals) process.off(s, ignore);
      process.off("SIGTERM", forwardTerm);
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal];
}
