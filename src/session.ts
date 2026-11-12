import { type Config, type Environment, effectiveProjectId, findEnvironmentByOrigin, loadConfig } from "./config.js";
import { tokenStore } from "./credentials.js";
import { EliteaClient } from "./elitea.js";
import { CliError } from "./errors.js";
import { defaultEnvName, tryNormalizeUrl } from "./urls.js";

export class NotLoggedInError extends CliError {
  constructor(message = "Not logged in — run `elitea-cli login` first") {
    super(message, 3);
    this.name = "NotLoggedInError";
  }
}

export class NoActiveEnvironmentError extends CliError {
  constructor() {
    super("No active environment — run `elitea-cli login` or `elitea-cli env use <name>`", 3);
    this.name = "NoActiveEnvironmentError";
  }
}

export function unknownEnvironment(name: string): CliError {
  return new CliError(`No environment ${name} — run \`elitea-cli env list\``, 5);
}

/** The environment a command runs against. */
export interface SelectedEnvironment {
  config: Config;
  name: string;
  env: Environment;
  /** From ELITEA_CLI_URL with no saved environment for that server; never written to the config. */
  temporary: boolean;
}

export interface Session extends SelectedEnvironment {
  url: string;
  token: string;
  projectId: number;
  client: EliteaClient;
}

let envFlag: string | undefined;

/** `--env <name>` of the command being run (cli.ts preAction hook). */
export function setEnvFlag(name: string | undefined): void {
  envFlag = name;
}

export function getEnvFlag(): string | undefined {
  return envFlag;
}

/** The environment name asked for by `--env` or ELITEA_CLI_ENV, if any. */
export function requestedEnvName(): string | undefined {
  return envFlag ?? (process.env.ELITEA_CLI_ENV || undefined);
}

/** ELITEA_CLI_URL, normalized; a malformed value is a usage error. */
export function envUrl(): string | undefined {
  const raw = process.env.ELITEA_CLI_URL;
  if (!raw) return undefined;
  const url = tryNormalizeUrl(raw);
  if (!url) throw new CliError(`ELITEA_CLI_URL must be a full URL, for example https://<your-server>, got "${raw}"`, 2);
  return url;
}

/**
 * --env > ELITEA_CLI_ENV > ELITEA_CLI_URL > active environment. --env never mixes with
 * ELITEA_CLI_URL: the selected environment's own URL is used, so its token stays on its server.
 */
export async function selectEnvironment(config?: Config): Promise<SelectedEnvironment> {
  config ??= await loadConfig();
  const name = requestedEnvName();
  if (name !== undefined) {
    const env = config.environments[name];
    if (!env) throw unknownEnvironment(name);
    return { config, name, env, temporary: false };
  }
  const url = envUrl();
  if (url) {
    const saved = findEnvironmentByOrigin(config, url);
    if (saved) return { config, ...saved, temporary: false };
    return { config, name: defaultEnvName(url), env: { url, integrations: {} }, temporary: true };
  }
  const active = config.active ? config.environments[config.active] : undefined;
  if (!config.active || !active) throw new NoActiveEnvironmentError();
  return { config, name: config.active, env: active, temporary: false };
}

export function loginHint(selected: Pick<SelectedEnvironment, "name" | "env" | "temporary">): string {
  return selected.temporary ? `elitea-cli login --url ${selected.env.url}` : `elitea-cli login --env ${selected.name}`;
}

export async function requireSession(): Promise<Session> {
  const selected = await selectEnvironment();
  const url = selected.env.url;
  const token = await tokenStore.get(url);
  if (!token) {
    throw new NotLoggedInError(`Not logged in to ${selected.temporary ? url : selected.name} — run \`${loginHint(selected)}\``);
  }
  const client = new EliteaClient(url, token);
  let projectId = effectiveProjectId(selected.env);
  // A temporary environment has no saved project: use the personal one.
  if (projectId === undefined && selected.temporary) projectId = (await client.getUser()).personal_project_id;
  if (projectId === undefined) throw new NotLoggedInError("No project selected — run `elitea-cli login` or `elitea-cli project`");
  return { ...selected, url, token, projectId, client };
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}
