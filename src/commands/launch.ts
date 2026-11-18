import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { select } from "@inquirer/prompts";
import { updateEnvironment } from "../config.js";
import { AuthError, type EliteaClient, type EliteaModel, type ModelCatalog } from "../elitea.js";
import { CliError, EXIT, notFoundError } from "../errors.js";
import { claude } from "../integrations/claude.js";
import { writeClaudeTools } from "../integrations/claudePlugin.js";
import { findIntegration, integrations } from "../integrations/registry.js";
import type { Integration } from "../integrations/types.js";
import { defaultFastModel, defaultModelFor, findModel, isAnthropicModel, isOpenAIModel } from "../models.js";
import { findExecutable, mergeEnv, runForeground } from "../process.js";
import { NoActiveEnvironmentError, NotLoggedInError, type Session, isInteractive, requireSession } from "../session.js";
import { chooseProject } from "./project.js";
import { loginCommand } from "./login.js";

const execFileAsync = promisify(execFile);

export interface LaunchOptions {
  model?: string;
  fastModel?: string;
  pick?: boolean;
  print?: boolean;
  check?: boolean;
  project?: string;
}

/** AC-7: the one message for "no login" when nothing can be asked. */
export const NOT_LOGGED_IN = "Not logged in — run `elitea-cli login` or set ELITEA_CLI_URL and ELITEA_CLI_TOKEN";

function requireModel(catalog: ModelCatalog, query: string): EliteaModel {
  const model = findModel(catalog, query);
  if (!model) {
    throw notFoundError(`Model "${query}" is not available in this project. Available: ${catalog.items.map((m) => m.name).join(", ")}`);
  }
  return model;
}

async function pickModel(message: string, catalog: ModelCatalog, preselect: EliteaModel | undefined): Promise<EliteaModel> {
  return select<EliteaModel>({
    message,
    default: preselect,
    pageSize: 15,
    choices: catalog.items.map((m) => ({ name: `${m.display_name}  (${m.name})`, value: m })),
  });
}

/**
 * The models the agent is offered, its own family first. Every model of the project works through
 * /llm for both agents (LiteLLM translates the formats; Claude models answered Codex's responses
 * calls with tools on dev.elitea.ai, story #7561 open question 1), so nothing is left out.
 */
export function agentCatalog(catalog: ModelCatalog, integration: Pick<Integration, "family">): ModelCatalog {
  const native = (m: EliteaModel) => (integration.family === "anthropic" ? isAnthropicModel(m) : isOpenAIModel(m));
  return { ...catalog, items: [...catalog.items.filter(native), ...catalog.items.filter((m) => !native(m))] };
}

/** AC-9: what each pick is for, said once in the question. */
export function slotQuestion(integration: Pick<Integration, "displayName" | "usesFastModel">, slot: "main" | "fast"): string {
  if (slot === "fast") return "Fast model: background tasks and quick steps (Claude Code's haiku slot)";
  return integration.usesFastModel
    ? `Main model for ${integration.displayName}: your conversation, the opus and sonnet slots and subagents`
    : `Model for ${integration.displayName}: every request of the session`;
}

/** --model > saved choice (if still offered) > interactive pick on first use > sensible default. */
export async function resolveModels(
  integration: Integration,
  catalog: ModelCatalog,
  saved: { model?: string; fastModel?: string },
  opts: LaunchOptions,
) {
  const savedModel = saved.model ? findModel(catalog, saved.model) : undefined;
  let model: EliteaModel;
  let changed = false;
  if (opts.model) {
    model = requireModel(catalog, opts.model);
    changed = true;
  } else if (savedModel && !opts.pick) {
    model = savedModel;
  } else if (isInteractive() && !opts.check) {
    model = await pickModel(slotQuestion(integration, "main"), catalog, savedModel ?? defaultModelFor(catalog, integration.family));
    changed = true;
  } else {
    model = defaultModelFor(catalog, integration.family)!;
  }

  let fastModel = model;
  if (integration.usesFastModel) {
    const savedFast = saved.fastModel ? findModel(catalog, saved.fastModel) : undefined;
    if (opts.fastModel) {
      fastModel = requireModel(catalog, opts.fastModel);
      changed = true;
    } else if (savedFast && !opts.pick) {
      fastModel = savedFast;
    } else if (isInteractive() && !opts.check && (opts.pick || changed)) {
      fastModel = await pickModel(slotQuestion(integration, "fast"), catalog, savedFast ?? defaultFastModel(catalog, model));
      changed = true;
    } else {
      fastModel = defaultFastModel(catalog, model);
    }
  }
  return { model, fastModel, changed };
}

