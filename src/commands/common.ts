import type { EliteaClient } from "../elitea.js";
import { requireSession } from "../session.js";
import { chooseProject } from "./project.js";

/** The session client and the project to work in: `-p` for this command only, else the active one. */
export async function projectSession(project: string | undefined): Promise<{ client: EliteaClient; projectId: number; baseUrl: string }> {
  const { client, projectId: activeProjectId, url } = await requireSession();
  const projectId = project === undefined ? activeProjectId : (await chooseProject(client, await client.getUser(), { requested: project })).id;
  return { client, projectId, baseUrl: url };
}

/** Minimal stderr spinner; nothing is drawn when stderr is not a terminal. */
export async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return work;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label} ${seconds}s`);
  }, 100);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K");
  }
}

/** Collects a repeatable option (`--tag a --tag b`). */
export const collect = (value: string, previous: string[] = []) => [...previous, value];
