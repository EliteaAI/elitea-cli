import { type Config, effectiveProjectId, effectiveUrl, loadConfig } from "./config.js";
import { tokenStore } from "./credentials.js";
import { EliteaClient } from "./elitea.js";

export interface Session {
  config: Config;
  url: string;
  token: string;
  projectId: number;
  client: EliteaClient;
}

export class NotLoggedInError extends Error {
  constructor(message = "Not logged in — run `elitea-cli login` first") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

export async function requireSession(): Promise<Session> {
  const config = await loadConfig();
  const url = effectiveUrl(config);
  const token = await tokenStore.get(url);
  if (!token) throw new NotLoggedInError();
  const projectId = effectiveProjectId(config);
  if (projectId === undefined) throw new NotLoggedInError("No project selected — run `elitea-cli login` or `elitea-cli project`");
  return { config, url, token, projectId, client: new EliteaClient(url, token) };
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}
