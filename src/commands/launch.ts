import { fileURLToPath } from "node:url";
import { select } from "@inquirer/prompts";
import { saveConfig } from "../config.js";
import type { EliteaModel, ModelCatalog } from "../elitea.js";
import { claude } from "../integrations/claude.js";
import { writeClaudeTools } from "../integrations/claudePlugin.js";
import { findIntegration, integrations } from "../integrations/registry.js";
import type { Integration } from "../integrations/types.js";
import { defaultFastModel, defaultModelFor, findModel } from "../models.js";
import { findExecutable, mergeEnv, runForeground } from "../process.js";
import { isInteractive, requireSession } from "../session.js";

export interface LaunchOptions {
  model?: string;
  fastModel?: string;
  pick?: boolean;
  print?: boolean;
}

function requireModel(catalog: ModelCatalog, query: string): EliteaModel {
  const model = findModel(catalog, query);
  if (!model) {
    throw new Error(`Model "${query}" is not available in this project. Available: ${catalog.items.map((m) => m.name).join(", ")}`);
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

/** --model > saved choice (if still offered) > interactive pick on first use > sensible default. */
async function resolveModels(integration: Integration, catalog: ModelCatalog, saved: { model?: string; fastModel?: string }, opts: LaunchOptions) {
  if (catalog.items.length === 0) throw new Error("This project has no models configured in EliteA");

  const savedModel = saved.model ? findModel(catalog, saved.model) : undefined;
  let model: EliteaModel;
  let changed = false;
  if (opts.model) {
    model = requireModel(catalog, opts.model);
    changed = true;
  } else if (savedModel && !opts.pick) {
    model = savedModel;
  } else if (isInteractive()) {
    model = await pickModel(`Model for ${integration.displayName}`, catalog, savedModel ?? defaultModelFor(catalog, integration.family));
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
    } else if (isInteractive() && (opts.pick || changed)) {
      fastModel = await pickModel("Fast model (background tasks, haiku slot)", catalog, savedFast ?? defaultFastModel(catalog, model));
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

export async function launchCommand(name: string | undefined, extraArgs: string[], opts: LaunchOptions): Promise<number> {
  if (!name) {
    console.log("Usage: elitea-cli launch <integration> [options] [-- agent args]\n\nIntegrations:");
    for (const i of integrations) console.log(`  ${i.name.padEnd(10)} ${i.displayName}`);
    return 1;
  }
  const integration = findIntegration(name);
  if (!integration) {
    throw new Error(`Unknown integration "${name}". Available: ${integrations.map((i) => i.name).join(", ")}`);
  }

  const bin = findExecutable(integration.binary.name, integration.binary.fallbacks);
  if (!bin) {
    throw new Error(`${integration.displayName} is not installed. Install it with:\n  ${integration.installHint}`);
  }

  const session = await requireSession();
  const catalog = await session.client.getModels(session.projectId);
  const saved = session.config.integrations[integration.name] ?? {};
  const { model, fastModel, changed } = await resolveModels(integration, catalog, saved, opts);
  if (changed) {
    await saveConfig({
      ...session.config,
      integrations: {
        ...session.config.integrations,
        [integration.name]: { model: model.name, ...(integration.usesFastModel ? { fastModel: fastModel.name } : {}) },
      },
    });
  }

  const project = session.config.project;
  const spec = await integration.prepare({
    bin,
    url: session.url,
    token: session.token,
    projectId: session.projectId,
    catalog,
    model,
    fastModel,
    extraArgs,
    userName: session.config.user?.name,
    projectName: project?.id === session.projectId ? project.name : undefined,
    tools: integration.name === claude.name ? await writeClaudeTools({ cliPath: fileURLToPath(import.meta.url) }) : undefined,
  });

  if (opts.print) {
    for (const [k, v] of Object.entries(spec.env)) {
      if (v === undefined) console.log(`unset ${k}`);
      else console.log(`export ${k}=${shellQuote(v === session.token ? redact(v) : v)}`);
    }
    console.log([bin, ...spec.args].map(shellQuote).join(" "));
    return 0;
  }

  const fast = integration.usesFastModel && fastModel.name !== model.name ? `, fast: ${fastModel.display_name}` : "";
  console.error(`Launching ${integration.displayName} with ${model.display_name}${fast} (project ${session.projectId})`);
  return runForeground(bin, spec.args, mergeEnv(process.env, spec.env));
}
