import { search } from "@inquirer/prompts";
import { updateEnvironment } from "../config.js";
import { CliError } from "../errors.js";
import { type EliteaClient, type EliteaProject, type EliteaUser, PUBLIC_PROJECT_ID, projectLabel, projectName } from "../elitea.js";
import { isInteractive, requireSession } from "../session.js";

/** Personal project first, then alphabetical; the shared public project is hidden. */
export function sortProjects(projects: EliteaProject[], user: EliteaUser): EliteaProject[] {
  return projects
    .filter((p) => p.id !== PUBLIC_PROJECT_ID)
    .sort((a, b) => {
      if (a.id === user.personal_project_id) return -1;
      if (b.id === user.personal_project_id) return 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Resolve the project to use: an explicit id must be one of the user's projects
 * (EliteA silently falls back to another project for unknown ids), otherwise ask,
 * otherwise use the personal project.
 */
export async function chooseProject(
  client: EliteaClient,
  user: EliteaUser,
  opts: { requested?: string; current?: number },
): Promise<EliteaProject> {
  const projects = sortProjects(await client.listProjects(user.personal_project_id), user);
  const personal = projects.find((p) => p.id === user.personal_project_id) ?? {
    id: user.personal_project_id,
    name: "Personal",
  };

  if (opts.requested !== undefined) {
    const q = opts.requested.trim();
    const match = projects.find((p) => String(p.id) === q) ?? projects.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (!match) throw new Error(`Project "${q}" not found among your ${projects.length} projects — run \`elitea-cli projects\``);
    return match;
  }
  if (!isInteractive() || projects.length <= 1) return personal;

  const defaultId = opts.current ?? personal.id;
  return search<EliteaProject>({
    message: "Project (usage is billed here; team projects may have extra models)",
    pageSize: 12,
    source: (term) => {
      const t = (term ?? "").toLowerCase();
      const list = t ? projects.filter((p) => p.name.toLowerCase().includes(t) || String(p.id) === t) : projects;
      // Show the current/default project on top when not filtering.
      const ordered = t ? list : [...list.filter((p) => p.id === defaultId), ...list.filter((p) => p.id !== defaultId)];
      return ordered.map((p) => ({ name: projectLabel(p, user), value: p }));
    },
  });
}

export async function projectCommand(id: string | undefined): Promise<void> {
  const session = await requireSession();
  const user = await session.client.getUser();
  const project = await chooseProject(session.client, user, { requested: id, current: session.projectId });
  if (session.temporary) {
    throw new CliError(`${session.url} is not a saved environment — set ELITEA_CLI_PROJECT=${project.id}, or run \`elitea-cli login --url ${session.url}\``, 2);
  }
  await updateEnvironment(session.name, (env) => ({ ...env, project: { id: project.id, name: projectName(project, user) } }));
  console.log(`Project set to ${projectLabel(project, user)}`);
}

export async function projectsCommand(opts: { json?: boolean }): Promise<void> {
  const session = await requireSession();
  const user = await session.client.getUser();
  const projects = sortProjects(await session.client.listProjects(user.personal_project_id), user);
  if (opts.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  for (const p of projects) {
    const marker = p.id === session.projectId ? "*" : " ";
    console.log(`${marker} ${String(p.id).padStart(6)}  ${projectName(p, user)}`);
  }
}
