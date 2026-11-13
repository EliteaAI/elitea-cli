# elitea-cli

Run Claude Code on top of [EliteA](https://next.elitea.ai) —
like `ollama launch`, but the models come from your EliteA project.

```sh
npm install -g @eliteaai/elitea-cli

elitea-cli login            # enter your EliteA server URL, paste a personal access token, pick a project
elitea-cli launch claude    # Claude Code
```

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
| `elitea-cli pipelines list` | List pipelines only |
| `elitea-cli pipelines get <pipeline>` | Show a pipeline's configuration and YAML |
| `elitea-cli pipelines versions <pipeline>` | List a pipeline's versions |
| `elitea-cli pipelines run <pipeline> [input]` | Run a pipeline once and print its output |
| `elitea-cli launch claude` | Start Claude Code wired to EliteA |

Every command prints its options and examples with `--help`, e.g. `elitea-cli pipelines run --help`.

### Options shared by most commands

| Option | Meaning |
|---|---|
| `--env <name>` | Run this one command against another saved environment (see [Environments](#environments)) |
| `-p, --project <id\|name>` | Use this project instead of the active one, without switching |
| `-o, --output <format>` | `text` (default), `json` or `yaml`. `--json` is the same as `-o json` |

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
| `--timeout <minutes>` | Stop waiting after this long, 1–240 (default: `settings.timeout` in the config, else 30). The run itself goes on |
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

The timeout defaults to `settings.timeout` in `~/.elitea-cli/config.json`, else 30 minutes.
Stopping to wait (timeout, approval, Ctrl-C) never cancels the run on EliteA: open
`conversation_url` to see how it ends.

### Exit codes

| Exit code | |
|---|---|
| 0 | Done (or accepted, with `--no-wait`) |
| 1 | The run failed, or another error |
| 2 | Bad usage: missing or empty input, bad option value, unknown `--var` |
| 3 | Not logged in, or the token was rejected |
| 4 | Access denied (your role or token lacks the permission) |
| 5 | Unknown or ambiguous agent, pipeline, version or environment; an agent given to `pipelines …` |
| 6 | Conflict, or EliteA refused the input (e.g. too large) |
| 8 | Still running, or waiting for input, on EliteA |
| 130 | Ctrl-C (stopped waiting; the run goes on) |

## Launching Claude Code

```sh
elitea-cli launch claude                         # pick models on first run, then start
elitea-cli launch claude -m <model>              # use this model (saved for next time)
elitea-cli launch claude --pick                  # choose models again
elitea-cli launch claude --print                 # show the env and command, don't start
elitea-cli launch claude -- -p "explain this repo"   # everything after -- goes to claude
```

| Option | Meaning |
|---|---|
| `-m, --model <name>` | Model to use (saved for next time) |
| `--fast-model <name>` | Small model for Claude Code's background tasks |
| `--pick` | Choose models again interactively |
| `--print` | Print the environment and command instead of launching (token redacted) |
| `-- <args>` | Passed to `claude` unchanged |

The model you choose is remembered per agent.

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

The token is stored in the OS keychain (falls back to `~/.elitea-cli/credentials.json`, mode 0600).

## EliteA agents inside Claude Code

In any folder, `elitea-cli launch claude` starts Claude Code that knows your EliteA user and
project and can run your EliteA agents:

```
> what agents do we have?
> ask the Attach 2 agent to review src/payments/refund.ts
> /elitea:chat "Attach 2" and now check the tests too
```

Claude runs `elitea-cli agents --json`, `elitea-cli agents chat <agent> "<message>" --json` and
`elitea-cli pipelines run <pipeline> "<input>" -o json` through its Bash tool and reuses the conversation for follow-ups. The agent runs on EliteA and
sees only the message Claude sends it (Claude includes the code it needs), not your files.

| Slash command | |
|---|---|
| `/elitea:agents [search] [--project …]` | Agents and pipelines in the project |
| `/elitea:projects` | Your projects, the active one marked |
| `/elitea:chat <agent> <message>` | Send a message to an agent and show its answer |

What `launch` adds to the `claude` command line (nothing is written into `~/.claude`):
- `--append-system-prompt`: server, user and active project;
- `--plugin-dir ~/.elitea-cli/claude-plugin`: the `elitea` skill and the slash commands;
- `--settings` permissions: `elitea-cli status/projects/models/agents/pipelines` run without a prompt;
  `agents chat`, `agents run` and `pipelines run` always ask, because they run a remote agent,
  spend budget and the agent may have write tools;
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

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/cli.js
```
