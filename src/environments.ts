import { confirm } from "@inquirer/prompts";
import { type Config, findEnvironmentByOrigin } from "./config.js";
import { CliError } from "./errors.js";
import { isInteractive } from "./session.js";
import { ENV_NAME_HINT, URL_HINT, isLocalUrl, isValidEnvName, originKey, tryNormalizeUrl, urlScheme } from "./urls.js";

/** A URL typed on the command line; refused with the same text as the prompt (exit 2). */
export function parseUrlArg(raw: string): string {
  const url = tryNormalizeUrl(raw);
  if (!url) throw new CliError(URL_HINT, 2);
  return url;
}

/** For prompts: true, or the reason the name can't be used for this URL. */
export function checkEnvName(config: Config, name: string, url: string): true | string {
  if (!isValidEnvName(name)) return ENV_NAME_HINT;
  const existing = config.environments[name];
  if (existing && existing.url !== url) return `Environment ${name} already points to ${existing.url}`;
  return true;
}

export function assertEnvName(config: Config, name: string, url: string): void {
  const check = checkEnvName(config, name, url);
  if (check !== true) throw new CliError(check, check === ENV_NAME_HINT ? 2 : 6);
}

/**
 * Only one environment per host[:port] (the keychain key), whatever the scheme. `name` may be
 * that environment itself only when the scheme matches too.
 */
export function assertOriginFree(config: Config, name: string, url: string): void {
  const other = findEnvironmentByOrigin(config, url);
  if (!other) return;
  const host = originKey(url);
  const scheme = urlScheme(other.env.url);
  if (scheme !== urlScheme(url)) throw new CliError(`Environment ${other.name} already uses ${host} over ${scheme}`, 6);
  if (other.name === name) return;
  throw new CliError(`Environment ${other.name} already uses ${host} — run \`elitea-cli login --env ${other.name}\``, 6);
}

/** Plain http to anything but this machine needs a yes in a terminal, or --allow-http. */
export async function confirmInsecureUrl(url: string, allowHttp: boolean | undefined): Promise<void> {
  if (urlScheme(url) !== "http" || isLocalUrl(url) || allowHttp) return;
  console.error(`Warning: ${url} is not HTTPS; your token will be sent unencrypted`);
  if (!isInteractive()) throw new CliError("Refusing a non-HTTPS server outside a terminal — pass --allow-http", 2);
  if (!(await confirm({ message: "Continue?", default: false }))) throw new CliError("Cancelled");
}
