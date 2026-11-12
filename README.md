# elitea-cli

Run Claude Code on top of [EliteA](https://next.elitea.ai) —
like `ollama launch`, but the models come from your EliteA project.

```sh
npm install -g @eliteaai/elitea-cli

elitea-cli login            # enter your EliteA server URL, paste a personal access token, pick a project
elitea-cli launch claude    # Claude Code
```

## Commands

| Command | |
|---|---|
| `elitea-cli login [--url <url>] [--env <name>] [--project <id\|name>] [--token-stdin] [--allow-http]` | Log in to an EliteA server with a personal access token and pick a project |
| `elitea-cli logout [--env <name>] [--all]` | Forget the stored token (the environment stays) |
| `elitea-cli status [-o json]` | Show environment, server, user, project and saved model choices |
| `elitea-cli env list [-o json]` / `env add <name> --url <url>` / `env use <name>` / `env remove <name> [--yes]` | Manage saved environments (servers) |
| `elitea-cli projects` / `elitea-cli project [id\|name]` | List projects / switch the active project |
| `elitea-cli models` | Models available in the active project |
| `elitea-cli agents [list] [--type agent\|pipeline] [--search text] [--tag name]… [--status s]… [--mine] [--limit n] [-o json\|yaml]` | Agents and pipelines in the project, newest first |
| `elitea-cli agents get <agent> [--agent-version name\|id] [-o json\|yaml]` | An agent's configuration: model, instructions, toolkits, skills, variables |
| `elitea-cli agents versions <agent>` | Versions of an agent (`*` = default) |
| `elitea-cli agents run <agent> [message] [-f file\|-] [--timeout min] [--no-wait] [--var k=v]… [-o json\|yaml]` | Run an agent once and print its answer (for scripts and CI) |
| `elitea-cli agents chat [agent] [message] [-c conversation] [--agent-version name] [--json]` | Chat with an agent: interactive without a message, one answer with one |
| `elitea-cli pipelines list\|get\|versions\|run …` | The same for pipelines only; `pipelines get --yaml-only` prints the YAML |
| `elitea-cli launch claude [-m model] [--fast-model model] [--pick] [--print] [-- agent args]` | Start an agent wired to EliteA |

The model you choose is remembered per agent; `--pick` chooses again. Everything after `--` goes
to the agent unchanged, e.g. `elitea-cli launch claude -- -p "explain this repo"`.
`--print` shows the environment and command instead of running it (token redacted).

All commands take `-p <project>` to work in another project without switching the active one.

## Running agents and pipelines from scripts

```sh
elitea-cli pipelines run "Release notes" -f changes.md -o json | jq -r .answer
git diff | elitea-cli agents run "Code reviewer" -f - --timeout 10
id=$(elitea-cli agents run 42 "Nightly report" --no-wait)   # returns at once
```

`run` starts a new private conversation each time. `-o json` prints
`{status, answer, conversation_id, conversation_url, agent, version}`; `status` is `finished`,
`failed`, `timeout`, `waiting_for_input` (a human approval in EliteA) or `running` (`--no-wait`).
The timeout defaults to `settings.timeout` in `~/.elitea-cli/config.json`, else 30 minutes.
Stopping to wait (timeout, approval, Ctrl-C) never cancels the run on EliteA.

| Exit code | |
|---|---|
| 0 | Done (or accepted, with `--no-wait`) |
| 1 | The run failed, or another error |
| 2 | Bad usage: missing or empty input, bad option value |
| 3 | Not logged in, or the token was rejected |
| 4 | Access denied (your role or token lacks the permission) |
| 5 | Unknown or ambiguous agent, pipeline, version or environment |
| 6 | Conflict, or EliteA refused the input |
| 8 | Still running, or waiting for input, on EliteA |
| 130 | Ctrl-C |

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
