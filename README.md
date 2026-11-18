# elitea-cli

Run Claude Code or Codex in any folder on top of [EliteA](https://next.elitea.ai): the models and
the budget come from your EliteA project, so you need no API key of your own. Like
`ollama launch`, but for EliteA.

## Quick start

```sh
npm install -g @eliteaai/elitea-cli
elitea-cli launch claude     # or: elitea-cli launch codex
```

The first `launch` logs you in when needed: it asks for your EliteA server URL, opens the token
page so you can paste a personal access token, lets you pick a project and a model, then starts
the agent. Later launches start at once with the same choices. `elitea-cli login` does the same
step on its own.

```
$ elitea-cli launch codex
Not logged in.
EliteA server URL: https://next.elitea.ai
Personal access token: ********
Project: Elitea Dev
Model for Codex CLI: every request of the session › GPT-5.4
Codex gets EliteA models only; EliteA agents, pipelines and chats are available in Claude Code (elitea-cli launch claude).
Launching Codex CLI with GPT-5.4 (environment next.elitea.ai, project 12)
```

You need Node.js 20+, and [Claude Code](https://docs.claude.com/en/docs/claude-code) 2.1.284+ or
[Codex CLI](https://github.com/openai/codex) 0.139.0+ (`npm install -g @openai/codex`).

## Commands at a glance

| Command | What it does |
|---|---|
| `elitea-cli login` | Log in to an EliteA server with a personal access token and pick a project |
| `elitea-cli logout` | Forget the stored token (the environment stays) |
| `elitea-cli status` | Show environment, server, user, project and saved model choices |
| `elitea-cli env list\|add\|use\|remove` | Manage saved environments (servers) |
| `elitea-cli projects` | List your projects |
| `elitea-cli project [id\|name]` | Switch the active project |
| `elitea-cli models` | List models available in the active project |
| `elitea-cli agents` / `agents list` | List agents **and** pipelines in the project |
| `elitea-cli agents get <agent>` | Show an agent's configuration |
| `elitea-cli agents versions <agent>` | List an agent's versions |
| `elitea-cli agents run <agent> [message]` | Run an agent once and print its answer (scripts, CI) |
| `elitea-cli agents chat [agent] [message]` | Chat with an agent (interactive, or one question and one answer) |
| `elitea-cli agents create -f <file>` | Create an agent from a JSON or YAML file |
| `elitea-cli agents update <agent> -f <file>` | Change a version from a file (`--dry-run`: show the diff) |
| `elitea-cli agents edit <agent>` | Edit a version as YAML in your editor |
| `elitea-cli agents version create\|default <agent> <name>` | Create a version as a copy, or set the default one |
| `elitea-cli agents delete <agent>` | Delete an agent, or one version with `--agent-version` |
| `elitea-cli pipelines list` | List pipelines only |
| `elitea-cli pipelines get <pipeline>` | Show a pipeline's configuration and YAML |
| `elitea-cli pipelines versions <pipeline>` | List a pipeline's versions |
| `elitea-cli pipelines run <pipeline> [input]` | Run a pipeline once and print its output |
| `elitea-cli pipelines create\|update\|edit\|version\|delete` | The same as for agents, on pipelines (and `--yaml` for the pipeline YAML only) |
| `elitea-cli pipelines validate -f <file>` | Check pipeline YAML on EliteA without saving it |
| `elitea-cli credentials types\|list\|get` | Credential types and their fields; saved credentials, secrets as `****` |
| `elitea-cli credentials create\|update -f <file>` | Create or change a credential; secrets only via `--secret` / `--secret-env` |
| `elitea-cli credentials test\|delete <credential>` | Check a credential's connection, or delete it |
| `elitea-cli toolkits types [type]` | Toolkit types the project can use, or one type's settings and tools |
| `elitea-cli toolkits list\|get\|tools` | Saved toolkits (secrets as `****`), one toolkit, the tools it exposes |
| `elitea-cli toolkits create\|update -f <file>` | Create or change a toolkit; `credential: "<title>"`, secrets via `--secret` / `--secret-env` |
| `elitea-cli toolkits test <toolkit> <tool>` | Run one tool once and print its result |
| `elitea-cli toolkits delete <toolkit>` | Delete a toolkit (agents that use it lose it) |
| `elitea-cli agents toolkits add\|remove <agent> <toolkit>` | Attach a toolkit to an agent version, or detach it |
| `elitea-cli chats list` | Your chats in the project (the web UI's chat list), newest first |
| `elitea-cli chats show <id>` | A chat's messages, oldest first, in full |
| `elitea-cli chats send <id> [message]` | Send a message to an existing chat, as `agents run` does |
| `elitea-cli chats delete <id>…` | Delete chats |
| `elitea-cli launch claude\|codex` | Start Claude Code or Codex with EliteA as the model provider (`--check`: test the setup) |
| `elitea-cli api <METHOD> <path>` | Call any EliteA API endpoint with the stored token |
| `elitea-cli config list\|get\|set\|unset` | Show and change CLI settings (output, color, timeout) |
| `elitea-cli completion bash\|zsh\|fish\|powershell` | Print a shell completion script |
| `elitea-cli version` | Print the elitea-cli and Node.js versions (`--version`: the version only) |

Every command prints its options and examples with `--help`, e.g. `elitea-cli pipelines run --help`.

### Options shared by most commands

| Option | Meaning |
|---|---|
| `--env <name>` | Run this one command against another saved environment (see [Environments](#environments)) |
| `-p, --project <id\|name>` | Use this project instead of the active one, without switching |
| `-o, --output <format>` | `table` (default), `json` or `yaml`. `--json` is the same as `-o json` |
| `-q, --quiet` | Print only the primary id, for `$(…)`: the conversation id of `run --no-wait`, the new or deleted id |
| `--yes` | Don't ask before deleting, removing or overwriting (required outside a terminal) |
| `--no-color` | No ANSI colours (also `NO_COLOR=1` or `config set color never`) |
| `--debug` | Log every request as `METHOD path → status (ms)` and the stack of a failure to stderr. Tokens, passwords, secrets and keys are masked as `****` |

Global options (`-q`, `--yes`, `--no-color`, `--debug`, `--env`) may come before or after the command.

**stdout holds only the result** (the table, the JSON document, the answer). Progress, spinners,
hints and warnings go to stderr, and no spinner is drawn when stdout is not a terminal. With
`-o json` (or `--json`) an error is printed to stderr as one JSON line and stdout stays empty:

```json
{"error":{"status":403,"code":"TOKEN_SCOPE_OPERATION","message":"This token is not allowed to do this (TOKEN_SCOPE_OPERATION). …","exit":4}}
```

The default of `-o` for `agents get|versions`, `pipelines list|get|versions|run`, `agents run`
and `config list` is `ELITEA_CLI_OUTPUT`, then `config set output …`, then `table`. `projects`,
`models`, `agents [list]`, `agents chat` and `status` keep their text output unless `-o` is given.

### Naming an agent or pipeline

Wherever a command takes `<agent>` or `<pipeline>` you can give:

- the **id** (`42`),
- the **exact name** (`"Code reviewer"`, quotes needed for spaces),
- the name in **any case** (`"code reviewer"`),
- a **part of the name**, if only one item matches (`review`).

If nothing matches, or several items match, the command exits with code 5 and lists the candidates.
In a terminal, leaving the name out opens an interactive picker.

`agents …` commands accept both agents and pipelines. `pipelines …` commands accept only pipelines:
giving them a classic agent exits with code 5.

## Account and projects

### `login`

```sh
elitea-cli login                                     # asks for the URL, token and project
elitea-cli login --url https://dev.example.com       # skip the URL question
echo "$TOKEN" | elitea-cli login --url https://dev.example.com --token-stdin -p "My project"
```

| Option | Meaning |
|---|---|
| `--url <url>` | EliteA server URL |
| `--env <name>` | Log in to this saved environment |
| `-p, --project <id\|name>` | Project to use (otherwise you pick it from a list) |
| `--token-stdin` | Read the token from stdin instead of asking |
| `--no-browser` | Don't open the token page in a browser |
| `--allow-http` | Allow a plain `http://` server when there is no terminal to confirm |

### `logout`

```sh
elitea-cli logout              # forget the token of the active environment
elitea-cli logout --env prod   # ... of another environment
elitea-cli logout --all        # ... of all environments
```

The environment itself (URL, project, model choices) stays saved.

### `status`

```sh
elitea-cli status          # environment, server, user, project, model choices
elitea-cli status -o json
```

### `projects` / `project`

```sh
elitea-cli projects                 # list your projects, the active one marked
elitea-cli projects --json
elitea-cli project                  # pick the active project from a list
elitea-cli project 12               # switch by id
elitea-cli project "Team project"   # switch by name
```

### `models`

```sh
elitea-cli models          # models available in the active project
elitea-cli models --json
```

## Agents

### `agents` / `agents list`: list

Lists agents and pipelines in the project, newest first. All pages are fetched.
Columns: `ID NAME TYPE STATUS DESCRIPTION`.

```sh
elitea-cli agents                                      # everything
elitea-cli agents list --type agent                    # classic agents only
elitea-cli agents list --type pipeline                 # pipelines only
elitea-cli agents list -s review                       # name contains "review"
elitea-cli agents list --tag jira --tag qa             # has both tags
elitea-cli agents list --status published --status draft
elitea-cli agents list --mine --limit 5 -o json
```

| Option | Meaning |
|---|---|
| `--type <agent\|pipeline>` | Only agents or only pipelines (default: both) |
| `-s, --search <text>` | Only items whose name matches the text |
| `--tag <name>` | Only items with this tag. Repeatable: all given tags must match |
| `--status <status>` | Only items with a version in this status: `draft`, `published`, `on_moderation`, `rejected`, `user_approval`, `unpublished`. Repeatable |
| `--mine` | Only items you authored |
| `--limit <n>` | Show at most n items |
| `-p`, `-o`, `--json` | See [shared options](#options-shared-by-most-commands) |

### `agents get <agent>`: show configuration

Shows the agent and one of its versions: model, instructions, toolkits, skills and variables.
In text mode only the first 20 lines of the instructions are shown. JSON and YAML carry everything.

```sh
elitea-cli agents get "Code reviewer"                        # default version
elitea-cli agents get "Code reviewer" --agent-version v2     # another version, by name or id
elitea-cli agents get "Code reviewer" -o json > reviewer.json
```

| Option | Meaning |
|---|---|
| `--agent-version <name\|id>` | Version to show (default: the default version) |
| `-o json\|yaml` | The version object exactly as EliteA returns it, plus `cli: {default_version, agent}` |

### `agents versions <agent>`: list versions

```sh
elitea-cli agents versions "Code reviewer"
elitea-cli agents versions 42 -o json
```

Columns: `ID NAME STATUS DEFAULT AUTHOR CREATED`. `*` in `DEFAULT` marks the default version.

### `agents run <agent> [message]`: run once

Sends one message to the agent in a **new private conversation**, waits for the answer and prints
it. Made for scripts and CI. See [Running from scripts](#running-agents-and-pipelines-from-scripts)
for the JSON output and exit codes.

```sh
elitea-cli agents run "Code reviewer" "Review this function: ..."
elitea-cli agents run "Code reviewer" -f diff.txt            # input from a file
git diff | elitea-cli agents run "Code reviewer" -f -        # input from stdin
elitea-cli agents run 42 "Hi" --var language=uk --var tone=short
elitea-cli agents run 42 "Hi" --agent-version v2 --timeout 10
elitea-cli agents run 42 "Nightly report" --no-wait          # print the conversation id, don't wait
elitea-cli agents run 42 "Hi" -o json | jq -r .answer
```

| Option | Meaning |
|---|---|
| `[message]` / `-f, --file <path>` | The input: as an argument, from a file, or from stdin with `-f -`. Required, must not be empty |
| `--agent-version <name\|id>` | Version to run (default: the default version) |
| `--var <key=value>` | Set a variable of the version for this run only. Repeatable. Unknown names exit 2 and list the version's variables |
| `--timeout <minutes>` | Stop waiting after this long, 1–240 (default: `ELITEA_CLI_TIMEOUT`, then `config set timeout`, else 30). The run itself goes on |
| `--no-wait` | Return as soon as EliteA accepts the message: prints the conversation id (exit 0) |
| `-o json\|yaml` | `{status, answer, conversation_id, conversation_url, agent, version}` |

### `agents chat [agent] [message]`: chat

```sh
elitea-cli agents chat                              # pick an agent, then chat interactively
elitea-cli agents chat "Code reviewer"              # interactive chat with this agent
elitea-cli agents chat "Code reviewer" "Hi" --json  # one question, one answer: {answer, conversation_id, agent}
elitea-cli agents chat "Code reviewer" "And the tests?" -c 1234   # continue conversation 1234
```

| Option | Meaning |
|---|---|
| `--agent-version <name>` | Agent version (default: the default version) |
| `-c, --conversation <id>` | Continue an existing conversation |
| `--json` | One-shot mode: print `{answer, conversation_id, agent}` |

Commands inside the interactive chat:

| Command | |
|---|---|
| `/new` | Start a new conversation with the same agent |
| `/agent` | Switch to another agent |
| `/help` | Show these commands |
| `/exit`, `/quit` | Leave |

Use `chat` to talk to an agent and `run` to call it from scripts: `run` always starts a new
conversation, has a timeout, `--var`, `--no-wait` and exit codes for every outcome.

## Pipelines

`pipelines …` work like the matching `agents …` commands, with the same options, but only on
pipelines.

### `pipelines list`

```sh
elitea-cli pipelines list
elitea-cli pipelines list -s release --status published -o json
```

Options: `-s`, `--tag`, `--status`, `--mine`, `--limit`, `-p`, `-o`, the same as in
[`agents list`](#agents--agents-list-list).

### `pipelines get <pipeline>`

Shows the pipeline, one of its versions and its **whole** YAML.

```sh
elitea-cli pipelines get "Release notes"
elitea-cli pipelines get "Release notes" --agent-version v3
elitea-cli pipelines get "Release notes" --yaml-only > release-notes.yaml   # just the YAML
elitea-cli pipelines get "Release notes" -o json
```

| Option | Meaning |
|---|---|
| `--agent-version <name\|id>` | Version to show (default: the default version) |
| `--yaml-only` | Print only the pipeline YAML, e.g. to save it as a file |
| `-o json\|yaml` | The version object exactly as EliteA returns it |

### `pipelines versions <pipeline>`

```sh
elitea-cli pipelines versions "Release notes"
```

Columns: `ID NAME STATUS DEFAULT AUTHOR CREATED`.

### `pipelines run <pipeline> [input]`

Runs the pipeline once in a new private conversation and prints its output. A pipeline needs input:
running it without any exits with code 2.

```sh
elitea-cli pipelines run "Release notes" "Changes since 1.4"
elitea-cli pipelines run "Release notes" -f changes.md
cat changes.md | elitea-cli pipelines run "Release notes" -f -
elitea-cli pipelines run "Release notes" -f changes.md --var version=1.5 -o json | jq -r .answer
```

Options: `-f`, `--agent-version`, `--var`, `--timeout`, `--no-wait`, `-p`, `-o`, the same as in
[`agents run`](#agents-run-agent-message-run-once).

## Agents and pipelines as files

Keep agents and pipelines in Git, review changes as code, and apply them to an environment
without the UI. Files use **EliteA's own JSON shape**; a YAML file is the same structure.
Examples: [examples/agent.yaml](examples/agent.yaml), [examples/pipeline.yaml](examples/pipeline.yaml).

Every command here except `pipelines validate` changes something: a viewer gets exit 4, and a
scoped token needs the `build` operation. Editors and admins can run them, and so can the owner of a
personal project.

### `create`

```sh
elitea-cli agents create -f examples/agent.yaml
elitea-cli agents create -f reviewer.json -q            # prints only the new id
cat agent.yaml | elitea-cli agents create -f -
elitea-cli pipelines create -f examples/pipeline.yaml
elitea-cli pipelines create --name "Release notes" --yaml release-notes.yaml [--model gpt-5-mini] [--description "…"]
```

Prints `Created agent "<name>" (<id>), version base (<version id>)`; `-o json` prints the object EliteA
returns. The file is sent as EliteA's create body. A file without `versions` gets one `base`
version from its top-level `instructions`, `llm_settings`, `agent_type`, `tools`, `variables`, … so
`{name, instructions, llm_settings}` is enough. Fields the file leaves out are not sent: EliteA's
defaults apply (a classic agent; `pipelines create` sets `agent_type: pipeline`). `llm_settings` is
required by EliteA; `{}` (or no `--model`) uses the project's default model.

A file that is not valid JSON or YAML fails before anything is sent (`<file>: not valid JSON or YAML
(line N: …)`, exit 2). EliteA's own refusals (two versions, a version not named `base`, broken
pipeline YAML, too many conversation starters) are printed one per line, exit 6. A name already used
by another agent or pipeline is allowed by EliteA: the item is created and a note goes to stderr.

### `update`

```sh
elitea-cli agents get "Code reviewer" -o yaml > reviewer.yaml       # edit reviewer.yaml
elitea-cli agents update "Code reviewer" -f reviewer.yaml --dry-run  # unified diff, nothing sent
elitea-cli agents update "Code reviewer" -f reviewer.yaml
elitea-cli agents update 42 -f v2.yaml --agent-version v2
elitea-cli pipelines update "Release notes" --yaml release-notes.yaml   # only the pipeline YAML
```

Changes one version (`--agent-version`, default: the default version) and prints
`Updated <name>/<version>`. The file is what `get -o json|yaml` prints; the server's fields in it
(`id`, `author`, `created_at`, `status`, `instructions_sha256`, `cli`, …) are ignored. Only the
fields that differ from the version are sent, and **fields the file leaves out keep their value**.
A file never renames a version.

- **Toolkits are not changed by `update`** (EliteA attaches them separately). A `tools` list that
  differs from the attached toolkits prints `The file changes the attached toolkits (<now> → <file>);
  update does not change toolkits` on stderr; use `agents toolkits add|remove`.
- A published version can't be changed: EliteA's text and `Create a new version with
  elitea-cli agents version create`, exit 6.
- Before saving, the version is read again. If someone saved it since (its instructions changed),
  you are asked `… was changed on the server since you opened it. Overwrite?`. Outside a terminal,
  or on no, nothing is sent (exit 6); `--yes` overwrites.

### `edit`

```sh
elitea-cli agents edit "Code reviewer"            # the version as YAML
elitea-cli pipelines edit "Release notes"         # only the pipeline YAML
```

Opens the version in `$VISUAL`, else `$EDITOR`, else `vi` (`notepad` on Windows). Saving and closing
sends the change; closing without a change prints `No changes`. The file is created with mode 0600 in
the OS temp folder and deleted afterwards. For pipelines the YAML is checked with
`pipelines validate` first: errors block the save, warnings don't. When EliteA refuses the change you
are asked `Edit again?`; on no, your edits stay in the temp file, whose path is printed (exit 6).

`edit` needs a terminal; in scripts use `update -f`. An editor that exits non-zero saves nothing
(exit 1); a file saved empty saves nothing (exit 2).

### `version create` / `version default`

```sh
elitea-cli agents version create "Code reviewer" v2              # copy of the default version
elitea-cli agents version create "Code reviewer" v3 --from v2 -q # prints only the new version id
elitea-cli agents version default "Code reviewer" v2             # `agents versions` marks it *
```

The new version is a copy of `--from` (default: the default version): instructions, model,
variables, toolkits and skills. A name the item already has exits 6.

### `delete`

```sh
elitea-cli agents delete "Code reviewer"                         # the agent and all its versions
elitea-cli agents delete "Code reviewer" --agent-version v1      # one version
elitea-cli agents delete 42 --agent-version v1 --replace-with v2 --yes
```

Asks for confirmation (see [Deleting and overwriting](#deleting-and-overwriting)). Deleting a version
also disables its schedules. EliteA refuses to delete the default version, the `base` version and
published versions. It also refuses a version other agents or pipelines use, and the CLI then adds
`Pass --replace-with <version> to move them to another version first`. A whole agent with a published
version is refused too ("Unpublish first"); otherwise it is deleted with its webhooks, even when other
agents use it. `pipelines delete` refuses a classic agent.

### `pipelines validate`

```sh
elitea-cli pipelines validate -f release-notes.yaml
elitea-cli pipelines validate -f release-notes.yaml -o json      # EliteA's {valid, errors, warnings}
```

Nothing is saved, and viewers may run it. Prints one line per problem, then `Valid` or
`N error(s), M warning(s)`:

```
ERROR draft.transitions [unknown_transition_target]: Node 'draft' has a transition to 'reviw' which does not exist. Check the node id spelling.
WARN draft.llm_settings.model_name [llm_no_model]: LLM node 'draft' has no model_name in llm_settings. The pipeline's LLM settings will be used as a fallback.
1 error(s), 1 warning(s)
```

Exit code: 0 when valid (warnings allowed), 6 when not.

## Credentials

Credentials (Jira, GitHub, AI provider keys, …) can be prepared by script without a secret ever
reaching the screen, the shell history or Git. A stored secret cannot be read back: `get`, `list`
and every `-o json|yaml` print secret fields as `****`, and `--debug` masks them too.

```sh
elitea-cli credentials types                       # TYPE, TITLE, SECTION, FIELDS (* required, (secret))
elitea-cli credentials types --type jira -o json   # the type's full schema
elitea-cli credentials list [--type github]        # ID, TITLE, TYPE, SCOPE, STATUS
elitea-cli credentials get "Jira EL"               # every field; secrets as ****
```

`SCOPE` is `project`, `personal` (your personal project) or `shared` (shared from the public
project). `STATUS` is the result of the last check EliteA stored (`ok`, `failed`, `unknown`); `list`
runs no check. Name a credential by id, title (`elitea_title`) or label.

### `create` / `update`

The file uses EliteA's shape. Leave secret fields **out of the file**:

```yaml
# jira-cred.yaml
elitea_title: jira_el        # unique id: letters, digits, _
label: Jira EL
type: jira
data:
  base_url: https://jira.example.com
  username: ada
```

```sh
printf %s "$JIRA_TOKEN" | elitea-cli credentials create -f jira-cred.yaml --secret api_key
elitea-cli credentials create -f jira-cred.yaml --secret-env api_key=JIRA_TOKEN
elitea-cli credentials create -f jira-cred.yaml --secret api_key      # in a terminal: masked prompt
```

- `--secret <field>` asks with a masked prompt in a terminal; otherwise it reads stdin (one
  trailing newline is dropped), so only one `--secret` works without a terminal: give the others
  with `--secret-env`.
- `--secret-env <field>=<VAR>` takes the value from an environment variable; unset or empty → exit 2.
- No option takes a secret value itself (it would land in the shell history).
- A secret field with a value in the file → `Secret field must come from --secret or --secret-env,
  not from the file`, exit 2, nothing sent. `****` in the file → exit 2 as well.

`update` changes only what the file gives; everything else, secrets included, keeps its stored
value. A file from `credentials get -o yaml` works once its `****` lines are removed. A field set to
`null` is cleared. Before saving, the CLI reads the credential again: if someone changed it in
between, it prints `<title> was changed by someone else; run the command again` (exit 6) and sends
nothing.

```sh
elitea-cli credentials update jira_el -f jira-cred.yaml
printf %s "$NEW_TOKEN" | elitea-cli credentials update jira_el -f jira-cred.yaml --secret api_key
```

EliteA's refusals (a duplicate title, a missing required field, an admin-managed type, a team
sign-in only project admins may change) are printed as EliteA words them, exit 6. A credential
shared from another project is changed in that project (`-p <id>`).

### `test` / `delete`

```sh
elitea-cli credentials test "Jira EL"      # Connection OK (exit 0) / Connection failed: <reason> (exit 1)
elitea-cli credentials delete jira_el      # asks first; --yes in scripts
```

`test` needs the permission to use secrets: without it EliteA answers 403 (exit 4). Deleting a
credential that toolkits use is not refused; those toolkits fail until they get another one.

OAuth types that need a browser sign-in (Teams, Outlook, SharePoint, Dataverse, …) can be created
from the CLI, but the CLI does not sign in: `get` and `test` print `Sign-in required: open ELITEA →
Credentials → <title> to sign in (<link>)`.

## Toolkits

A toolkit is a configured integration (Jira, GitHub, an MCP server, …) that agents use as tools.
Secret settings are handled as for credentials: never shown (`****` in every output and in
`--debug`), never taken from a file or the command line.

```sh
elitea-cli toolkits types                 # TYPE, TITLE, CREDENTIAL, TOOLS (--mcp: MCP types)
elitea-cli toolkits types jira            # settings (* required, secret), the credential field, the tools
elitea-cli toolkits types jira -o json    # {credential_field, settings, tools, schema}
elitea-cli toolkits list [--type jira] [--search text] [--mcp]   # ID, NAME, TYPE, CREDENTIAL
elitea-cli toolkits get "Jira EL"         # settings, credential, tools with SELECTED yes/no
elitea-cli toolkits tools "Jira EL"       # NAME, DESCRIPTION, SELECTED
```

A type the project cannot use (blocked on this server, or missing because a platform dependency
is not installed) → `Toolkit type <t> is not available in this project`, exit 5. Name a toolkit by
id or name.

### `create` / `update`

```yaml
# jira-toolkit.yaml
type: jira
name: Jira EL
credential: Jira EL                 # a credential title or label
settings:
  limit: 10
  selected_tools: [search_using_jql, create_issue]   # omitted or []: every tool
```

```sh
elitea-cli toolkits create -f jira-toolkit.yaml          # Created toolkit Jira EL (115)
elitea-cli toolkits update "Jira EL" -f changes.yaml     # only the settings given change
elitea-cli toolkits create -f squad.yaml --secret-env access_key=SQUAD_KEY
```

- `credential:` is looked up among this project's credentials first, then your personal ones,
  then those shared from the public project; only credentials of the type the toolkit needs count.
  No match → `Credential <title> not found in project <id>`, two at the same level → `matches
  several`, both exit 5, nothing created. Setting the field yourself (`settings.jira_configuration:
  {elitea_title, private}`) works too.
- Secret settings (`toolkits types <type>` marks them) come from `--secret <setting>` or
  `--secret-env <setting>=<VAR>`, as for credentials. A value in the file or `****` → exit 2.
- An unknown tool in `selected_tools` → exit 6, nothing sent. EliteA's refusals (a missing required
  setting, a blocked type, sharing rules) are printed as EliteA words them, exit 6.
- `update` keeps every setting the file leaves out, secrets included; `null` clears a setting. If
  someone changed the toolkit since it was read, exit 6 and nothing is sent.

### `test` / `delete`

```sh
elitea-cli toolkits test "Jira EL" search_using_jql --args '{"jql": "project = EL", "limit": 5}'
elitea-cli toolkits test 115 create_issue --args-file issue.json --yes -o json
elitea-cli toolkits delete "Jira EL"
```

`test` runs the tool once on EliteA against the real service, so in a terminal it asks first
(`Run <tool> on <toolkit>? It may change data in <service>.`); `--yes` skips the question and is
required without a terminal (exit 2 otherwise). It prints the tool's result (exit 0) or its error
(exit 1); `--timeout <seconds>` (default 300) → exit 8. `-o json`: `{ok, result, error, tool, toolkit}`.

`delete` asks first. EliteA does not refuse to delete a toolkit agents use: it removes it from
every agent version, published ones too, and does not say which ones.

### Attaching toolkits to agents

```sh
elitea-cli agents toolkits add "Release bot" "Jira EL" --tools search_using_jql,create_issue
elitea-cli agents toolkits remove "Release bot" "Jira EL" --agent-version v2
```

`add` attaches the toolkit to the default version (or `--agent-version`) with all the tools the
toolkit has selected, or only those in `--tools`: `Attached <toolkit> to <agent>/<version> (<n>
tools)`. Already attached → said, exit 0, nothing changed; to change the tools, `remove` and `add`
again. A tool the toolkit doesn't have → exit 6. `remove` of a toolkit that is not attached → exit 5.
A published version cannot change (exit 6, create a version first); if someone attached or detached
it in between → exit 6. Pipelines name their toolkits in the pipeline YAML (`pipelines update --yaml`).

## Chats

Every `agents run`, `pipelines run` and `agents chat` creates a private chat, which also shows in
the EliteA web UI. The `chats` commands take the **numeric** chat id that `chats list` shows (and
that `run --no-wait -q` prints); a uuid exits 2 without sending a request.

```sh
id=$(elitea-cli agents run Reviewer -f diff.txt --no-wait -q)
elitea-cli chats show "$id" --last 1                     # later: the answer
elitea-cli chats send "$id" "And the tests?" -o json | jq -r .answer
elitea-cli chats list -s review
elitea-cli chats delete 1234 1235 --yes
```

### `chats list`

The chat list of the web UI: public chats of the project and the private ones you are in (all
of them for a project admin), most recently updated first. Columns: `ID NAME PARTICIPANTS
UPDATED RUNNING`: `PARTICIPANTS` are the agents in it, `UPDATED` is local time, `RUNNING` is
`yes` while a reply is being written. `--search <text>` matches the name, `--limit N` (default
20) caps the rows. `-o json|yaml`: `[{id, uuid, name, agents[{id, name, project_id}], created_at,
updated_at, running, private, author_id, messages}]`. No chats → `No chats found` on stderr, `[]`.

### `chats show <id>`

Prints each message as `<author> (<YYYY-MM-DD HH:MM>):` and its full text, oldest first: the last
20 by default, `--last N`, or `--all` (not both). A reply still being written is marked
`(still running)`; one whose run died is `(never finished)`. A failed reply shows its error's last
line. `-o json|yaml`: `[{id, author, author_type, created_at, text, is_streaming, error?}]`. A chat
that does not exist, is in another project or is not visible to you → `Chat not found`, exit 5.

### `chats send <id> [message]`

`agents run` on an existing chat: the same input (`[message]`, `-f <file>`, `-f -`), `--timeout`,
`--no-wait`, output, JSON shape and exit codes (see
[Running from scripts](#running-agents-and-pipelines-from-scripts)). A chat with several agents
needs `--to <agent>` (name or id); a chat without an agent exits 2. A chat whose reply is still
being written is refused (`Chat is still running…`, exit 6) and nothing is sent. Two `send`s
started at the same moment can both pass that check: EliteA itself does not refuse the second.
`agents chat <agent> -c <id> "<message>"` sends the same request.

### `chats delete <id>…`

Asks `Delete chat '<name>' (<id>)? Files created by skill scripts in it are deleted too.` (or,
while it runs, `Chat '<name>' (<id>) is still running. Delete it anyway?…`); `--yes` skips it and
is required without a terminal. Several ids are asked about once; a failure on one does not stop
the others, and the summary prints `Deleted: …` and `Failed: <id> (<reason>)`. Exit 0 when all
were deleted, else the code of the first failure. Only the chat's author (or a project admin) may
delete it: others get 403, exit 4.

## Running agents and pipelines from scripts

```sh
elitea-cli pipelines run "Release notes" -f changes.md -o json | jq -r .answer
git diff | elitea-cli agents run "Code reviewer" -f - --timeout 10
id=$(elitea-cli agents run 42 "Nightly report" --no-wait)   # returns at once
```

`run` starts a new private conversation each time. The answer goes to stdout; notes for people
(the conversation link, errors) go to stderr, so `$(…)` and pipes only get the answer.

`-o json` prints:

```json
{
  "status": "finished",
  "answer": "…",
  "conversation_id": 1234,
  "conversation_url": "https://<server>/…",
  "agent": { "id": 42, "name": "Code reviewer", "type": "openai" },
  "version": { "id": 7, "name": "base" }
}
```

| `status` | Meaning | Exit code |
|---|---|---|
| `finished` | The agent answered | 0 |
| `running` | Accepted, not waited for (`--no-wait`) | 0 |
| `failed` | The run failed on EliteA | 1 |
| `timeout` | `--timeout` passed; the run goes on on EliteA | 8 |
| `waiting_for_input` | The agent waits for a human approval (or an MCP login) in EliteA | 8 |

The timeout defaults to `ELITEA_CLI_TIMEOUT`, then `config set timeout …`, else 30 minutes.
Stopping to wait (timeout, approval, Ctrl-C) never cancels the run on EliteA: open
`conversation_url` to see how it ends.

### Exit codes

Every command (except `status` and `launch`, below) ends with one of these:

| Exit code | |
|---|---|
| 0 | Success (or accepted, with `--no-wait`) |
| 1 | Any other error: the run failed, EliteA unreachable or busy (503), an unexpected server error |
| 2 | Usage: unknown flag, missing argument, bad value, confirmation or terminal needed outside a terminal |
| 3 | Not logged in, or the token was rejected or expired |
| 4 | Forbidden (403): your role or the token's scope doesn't allow this |
| 5 | Not found (404), or a name (agent, pipeline, version, project, environment) that matches nothing or several |
| 6 | Validation or conflict (400, 409, 422): each field error is printed as `<field>: <message>` |
| 7 | A limit or budget was reached (429); `Retry after N s` when EliteA says when |
| 8 | Still running, or waiting for input, on EliteA |
| 130 | Ctrl-C |

`status` exits 1 in every not-logged-in state; `launch` exits with the coding agent's exit code.

### Errors

| EliteA answers | elitea-cli prints |
|---|---|
| 403 | `Forbidden: <EliteA's message>` and `The token may lack permissions, or your role in project <id> does not allow this` |
| 403 `TOKEN_SCOPE_*` (scoped token) | `This token is not allowed to do this (<code>). Create a token with the '<build\|run>' operation for project <id>` |
| 429 | EliteA's own text (budget, run cap…) and `Retry after N s`; "budget … exhausted" only for a budget limit |
| 400 / 409 / 422 | One `<field>: <message>` line per field |
| 503 | GET: retried once after `retry_after` (at most 30 s). POST/PUT/PATCH/DELETE: `EliteA is busy (503); nothing was retried — try again` |
| no answer | `Cannot reach <url>: <reason>` |

### Deleting and overwriting

Commands that delete, remove, revoke or overwrite ask `<Action> <type> '<name>' (<id>)?` in a
terminal; only `y`/`yes` continues. `--yes` skips the question. Outside a terminal without `--yes`
they fail with exit 2 and change nothing. `-q` never skips the question.

## Calling the API directly: `api`

For anything that has no command yet. `api` calls the active environment with the stored token
and prints the response as is (JSON pretty-printed).

```sh
elitea-cli api GET /api/v2/auth/user/
elitea-cli api GET '/api/v2/elitea_core/applications/prompt_lib/{project}' -F limit=5 | jq '.rows[].name'
elitea-cli api POST '/api/v2/elitea_core/conversations/prompt_lib/{project}' -f body.json
echo '{"name":"x"}' | elitea-cli api PUT /api/v2/... -f -
```

| Option | Meaning |
|---|---|
| `-f, --file <path>` | Request body from a file; `-` reads stdin |
| `-F, --field key=value` | Repeatable. GET/DELETE: query parameters; POST/PUT/PATCH: a JSON body. Numbers and `true`/`false`/`null` are typed |
| `-H, --header 'Name: value'` | Extra header (repeatable). `Authorization` is refused |
| `-i, --include` | Also print the status line and response headers (stderr) |
| `-O, --output-file <path>` | Write the response body to a file |
| `-p, --project <id\|name>` | The project `{project}` stands for (default: the active one) |

`<path>` starts with `/`; a full URL is accepted only on the environment's own origin, so the token
is never sent anywhere else. Redirects are not followed. An error status prints EliteA's raw
error body to stderr and exits with the code for that status (table above).

## Settings: `config`

```sh
elitea-cli config list             # value and source of every setting
elitea-cli config set output json  # default -o of list/get commands
elitea-cli config set timeout 60   # minutes `run` waits
elitea-cli config unset timeout
```

| Setting | Values | Default | Environment variable (wins) |
|---|---|---|---|
| `output` | `table`, `json`, `yaml` | `table` | `ELITEA_CLI_OUTPUT` |
| `color` | `auto`, `never` | `auto` | `NO_COLOR` |
| `timeout` | 1–240 (minutes) | 30 | `ELITEA_CLI_TIMEOUT` |

Settings apply to all environments. An unknown key or value exits 2 and lists the allowed values.

## Shell completion

```sh
elitea-cli completion zsh > "${fpath[1]}/_elitea-cli"                               # zsh, then restart the shell
elitea-cli completion bash > ~/.local/share/bash-completion/completions/elitea-cli  # bash
elitea-cli completion fish > ~/.config/fish/completions/elitea-cli.fish            # fish
elitea-cli completion powershell >> $PROFILE                                         # PowerShell
```

## Launching Claude Code and Codex

```sh
elitea-cli launch claude                         # pick models on first run, then start
elitea-cli launch codex                          # the same for Codex
elitea-cli launch claude -m <model>              # use this model (saved for next time)
elitea-cli launch claude --pick                  # choose models again
elitea-cli launch codex -p "Team project"        # another project for this launch only
elitea-cli launch claude --check                 # test token, models and one model call; don't start
elitea-cli launch claude --print                 # show the env and command, don't start
elitea-cli launch claude -- -p "explain this repo"       # everything after -- goes to the agent
elitea-cli launch codex -- exec "fix the failing test"
```

| Option | Meaning |
|---|---|
| `-m, --model <name>` | Model to use (saved for next time) |
| `--fast-model <name>` | Small model for Claude Code's background tasks (the haiku slot) |
| `--pick` | Choose models again interactively |
| `-p, --project <id\|name>` | Use this project for this launch only; the active project and its model choices stay |
| `--env <name>` | Use this saved environment (server) for this launch only |
| `--check` | Check the token and the project's models, then make one tiny model call through `/llm` in the agent's own format: `OK <model> <ms>` or the error, exit 0 or 1. Starts nothing; for support and CI smoke tests |
| `--print` | Print the environment and command instead of launching (token redacted); saves nothing |
| `-- <args>` | Passed to the agent unchanged |

The model you choose is remembered per agent and project. elitea-cli never writes to `~/.claude`,
`~/.codex` or your shell profile: everything is passed to the agent for this run only, so your own
Claude Code or Codex setup works unchanged after the session.

### Claude Code

What you get: Claude Code on your project's models (`/model` lists only them), the opus and sonnet
slots and subagents on the main model, the haiku slot on the fast model, and the EliteA context:
the `elitea` skill, `/elitea:*` commands, your user and project in the system prompt, so Claude can
list, run, create and change your EliteA agents, pipelines, chats, toolkits and credentials (see
[EliteA agents inside Claude Code](#elitea-agents-inside-claude-code)).

What you don't get: claude.ai connectors (Claude Code says they are disabled while an EliteA
token is in use) and auto mode, which EliteA does not implement.

### Codex

What you get: Codex CLI on your project's models through EliteA's `/llm/v1` (responses API), with
its tools, sandbox and file edits working as usual. Every model of the project is offered, the
OpenAI ones first: EliteA translates the format, so Claude models work in Codex too.

What you don't get: the EliteA context. Codex knows nothing about your EliteA agents, pipelines or
chats; use `elitea-cli launch claude` for that, or run `elitea-cli …` commands yourself. Codex's
image generation tool is turned off (EliteA's deployments refuse it).

### Before the agent starts

`launch` checks, in this order, and starts nothing when one fails:

| Check | Message | Exit |
|---|---|---|
| The agent is installed | `<agent> is not installed. Install it with: …` | 1 |
| It is the tested version or newer (Claude Code 2.1.284, Codex 0.139.0) | `<agent> <v> is older than the oldest tested version …` | 1 |
| You are logged in | In a terminal: the login flow, then the launch goes on. Otherwise: `Not logged in — run elitea-cli login or set ELITEA_CLI_URL and ELITEA_CLI_TOKEN` | 3 |
| The token still works | `Your ELITEA token for <environment> has expired — run elitea-cli login` | 3 |
| The project has models | `No models in project <id> work with <agent>. Ask your project admin to add a model.` | 1 |
| `-m` / `-p` name something that exists | `Model "<m>" is not available…` / `Project "<p>" not found…` | 5 |

Once the agent runs, `launch` exits with the agent's own exit code.

### Errors during a session

The agent shows these itself, as EliteA's `/llm` gateway answers them:

| What happened | `/llm` answers | What to do |
|---|---|---|
| Token expired or revoked | 401 `auth_error` | `elitea-cli login`, then launch again |
| Model removed from the project, or not available to it | 403 `team_model_access_denied` | `elitea-cli launch <agent> --pick` |
| Your role or the token's scope doesn't allow the project | 403 | Ask your project admin, or log in with another token |
| Project or member budget used up | 429 `budget_exceeded` | Ask your project admin to raise the budget |
| Rate limit | 429 | Wait and retry; the agent usually retries by itself |

`elitea-cli launch <agent> --check` runs the same call the agent makes and prints which of these
you are hitting.

### In CI and scripts

No saved login is needed: set the server and token, name the model, and pass the agent's
non-interactive arguments after `--`. Nothing is prompted and nothing is written to disk; the
personal project is used unless `ELITEA_CLI_PROJECT` names another.

```sh
export ELITEA_CLI_URL=https://next.elitea.ai ELITEA_CLI_TOKEN="$ELITEA_PAT" ELITEA_CLI_PROJECT=12
elitea-cli launch claude --check -m global.anthropic.claude-sonnet-5-5       # smoke test
elitea-cli launch claude -m global.anthropic.claude-sonnet-5-5 -- -p "Summarize the changes in this PR"
elitea-cli launch codex -m global.openai.gpt-5.6-terra -- exec --sandbox workspace-write "fix the failing test"
```

## Environments

Each EliteA server you log in to is saved as a named **environment** with its own user, active
project, model choices and token. There is no default server: the first `login` asks for the URL
and a name (default: the host, e.g. `dev.example.com`, `localhost-8080`).

```sh
elitea-cli login                       # pick a saved environment or add a new one
elitea-cli env list                    # * marks the active one
elitea-cli env use dev                 # switch
elitea-cli --env prod agents           # one command against another environment
```

The environment is chosen by `--env` > `ELITEA_CLI_ENV` > `ELITEA_CLI_URL` > the active one. There is
one environment per server (`host[:port]`), and a token stored for one server is never sent to another.
Plain `http://` servers other than localhost need a confirmation (or `--allow-http` in scripts).
The 0.1.0 config is converted on first run; the old file is kept as `~/.elitea-cli/config.v1.json`.

In CI, no saved config is needed: `ELITEA_CLI_URL=https://<your-server> ELITEA_CLI_TOKEN=… elitea-cli agents`.

## How it works

- **Claude Code** gets environment variables: `ANTHROPIC_BASE_URL=<eliteA>/llm`, bearer token,
  `X-Project-Id` header, and your models for the opus/sonnet/haiku slots. It also gets the EliteA
  context (below) through command-line flags.
- **Codex** gets `-c` overrides only: a model provider pointing at `<eliteA>/llm/v1` (responses
  API) with the bearer token from an environment variable and the `X-Project-Id` header, and a model
  catalog of your project's models built from the installed Codex's own (written to
  `~/.elitea-cli/codex-models.json`). `~/.codex/config.toml` is never read for this or changed.

The token is stored in the OS keychain (falls back to `~/.elitea-cli/credentials.json`, mode 0600).

## EliteA agents inside Claude Code

In any folder, `elitea-cli launch claude` starts Claude Code that knows your EliteA user and
project and can run your EliteA agents:

```
> what agents do we have?
> ask the Attach 2 agent to review src/payments/refund.ts
> /elitea:chat "Attach 2" and now check the tests too
```

Claude runs `elitea-cli agents list --json`, `elitea-cli agents chat <agent> "<message>" --json` and
`elitea-cli pipelines run <pipeline> "<input>" -o json` through its Bash tool and reuses the conversation for follow-ups. The agent runs on EliteA and
sees only the message Claude sends it (Claude includes the code it needs), not your files.

| Slash command | |
|---|---|
| `/elitea:agents [search] [--project …]` | Agents and pipelines in the project |
| `/elitea:projects` | Your projects, the active one marked |
| `/elitea:chat <agent> <message>` | Send a message to an agent and show its answer |
| `/elitea:toolkits [toolkit \| type \| search]` | Toolkits in the project, or one toolkit's tools |

Toolkits work from the chat too ("give the Release bot agent the Jira EL toolkit with only
search"): Claude reads the type with `toolkits types`, writes the file, and runs `toolkits create`
and `agents toolkits add`, each after your OK. It never writes a secret into a file: for a secret
setting it gives you the `--secret-env` command to run yourself. Before `toolkits test` it names the
tool and its arguments and waits for your OK, because the tool acts on the real service.

What `launch` adds to the `claude` command line (nothing is written into `~/.claude`):
- `--append-system-prompt`: server, user and active project;
- `--plugin-dir ~/.elitea-cli/claude-plugin`: the `elitea` skill and the slash commands;
- `--settings` permissions: only read commands run without a prompt (`status`, `projects`,
  `models`, `agents` / `agents list|get|versions`, `pipelines list|get|versions|validate`,
  `toolkits list|get|types|tools`, `credentials list|get|types`, `chats list|show`, `env list`).
  Every other `elitea-cli` command asks: running or chatting with an agent (budget, write tools),
  creating, changing or deleting anything, `api`, `login`, `env`/`config` changes. There is no
  `agents:*`-style prefix, so a new verb such as `agents delete` can never run unasked;
- `PATH`: `~/.elitea-cli/bin/elitea-cli`, a shim that runs the same elitea-cli build. The token is
  not passed; the shim reads it from the store. `ELITEA_CLI_ENV` names the launch's environment,
  so Claude's calls go to the same server.

## Environment

| Variable | |
|---|---|
| `ELITEA_CLI_ENV` | Use this saved environment (like `--env`) |
| `ELITEA_CLI_URL` | Use the environment of this server, or a temporary unsaved one (CI) |
| `ELITEA_CLI_TOKEN` | Use this token for the selected environment instead of the stored one (CI) |
| `ELITEA_CLI_PROJECT` | Override the project id of the selected environment |
| `ELITEA_CLI_HOME` | Config directory (default `~/.elitea-cli`) |
| `ELITEA_CLI_NO_KEYCHAIN` | Store the token in a file instead of the keychain |
| `ELITEA_CLI_OUTPUT` | Default `-o` of list/get commands (`table`, `json`, `yaml`) |
| `ELITEA_CLI_TIMEOUT` | Minutes `run` waits (1–240) |
| `NO_COLOR` | No ANSI colours |
| `ELITEA_CLI_DEBUG` | Same as `--debug` |

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/cli.js
```
