import { Command } from "commander";
import { agentChatCommand } from "./commands/agentChat.js";
import { agentsCommand } from "./commands/agents.js";
import { launchCommand } from "./commands/launch.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { modelsCommand } from "./commands/models.js";
import { projectCommand, projectsCommand } from "./commands/project.js";
import { statusCommand } from "./commands/status.js";

const program = new Command()
  .name("elitea-cli")
  .description("Launch Claude Code on top of EliteA and work with EliteA projects and agents")
  .version("0.1.0")
  // `agents` and `agents chat` share --json/--project; without this the parent swallows them.
  .enablePositionalOptions();

program
  .command("login")
  .description("Log in with an EliteA personal access token and pick a project")
  .option("--url <url>", "EliteA server URL (default https://next.elitea.ai)")
  .option("--token-stdin", "read the token from stdin")
  .option("-p, --project <id|name>", "project to use")
  .option("--no-browser", "don't open the token page in a browser")
  .action(loginCommand);

program.command("logout").description("Forget the stored token").action(logoutCommand);

program
  .command("status")
  .description("Show login state, project and model choices")
  .action(async () => {
    process.exitCode = await statusCommand();
  });

program.command("projects").description("List your EliteA projects").option("--json").action(projectsCommand);

program
  .command("project")
  .argument("[id|name]", "project to switch to (interactive when omitted)")
  .description("Switch the active project")
  .action(projectCommand);

program.command("models").description("List models available in the active project").option("--json").action(modelsCommand);

const agents = program
  .command("agents")
  .description("List EliteA agents in the active project")
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
  .option("-m, --model <name>", "model to use (saved for next time)")
  .option("--fast-model <name>", "small model for background tasks (Claude Code)")
  .option("--pick", "choose models again interactively")
  .option("--print", "print the environment and command instead of launching")
  .action(async (name: string | undefined, args: string[], opts) => {
    process.exitCode = await launchCommand(name, args, opts);
  });

try {
  await program.parseAsync();
} catch (err) {
  // Ctrl-C inside an interactive prompt.
  if ((err as Error).name === "ExitPromptError") process.exit(130);
  console.error(`error: ${(err as Error).message}`);
  if (process.env.ELITEA_CLI_DEBUG) console.error(err);
  process.exit(1);
}
