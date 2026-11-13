import { Command, CommanderError, Option } from "commander";
import { apiCommand } from "./commands/api.js";
import { SHELLS, completionScript } from "./commands/completion.js";
import { configGetCommand, configListCommand, configSetCommand, configUnsetCommand } from "./commands/settings.js";
import { loadConfig } from "./config.js";
import { ctx, isDebug, operationFor } from "./context.js";
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
import { EXIT, EXIT_CODES_HELP, errorJson, exitCodeOf, usageError } from "./errors.js";
import { scrub } from "./redact.js";
import type { ItemKind } from "./resolve.js";
import { setEnvFlag } from "./session.js";

const VERSION = "0.1.0";
const PROJECT_HELP = "use this project instead of the active one";
const OUTPUT_HELP = "table, json or yaml";
const ENV_HELP = "saved environment to use for this command (see `elitea-cli env list`)";
const envOption = () => new Option("--env <name>", ENV_HELP);

/** Flags every command accepts, before or after the command name (AC scope: global flags). */
function globalOptions(cmd: Command): Command {
  return cmd
    .option("-q, --quiet", "print only the primary id (create, delete, run --no-wait)")
    .option("--yes", "don't ask before deleting, removing or overwriting")
    .option("--no-color", "no ANSI colours (also NO_COLOR)")
    .option("--debug", "log each request (secrets masked) and the stack on failure to stderr");
}

const program = globalOptions(
  new Command()
    .name("elitea-cli")
    .description("Launch Claude Code on top of EliteA and work with EliteA projects and agents")
    .version(VERSION)
    // `agents` and `agents chat` share --json/--project; without this the parent swallows them.
    .enablePositionalOptions()
    .addOption(envOption()),
).addHelpText("after", EXIT_CODES_HELP);

/** The first value of `name` from the command up to the root: the flag closest to the command wins. */
function nearest<T>(action: Command, name: string): T | undefined {
  for (let cmd: Command | null = action; cmd; cmd = cmd.parent) {
    const source = cmd.getOptionValueSource(name);
    if (source !== undefined && source !== "default") return cmd.getOptionValue(name) as T;
  }
  return undefined;
}

function commandPath(action: Command): string {
  const names: string[] = [];
  for (let cmd: Command | null = action; cmd?.parent; cmd = cmd.parent) names.unshift(cmd.name());
  return names.join(" ");
}

program.hook("preAction", async (_root, action) => {
  setEnvFlag(nearest<string>(action, "env"));
  ctx.quiet = Boolean(nearest(action, "quiet"));
  ctx.yes = Boolean(nearest(action, "yes"));
  ctx.debug = Boolean(nearest(action, "debug"));
  ctx.color = nearest<boolean>(action, "color") !== false;
  const output = action.getOptionValue("output") as string | undefined;
  ctx.json = Boolean(action.getOptionValue("json")) || output?.toLowerCase() === "json";
  ctx.operation = operationFor(commandPath(action));
  try {
    ctx.settings = (await loadConfig()).settings;
  } catch {
    // A broken config is reported by the command itself.
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
  .option("-o, --output <format>", OUTPUT_HELP)
  .option("--json", "same as -o json")
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

program
  .command("projects")
  .description("List your EliteA projects")
  .addOption(envOption())
  .option("-o, --output <format>", OUTPUT_HELP)
  .option("--json", "same as -o json")
  .action(projectsCommand);

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
  .option("-o, --output <format>", OUTPUT_HELP)
  .option("--json", "same as -o json")
  .action(modelsCommand);

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
3 not logged in, 4 forbidden, 5 unknown name, 7 limit or budget, 8 still running or waiting
for input (the run goes on on EliteA), 130 Ctrl-C (stopped waiting; the run goes on).`;

const agents = listOptions(
  program.command("agents").description("List, inspect and run EliteA agents and pipelines (no subcommand: list)"),
  "agent",
)
  .enablePositionalOptions()
  // `agents` alone lists; `agents <word>` with an unknown word is a usage error, not extra arguments.
  .argument("[subcommand]")
  .allowExcessArguments()
  .action((sub: string | undefined, opts) => {
    if (sub !== undefined) {
      const known = agents.commands.map((c) => c.name()).join(", ");
      throw usageError(`Unknown command 'agents ${sub}'. Commands: ${known} — see \`elitea-cli agents --help\``);
    }
    return listCommand("agent", opts);
  });

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
  .option("-o, --output <format>", "json: same as --json (one-shot mode)")
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

const config = program
  .command("config")
  .description("Show and change elitea-cli settings (all environments)")
  .addHelpText(
    "after",
    `
Settings (an environment variable wins over each):
  output   table|json|yaml   default output of list/get commands added since 0.2 (ELITEA_CLI_OUTPUT)
  color    auto|never        colours in the terminal (NO_COLOR)
  timeout  1–240             minutes \`run\` waits, default 30 (ELITEA_CLI_TIMEOUT)

Examples:
  elitea-cli config list
  elitea-cli config set timeout 60`,
  );

