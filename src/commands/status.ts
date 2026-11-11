import { effectiveProjectId, effectiveUrl, loadConfig } from "../config.js";
import { tokenStore } from "../credentials.js";
import { AuthError, EliteaClient } from "../elitea.js";

export async function statusCommand(): Promise<number> {
  const config = await loadConfig();
  const url = effectiveUrl(config);
  const token = await tokenStore.get(url);
  console.log(`Server:  ${url}`);
  if (!token) {
    console.log("Status:  not logged in — run `elitea-cli login`");
    return 1;
  }
  try {
    const user = await new EliteaClient(url, token).getUser();
    console.log(`User:    ${user.name} <${user.email}>`);
  } catch (err) {
    if (err instanceof AuthError) {
      console.log("Status:  token rejected (expired or revoked) — run `elitea-cli login`");
      return 1;
    }
    throw err;
  }
  const projectId = effectiveProjectId(config);
  const name = config.project?.id === projectId ? config.project?.name : undefined;
  console.log(`Project: ${projectId ?? "none"}${name ? ` (${name})` : ""}${process.env.ELITEA_CLI_PROJECT ? " [ELITEA_CLI_PROJECT]" : ""}`);
  console.log(`Token:   ${process.env.ELITEA_CLI_TOKEN ? "from ELITEA_CLI_TOKEN" : "stored"}`);
  for (const [name, prefs] of Object.entries(config.integrations)) {
    const models = [prefs.model, prefs.fastModel && `fast: ${prefs.fastModel}`].filter(Boolean).join(", ");
    if (models) console.log(`${(name + ":").padEnd(9)}${models}`);
  }
  return 0;
}
