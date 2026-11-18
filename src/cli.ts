import { Command, CommanderError, Option } from "commander";
import { apiCommand } from "./commands/api.js";
import { SHELLS, completionScript } from "./commands/completion.js";
import { configGetCommand, configListCommand, configSetCommand, configUnsetCommand } from "./commands/settings.js";
import { loadConfig } from "./config.js";
import { ctx, isDebug, operationFor } from "./context.js";
import { agentChatCommand } from "./commands/agentChat.js";
import {
  createCommand,
  deleteCommand,
  editCommand,
  updateCommand,
  validateCommand,
  versionCreateCommand,
  versionDefaultCommand,
} from "./commands/authoring.js";
import { listCommand, STATUSES } from "./commands/agents.js";
import {
  createCommand as credentialCreateCommand,
  deleteCommand as credentialDeleteCommand,
  getCommand as credentialGetCommand,
  listCommand as credentialListCommand,
  testCommand as credentialTestCommand,
  typesCommand as credentialTypesCommand,
  updateCommand as credentialUpdateCommand,
} from "./commands/credentials.js";
import { collect } from "./commands/common.js";
import {
  addCommand as toolkitAddCommand,
  createCommand as toolkitCreateCommand,
  deleteCommand as toolkitDeleteCommand,
  getCommand as toolkitGetCommand,
  listCommand as toolkitListCommand,
  removeCommand as toolkitRemoveCommand,
  testCommand as toolkitTestCommand,
  toolsCommand as toolkitToolsCommand,
  typesCommand as toolkitTypesCommand,
  updateCommand as toolkitUpdateCommand,
} from "./commands/toolkits.js";
import {
  DEFAULT_LAST,
  DEFAULT_LIST_LIMIT,
  deleteCommand as chatDeleteCommand,
  listCommand as chatListCommand,
  sendCommand as chatSendCommand,
  showCommand as chatShowCommand,
} from "./commands/chats.js";
import { getCommand, versionsCommand } from "./commands/inspect.js";
import { runCommand } from "./commands/run.js";
import { envAddCommand, envListCommand, envRemoveCommand, envUseCommand } from "./commands/env.js";
import { launchCommand } from "./commands/launch.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { modelsCommand } from "./commands/models.js";
import { projectCommand, projectsCommand } from "./commands/project.js";
import { statusCommand } from "./commands/status.js";
import { EXIT, EXIT_CODES_HELP, errorJson, exitCodeOf, usageError } from "./errors.js";
import { scrub, scrubAll } from "./redact.js";
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

const WRITE_OUTPUT_HELP = "text, json or yaml (the object EliteA returns)";

