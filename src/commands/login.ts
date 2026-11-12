import { input, password, select } from "@inquirer/prompts";
import open from "open";
import { join } from "node:path";
import { type Config, type Environment, eliteaCliHome, findEnvironmentByOrigin, loadConfig, saveConfig } from "../config.js";
import { tokenStore } from "../credentials.js";
import { AuthError, EliteaClient, projectLabel, projectName } from "../elitea.js";
import { assertEnvName, assertOriginFree, checkEnvName, confirmInsecureUrl, parseUrlArg } from "../environments.js";
import { CliError } from "../errors.js";
import { envUrl, isInteractive, requestedEnvName, selectEnvironment, unknownEnvironment } from "../session.js";
import { URL_HINT, defaultEnvName, tryNormalizeUrl } from "../urls.js";
import { chooseProject } from "./project.js";

export interface LoginOptions {
  url?: string;
  tokenStdin?: boolean;
  project?: string;
  browser?: boolean;
  allowHttp?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function tokenPageUrl(url: string): string {
  return `${url}/app/settings/create-personal-token`;
}

async function promptForToken(url: string, openBrowser: boolean): Promise<string> {
  const page = tokenPageUrl(url);
  console.log(
    [
      "",
      "elitea-cli uses an EliteA personal access token.",
      `  1. Open ${page}`,
      "     (or Settings → Tokens in EliteA) and create a token.",
      "  2. Copy it and paste it below.",
      "",
    ].join("\n"),
  );
  if (openBrowser) {
    try {
      await open(page);
    } catch {
      // No browser available; the URL is printed above.
    }
  }
  return password({
    message: "Personal access token",
    mask: "*",
    validate: (v) => (v.trim().length > 20 ? true : "That doesn't look like a token"),
  });
}

/** The environment a login is for: a saved one (re-login) or a new one, saved only on success. */
interface LoginTarget {
  name: string;
  url: string;
  existing?: Environment;
}

const ADD_NEW = Symbol("add");

/** For a URL: re-use the saved environment of that server, else name a new one. */
async function targetForUrl(config: Config, url: string, ask: boolean): Promise<LoginTarget> {
  const saved = findEnvironmentByOrigin(config, url);
  if (saved) {
    assertOriginFree(config, saved.name, url); // same host over the other scheme → refused
    console.log(`Using environment ${saved.name} (${saved.env.url})`);
    return { name: saved.name, url: saved.env.url, existing: saved.env };
  }
  const suggested = defaultEnvName(url);
  const name = ask
    ? (await input({ message: "Environment name", default: suggested, validate: (v) => checkEnvName(config, v.trim(), url) })).trim()
    : suggested;
  assertEnvName(config, name, url);
  return { name, url };
}

async function promptForUrl(): Promise<string> {
  const raw = await input({ message: "EliteA server URL", validate: (v) => (tryNormalizeUrl(v) ? true : URL_HINT) });
  return parseUrlArg(raw);
}

async function resolveTarget(config: Config, opts: LoginOptions, interactive: boolean): Promise<LoginTarget> {
  const name = requestedEnvName();
  if (name !== undefined) {
    const existing = config.environments[name];
    if (existing) {
      if (opts.url !== undefined && parseUrlArg(opts.url) !== existing.url) {
        throw new CliError(`Environment ${name} already points to ${existing.url}`, 6);
      }
      return { name, url: existing.url, existing };
    }
    // --env <new> --url <url> creates it; --env alone must name a saved environment.
    if (opts.url === undefined) throw unknownEnvironment(name);
    const url = parseUrlArg(opts.url);
    assertEnvName(config, name, url);
    assertOriginFree(config, name, url);
    return { name, url };
  }

  const url = opts.url !== undefined ? parseUrlArg(opts.url) : envUrl();
  if (url) return targetForUrl(config, url, interactive);

  if (!interactive) throw new CliError("No server: pass --url <url> or --env <name>", 2);
  const names = Object.keys(config.environments);
  if (names.length > 0) {
    const ordered = config.active ? [config.active, ...names.filter((n) => n !== config.active)] : names;
    const choice = await select<string | typeof ADD_NEW>({
      message: "Environment",
      choices: [
        ...ordered.map((n) => ({ name: `${n}  ${config.environments[n]!.url}`, value: n })),
        { name: "Add a new environment…", value: ADD_NEW },
      ],
    });
    if (choice !== ADD_NEW) return { name: choice, url: config.environments[choice]!.url, existing: config.environments[choice] };
  }
  return targetForUrl(config, await promptForUrl(), true);
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const config = await loadConfig();
  // A token piped in or set in the environment means a script: never prompt for the server.
  const interactive = isInteractive() && !opts.tokenStdin && !process.env.ELITEA_CLI_TOKEN;
  const target = await resolveTarget(config, opts, interactive);
  const { url } = target;
  await confirmInsecureUrl(url, opts.allowHttp);

  let token: string;
  if (opts.tokenStdin) token = await readStdin();
  else if (process.env.ELITEA_CLI_TOKEN) token = process.env.ELITEA_CLI_TOKEN;
  else if (isInteractive()) token = (await promptForToken(url, opts.browser !== false)).trim();
  else throw new CliError("No token: pass --token-stdin or set ELITEA_CLI_TOKEN when not running in a terminal", 2);
  if (!token) throw new CliError("Empty token", 2);

  const client = new EliteaClient(url, token);
  let user;
  try {
    user = await client.getUser();
  } catch (err) {
    if (err instanceof AuthError) throw new AuthError(`EliteA at ${url} rejected this token — check it and try again`);
    throw err;
  }
  console.log(`Logged in to ${url} as ${user.name} <${user.email}>`);
  console.log(`Environment: ${target.name}`);

  const previous = target.existing;
  const sameAccount = previous?.user?.id === user.id;
  const project = await chooseProject(client, user, {
    requested: opts.project,
    current: sameAccount ? previous?.project?.id : undefined,
  });

  const where = await tokenStore.set(url, token);
  // Re-read: the project prompt may have taken a while.
  const latest = await loadConfig();
  latest.environments[target.name] = {
    url,
    user: { id: user.id, name: user.name, email: user.email },
    project: { id: project.id, name: projectName(project, user) },
    // Model choices are per project catalog; keep them only for the same account + project.
    integrations: sameAccount && previous?.project?.id === project.id ? previous.integrations : {},
  };
  latest.active = target.name;
  await saveConfig(latest);

  console.log(`Project: ${projectLabel(project, user)}`);
  console.log(`Token saved to ${where === "keychain" ? "the OS keychain" : join(eliteaCliHome(), "credentials.json")}`);
  console.log("\nNext: `elitea-cli launch claude`");
}

export async function logoutCommand(opts: { all?: boolean }): Promise<void> {
  const config = await loadConfig();
  if (opts.all) {
    const envs = Object.values(config.environments);
    for (const env of envs) await tokenStore.delete(env.url);
    console.log(`Logged out of ${envs.length} environments`);
    return;
  }
  // The environment entry (server, user, project, models) stays; only the token goes.
  const selected = await selectEnvironment(config);
  await tokenStore.delete(selected.env.url);
  console.log(selected.temporary ? `Logged out of ${selected.env.url}` : `Logged out of ${selected.name} (${selected.env.url})`);
}
