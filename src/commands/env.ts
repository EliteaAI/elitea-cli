import { confirm } from "@inquirer/prompts";
import { loadConfig, saveConfig } from "../config.js";
import { tokenStore } from "../credentials.js";
import { assertEnvName, assertOriginFree, confirmInsecureUrl, parseUrlArg } from "../environments.js";
import { CliError } from "../errors.js";
import { isInteractive, selectEnvironment, unknownEnvironment } from "../session.js";

export interface OutputOptions {
  output?: string;
}

export function wantsJson(opts: OutputOptions): boolean {
  const format = (opts.output ?? "text").toLowerCase();
  if (format !== "text" && format !== "json") throw new CliError(`--output must be text or json, got "${opts.output}"`, 2);
  return format === "json";
}

export interface EnvRow {
  name: string;
  url: string;
  active: boolean;
  user_email: string | null;
  project_id: number | null;
  project_name: string | null;
  token: "stored" | "missing" | "env";
}

/** Saved environments with their token state; offline (no server calls). */
export async function listEnvironments(): Promise<EnvRow[]> {
  const config = await loadConfig();
  // The environment this command would use is the one ELITEA_CLI_TOKEN applies to.
  let current: string | undefined;
  if (process.env.ELITEA_CLI_TOKEN) {
    try {
      const selected = await selectEnvironment(config);
      if (!selected.temporary) current = selected.name;
    } catch {
      // nothing selected
    }
  }
  const rows: EnvRow[] = [];
  for (const [name, env] of Object.entries(config.environments)) {
    const stored = await tokenStore.getStored(env.url);
    rows.push({
      name,
      url: env.url,
      active: name === config.active,
      user_email: env.user?.email ?? null,
      project_id: env.project?.id ?? null,
      project_name: env.project?.name ?? null,
      token: name === current ? "env" : stored ? "stored" : "missing",
    });
  }
  return rows;
}

export async function envListCommand(opts: OutputOptions): Promise<void> {
  const json = wantsJson(opts);
  const rows = await listEnvironments();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.error("No environments — run `elitea-cli login`");
    return;
  }
  const cells = rows.map((r) => [
    r.active ? "*" : " ",
    r.name,
    r.url,
    r.user_email ?? "-",
    r.project_id === null ? "-" : `${r.project_name ?? ""} (${r.project_id})`.trim(),
    r.token === "env" ? "from ELITEA_CLI_TOKEN" : r.token,
  ]);
  const header = [" ", "NAME", "URL", "USER", "PROJECT", "TOKEN"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  for (const line of [header, ...cells]) {
    console.log(line.map((c, i) => (i === line.length - 1 ? c : c.padEnd(widths[i]!))).join("  "));
  }
}

export async function envAddCommand(name: string, opts: { url: string; allowHttp?: boolean }): Promise<void> {
  const url = parseUrlArg(opts.url);
  const config = await loadConfig();
  assertEnvName(config, name, url);
  assertOriginFree(config, name, url);
  await confirmInsecureUrl(url, opts.allowHttp);
  if (config.environments[name]) {
    console.log(`Environment ${name} (${url}) already exists`);
    return;
  }
  config.environments[name] = { url, integrations: {} };
  await saveConfig(config);
  console.log(`Added environment ${name} (${url}) — log in with \`elitea-cli login --env ${name}\``);
}

export async function envUseCommand(name: string): Promise<void> {
  const config = await loadConfig();
  const env = config.environments[name];
  if (!env) throw unknownEnvironment(name);
  config.active = name;
  await saveConfig(config);
  console.log(`Active environment: ${name} (${env.url})`);
}

export async function envRemoveCommand(name: string, opts: { yes?: boolean }): Promise<void> {
  const config = await loadConfig();
  const env = config.environments[name];
  if (!env) throw unknownEnvironment(name);
  if (!opts.yes) {
    if (!isInteractive()) throw new CliError(`Refusing to remove environment ${name} without confirmation — pass --yes`, 2);
    const ok = await confirm({
      message: `Remove environment '${name}' (${env.url})? Its stored token is deleted too.`,
      default: false,
    });
    if (!ok) return;
  }
  await tokenStore.delete(env.url);
  delete config.environments[name];
  if (config.active === name) config.active = undefined;
  await saveConfig(config);
  console.log(`Removed environment ${name} (${env.url})`);
}