/** create, update, edit, version create|default and delete under `agents` and `pipelines` (story 04). */
function authoringCommands(parent: Command, kind: ItemKind): void {
  const noun = kind;
  const plural = `${kind}s`;
  const common = (cmd: Command) => cmd.addOption(envOption()).option("-p, --project <id|name>", PROJECT_HELP);

  const create = common(parent.command("create").description(`Create ${kind === "agent" ? "an agent" : "a pipeline"} from a JSON or YAML file`))
    .option("-f, --file <path>", `the ${noun} as EliteA's create body ({name, description, versions} or {name, instructions, llm_settings, …}); - reads stdin`)
    .option("-o, --output <format>", WRITE_OUTPUT_HELP);
  if (kind === "pipeline") {
    create
      .option("--name <name>", "pipeline name (with --yaml, instead of -f)")
      .option("--yaml <path>", "the pipeline YAML (with --name)")
      .option("--model <name>", "model (default: the project's default model)")
      .option("--description <text>", "pipeline description");
  }
  create
    .addHelpText(
      "after",
      kind === "agent"
        ? "\nA file without `versions` gets one base version from its top-level instructions, llm_settings, agent_type….\n\nExamples:\n  elitea-cli agents create -f examples/agent.yaml\n  id=$(elitea-cli agents create -f reviewer.json -q)"
        : "\nExamples:\n  elitea-cli pipelines create --name \"Release notes\" --yaml release-notes.yaml\n  elitea-cli pipelines create -f examples/pipeline.yaml",
    )
    .action((opts) => createCommand(kind, opts));

  const update = common(
    parent
      .command("update")
      .argument(`<${noun}>`, `${noun} id or name`)
      .description(kind === "agent" ? "Change a version from a file (fields left out keep their value)" : "Change a version from a file, or only its YAML"),
  )
    .option("-f, --file <path>", `version file, as \`${plural} get -o json\` prints it; - reads stdin`)
    .option("--agent-version <name|id>", "version to change (default: the default version)")
    .option("--dry-run", "print a diff of what would change and send nothing")
    .option("-o, --output <format>", WRITE_OUTPUT_HELP);
  if (kind === "pipeline") update.option("--yaml <path>", "the pipeline YAML only");
  update
    .addHelpText(
      "after",
      `\nExamples:\n  elitea-cli ${plural} get 42 -o yaml > v.yaml   # edit v.yaml\n  elitea-cli ${plural} update 42 -f v.yaml --dry-run\n  elitea-cli ${plural} update 42 -f v.yaml` +
        (kind === "pipeline" ? "\n  elitea-cli pipelines update \"Release notes\" --yaml release-notes.yaml" : ""),
    )
    .action((query: string, opts) => updateCommand(kind, query, opts));

  common(
    parent
      .command("edit")
      .argument(`<${noun}>`, `${noun} id or name`)
      .description(kind === "agent" ? "Edit a version as YAML in $VISUAL / $EDITOR" : "Edit a version's pipeline YAML in $VISUAL / $EDITOR"),
  )
    .option("--agent-version <name|id>", "version to edit (default: the default version)")
    .option("-o, --output <format>", WRITE_OUTPUT_HELP)
    .action((query: string, opts) => editCommand(kind, query, opts));

  const version = parent.command("version").description(`Create a version of ${kind === "agent" ? "an agent" : "a pipeline"} or set the default one`);
  common(
    version
      .command("create")
      .argument(`<${noun}>`, `${noun} id or name`)
      .argument("<name>", "name of the new version")
      .description("Create a version as a copy of another one"),
  )
    .option("--from <name|id>", "version to copy (default: the default version)")
    .option("-o, --output <format>", WRITE_OUTPUT_HELP)
    .addHelpText("after", `\nExample:\n  elitea-cli ${plural} version create 42 v2 --from base`)
    .action((query: string, name: string, opts) => versionCreateCommand(kind, query, name, opts));
  common(
    version
      .command("default")
      .argument(`<${noun}>`, `${noun} id or name`)
      .argument("<version>", "version name or id")
      .description("Make a version the default one"),
  )
    .option("-o, --output <format>", WRITE_OUTPUT_HELP)
    .action((query: string, name: string, opts) => versionDefaultCommand(kind, query, name, opts));

  common(
    parent
      .command("delete")
      .argument(`<${noun}>`, `${noun} id or name`)
      .description(`Delete ${kind === "agent" ? "an agent" : "a pipeline"} with all its versions, or one version`),
  )
    .option("--agent-version <name|id>", "delete only this version (its schedules are disabled)")
    .option("--replace-with <name|id>", "move agents and pipelines that use the version to this one first")
    .option("-y, --yes", "don't ask for confirmation")
    .addHelpText("after", `\nExamples:\n  elitea-cli ${plural} delete 42\n  elitea-cli ${plural} delete 42 --agent-version v1 --replace-with v2 --yes`)
    .action((query: string, opts) => deleteCommand(kind, query, opts));
}

const RUN_EXIT_HELP = `
Exit codes: 0 finished (or accepted with --no-wait), 1 the run failed, 2 bad usage,
3 not logged in, 4 forbidden, 5 unknown name, 7 limit or budget, 8 still running or waiting
for input (the run goes on on EliteA), 130 Ctrl-C (stopped waiting; the run goes on).`;

