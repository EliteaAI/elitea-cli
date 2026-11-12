import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { writeFileAtomic } from "./fsutil.js";
import { defaultEnvName, originKey, tryNormalizeUrl } from "./urls.js";

export interface IntegrationPrefs {
  model?: string;
  fastModel?: string;
}

/** One EliteA server the user works with. The token is kept apart, in credentials.ts. */
export interface Environment {
  /** Normalized `scheme://host[:port]` (urls.ts). */
  url: string;
  user?: { id: number; name: string; email: string };
  project?: { id: number; name: string };
  integrations: Record<string, IntegrationPrefs>;
}

export interface Config {
  active?: string;
  environments: Record<string, Environment>;
  settings: Record<string, unknown>;
}

/** The 0.1.0 file: one server. Version 2 still writes these keys for the active environment. */
interface ConfigV1 {
  url?: string;
  user?: Environment["user"];
  project?: Environment["project"];
  integrations?: Record<string, IntegrationPrefs>;
}

interface ConfigV2File extends ConfigV1 {
  version: 2;
  active?: string;
  environments?: Record<string, Environment>;
  settings?: Record<string, unknown>;
}

export function eliteaCliHome(): string {
  return process.env.ELITEA_CLI_HOME ?? join(homedir(), ".elitea-cli");
}

function configPath(): string {
  return join(eliteaCliHome(), "config.json");
}

export function emptyConfig(): Config {
  return { environments: {}, settings: {} };
}

/** A 0.1.0 config becomes one active environment named after its host; no url → no environment. */
export function migrateV1(old: ConfigV1): Config {
  const config = emptyConfig();
  const url = old.url ? tryNormalizeUrl(old.url) : undefined;
  if (!url) return config;
  const name = defaultEnvName(url);
  config.environments[name] = { url, user: old.user, project: old.project, integrations: old.integrations ?? {} };
  config.active = name;
  return config;
}

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw err;
  }
  const stored = JSON.parse(raw) as ConfigV1 | ConfigV2File;
  if ("version" in stored && stored.version >= 2) {
    const environments = stored.environments ?? {};
    for (const env of Object.values(environments)) env.integrations ??= {};
    return {
      active: stored.active && stored.active in environments ? stored.active : undefined,
      environments,
      settings: stored.settings ?? {},
    };
  }

  // One-time conversion; the old file is kept as config.v1.json (never overwritten).
  const config = migrateV1(stored);
  try {
    await writeFile(join(eliteaCliHome(), "config.v1.json"), raw, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new CliError(`Cannot update ${configPath()}: ${(err as Error).message}`);
    }
  }
  try {
    await saveConfig(config);
  } catch (err) {
    throw new CliError(`Cannot update ${configPath()}: ${(err as Error).message}`);
  }
  return config;
}

/** Writes version 2 plus the active environment's url/user/project/integrations, which 0.1.0 reads. */
export async function saveConfig(config: Config): Promise<void> {
  const active = config.active ? config.environments[config.active] : undefined;
  const file: ConfigV2File = {
    version: 2,
    active: active ? config.active : undefined,
    environments: config.environments,
    settings: config.settings,
    ...(active ? { url: active.url, user: active.user, project: active.project, integrations: active.integrations } : {}),
  };
  await mkdir(eliteaCliHome(), { recursive: true, mode: 0o700 });
  await writeFileAtomic(configPath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** The saved environment with this URL's origin key (at most one exists), whatever its scheme. */
export function findEnvironmentByOrigin(config: Config, url: string): { name: string; env: Environment } | undefined {
  const key = originKey(url);
  for (const [name, env] of Object.entries(config.environments)) {
    if (originKey(env.url) === key) return { name, env };
  }
  return undefined;
}

/** ELITEA_CLI_PROJECT wins over the environment's saved project (CI / headless use). */
export function effectiveProjectId(env: Environment): number | undefined {
  const fromEnv = process.env.ELITEA_CLI_PROJECT;
  if (fromEnv) {
    const id = Number(fromEnv);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`ELITEA_CLI_PROJECT must be a positive integer, got "${fromEnv}"`);
    return id;
  }
  return env.project?.id;
}

/** Change one saved environment, re-reading the file first so concurrent edits to others survive. */
export async function updateEnvironment(name: string, change: (env: Environment) => Environment): Promise<void> {
  const config = await loadConfig();
  const env = config.environments[name];
  if (!env) return;
  config.environments[name] = change(env);
  await saveConfig(config);
}
