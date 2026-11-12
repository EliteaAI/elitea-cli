import { Command, Option } from "commander";
import { agentChatCommand } from "./commands/agentChat.js";
import { agentsCommand } from "./commands/agents.js";
import { envAddCommand, envListCommand, envRemoveCommand, envUseCommand } from "./commands/env.js";
import { launchCommand } from "./commands/launch.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { modelsCommand } from "./commands/models.js";
import { projectCommand, projectsCommand } from "./commands/project.js";
import { statusCommand } from "./commands/status.js";
import { AuthError } from "./elitea.js";
import { CliError } from "./errors.js";
import { setEnvFlag } from "./session.js";

const ENV_HELP = "saved environment to use for this command (see `elitea-cli env list`)";
const envOption = () => new Option("--env <name>", ENV_HELP);

const program = new Command()
  .name("elitea-cli")
  .description("Launch Claude Code on top of EliteA and work with EliteA projects and agents")
  .version("0.1.0")
  // `agents` and `agents chat` share --json/--project; without this the parent swallows them.
  .enablePositionalOptions()
  .addOption(envOption());

// `--env` may be given before the command or after it; the one closest to the command wins.
program.hook("preAction", (_root, action) => {
  for (let cmd: Command | null = action; cmd; cmd = cmd.parent) {
    const value = cmd.getOptionValue("env") as string | undefined;
    if (value !== undefined) {
      setEnvFlag(value);
      return;
    }
  }
});

program
  .command("login")
  .description("Log in to an EliteA server with a personal access token and pick a project")
  .option("--url <url>", "EliteA server URL, e.g. https://<your-server>")
  .addOption(envOption())
  .option("--token-stdin", "read the token from stdin")
  .option("-p, --project <id|name>", "project to use")
  .option("--no-browser", "don't open the token page in a browser")
  .option("--allow-http", "allow a non-HTTPS server outside a terminal")
  .action(loginCommand);

program
  .command("logout")
  .description("Forget the stored token of the active (or --env) environment")
  .addOption(envOption())
  .option("--all", "forget the tokens of all environments")
  .action(logoutCommand);

program
  .command("status")
  .description("Show environment, login state, project and model choices")
  .addOption(envOption())
  .option("-o, --output <format>", "text or json", "text")
  .action(async (opts) => {
    process.exitCode = await statusCommand(opts);
  });

const env = program
  .command("env")
  .description("Manage saved EliteA environments (servers)")
  .addHelpText(
    "after",
    `
Examples:
  elitea-cli env list
  elitea-cli env add dev --url https://dev.example.com
  elitea-cli env use dev
  elitea-cli env remove dev`,
  );

env
  .command("list")
  .description("List saved environments (works offline)")
  .addOption(envOption())
  .option("-o, --output <format>", "text or json", "text")
  .addHelpText("after", "\nExample:\n  elitea-cli env list -o json")
  .action(envListCommand);

env
  .command("add")
  .argument("<name>", "1–40 letters, digits, '.', '-' or '_'")
  .requiredOption("--url <url>", "EliteA server URL")
  .option("--allow-http", "allow a non-HTTPS server outside a terminal")
  .description("Save an environment without logging in")
  .addHelpText("after", "\nExample:\n  elitea-cli env add dev --url https://dev.example.com")
  .action(envAddCommand);

env
  .command("use")
  .argument("<name>")
  .description("Make an environment the active one")
  .addHelpText("after", "\nExample:\n  elitea-cli env use dev")
  .action(envUseCommand);

env
  .command("remove")
  .argument("<name>")
  .option("-y, --yes", "don't ask for confirmation")
  .description("Delete an environment and its stored token")
  .addHelpText("after", "\nExample:\n  elitea-cli env remove dev --yes")
  .action(envRemoveCommand);

program.command("projects").description("List your EliteA projects").addOption(envOption()).option("--json").action(projectsCommand);

program
  .command("project")
  .argument("[id|name]", "project to switch to (interactive when omitted)")
  .description("Switch the active project of the environment")
  .addOption(envOption())
  .action(projectCommand);

program
  .command("models")
  .description("List models available in the active project")
  .addOption(envOption())
  .option("--json")
  .action(modelsCommand);

const agents = program
  .command("agents")
  .description("List EliteA agents in the active project (pipelines are not included)")
  .addOption(envOption())
  .option("--json")
  .option("-s, --search <text>", "only agents whose name matches")
  .option("-p, --project <id|name>", "use this project instead of the active one")
  .enablePositionalOptions()
  .action(agentsCommand);

agents
  .command("chat")
  .argument("[agent]", "agent id or name (interactive picker when omitted)")
  .argument("[message]", "send one message, print the answer and exit")
  .description("Chat with an EliteA agent (interactive when no message is given)")
  .addOption(envOption())
  .option("--agent-version <name>", "agent version (default: the agent's default version)")
  .option("-c, --conversation <id>", "continue an existing conversation")
  .option("-p, --project <id|name>", "use this project instead of the active one")
  .option("--json", "print {answer, conversation_id, agent} (one-shot mode)")
  .action(agentChatCommand);

program
  .command("launch")
  .argument("[integration]", "claude")
  .argument("[args...]", "arguments for the agent, after --")
  .description("Launch an agent wired to EliteA")
  .addOption(envOption())
  .option("-m, --model <name>", "model to use (saved for next time)")
  .option("--fast-model <name>", "small model for background tasks (Claude Code)")
  .option("--pick", "choose models again interactively")
  .option("--print", "print the environment and command instead of launching")
  .action(async (name: string | undefined, args: string[], opts) => {
    process.exitCode = await launchCommand(name, args, opts);
  });

function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof AuthError) return 3;
  return 1;
}

try {
  await program.parseAsync();
} catch (err) {
  // Ctrl-C inside an interactive prompt.
  if ((err as Error).name === "ExitPromptError") process.exit(130);
  console.error(`error: ${(err as Error).message}`);
  if (process.env.ELITEA_CLI_DEBUG) console.error(err);
  process.exit(exitCodeOf(err));
}
