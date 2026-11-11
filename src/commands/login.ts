import { password } from "@inquirer/prompts";
import open from "open";
import { join } from "node:path";
import { DEFAULT_URL, eliteaCliHome, loadConfig, saveConfig } from "../config.js";
import { tokenStore } from "../credentials.js";
import { AuthError, EliteaClient, projectLabel, projectName } from "../elitea.js";
import { isInteractive } from "../session.js";
import { chooseProject } from "./project.js";

export interface LoginOptions {
  url?: string;
  tokenStdin?: boolean;
  project?: string;
  browser?: boolean;
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

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const config = await loadConfig();
  const url = (opts.url ?? process.env.ELITEA_CLI_URL ?? config.url ?? DEFAULT_URL).replace(/\/+$/, "");

  let token: string;
  if (opts.tokenStdin) token = await readStdin();
  else if (process.env.ELITEA_CLI_TOKEN) token = process.env.ELITEA_CLI_TOKEN;
  else if (isInteractive()) token = (await promptForToken(url, opts.browser !== false)).trim();
  else throw new Error("No token: pass --token-stdin or set ELITEA_CLI_TOKEN when not running in a terminal");
  if (!token) throw new Error("Empty token");

  const client = new EliteaClient(url, token);
  let user;
  try {
    user = await client.getUser();
  } catch (err) {
    if (err instanceof AuthError) throw new AuthError(`EliteA at ${url} rejected this token — check it and try again`);
    throw err;
  }
  console.log(`Logged in to ${url} as ${user.name} <${user.email}>`);

  const sameAccount = config.url === url && config.user?.id === user.id;
  const project = await chooseProject(client, user, {
    requested: opts.project,
    current: sameAccount ? config.project?.id : undefined,
  });

  const where = await tokenStore.set(url, token);
  await saveConfig({
    ...config,
    url,
    user: { id: user.id, name: user.name, email: user.email },
    project: { id: project.id, name: projectName(project, user) },
    // Model choices are per project catalog; keep them only for the same account + project.
    integrations: sameAccount && config.project?.id === project.id ? config.integrations : {},
  });

  console.log(`Project: ${projectLabel(project, user)}`);
  console.log(`Token saved to ${where === "keychain" ? "the OS keychain" : join(eliteaCliHome(), "credentials.json")}`);
  console.log("\nNext: `elitea-cli launch claude` or `elitea-cli launch codex`");
}

export async function logoutCommand(): Promise<void> {
  const config = await loadConfig();
  await tokenStore.delete(config.url);
  const { user: _user, ...rest } = config;
  await saveConfig(rest);
  console.log(`Logged out of ${config.url}`);
}
