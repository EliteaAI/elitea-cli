import { search } from "@inquirer/prompts";
import type { AgentVersionSummary, EliteaAgent, EliteaAgentDetails, EliteaClient } from "./elitea.js";
import { needsTerminal, notFoundError } from "./errors.js";
import { isInteractive } from "./session.js";

/** Which command family names the item: `agents …` accepts any application, `pipelines …` only pipelines. */
export type ItemKind = "agent" | "pipeline";

export const isPipeline = (a: Pick<EliteaAgent, "agent_type">) => a.agent_type === "pipeline";

/** Match by id, then exact name, then case-insensitive name; a unique substring match also counts. */
export function findAgent(agents: EliteaAgent[], query: string): EliteaAgent | undefined {
  const q = query.trim().toLowerCase();
  const exact =
    agents.find((a) => String(a.id) === query.trim()) ??
    agents.find((a) => a.name === query) ??
    agents.find((a) => a.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = agents.filter((a) => a.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

export async function pickAgent(agents: EliteaAgent[]): Promise<EliteaAgent> {
  return search<EliteaAgent>({
    message: "Agent",
    pageSize: 12,
    source: (term) => {
      const t = (term ?? "").toLowerCase();
      return agents
        .filter((a) => !t || a.name.toLowerCase().includes(t) || String(a.id) === t)
        .map((a) => ({ name: `${a.name}  (${a.id})`, value: a, description: a.description ?? undefined }));
    },
  });
}

const listHint = (kind: ItemKind) => (kind === "pipeline" ? "elitea-cli pipelines list" : "elitea-cli agents");
const label = (kind: ItemKind) => (kind === "pipeline" ? "Pipeline" : "Agent");

/**
 * Find one item in `agents` (all applications of the project). Unknown or ambiguous names exit 5;
 * `pipelines …` given a classic agent exits 5 too.
 */
export function resolveIn(agents: EliteaAgent[], query: string, kind: ItemKind): EliteaAgent {
  const agent = findAgent(agents, query);
  if (!agent) {
    const close = agents.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));
    const hint = close.length > 1 ? `matches several: ${close.map((a) => `${a.name} (${a.id})`).join(", ")}` : "not found";
    throw notFoundError(`${label(kind)} "${query}" ${hint} — run \`${listHint(kind)}\``);
  }
  if (kind === "pipeline" && !isPipeline(agent)) {
    throw notFoundError(`"${agent.name}" is an agent, not a pipeline — use \`elitea-cli agents get ${agent.id}\``);
  }
  return agent;
}

/** Resolve a name or id against the project; picks interactively when `query` is omitted and a terminal is attached. */
export async function resolveAgent(
  client: EliteaClient,
  projectId: number,
  query: string | undefined,
  kind: ItemKind,
  usage: string,
): Promise<{ agent: EliteaAgent; agents: EliteaAgent[] }> {
  const agents = await client.listAgents(projectId, { type: "all" });
  if (agents.length === 0) throw notFoundError(`No agents in project ${projectId}`);
  if (query === undefined) {
    if (!isInteractive()) throw needsTerminal(`The ${kind} picker`, `name the ${kind}: ${usage}`);
    return { agent: await pickAgent(kind === "pipeline" ? agents.filter(isPipeline) : agents), agents };
  }
  return { agent: resolveIn(agents, query, kind), agents };
}

/** A version by name or id; the default version when `version` is omitted. */
export function resolveVersion(details: EliteaAgentDetails, version?: string): AgentVersionSummary {
  if (version === undefined) {
    const id = details.version_details?.id;
    const match = details.versions.find((v) => v.id === id) ?? details.versions[0];
    if (!match) throw notFoundError(`Agent "${details.name}" has no versions`);
    return match;
  }
  const match = details.versions.find((v) => v.name === version) ?? details.versions.find((v) => String(v.id) === version);
  if (!match) {
    throw notFoundError(`Agent "${details.name}" has no version "${version}". Versions: ${details.versions.map((v) => v.name).join(", ")}`);
  }
  return match;
}