function redact(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "***";
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** "1.2.3" ≥ "1.2.0"; anything unreadable passes (an unknown build should not block a launch). */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return true;
    if (x !== y) return x > y;
  }
  return true;
}

/** AC-14: the installed agent is at least the tested version. Unreadable output is not an error. */
async function checkAgentVersion(integration: Integration, bin: string): Promise<string | undefined> {
  let out: string;
  try {
    out = (await execFileAsync(bin, ["--version"], { timeout: 15_000 })).stdout;
  } catch {
    return undefined;
  }
  const version = integration.versionPattern.exec(out)?.[1];
  if (version && !versionAtLeast(version, integration.minVersion)) {
    throw new CliError(
      `${integration.displayName} ${version} is older than the oldest tested version ${integration.minVersion}. Update it:\n  ${integration.installHint}`,
      EXIT.general,
    );
  }
  return version;
}

/**
 * The session to launch with (AC-6, AC-7): not logged in → the login flow in a terminal, then the
 * launch goes on; without a terminal → exit 3, no prompt.
 */
async function launchSession(opts: LaunchOptions): Promise<Session> {
  try {
    return await requireSession();
  } catch (err) {
    if (!(err instanceof NotLoggedInError || err instanceof NoActiveEnvironmentError)) throw err;
    if (!isInteractive() || opts.check || opts.print) throw new CliError(NOT_LOGGED_IN, EXIT.auth);
    console.error(`${err.message.split(" — ")[0]}.`);
    await loginCommand({ project: opts.project, next: false });
    return requireSession();
  }
}

/** AC-10: the token still works (the catalog call) and the project has models; else nothing starts. */
async function readCatalog(session: Session): Promise<ModelCatalog> {
  try {
    return await session.client.getModels(session.projectId);
  } catch (err) {
    if (err instanceof AuthError) {
      throw new CliError(`Your ELITEA token for ${session.temporary ? session.url : session.name} has expired — run \`elitea-cli login\``, EXIT.auth);
    }
    throw err;
  }
}

/** AC-12: one tiny request in the agent's own format; prints `OK <model> <ms>` or the error. */
async function probe(client: EliteaClient, integration: Integration, projectId: number, model: EliteaModel): Promise<number> {
  const started = Date.now();
  let res: Response;
  try {
    res = await client.send("POST", integration.probe.path, {
      body: integration.probe.body(model.name),
      headers: { "X-Project-Id": String(projectId), ...integration.probe.headers },
    });
  } catch (err) {
    console.error(`FAIL ${model.name}: ${(err as Error).message}`);
    return EXIT.general;
  }
  const ms = Date.now() - started;
  if (res.ok) {
    console.log(`OK ${model.name} ${ms} ms`);
    return EXIT.ok;
  }
  const text = await res.text().catch(() => "");
  let said = text.trim().slice(0, 300);
  try {
    const body = JSON.parse(text) as { error?: { message?: string; type?: string } | string };
    const e = body.error;
    said = typeof e === "string" ? e : [e?.message, e?.type && `(${e.type})`].filter(Boolean).join(" ") || said;
  } catch {
    // not JSON: keep the text
  }
  console.error(`FAIL ${model.name}: ${integration.probe.path} answered HTTP ${res.status}${said ? ` — ${said}` : ""}`);
  return EXIT.general;
}

