# elitea-cli — local test run

elitea-cli is not published to npm yet (`npm view elitea-cli` → 404, item A11 in `BACKLOG.md`), so run it
from this folder.

## Prerequisites

- Node.js ≥ 20
- Claude Code — a recent version (the POC was tested on 2.1.284; older versions may not know the env vars elitea-cli sets)
- Codex CLI — only if you test `launch codex`
- An EliteA personal access token (PAT) from `https://next.elitea.ai`

## 1. Install dependencies and build

```sh
cd elitea-cli
npm install
npm test && npm run typecheck && npm run build   # produces dist/cli.js
```

> **If `npm test` fails with `Cannot find native binding` / `@rolldown/binding-…`** — the
> `package-lock.json` is missing rolldown's platform binaries (npm optional-dependencies bug,
> https://github.com/npm/cli/issues/4828). Regenerate the lockfile:
>
> ```sh
> rm -rf node_modules package-lock.json && npm install
> ```

## 2. Update Claude Code / install Codex

```sh
claude update                    # or: brew upgrade claude-code
npm install -g @openai/codex     # optional, for launch codex
```

## 3. Create an EliteA personal access token

On `https://next.elitea.ai` → settings → personal tokens. Expected route:
`/app/settings/create-personal-token` (not yet verified in a browser — item A2).

Never commit the token or paste it into chats.

## Shortcut: npm scripts

These rebuild `dist/` and run with the isolated test environment from step 4 already set — no
`export` needed:

```sh
npm run elitea-cli:login      # paste the token, pick a project
npm run elitea-cli:status     # check user / project
npm run elitea-cli:models     # available models
npm run elitea-cli:agents     # EliteA agents (-- --search <text>, -- --json)
npm run elitea-cli:agent-chat # pick an agent and chat (/help, /new, /agent, /exit)
npm run elitea-cli:projects   # list projects
npm run elitea-cli:claude     # interactive Claude Code
npm run elitea-cli:codex      # Codex
npm run elitea-cli:logout     # forget the token
npm run elitea-cli:reset      # delete /tmp/elitea-cli-home and start over
```

Pass options after `--`, and agent arguments after a second `--`:

```sh
npm run elitea-cli:claude -- --pick                 # choose models again
npm run elitea-cli:claude -- -- -p "say hi"         # headless answer
npm run elitea-cli -- launch claude --print         # any other command
npm run elitea-cli:agent-chat -- "Attach 2" "say hi"  # one answer, then exit
npm run elitea-cli:agent-chat -- 2 "and now?" -c 11   # follow-up in conversation 11
```

## 4. (Optional) Isolate the test environment

```sh
export ELITEA_CLI_HOME=/tmp/elitea-cli-home ELITEA_CLI_NO_KEYCHAIN=1
```

By default `login` stores:

| What | Where |
|---|---|
| Settings (URL, user, project, chosen models) | `~/.elitea-cli/config.json` |
| Token | macOS Keychain (service `elitea-cli`) |

- `ELITEA_CLI_HOME` — config goes to `/tmp/elitea-cli-home/config.json` instead of `~/.elitea-cli`.
- `ELITEA_CLI_NO_KEYCHAIN=1` — token goes to `/tmp/elitea-cli-home/credentials.json` (mode 0600) instead of the Keychain.

Why: test runs leave no traces on the system; to start over, `rm -rf /tmp/elitea-cli-home`.
For a casual try-out you can skip this step.

Caveats:
- `export` only applies to the current terminal window — set it again in a new window, otherwise
  elitea-cli will say you are not logged in.
- `/tmp` is cleared on reboot — you will need to `login` again.
- In the file the token is stored in plain text (protected only by mode 0600); the Keychain is safer.

## 5. Log in

```sh
node dist/cli.js login          # paste the token (hidden input), pick a project
node dist/cli.js status         # check user / project
node dist/cli.js models         # available models
node dist/cli.js agents         # EliteA agents in the project
```

Non-interactive: `printf %s "$PAT" | node dist/cli.js login --token-stdin`.

## 6. Inspect what the agent will get (without running it)

```sh
node dist/cli.js launch claude --print     # env + command, token redacted
node dist/cli.js launch codex --print
```

## 7. Real run

```sh
node dist/cli.js launch claude -- -p "say hi"     # single headless answer
node dist/cli.js launch claude                    # interactive Claude Code
node dist/cli.js launch codex -- exec --skip-git-repo-check "say hi"
```

On the first `launch` elitea-cli asks for a model and remembers it per agent; `--pick` chooses again.
elitea-cli options go anywhere; agent arguments go **only after `--`**.

### EliteA agents from inside Claude Code

`launch claude` also gives Claude the EliteA context: the session line (user, project), the
`elitea` plugin (skill + `/elitea:agents`, `/elitea:projects`, `/elitea:chat`) and `elitea-cli`
on its PATH. npm scripts always run in the elitea-cli folder, so to try it in **another folder**
call `dist/cli.js` by its absolute path (or `npm link`, step 8):

```sh
mkdir -p /tmp/x && cd /tmp/x
ELITEA_CLI_HOME=/tmp/elitea-cli-home ELITEA_CLI_NO_KEYCHAIN=1 node ~/…/elitea-cli/dist/cli.js launch claude
```

Then ask: "Which EliteA project are we in?", "What agents do we have?", "Ask Attach 2 what 2+2
is, then ask it to double that". `agents chat` asks for approval every time, by design.

## 8. (Optional) Global `elitea-cli` command

```sh
npm link                   # now: elitea-cli launch claude
npm unlink -g elitea-cli   # remove
```

## Known issues

- `bedrock/converse/*` models fail with Claude Code (400 "text content blocks must be
  non-empty") — pick `eu.anthropic.*`. elitea-cli never selects them by default.
- The "claude.ai connectors are disabled…" warning when Claude Code starts is harmless.
- Odd env-var-related errors — most often an outdated Claude Code (see step 2).
- EliteA API details and gateway bugs — see `HANDOVER.md`.
