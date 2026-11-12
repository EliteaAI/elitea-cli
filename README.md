# elitea-cli

Run Claude Code on top of [EliteA](https://next.elitea.ai) —
like `ollama launch`, but the models come from your EliteA project.

```sh
npm install -g @eliteaai/elitea-cli

elitea-cli login            # paste a personal access token, pick a project
elitea-cli launch claude    # Claude Code
```

## Commands

| Command | |
|---|---|
| `elitea-cli login [--project <id\|name>] [--url <url>] [--token-stdin]` | Log in with an EliteA personal access token and pick a project |
| `elitea-cli logout` | Forget the stored token |
| `elitea-cli status` | Show server, user, project and saved model choices |
| `elitea-cli projects` / `elitea-cli project [id\|name]` | List projects / switch the active project |
| `elitea-cli models` | Models available in the active project |
| `elitea-cli agents [--search text] [--project id\|name] [--json]` | EliteA agents in the active project |
| `elitea-cli agents chat [agent] [message] [-c conversation] [--agent-version name] [--json]` | Chat with an agent: interactive without a message, one answer with one |
| `elitea-cli launch claude [-m model] [--fast-model model] [--pick] [--print] [-- agent args]` | Start an agent wired to EliteA |

The model you choose is remembered per agent; `--pick` chooses again. Everything after `--` goes
to the agent unchanged, e.g. `elitea-cli launch claude -- -p "explain this repo"`.
`--print` shows the environment and command instead of running it (token redacted).

## How it works

- **Claude Code** gets environment variables: `ANTHROPIC_BASE_URL=<eliteA>/llm`, bearer token,
  `X-Project-Id` header, and your models for the opus/sonnet/haiku slots. It also gets the EliteA
  context (below) through command-line flags.

The token is stored in the OS keychain (falls back to `~/.elitea-cli/credentials.json`, mode 0600).

## EliteA agents inside Claude Code

In any folder, `elitea-cli launch claude` starts Claude Code that knows your EliteA user and
project and can run your EliteA agents and pipelines:

```
> what agents do we have?
> ask the Attach 2 agent to review src/payments/refund.ts
> /elitea:chat "Attach 2" and now check the tests too
```

Claude runs `elitea-cli agents --json` and `elitea-cli agents chat <agent> "<message>" --json`
through its Bash tool and reuses the conversation for follow-ups. The agent runs on EliteA and
sees only the message Claude sends it (Claude includes the code it needs), not your files.

| Slash command | |
|---|---|
| `/elitea:agents [search] [--project …]` | Agents and pipelines in the project |
| `/elitea:projects` | Your projects, the active one marked |
| `/elitea:chat <agent> <message>` | Send a message to an agent and show its answer |

What `launch` adds to the `claude` command line (nothing is written into `~/.claude`):
- `--append-system-prompt`: server, user and active project;
- `--plugin-dir ~/.elitea-cli/claude-plugin`: the `elitea` skill and the slash commands;
- `--settings` permissions: `elitea-cli status/projects/models/agents` run without a prompt;
  `agents chat` always asks, because it runs a remote agent, spends budget and the agent may
  have write tools;
- `PATH`: `~/.elitea-cli/bin/elitea-cli`, a shim that runs the same elitea-cli build. The token is
  not passed; the shim reads it from the store.

## Environment

| Variable | |
|---|---|
| `ELITEA_CLI_TOKEN` | Use this token instead of the stored one (CI) |
| `ELITEA_CLI_PROJECT` | Override the active project id |
| `ELITEA_CLI_URL` | Override the EliteA server URL |
| `ELITEA_CLI_HOME` | Config directory (default `~/.elitea-cli`) |
| `ELITEA_CLI_NO_KEYCHAIN` | Store the token in a file instead of the keychain |

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/cli.js
```