export async function launchCommand(name: string | undefined, extraArgs: string[], opts: LaunchOptions): Promise<number> {
  if (!name) {
    console.log("Usage: elitea-cli launch <integration> [options] [-- agent args]\n\nIntegrations:");
    for (const i of integrations) console.log(`  ${i.name.padEnd(10)} ${i.displayName}`);
    return EXIT.usage;
  }
  const integration = findIntegration(name);
  if (!integration) {
    throw new CliError(`Unknown integration "${name}". Available: ${integrations.map((i) => i.name).join(", ")}`, EXIT.usage);
  }

  const bin = findExecutable(integration.binary.name, integration.binary.fallbacks);
  if (!bin) {
    throw new CliError(`${integration.displayName} is not installed. Install it with:\n  ${integration.installHint}`, EXIT.general);
  }
  await checkAgentVersion(integration, bin);

  const session = await launchSession(opts);
  // -p: another project for this launch only; the active one and its model choices stay (AC-15).
  let projectId = session.projectId;
  let projectName = session.env.project?.id === projectId ? session.env.project?.name : undefined;
  if (opts.project !== undefined) {
    const project = await chooseProject(session.client, await session.client.getUser(), { requested: opts.project });
    projectId = project.id;
    projectName = project.name;
  }
  const catalog = agentCatalog(await readCatalog({ ...session, projectId }), integration);
  if (catalog.items.length === 0) {
    throw new CliError(`No models in project ${projectId} work with ${integration.displayName}. Ask your project admin to add a model.`, EXIT.general);
  }

  const sameProject = projectId === session.projectId;
  const saved = sameProject ? (session.env.integrations[integration.name] ?? {}) : {};
  const { model, fastModel, changed } = await resolveModels(integration, catalog, saved, opts);
  // --print and --check only show; another project's picks are not this project's (AC-15, AC-16).
  if (changed && !session.temporary && sameProject && !opts.print && !opts.check) {
    await updateEnvironment(session.name, (env) => ({
      ...env,
      integrations: {
        ...env.integrations,
        [integration.name]: { model: model.name, ...(integration.usesFastModel ? { fastModel: fastModel.name } : {}) },
      },
    }));
  }

  if (opts.check) {
    const models = integration.usesFastModel && fastModel.name !== model.name ? [model, fastModel] : [model];
    let code: number = EXIT.ok;
    for (const m of models) code = Math.max(code, await probe(session.client, integration, projectId, m));
    return code;
  }

  const spec = await integration.prepare({
    bin,
    url: session.url,
    token: session.token,
    projectId,
    catalog,
    model,
    fastModel,
    extraArgs,
    environment: session.temporary ? undefined : session.name,
    userName: session.env.user?.name,
    projectName,
    tools: integration.name === claude.name ? await writeClaudeTools({ cliPath: fileURLToPath(import.meta.url) }) : undefined,
  });

  if (opts.print) {
    console.log(`# environment: ${session.temporary ? `${session.url} (ELITEA_CLI_URL, not saved)` : session.name}, project ${projectId}`);
    for (const [k, v] of Object.entries(spec.env)) {
      if (v === undefined) console.log(`unset ${k}`);
      else console.log(`export ${k}=${shellQuote(v === session.token ? redact(v) : v)}`);
    }
    console.log([bin, ...spec.args].map(shellQuote).join(" "));
    return EXIT.ok;
  }

  const fast = integration.usesFastModel && fastModel.name !== model.name ? `, fast: ${fastModel.display_name}` : "";
  if (integration.launchNote) console.error(integration.launchNote);
  console.error(`Launching ${integration.displayName} with ${model.display_name}${fast} (environment ${session.name}, project ${projectId})`);
  return runForeground(bin, spec.args, mergeEnv(process.env, spec.env));
}
