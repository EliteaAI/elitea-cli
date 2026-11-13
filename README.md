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

Claude runs `elitea-cli agents list --json`, `elitea-cli agents chat <agent> "<message>" --json` and
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
