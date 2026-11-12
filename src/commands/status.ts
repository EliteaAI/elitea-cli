import { effectiveProjectId } from "../config.js";
import { tokenStore } from "../credentials.js";
import { AuthError, EliteaClient, type EliteaUser } from "../elitea.js";
import { NoActiveEnvironmentError, loginHint, selectEnvironment } from "../session.js";
import { type OutputOptions, wantsJson } from "./env.js";

interface StatusJson {
  environment: string | null;
  url: string | null;
  user: { id: number; name: string; email: string } | null;
  project: { id: number; name: string } | null;
  token: "stored" | "missing" | "env" | "rejected" | null;
}

/** Exit 1 in every not-logged-in state: no environment, no token, token rejected. */
export async function statusCommand(opts: OutputOptions = {}): Promise<number> {
  const json = wantsJson(opts);
  const out: string[] = [];
  const result: StatusJson = { environment: null, url: null, user: null, project: null, token: null };
  const finish = (code: number) => {
    if (json) console.log(JSON.stringify(result, null, 2));
    else for (const line of out) console.log(line);
    return code;
  };

  let selected;
  try {
    selected = await selectEnvironment();
  } catch (err) {
    if (!(err instanceof NoActiveEnvironmentError)) throw err;
    out.push("No active environment — run `elitea-cli login`");
    return finish(1);
  }
  const { env } = selected;
  result.environment = selected.name;
  result.url = env.url;
  out.push(`Environment: ${selected.temporary ? `${selected.name} [ELITEA_CLI_URL, not saved]` : selected.name}`);
  out.push(`Server:  ${env.url}`);

  const token = await tokenStore.get(env.url);
  if (!token) {
    result.token = "missing";
    out.push(`Status:  not logged in — run \`${loginHint(selected)}\``);
    return finish(1);
  }
  result.token = process.env.ELITEA_CLI_TOKEN ? "env" : "stored";
  let user: EliteaUser;
  try {
    user = await new EliteaClient(env.url, token).getUser();
    out.push(`User:    ${user.name} <${user.email}>`);
    result.user = { id: user.id, name: user.name, email: user.email };
  } catch (err) {
    if (err instanceof AuthError) {
      result.token = "rejected";
      out.push(`Status:  token rejected (expired or revoked) — run \`${loginHint(selected)}\``);
      return finish(1);
    }
    throw err;
  }
  const projectId = effectiveProjectId(env) ?? (selected.temporary ? user.personal_project_id : undefined);
  const name = env.project?.id === projectId ? env.project?.name : undefined;
  if (projectId !== undefined) result.project = { id: projectId, name: name ?? (projectId === user.personal_project_id ? "Personal" : "") };
  out.push(`Project: ${projectId ?? "none"}${name ? ` (${name})` : ""}${process.env.ELITEA_CLI_PROJECT ? " [ELITEA_CLI_PROJECT]" : ""}`);
  out.push(`Token:   ${process.env.ELITEA_CLI_TOKEN ? "from ELITEA_CLI_TOKEN" : "stored"}`);
  for (const [integration, prefs] of Object.entries(env.integrations)) {
    const models = [prefs.model, prefs.fastModel && `fast: ${prefs.fastModel}`].filter(Boolean).join(", ");
    if (models) out.push(`${(integration + ":").padEnd(9)}${models}`);
  }
  return finish(0);
}
