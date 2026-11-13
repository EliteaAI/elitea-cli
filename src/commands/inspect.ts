import type { AgentVersion, EliteaAgentDetails } from "../elitea.js";
import { usageError } from "../errors.js";
import { formatTable, parseFormat, printData } from "../output.js";
import { type ItemKind, resolveAgent, resolveVersion } from "../resolve.js";
import { projectSession } from "./common.js";

export interface GetOptions {
  agentVersion?: string;
  project?: string;
  output?: string;
  json?: boolean;
  yamlOnly?: boolean;
}

/** Lines of instructions shown in table mode; JSON/YAML carry them in full. */
export const INSTRUCTION_PREVIEW_LINES = 20;

const usage = (kind: ItemKind, verb: string) => `elitea-cli ${kind}s ${verb} <${kind}>`;

function listOrNone(items: string[]): string {
  return items.length ? items.join(", ") : "(none)";
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** Human-readable view of an agent and one of its versions. */
export function formatAgentDetails(
  agent: EliteaAgentDetails,
  version: AgentVersion,
  skills: Array<{ name: string }>,
): string[] {
  const pipeline = (version.agent_type ?? agent.agent_type) === "pipeline";
  const defaultVersion = agent.versions.find((v) => v.id === agent.version_details?.id);
  const tags = (version.tags ?? agent.tags ?? []).map((t) => t.name);
  const tools = (version.tools ?? []).map((t) => `${t.toolkit_name ?? t.name ?? "?"} (${t.type ?? "?"})`);
  const variables = (version.variables ?? []).map((v) => (v.value === undefined || v.value === "" ? v.name : `${v.name}=${String(v.value)}`));
  const starters = (version.conversation_starters ?? []).map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
  const instructions = version.instructions ?? "";

  const out = [
    `ID:              ${agent.id}`,
    `Name:            ${agent.name}`,
    `Description:     ${(agent.description ?? "").replace(/\s+/g, " ").trim() || "(none)"}`,
    `Type:            ${version.agent_type ?? agent.agent_type ?? ""}`,
    `Tags:            ${listOrNone(tags)}`,
    `Default version: ${defaultVersion ? `${defaultVersion.name} (${defaultVersion.id})` : "(none)"}`,
    "",
    `Version:         ${version.name} (${version.id})${version.status ? ` — ${version.status}` : ""}`,
    `Model:           ${version.llm_settings?.model_name || "(project default)"}`,
    `Toolkits:        ${listOrNone(tools)}`,
    `Skills:          ${listOrNone(skills.map((s) => s.name))}`,
    `Variables:       ${listOrNone(variables)}`,
    `Starters:        ${listOrNone(starters)}`,
    `Welcome message: ${version.welcome_message?.trim() || "(none)"}`,
    "",
  ];
  if (pipeline) {
    out.push("Pipeline YAML:", indent(instructions || "(empty)"));
  } else {
    const lines = instructions.split("\n");
    const shown = lines.slice(0, INSTRUCTION_PREVIEW_LINES).join("\n");
    out.push("Instructions:", indent(shown || "(empty)"));
    if (lines.length > INSTRUCTION_PREVIEW_LINES) {
      out.push(`  … ${lines.length - INSTRUCTION_PREVIEW_LINES} more lines (full text with -o yaml)`);
    }
  }
  return out;
}

async function loadAgent(kind: ItemKind, query: string, project: string | undefined) {
  const { client, projectId } = await projectSession(project);
  const { agent } = await resolveAgent(client, projectId, query, kind, usage(kind, "get"));
  const details = await client.getAgent(projectId, agent.id);
  return { client, projectId, agent, details };
}

/** `agents get` / `pipelines get`. */
export async function getCommand(kind: ItemKind, query: string, opts: GetOptions): Promise<void> {
  if (opts.yamlOnly && (opts.output !== undefined || opts.json)) throw usageError("--yaml-only cannot be combined with --output");
  const format = parseFormat(opts, !opts.yamlOnly);
  const { client, projectId, details } = await loadAgent(kind, query, opts.project);
  const summary = resolveVersion(details, opts.agentVersion);
  const [version, skills] = await Promise.all([
    client.getVersion(projectId, details.id, summary.id),
    format === "text" && !opts.yamlOnly ? client.getVersionSkills(projectId, summary.id).catch(() => []) : Promise.resolve([]),
  ]);

  if (opts.yamlOnly) {
    const yaml = version.instructions ?? "";
    process.stdout.write(yaml.endsWith("\n") || yaml === "" ? yaml : `${yaml}\n`);
    return;
  }
  if (format !== "text") {
    const defaultVersion = details.versions.find((v) => v.id === details.version_details?.id);
    printData(format, {
      ...version,
      cli: {
        default_version: defaultVersion ? { id: defaultVersion.id, name: defaultVersion.name } : null,
        agent: { id: details.id, name: details.name },
      },
    });
    return;
  }
  for (const line of formatAgentDetails(details, version, skills)) console.log(line);
}

/** Version table: `*` marks the default. CREATED, because EliteA keeps no update time for versions. */
export function formatVersions(details: EliteaAgentDetails, columns = 120): string[] {
  const defaultId = details.version_details?.id;
  const rows = details.versions.map((v) => [
    String(v.id),
    v.name,
    v.status ?? "",
    v.id === defaultId ? "*" : "",
    v.author_name || v.author_email || "",
    v.created_at ? v.created_at.replace("T", " ").slice(0, 16) : "",
  ]);
  return formatTable(["ID", "NAME", "STATUS", "DEFAULT", "AUTHOR", "CREATED"], rows, columns);
}

/** `agents versions` / `pipelines versions`. */
export async function versionsCommand(kind: ItemKind, query: string, opts: { project?: string; output?: string; json?: boolean }): Promise<void> {
  const format = parseFormat(opts, true);
  const { details } = await loadAgent(kind, query, opts.project);
  if (format !== "text") {
    const defaultId = details.version_details?.id;
    printData(
      format,
      details.versions.map((v) => ({ ...v, default: v.id === defaultId })),
    );
    return;
  }
  for (const line of formatVersions(details, process.stdout.columns)) console.log(line);
}
