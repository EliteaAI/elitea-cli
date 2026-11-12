import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ModelCatalog } from "../elitea.js";
import { ELITEA_PERMISSIONS, sessionContext } from "./claudePlugin.js";
import type { Integration } from "./types.js";

/** Claude Code assumes this window for unknown models; only override when smaller. */
const CLAUDE_DEFAULT_CONTEXT = 200_000;

export const claude: Integration = {
  name: "claude",
  aliases: ["claude-code"],
  displayName: "Claude Code",
  family: "anthropic",
  usesFastModel: true,
  binary: {
    name: "claude",
    fallbacks: [join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude")],
  },
  installHint: "curl -fsSL https://claude.ai/install.sh | bash",

  async prepare(ctx) {
    const main = ctx.model.name;
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: `${ctx.url}/llm`,
      // EliteA only accepts Bearer auth; a real ANTHROPIC_API_KEY would be sent as x-api-key and win.
      ANTHROPIC_AUTH_TOKEN: ctx.token,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_CUSTOM_HEADERS: `X-Project-Id: ${ctx.projectId}`,
      ANTHROPIC_MODEL: main,
      ANTHROPIC_DEFAULT_OPUS_MODEL: main,
      ANTHROPIC_DEFAULT_SONNET_MODEL: main,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ctx.fastModel.name,
      CLAUDE_CODE_SUBAGENT_MODEL: main,
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_FEEDBACK_COMMAND: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    };
    if (ctx.model.context_window && ctx.model.context_window < CLAUDE_DEFAULT_CONTEXT) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(ctx.model.context_window);
    }
    // EliteA doesn't implement the auto-mode classifier endpoint; respect an explicit user choice.
    if (process.env.CLAUDE_CODE_AUTO_MODE_SERVER === undefined) env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";

    const settings: Record<string, unknown> = modelPickerSettings(ctx.catalog);
    const args = ["--model", main];
    if (ctx.tools) {
      // EliteA context: who/where we are, the elitea skill + commands, and elitea-cli on PATH.
      settings.permissions = ELITEA_PERMISSIONS;
      args.push("--append-system-prompt", sessionContext(ctx), "--plugin-dir", ctx.tools.pluginDir);
      env.PATH = [ctx.tools.shimDir, process.env.PATH].filter(Boolean).join(delimiter);
      // The shim reads the token from the store itself; it only needs to know which environment.
      if (ctx.environment) env.ELITEA_CLI_ENV = ctx.environment;
    }
    return { args: [...args, "--settings", JSON.stringify(settings), ...ctx.extraArgs], env };
  },
};

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Replace Claude's built-in /model lineup (Fable, Opus, …) with the project's EliteA catalog. */
function modelPickerSettings(catalog: ModelCatalog) {
  return {
    modelPicker: {
      replaceBuiltInOptions: true,
      options: catalog.items.map((m) => ({
        model: m.name,
        label: m.display_name,
        description: `EliteA · ${m.name} · ${k(m.context_window)} context`,
      })),
    },
  };
}
