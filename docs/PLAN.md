# elitea-cli — plan

`ollama launch`, but the LLM provider is EliteA (`next.elitea.ai`). Node.js/TypeScript CLI that
authenticates the user against EliteA and launches coding agents / desktop apps wired to it.

```
elitea-cli login | logout | status
elitea-cli projects | models
elitea-cli launch claude | codex | cowork | chatgpt   [--model M] [--project P] [--config] [--restore] [-- args]
elitea-cli serve                 # local gateway (needed by desktop apps)
elitea-cli service install|uninstall|status   # run the gateway as a login item
```

## Verified facts (2026-09-29, real PAT)

**Auth.** Only EliteA personal access tokens work (`Authorization: Bearer <PAT>`, `x-api-key` → 401).
Keycloak (`ai-auth.elitea.ai/auth/realms/next`) has no public client and the API rejects Keycloak
tokens, so OAuth needs EliteA-side changes (see Later).

**Platform API used by login:**

| Call | Returns |
|---|---|
| `GET /api/v2/auth/user` | `{id, name, email, personal_project_id}` — validates the PAT |
| `GET /api/v2/projects/project/default/<pid>?check_public_role=true` | user's projects `[{id, name}]` (id 1 = `promptlib_public`) |
| `GET /api/v2/configurations/models/<pid>?include_shared=true` | models with `display_name, context_window, max_output_tokens, supports_reasoning, supports_vision` + default / low-tier / high-tier model names |

**LLM gateway** (`/llm/v1`, LiteLLM): `/models`, `/messages` (+ `count_tokens`, streaming, tools,
thinking, prompt caching), `/responses`, `/chat/completions` all work. `X-Project-Id` selects the
project and changes the model set; an unknown project silently falls back → validate client-side.

**Claude Code:** works with env vars only (no proxy).
**Codex CLI 0.139:** works with `-c` overrides, but requires (a) our own `model_catalog_json`
(full schema), (b) `features.image_generation=false` (Azure gpt-5.4 rejects the tool),
(c) `model_reasoning_summary=auto` (gpt-5.6-* 400s on `thinking` otherwise — EliteA/LiteLLM bug, report it).

## Status

- **Phase 1 done (2026-09-29):** `login / logout / status / projects / project / models / launch claude|codex`.
  Verified end to end on next.elitea.ai: Claude Code (Sonnet 5) and Codex (GPT-5.6-Terra) complete a
  tool-using task through `elitea-cli launch`.
- Changed vs. the original plan: login picks only the project; models are chosen per agent on
  first `launch` (remembered, `--pick` to change), since each agent wants a different family.
