import { Command, Option } from "commander";
import { agentChatCommand } from "./commands/agentChat.js";
import { listCommand, STATUSES } from "./commands/agents.js";
import { collect } from "./commands/common.js";
import { getCommand, versionsCommand } from "./commands/inspect.js";
import { runCommand } from "./commands/run.js";
import { envAddCommand, envListCommand, envRemoveCommand, envUseCommand } from "./commands/env.js";
import { launchCommand } from "./commands/launch.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { modelsCommand } from "./commands/models.js";
import { projectCommand, projectsCommand } from "./commands/project.js";
import { statusCommand } from "./commands/status.js";
import { exitCodeOf } from "./errors.js";
import type { ItemKind } from "./resolve.js";
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

const PROJECT_HELP = "use this project instead of the active one";
const OUTPUT_HELP = "text, json or yaml";

function listOptions(cmd: Command, kind: ItemKind): Command {
  cmd
    .addOption(envOption())
    .option("-s, --search <text>", "only items whose name matches")
    .option("--tag <name>", "only items with this tag (repeatable: all must match)", collect)
    .option("--status <status>", `only items with a version in this status: ${STATUSES.join(", ")} (repeatable)`, collect)
    .option("--mine", "only items you authored")
    .option("--limit <n>", "show at most n items")
    .option("-p, --project <id|name>", PROJECT_HELP)
    .option("-o, --output <format>", OUTPUT_HELP)
    .option("--json", "same as -o json");
  if (kind === "agent") cmd.option("--type <type>", "agent or pipeline (default: both)");
  return cmd;
}

function getOptions(cmd: Command, kind: ItemKind): Command {
  cmd
    .addOption(envOption())
    .option("--agent-version <name|id>", "version to show (default: the default version)")
    .option("-p, --project <id|name>", PROJECT_HELP)
    .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml print the version object as EliteA returns it`)
    .option("--json", "same as -o json");
  if (kind === "pipeline") cmd.option("--yaml-only", "print only the pipeline YAML (to save as a file)");
  return cmd;
}

function versionsOptions(cmd: Command): Command {
  return cmd
    .addOption(envOption())
    .option("-p, --project <id|name>", PROJECT_HELP)
    .option("-o, --output <format>", OUTPUT_HELP)
    .option("--json", "same as -o json");
}

function runOptions(cmd: Command): Command {
  return cmd
    .addOption(envOption())
    .option("-f, --file <path>", "read the input from a file; - reads stdin")
    .option("--agent-version <name|id>", "version to run (default: the default version)")
    .option("--var <key=value>", "set a variable for this run (repeatable)", collect)
    .option("--timeout <minutes>", "stop waiting after this long, 1–240 (default: settings.timeout, else 30)")
    .option("--no-wait", "print the conversation id as soon as the message is accepted")
    .option("-p, --project <id|name>", PROJECT_HELP)
    .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: {status, answer, conversation_id, conversation_url, agent, version}`);
}

const RUN_EXIT_HELP = `
Exit codes: 0 finished (or accepted with --no-wait), 1 the run failed, 2 bad usage,
4 access denied, 5 unknown name, 8 still running or waiting for input (the run goes on
on EliteA), 130 Ctrl-C (stopped waiting; the run goes on).`;

const agents = listOptions(
  program.command("agents").description("List, inspect and run EliteA agents and pipelines (no subcommand: list)"),
  "agent",
)
  .enablePositionalOptions()
  .action((opts) => listCommand("agent", opts));

listOptions(agents.command("list").description("List agents and pipelines in the project, newest first"), "agent")
  .addHelpText("after", "\nExamples:\n  elitea-cli agents list --type agent --status published\n  elitea-cli agents list --mine -o json")
  .action((opts) => listCommand("agent", opts));

getOptions(agents.command("get").argument("<agent>", "agent id or name").description("Show an agent (or pipeline) and one of its versions"), "agent")
  .addHelpText("after", "\nExample:\n  elitea-cli agents get \"Code reviewer\" -o json > reviewer.json")
  .action((query: string, opts) => getCommand("agent", query, opts));

versionsOptions(agents.command("versions").argument("<agent>", "agent id or name").description("List the versions of an agent"))
  .action((query: string, opts) => versionsCommand("agent", query, opts));

runOptions(
  agents
    .command("run")
    .argument("<agent>", "agent id or name")
    .argument("[message]", "the message (or use -f)")
    .description("Run an agent once in a new private conversation and print its answer"),
)
  .addHelpText("after", `\nExamples:\n  elitea-cli agents run "Code reviewer" -f diff.txt -o json | jq -r .answer\n  git diff | elitea-cli agents run 42 -f - --timeout 10\n${RUN_EXIT_HELP}`)
  .action(async (query: string, message: string | undefined, opts) => {
    process.exitCode = await runCommand("agent", query, message, opts);
  });

agents
  .command("chat")
  .argument("[agent]", "agent id or name (interactive picker when omitted)")
  .argument("[message]", "send one message, print the answer and exit")
  .description("Chat with an EliteA agent (interactive when no message is given)")
  .addOption(envOption())
  .option("--agent-version <name>", "agent version (default: the agent's default version)")
  .option("-c, --conversation <id>", "continue an existing conversation")
  .option("-p, --project <id|name>", PROJECT_HELP)
  .option("--json", "print {answer, conversation_id, agent} (one-shot mode)")
  .action(agentChatCommand);

const pipelines = program
  .command("pipelines")
  .description("List, inspect and run EliteA pipelines")
  .addOption(envOption())
  .enablePositionalOptions();

listOptions(pipelines.command("list").description("List pipelines in the project, newest first"), "pipeline").action((opts) =>
  listCommand("pipeline", opts),
);

getOptions(pipelines.command("get").argument("<pipeline>", "pipeline id or name").description("Show a pipeline, one of its versions and its YAML"), "pipeline")
  .addHelpText("after", "\nExample:\n  elitea-cli pipelines get \"Release notes\" --yaml-only > release-notes.yaml")
  .action((query: string, opts) => getCommand("pipeline", query, opts));

versionsOptions(pipelines.command("versions").argument("<pipeline>", "pipeline id or name").description("List the versions of a pipeline"))
  .action((query: string, opts) => versionsCommand("pipeline", query, opts));

runOptions(
  pipelines
    .command("run")
    .argument("<pipeline>", "pipeline id or name")
    .argument("[input]", "the pipeline input (or use -f)")
    .description("Run a pipeline once in a new private conversation and print its output"),
)
  .addHelpText("after", `\nExample:\n  elitea-cli pipelines run "Release notes" -f changes.md -o json | jq -r .answer\n${RUN_EXIT_HELP}`)
  .action(async (query: string, input: string | undefined, opts) => {
    process.exitCode = await runCommand("pipeline", query, input, opts);
  });

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

try {
  await program.parseAsync();
} catch (err) {
  // Ctrl-C inside an interactive prompt.
  if ((err as Error).name === "ExitPromptError") process.exit(130);
  console.error(`error: ${(err as Error).message}`);
  if (process.env.ELITEA_CLI_DEBUG) console.error(err);
  process.exit(exitCodeOf(err));
}
