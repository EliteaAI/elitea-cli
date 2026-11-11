import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export const DEFAULT_URL = "https://next.elitea.ai";

export interface IntegrationPrefs {
  model?: string;
  fastModel?: string;
}

export interface Config {
  url: string;
  user?: { id: number; name: string; email: string };
  project?: { id: number; name: string };
  integrations: Record<string, IntegrationPrefs>;
}

export function eliteaCliHome(): string {
  return process.env.ELITEA_CLI_HOME ?? join(homedir(), ".elitea-cli");
}

function configPath(): string {
  return join(eliteaCliHome(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return {
    url: stored.url ?? DEFAULT_URL,
    user: stored.user,
    project: stored.project,
    integrations: stored.integrations ?? {},
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(eliteaCliHome(), { recursive: true, mode: 0o700 });
  await writeFileAtomic(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Env overrides win over the saved config (useful for CI / headless use). */
export function effectiveUrl(config: Config): string {
  return (process.env.ELITEA_CLI_URL ?? config.url).replace(/\/+$/, "");
}

export function effectiveProjectId(config: Config): number | undefined {
  const fromEnv = process.env.ELITEA_CLI_PROJECT;
  if (fromEnv) {
    const id = Number(fromEnv);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`ELITEA_CLI_PROJECT must be a positive integer, got "${fromEnv}"`);
    return id;
  }
  return config.project?.id;
}