- Found during testing: `bedrock/converse/*` models fail with Claude Code ("text content blocks
  must be non-empty", LiteLLM Converse route) → never used as Claude's default; report to EliteA.
  `/api/v2/auth/user` needs the trailing slash (308 otherwise).

## `elitea-cli login` flow

1. Server URL (default `https://next.elitea.ai`, `--url` to override).
2. Explain + open browser at the tokens settings page; user creates a PAT and pastes it (hidden input).
   Non-interactive: `--token-stdin`, or `ELITEA_CLI_TOKEN` env.
3. Validate via `/api/v2/auth/user` → "Logged in as <name> <email>".
4. Fetch projects → searchable picker, default = `personal_project_id`. `--project` skips it.
5. Fetch model catalog for that project → pick default model (preselect EliteA's default /
   high-tier), plus a small/fast model (preselect low-tier) for Claude's haiku slot.
6. Save: PAT in OS keychain (`@napi-rs/keyring`, fallback `~/.elitea-cli/credentials.json` mode 0600);
   everything else in `~/.elitea-cli/config.json`.

`elitea-cli status` re-validates the token and shows user / project / models; expired or revoked PAT →
clear message to re-run login.

## Integrations

| Target | How | Gateway? |
|---|---|---|
| `claude` (Claude Code) | env: `ANTHROPIC_BASE_URL=<url>/llm`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`, `ANTHROPIC_CUSTOM_HEADERS="X-Project-Id: N"`, opus/sonnet/haiku/subagent model vars, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from catalog, telemetry off. Spawn `claude --model M`, stdio inherit. | No |
| `codex` (Codex CLI) | `-c` overrides only (never edits user config): `model_providers.elitea-cli{base_url, wire_api="responses", env_key, http_headers}`, `model_catalog_json=~/.elitea-cli/codex-models.json` (generated from EliteA catalog), `features.image_generation=false`, `model_reasoning_summary=auto`. | No |
| `cowork` (Claude Desktop, chat + Cowork) | Claude Desktop "3p" mode: `deploymentMode:"3p"` in `Claude/` and `Claude-3p/claude_desktop_config.json`; own entry in `Claude-3p/configLibrary/_meta.json` + profile `{inferenceProvider:"gateway", inferenceGatewayBaseUrl:"http://127.0.0.1:<port>", inferenceGatewayAuthScheme:"bearer", coworkEgressAllowedHosts:["*"], telemetry off}`. Quit app → rewrite after exit (app saves config on quit) → reopen. | **Yes** |
| `chatgpt` (ChatGPT/Codex desktop app) | `~/.codex/config.toml` root keys: `openai_base_url=http://127.0.0.1:<port>/codex/v1`, `model_catalog_json` = native catalog + EliteA models; routing allow-list file; restore file with previous values. Keeps the user's ChatGPT models working. | **Yes** |
| later: `opencode`, `droid`, `copilot` | env / inline config, same pattern as Ollama | No |

**Why desktop apps need a gateway:** Claude Desktop cannot send custom headers (no `X-Project-Id`),
expects Anthropic-shaped `/v1/models` with Claude model IDs (5 fixed picker slots), and the ChatGPT
app has a single `openai_base_url` shared with the user's own OpenAI models, so routing must be per model.

## Local gateway (`elitea-cli serve`)

Plain Node `http` + `undici`, loopback only, rejects requests with `Origin`, random local key.
Reads PAT from keychain on every request (re-login takes effect without restart).

- `GET /_elitea-cli/health`
- **Anthropic side** (`/anthropic/v1/...`, for Claude Desktop):
  - `/v1/models` → Anthropic list with slot IDs (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-…`)
    mapped to user-chosen EliteA models, `display_name` = EliteA display name.
  - `/v1/messages`, `/v1/messages/count_tokens` → rewrite slot → real model, inject
    `Authorization: Bearer <PAT>` + `X-Project-Id`, stream through untouched.
- **Codex side** (`/codex/v1/...`, for ChatGPT app): models on the elitea-cli allow-list → EliteA
  `/llm/v1/responses` with fixes (drop `image_generation` tool, force `reasoning.summary`, zstd
  decode); everything else passed through to `chatgpt.com/backend-api/codex` / `api.openai.com`
  unchanged (same rule as Ollama: `ChatGPT-Account-ID` header decides).

Desktop apps outlive the `elitea-cli launch` command, so the gateway runs as a login item:
launchd LaunchAgent on macOS (`~/Library/LaunchAgents/ai.elitea.elitea-cli.plist`), Scheduled
Task on Windows. `launch cowork|chatgpt` installs/starts it if needed and checks health first.

## Safety rules for config edits (copied from Ollama)

- Prefer env / `-c` / inline config; write files only when unavoidable.
- Merge JSON/TOML, never overwrite unknown keys; backup to `~/.elitea-cli/backup/<tool>/` first;
  write temp + rename; tag own entries (own profile UUID, `elitea-cli` names) so `--restore` removes only ours.
- Never touch an existing `~/.codex/auth.json`.
- Coexist with Ollama: different profile UUID / file names. `chatgpt` takes over `openai_base_url`
  (currently Ollama's on this machine) and records the old value so `--restore` puts it back.

## Stack

TypeScript, Node ≥ 20, ESM, `commander`, `@inquirer/prompts`, `@napi-rs/keyring`, `smol-toml`,
`undici`, `open`; `vitest` for tests; `tsup` build; published to npm (check the name — "elitea-cli"
is also an Emacs package).

## Phases

1. **Core + CLI agents** — scaffold, config/keychain, EliteA client, `login/logout/status/projects/models`,
   `launch claude`, `launch codex` (+ catalog generation), adapter registry, safe file writer.
   Done = both agents run on a fresh machine after `elitea-cli login` only.
2. **Gateway + Cowork** — `elitea-cli serve` Anthropic side, `service install`, `launch cowork` (macOS
   first) with restart + restore. Spike first: does Cowork need anything beyond `/v1/messages`
   (web search / files / server tools)? Does the model picker accept our slot mapping?
3. **ChatGPT app** — gateway Codex side + routing, native catalog merge, `launch chatgpt` + restore.
4. **Polish** — Windows paths, opencode/droid, auto-install missing agents, `--yes` headless mode,
   npm publish.

## Later / needs EliteA

- OAuth: public Keycloak client (device code or loopback PKCE) in realm `next` + API accepting
  Keycloak tokens or a token→PAT exchange endpoint. Then the gateway also refreshes tokens.
- Fix LiteLLM `reasoning` → `thinking` mapping for gpt-5.6-*.
- Fix Bedrock Converse route rejecting Claude Code requests (empty text blocks).
- Optionally: implement Claude Code's auto-mode classifier endpoint on the gateway.
