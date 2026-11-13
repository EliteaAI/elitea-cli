import type { ApplicationType, EliteaAgent, EliteaClient, ListAgentsOptions } from "../elitea.js";
import { usageError } from "../errors.js";
import { parseFormat, printData } from "../output.js";
import type { ItemKind } from "../resolve.js";
import { projectSession } from "./common.js";

/** EliteA PublishStatus values a user can filter by (`embedded` is internal). */
export const STATUSES = ["draft", "published", "on_moderation", "rejected", "user_approval", "unpublished"] as const;

export interface AgentsOptions {
  json?: boolean;
  output?: string;
  search?: string;
  project?: string;
  type?: string;
  tag?: string[];
  status?: string[];
  mine?: boolean;
  limit?: string;
}

/** One table line per agent; the description is cut to fit the terminal. */
export function formatAgents(agents: EliteaAgent[], columns = 120): string[] {
  const idWidth = Math.max(...agents.map((a) => String(a.id).length), 2);
  const nameWidth = Math.max(...agents.map((a) => a.name.length), 4);
  const typeWidth = Math.max(...agents.map((a) => (a.agent_type ?? "").length), 4);
  const statusWidth = Math.max(...agents.map((a) => (a.status ?? "").length), 6);
  const prefix = (id: string, name: string, type: string, status: string) =>
    `${id.padStart(idWidth)}  ${name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${status.padEnd(statusWidth)}  `;
  const room = Math.max(columns - prefix("", "", "", "").length, 10);
  const fit = (s: string) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);

  return [
    `${prefix("ID", "NAME", "TYPE", "STATUS")}DESCRIPTION`,
    ...agents.map(
      (a) =>
        prefix(String(a.id), a.name, a.agent_type ?? "", a.status ?? "") +
        fit((a.description ?? "").replace(/\s+/g, " ").trim()),
    ),
  ];
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usageError(`--limit must be a positive whole number, got "${value}"`);
  return n;
}

export function parseStatuses(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const statuses = values.flatMap((v) => v.split(",")).map((v) => v.trim());
  const bad = statuses.find((s) => !(STATUSES as readonly string[]).includes(s));
  if (bad !== undefined) throw usageError(`--status must be one of ${STATUSES.join(", ")}, got "${bad}"`);
  return statuses;
}

function parseType(value: string | undefined): ApplicationType {
  if (value === undefined) return "all";
  if (value === "agent" || value === "pipeline") return value;
  throw usageError(`--type must be agent or pipeline, got "${value}"`);
}

/** Tag names → ids. An unknown tag can match nothing, so the result is undefined (list nothing). */
async function tagIds(client: EliteaClient, projectId: number, names: string[] | undefined): Promise<number[] | null | undefined> {
  if (!names?.length) return undefined;
  const tags = await client.listTags(projectId);
  const ids: number[] = [];
  for (const name of names) {
    const tag = tags.find((t) => t.name === name) ?? tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      console.error(`No tag "${name}" in project ${projectId}`);
      return null;
    }
    ids.push(tag.id);
  }
  return ids;
}

/** `agents [list]` (kind agent: all applications, --type narrows) and `pipelines list`. */
export async function listCommand(kind: ItemKind, opts: AgentsOptions): Promise<void> {
  // `agents [list]` predates settings.output and keeps its text default (AC-6a, AC-22).
  const format = parseFormat(opts, kind === "pipeline");
  const type = kind === "pipeline" ? "pipeline" : parseType(opts.type);
  const statuses = parseStatuses(opts.status);
  const maxTotal = parseLimit(opts.limit);
  const { client, projectId } = await projectSession(opts.project);

  const tags = await tagIds(client, projectId, opts.tag);
  const query: ListAgentsOptions = { query: opts.search, type, statuses, maxTotal, tagIds: tags ?? undefined };
  if (opts.mine) query.authorId = (await client.getUser()).id;
  const agents = tags === null ? [] : await client.listAgents(projectId, query);

  if (format !== "text") {
    printData(format, agents);
    return;
  }
  if (agents.length === 0) {
    if (kind === "pipeline") console.error("No pipelines found");
    else console.log(opts.search ? `No agents matching "${opts.search}" in project ${projectId}` : `No agents in project ${projectId}`);
    return;
  }
  for (const line of formatAgents(agents, process.stdout.columns)) console.log(line);
}

/** Kept for callers of the 0.1 API. */
export const agentsCommand = (opts: AgentsOptions) => listCommand("agent", opts);