config
  .command("list")
  .description("Show every setting, its value and where it comes from")
  .option("-o, --output <format>", "table, json or yaml")
  .option("--json", "same as -o json")
  .action(configListCommand);

config.command("get").argument("<key>", "output, color or timeout").description("Print one setting's value").action(configGetCommand);

config
  .command("set")
  .argument("<key>", "output, color or timeout")
  .argument("<value>")
  .description("Change a setting")
  .addHelpText("after", "\nExamples:\n  elitea-cli config set output json\n  elitea-cli config set color never")
  .action(configSetCommand);

config.command("unset").argument("<key>").description("Reset a setting to its default").action(configUnsetCommand);

program
  .command("api")
  .argument("<method>", "GET, POST, PUT, PATCH or DELETE")
  .argument("<path>", "path on the active environment, e.g. /api/v2/auth/user/; {project} = the project id")
  .description("Call any EliteA API endpoint with the stored token and print the raw response")
  .addOption(envOption())
  .option("-f, --file <path>", "request body from a file; - reads stdin")
  .option("-F, --field <key=value>", "JSON body field (POST/PUT/PATCH) or query parameter (GET/DELETE); repeatable", collect)
  .option("-H, --header <'Name: value'>", "extra request header (repeatable; not Authorization)", collect)
  .option("-i, --include", "also print the status line and response headers (to stderr)")
  .option("-O, --output-file <path>", "write the response body to a file")
  .option("-p, --project <id|name>", PROJECT_HELP)
  .addHelpText(
    "after",
    `
Examples:
  elitea-cli api GET /api/v2/auth/user/
  elitea-cli api GET '/api/v2/elitea_core/applications/prompt_lib/{project}' -F limit=5 | jq '.rows[].name'
  elitea-cli api POST /api/v2/elitea_core/conversations/prompt_lib/{project} -f body.json

An error status prints the raw error body to stderr and exits with the code for that status.
${EXIT_CODES_HELP}`,
  )
  .action(async (method: string, path: string, opts) => {
    process.exitCode = await apiCommand(method, path, opts);
  });

program
  .command("completion")
  .argument("<shell>", SHELLS.join(", "))
  .description("Print a shell completion script")
  .addHelpText(
    "after",
    `
Examples:
  elitea-cli completion zsh > "\${fpath[1]}/_elitea-cli"
  elitea-cli completion bash > ~/.local/share/bash-completion/completions/elitea-cli`,
  )
  .action((shell: string) => {
    process.stdout.write(completionScript(shell, program));
  });

program
  .command("version")
  .description("Print the elitea-cli and Node.js versions")
  .option("-o, --output <format>", "text or json")
  .action((opts: { output?: string }) => {
    if (opts.output?.toLowerCase() === "json") console.log(JSON.stringify({ version: VERSION, node: process.versions.node }));
    else console.log(`elitea-cli ${VERSION}\nnode ${process.versions.node}`);
  });

/** Every command gets the global flags (accepted after the command name too) and usage errors exit 2. */
function finishTree(cmd: Command): void {
  const longs = new Set(cmd.options.map((o) => o.long));
  if (cmd !== program) {
    if (!longs.has("--quiet")) cmd.option("-q, --quiet", "print only the primary id");
    if (!longs.has("--yes")) cmd.option("--yes", "don't ask before deleting, removing or overwriting");
    if (!longs.has("--no-color")) cmd.option("--no-color", "no ANSI colours");
    if (!longs.has("--debug")) cmd.option("--debug", "log requests (secrets masked) and stacks to stderr");
  }
  cmd.exitOverride();
  cmd.configureOutput({ outputError: (text, write) => (wantsJsonArgv() ? undefined : write(text)) });
  for (const sub of cmd.commands) finishTree(sub);
}

/** JSON mode from argv, for errors raised before an action runs (unknown flags…). */
function wantsJsonArgv(argv = process.argv.slice(2)): boolean {
  if (ctx.json) return true;
  return argv.some((a, i) => a === "--json" || a === "-ojson" || a === "--output=json" || ((a === "-o" || a === "--output") && argv[i + 1]?.toLowerCase() === "json"));
}

function fail(err: unknown, exit: number): never {
  if (wantsJsonArgv()) {
    console.error(errorJson(err).replace(/"exit":\d+/, `"exit":${exit}`));
  } else {
    console.error(`error: ${(err as Error).message}`);
  }
  if (isDebug() && err instanceof Error && err.stack) console.error(scrub(err.stack, process.env.ELITEA_CLI_TOKEN));
  process.exit(exit);
}

finishTree(program);

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    // --help and --version end here with code 0; everything else commander refuses is usage.
    if (err.exitCode === 0) process.exit(0);
    if (err.code === "commander.help") process.exit(EXIT.usage);
    if (wantsJsonArgv()) fail(new Error(err.message.replace(/^error: /, "")), EXIT.usage);
    process.exit(EXIT.usage);
  }
  // Ctrl-C inside an interactive prompt.
  if ((err as Error).name === "ExitPromptError") process.exit(EXIT.interrupted);
  fail(err, exitCodeOf(err));
}