const agents = listOptions(
  program.command("agents").description("List, inspect, run, create, change and delete EliteA agents and pipelines (no subcommand: list)"),
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

authoringCommands(agents, "agent");

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

const agentToolkits = agents
  .command("toolkits")
  .description("Attach toolkits to an agent version or detach them (pipelines name toolkits in their YAML)")
  .enablePositionalOptions();

const toolkitTarget = (cmd: Command) =>
  cmd
    .addOption(envOption())
    .option("--agent-version <name|id>", "version to change (default: the default version)")
    .option("-p, --project <id|name>", PROJECT_HELP)
    .option("-o, --output <format>", "text, json or yaml");

toolkitTarget(
  agentToolkits
    .command("add")
    .argument("<agent>", "agent id or name")
    .argument("<toolkit>", "toolkit id or name")
    .description("Attach a toolkit to an agent version, with all its tools or the ones named"),
)
  .option("--tools <a,b>", "only these tools of the toolkit (default: all its selected tools)")
  .addHelpText(
    "after",
    `
To change the tools of an attached toolkit: remove it, then add it with --tools.

Examples:
  elitea-cli agents toolkits add "Release bot" "Jira EL" --tools search_using_jql,create_issue
  elitea-cli agents toolkits add 42 115 --agent-version v2`,
  )
  .action(toolkitAddCommand);

toolkitTarget(
  agentToolkits
    .command("remove")
    .argument("<agent>", "agent id or name")
    .argument("<toolkit>", "toolkit id or name")
    .description("Detach a toolkit from an agent version"),
)
  .addHelpText("after", '\nExample:\n  elitea-cli agents toolkits remove "Release bot" "Jira EL"')
  .action(toolkitRemoveCommand);

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
  .description("List, inspect, run, create, change, validate and delete EliteA pipelines")
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

authoringCommands(pipelines, "pipeline");

pipelines
  .command("validate")
  .description("Check pipeline YAML on EliteA without saving it (exit 0 valid, 6 not valid)")
  .addOption(envOption())
  .option("-f, --file <path>", "the pipeline YAML; - reads stdin")
  .option("--yaml <path>", "same as -f")
  .option("-p, --project <id|name>", PROJECT_HELP)
  .option("-o, --output <format>", "text or json (the platform's {valid, errors, warnings})")
  .addHelpText("after", "\nExample:\n  elitea-cli pipelines validate -f release-notes.yaml")
  .action(async (opts) => {
    process.exitCode = await validateCommand(opts);
  });

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

const credentials = program
  .command("credentials")
  .description("List, inspect, create, change, test and delete credentials; secrets are never shown")
  .addOption(envOption())
  .enablePositionalOptions();

const credentialCommon = (cmd: Command) => cmd.addOption(envOption()).option("-p, --project <id|name>", PROJECT_HELP);
const SECRET_HELP = "a secret field to set: masked prompt in a terminal, else read from stdin (repeatable in a terminal)";
const SECRET_ENV_HELP = "a secret field from an environment variable: <field>=<ENV_VAR> (repeatable)";

credentialCommon(credentials.command("types").description("List credential types, their fields and which ones are secret"))
  .option("--type <type>", "only this type")
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml give each type's full schema`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nExamples:\n  elitea-cli credentials types\n  elitea-cli credentials types --type jira -o json")
  .action(credentialTypesCommand);

credentialCommon(credentials.command("list").description("List credentials of the project and those shared with it (no connection check)"))
  .option("--type <type>", "only credentials of this type")
  .option("-o, --output <format>", OUTPUT_HELP)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nExample:\n  elitea-cli credentials list --type github -o json")
  .action(credentialListCommand);

credentialCommon(credentials.command("get").argument("[credential]", "credential id or title").description("Show a credential; secret fields print as ****"))
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: the credential as EliteA returns it, secrets as ****`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nExample:\n  elitea-cli credentials get jira_el -o yaml > jira-cred.yaml")
  .action(credentialGetCommand);

const CREDENTIAL_FILE_HELP = `
The file uses EliteA's shape: {elitea_title, label, type, shared, data: {…}}. Leave secret fields
out of the file; give them with --secret <field> or --secret-env <field>=<VAR>. A secret value is
never accepted on the command line (it would land in the shell history).`;

credentialCommon(credentials.command("create").description("Create a credential from a YAML or JSON file"))
  .option("-f, --file <path>", "the credential; - reads stdin")
  .option("--secret <field>", SECRET_HELP, collect)
  .option("--secret-env <field=VAR>", SECRET_ENV_HELP, collect)
  .option("-o, --output <format>", "text, json or yaml (secrets as ****)")
  .addHelpText(
    "after",
    `${CREDENTIAL_FILE_HELP}

Examples:
  printf %s "$JIRA_TOKEN" | elitea-cli credentials create -f jira-cred.yaml --secret api_key
  elitea-cli credentials create -f github-cred.yaml --secret-env access_token=GITHUB_PAT`,
  )
  .action(credentialCreateCommand);

credentialCommon(
  credentials
    .command("update")
    .argument("<credential>", "credential id or title")
    .description("Change a credential from a file; fields and secrets left out keep their stored value"),
)
  .option("-f, --file <path>", "fields to change, in the create shape; - reads stdin")
  .option("--secret <field>", SECRET_HELP, collect)
  .option("--secret-env <field=VAR>", SECRET_ENV_HELP, collect)
  .option("-o, --output <format>", "text, json or yaml (secrets as ****)")
  .addHelpText(
    "after",
    `${CREDENTIAL_FILE_HELP}

Examples:
  elitea-cli credentials update jira_el -f jira-cred.yaml
  printf %s "$NEW_TOKEN" | elitea-cli credentials update jira_el -f jira-cred.yaml --secret api_key`,
  )
  .action(credentialUpdateCommand);

credentialCommon(credentials.command("test").argument("<credential>", "credential id or title").description("Check the connection of a saved credential"))
  .option("-o, --output <format>", "text or json ({ok, message, credential})")
  .addHelpText("after", "\nExit codes: 0 connection OK, 1 connection failed, 4 no permission to test credentials.\n\nExample:\n  elitea-cli credentials test \"Jira EL\"")
  .action(async (query: string, opts) => {
    process.exitCode = await credentialTestCommand(query, opts);
  });

credentialCommon(credentials.command("delete").argument("<credential>", "credential id or title").description("Delete a credential"))
  .option("-y, --yes", "don't ask for confirmation")
  .addHelpText("after", "\nExample:\n  elitea-cli credentials delete jira_el --yes")
  .action(credentialDeleteCommand);

const toolkits = program
  .command("toolkits")
  .description("List, inspect, create, change, test and delete toolkits; secrets are never shown")
  .addOption(envOption())
  .enablePositionalOptions();

const toolkitCommon = (cmd: Command) => cmd.addOption(envOption()).option("-p, --project <id|name>", PROJECT_HELP);

toolkitCommon(toolkits.command("types").argument("[type]", "show this type's settings and tools").description("List the toolkit types the project can use, or one type's settings"))
  .option("--mcp", "MCP server types")
  .option("--all", "also types the web UI hides")
  .option("-o, --output <format>", `${OUTPUT_HELP}; with a type, json/yaml give its settings schema`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nExamples:\n  elitea-cli toolkits types\n  elitea-cli toolkits types jira\n  elitea-cli toolkits types github -o json")
  .action(toolkitTypesCommand);

toolkitCommon(toolkits.command("list").description("List the project's toolkits, newest first"))
  .option("--type <type>", "only toolkits of this type (repeatable)", collect)
  .option("-s, --search <text>", "only toolkits whose name or description matches")
  .option("--mcp", "MCP toolkits instead")
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: the toolkits with secrets as ****`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nExamples:\n  elitea-cli toolkits list --type jira\n  elitea-cli toolkits list -s release -o json")
  .action(toolkitListCommand);

toolkitCommon(toolkits.command("get").argument("<toolkit>", "toolkit id or name").description("Show a toolkit: settings (secrets as ****), credential and tools"))
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: the toolkit as EliteA returns it, secrets as ****`)
  .option("--json", "same as -o json")
  .addHelpText("after", '\nExample:\n  elitea-cli toolkits get "Jira EL" -o yaml > jira-toolkit.yaml')
  .action(toolkitGetCommand);

toolkitCommon(toolkits.command("tools").argument("<toolkit>", "toolkit id or name").description("List the tools a toolkit exposes and which are selected"))
  .option("-o, --output <format>", OUTPUT_HELP)
  .option("--json", "same as -o json")
  .action(toolkitToolsCommand);

const TOOLKIT_FILE_HELP = `
The file uses EliteA's shape: {type, name, description, settings: {…}}. Name the credential with
credential: "<title>" (this project's credentials first, then your personal ones, then shared
ones). Leave secret settings out of the file; give them with --secret <setting> or
--secret-env <setting>=<VAR>. selected_tools in settings picks the toolkit's tools.`;

toolkitCommon(toolkits.command("create").description("Create a toolkit from a YAML or JSON file"))
  .option("-f, --file <path>", "the toolkit; - reads stdin")
  .option("--secret <setting>", SECRET_HELP, collect)
  .option("--secret-env <setting=VAR>", SECRET_ENV_HELP, collect)
  .option("-o, --output <format>", "text, json or yaml (secrets as ****)")
  .addHelpText(
    "after",
    `${TOOLKIT_FILE_HELP}

Example jira-toolkit.yaml:
  type: jira
  name: Jira EL
  credential: Jira EL
  settings:
    selected_tools: [search_using_jql, create_issue]

Examples:
  elitea-cli toolkits create -f jira-toolkit.yaml
  id=$(elitea-cli toolkits create -f jira-toolkit.yaml -q)`,
  )
  .action(toolkitCreateCommand);

toolkitCommon(
  toolkits
    .command("update")
    .argument("<toolkit>", "toolkit id or name")
    .description("Change a toolkit from a file; settings and secrets left out keep their value"),
)
  .option("-f, --file <path>", "fields to change, in the create shape; - reads stdin")
  .option("--secret <setting>", SECRET_HELP, collect)
  .option("--secret-env <setting=VAR>", SECRET_ENV_HELP, collect)
  .option("-o, --output <format>", "text, json or yaml (secrets as ****)")
  .addHelpText("after", `${TOOLKIT_FILE_HELP} A setting set to null is cleared.\n\nExample:\n  elitea-cli toolkits update "Jira EL" -f jira-toolkit.yaml`)
  .action(toolkitUpdateCommand);

toolkitCommon(
  toolkits
    .command("test")
    .argument("<toolkit>", "toolkit id or name")
    .argument("<tool>", "tool name (see `toolkits tools`)")
    .description("Run one tool of a toolkit once and print its result"),
)
  .option("--args <json>", "the tool's arguments as a JSON object")
  .option("--args-file <path>", "the tool's arguments from a JSON file; - reads stdin")
  .option("--timeout <seconds>", "stop waiting after this long, 1–900 (default 300)")
  .option("-y, --yes", "don't ask before running (the tool acts on the real service)")
  .option("-o, --output <format>", "text or json ({ok, result, error, tool, toolkit})")
  .addHelpText(
    "after",
    `
Exit codes: 0 the tool answered, 1 the tool failed, 2 no --yes outside a terminal, 6 unknown tool,
8 timed out.

Examples:
  elitea-cli toolkits test "Jira EL" search_using_jql --args '{"jql": "project = EL", "limit": 5}'
  elitea-cli toolkits test 115 get_issue --args-file args.json --yes -o json`,
  )
  .action(async (query: string, tool: string, opts) => {
    process.exitCode = await toolkitTestCommand(query, tool, opts);
  });

toolkitCommon(toolkits.command("delete").argument("<toolkit>", "toolkit id or name").description("Delete a toolkit; agents that use it lose it"))
  .option("-y, --yes", "don't ask for confirmation")
  .addHelpText("after", "\nExample:\n  elitea-cli toolkits delete 115 --yes")
  .action(toolkitDeleteCommand);

const chats = program
  .command("chats")
  .description("List, read, continue and delete your EliteA chats (numeric chat ids, see `chats list`)")
  .addOption(envOption())
  .enablePositionalOptions();

const chatCommon = (cmd: Command) => cmd.addOption(envOption()).option("-p, --project <id|name>", PROJECT_HELP);

chatCommon(chats.command("list").description("List your chats in the project, most recently updated first (the web UI's chat list)"))
  .option("-s, --search <text>", "only chats whose name contains this text")
  .option("--limit <n>", `show at most n chats (default ${DEFAULT_LIST_LIMIT})`)
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: [{id, uuid, name, agents, created_at, updated_at, running, private, author_id, messages}]`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nColumns: ID NAME PARTICIPANTS (agents) UPDATED (local time) RUNNING.\n\nExamples:\n  elitea-cli chats list\n  elitea-cli chats list -s report --limit 50 -o json")
  .action(chatListCommand);

chatCommon(chats.command("show").argument("<id>", "numeric chat id").description("Print a chat's messages, oldest first, in full"))
  .option("--last <n>", `the last n messages (default ${DEFAULT_LAST})`)
  .option("--all", "every message")
  .option("-o, --output <format>", `${OUTPUT_HELP}; json/yaml: [{id, author, author_type, created_at, text, is_streaming, error?}]`)
  .option("--json", "same as -o json")
  .addHelpText("after", "\nA reply still being written is marked (still running).\n\nExamples:\n  elitea-cli chats show 1234\n  elitea-cli chats show 1234 --last 1 -o json | jq -r '.[0].text'")
  .action(chatShowCommand);

runOptions(
  chats
    .command("send")
    .argument("<id>", "numeric chat id")
    .argument("[message]", "the message (or use -f)")
    .description("Send a message to an existing chat and print the agent's answer, as `agents run` does"),
)
  .option("--to <agent>", "the agent to answer (id or name) when the chat has several")
  .addHelpText(
    "after",
    `\nA chat with a reply still being written is refused (exit 6) and nothing is sent.\n\nExamples:\n  id=$(elitea-cli agents run Reviewer -f diff.txt --no-wait -q)\n  elitea-cli chats send "$id" "And the tests?" -o json | jq -r .answer\n  elitea-cli chats send 1234 -f question.md --to "Code reviewer"\n${RUN_EXIT_HELP}`,
  )
  .action(async (id: string, message: string | undefined, opts) => {
    process.exitCode = await chatSendCommand(id, message, opts);
  });

chatCommon(chats.command("delete").argument("<id...>", "numeric chat ids").description("Delete chats (and the files skill scripts created in them)"))
  .option("-y, --yes", "don't ask for confirmation")
  .addHelpText(
    "after",
    "\nSeveral ids are confirmed once; a failure on one does not stop the others, and the summary says\nwhich were deleted. Exit 0 when all were, else the exit code of the first failure.\n\nExamples:\n  elitea-cli chats delete 1234\n  elitea-cli chats delete 1234 1235 1236 --yes",
  )
  .action(async (ids: string[], opts) => {
    process.exitCode = await chatDeleteCommand(ids, opts);
  });

program
  .command("launch")
  .argument("[integration]", "claude or codex")
  .argument("[args...]", "arguments for the agent, after --")
  .description("Start Claude Code or Codex with EliteA as the model provider (your project's models and budget)")
  .addOption(envOption())
  .option("-p, --project <id|name>", "use this project for this launch only (the active one stays)")
  .option("-m, --model <name>", "model to use (saved for next time)")
  .option("--fast-model <name>", "small model for background tasks (Claude Code)")
  .option("--pick", "choose models again interactively")
  .option("--print", "print the environment and command instead of launching (token redacted, nothing saved)")
  .option("--check", "check the token, the models and one small model call, then exit without launching")
  .addHelpText(
    "after",
    `
Claude Code also gets EliteA agents, pipelines and chats (the elitea skill and /elitea:* commands).
Codex gets EliteA models only.

Examples:
  elitea-cli launch claude
  elitea-cli launch codex -m global.openai.gpt-5.6-terra
  elitea-cli launch claude -- -p "explain this repo"
  elitea-cli launch codex -- exec "fix the failing test"
  elitea-cli launch claude --check

Exit codes: the agent's own exit code once it started; before that 1 (not installed, too old,
no models, --check failed), 2 usage, 3 not logged in or the token expired, 4 forbidden,
5 unknown model or project.`,
  )
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
  // Secret values given to this command never reach stderr, even inside a platform message (AC-14).
  const clean = (text: string) => scrubAll(scrub(text, process.env.ELITEA_CLI_TOKEN), ctx.secretValues);
  if (wantsJsonArgv()) {
    console.error(clean(errorJson(err).replace(/"exit":\d+/, `"exit":${exit}`)));
  } else {
    console.error(clean(`error: ${(err as Error).message}`));
  }
  if (isDebug() && err instanceof Error && err.stack) console.error(clean(err.stack));
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
