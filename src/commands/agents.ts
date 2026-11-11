import type { EliteaAgent } from "../elitea.js";
import { requireSession } from "../session.js";
import { chooseProject } from "./project.js";

export interface AgentsOptions {
  json?: boolean;
  search?: string;
  project?: string;
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

export async function agentsCommand(opts: AgentsOptions): Promise<void> {
  const { client, projectId: activeProjectId } = await requireSession();
  const projectId =
    opts.project === undefined ? activeProjectId : (await chooseProject(client, await client.getUser(), { requested: opts.project })).id;
  const agents = await client.listAgents(projectId, { query: opts.search });
  if (opts.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log(opts.search ? `No agents matching "${opts.search}" in project ${projectId}` : `No agents in project ${projectId}`);
    return;
  }
  for (const line of formatAgents(agents, process.stdout.columns)) console.log(line);
}
