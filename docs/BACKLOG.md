# elitea-cli — backlog

Starting point: a **proof of concept** (see `HANDOVER.md`). It proves the approach works end to end
for Claude Code and Codex on next.elitea.ai. It has not been hardened: no CI, no release, macOS-only
manual testing, one EliteA account tested.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks. Priority: **P0** needed for a first internal
release, **P1** next, **P2** later. IDs are stable; reference them in tickets/PRs.

## Epic A — Productionize the POC (P0)

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| A1 | Repo hygiene: first commit, CI (lint + typecheck + test + build on macOS/Linux/Windows, Node 20/22/24) | S | PRs blocked on red CI; ESLint/Prettier added and clean |
| A2 | Verify the login token page in a browser | S | `elitea-cli login` opens a page where a PAT can actually be created; fix the route (`/app/settings/create-personal-token`) if wrong |
| A3 | Test the interactive paths (project search, model pickers, Ctrl-C) | M | Tests using a mocked prompt layer cover: first launch picks + saves models, `--pick` re-prompts, saved model missing from the catalog → re-prompt, Ctrl-C exits 130 with no config written |
| A4 | Token expiry during use | S | Agent gets a 401/302 from EliteA → elitea-cli (or `status`) says "token expired, run `elitea-cli login`". Check up front: `launch` validates the token before spawning (it already hits the catalog; make the error message explicit) |
| A5 | Project switch clears stale model choices | S | `elitea-cli project X` drops or re-validates `integrations.*` models not in X's catalog (today it's only handled lazily at launch) |
| A6 | `--print` must not persist model choices | S | `launch … --print -m M` leaves config unchanged |
| A7 | Cache the Codex catalog | S | `codex debug models --bundled` runs only when the Codex version or EliteA catalog changes (key: codex `--version` + catalog hash) |
| A8 | Linux keychain fallback | S | On headless Linux without Secret Service, login stores to the 0600 file with a one-line notice; tested in CI |
| A9 | Windows support for `launch claude/codex` | M | Binary lookup (`.cmd`/`.exe`, npm global dirs), signal handling, paths; manually verified on Windows 11 |
| A10 | `elitea-cli env <agent>` | S | Prints `export …` lines (real token) for `eval "$(elitea-cli env claude)"`, for people launching agents themselves / from IDEs |
| A11 | Release: npm publish `elitea-cli`, `--version` from package.json, changelog | S | `npm i -g elitea-cli` works on a clean machine; version is not hard-coded in `cli.ts` |
| A12 | Live smoke test | M | Opt-in test (`ELITEA_CLI_E2E=1` + PAT secret) runs login → models → `launch claude -p` → `launch codex exec` against next.elitea.ai; runs nightly in CI, not on PRs |

## Epic B — Local gateway (P1, blocks C and D)

Needed because desktop apps can't send `X-Project-Id` / use EliteA model names. Design notes in
`HANDOVER.md` → "Next: Phase 2/3 notes".

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| B1 | `elitea-cli serve`: loopback HTTP server with health endpoint | M | Binds 127.0.0.1 only; rejects requests with `Origin`; `GET /_elitea-cli/health` 204; port configurable, default fixed |
| B2 | Anthropic passthrough | M | `/anthropic/v1/messages` and `count_tokens` forwarded to `<url>/llm/v1/…` with Bearer PAT + `X-Project-Id`; SSE streamed without buffering; token read from store per request (re-login needs no restart) |
| B3 | Anthropic `/v1/models` with Claude slot IDs | M | Returns Anthropic-shaped list (`id`, `display_name`, `anthropic_family_tier`, …) for opus/sonnet/haiku slots; `messages` rewrites slot ID → mapped EliteA model; mapping stored in config |
| B4 | Run as login item | M | `elitea-cli service install/uninstall/status`; launchd LaunchAgent on macOS, scheduled task on Windows; survives reboot; logs to `~/.elitea-cli/logs` |
| B5 | Gateway security review | S | No token in logs; loopback + Origin checks tested; local API key required |

## Epic C — `elitea-cli launch cowork` (Claude Desktop, P1)

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| C1 | Spike: what Cowork needs from the gateway | S | Written answer: does Cowork work with `/v1/messages` + `/v1/models` only, or does it also need web search / files / server tools? Go/no-go for C2 |
| C2 | Configure Claude Desktop 3p profile (macOS) | M | Writes `deploymentMode:"3p"`, `_meta.json` entry and our profile (own UUID, not Ollama's) using `writeWithBackup`; unknown keys preserved; gateway health checked first |
| C3 | Restart handling | S | Quit the app → wait for exit → rewrite config (the app saves on quit) → reopen; asks before quitting a running app |
| C4 | `--restore` | S | Back to `deploymentMode:"1p"`, our entry/profile removed, the user's other entries untouched |
| C5 | Windows paths | M | `%LOCALAPPDATA%\Claude*` and `Claude Nest*` variants written |

## Epic D — `elitea-cli launch chatgpt` (ChatGPT/Codex desktop app, P1)

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| D1 | Gateway Codex router | L | `/codex/v1/responses`: allow-listed EliteA models → `<url>/llm/v1/responses` with the Codex workarounds (drop `image_generation` tool, force `reasoning.summary`, zstd decode); everything else passed to OpenAI unchanged (`ChatGPT-Account-ID` → chatgpt.com backend, else api.openai.com); WebSocket upgrade → 426 |
| D2 | Configure `~/.codex/config.toml` root keys | M | Sets `openai_base_url` + `model_catalog_json` (native catalog + EliteA models); removes root `model_provider`; saves previous values to a restore file; never overwrites an existing `auth.json` |
| D3 | Restart + `--restore` | S | Same pattern as C3/C4; restore puts back the previous `openai_base_url` (on the POC machine it pointed at Ollama) |
| D4 | User's own ChatGPT models keep working | S | Manual test: after launch, a native OpenAI model and an EliteA model both answer in the app |

## Epic E — More agents (P2)

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| E1 | opencode | S | `OPENCODE_CONFIG_CONTENT` inline config with `@ai-sdk/openai-compatible`, base URL, headers, model limits; no files written |
| E2 | Factory Droid | S | Tagged `customModels` entries merged into `~/.factory/settings.json`; restore removes only ours |
| E3 | GitHub Copilot CLI, Cline, others | M each | Following the Ollama integration list; one adapter + test each |
| E4 | Offer to install missing agents | S | On "not installed", ask and run the official installer; `--yes` for headless |

## Epic F — OAuth login (P2, blocked on EliteA)

| ID | Story | Size | Acceptance criteria |
|---|---|---|---|
| F1 | EliteA: public OIDC client + token acceptance | — | EliteA registers a public client in realm `next` (device code and/or loopback PKCE) and the API accepts Keycloak tokens or exchanges them for a short-lived PAT |
| F2 | `elitea-cli login` via device code / browser | M | No token pasting; refresh token stored in keychain; PAT flow kept as `--token-stdin` fallback |
| F3 | Token refresh | M | Short-lived tokens refreshed transparently; CLI agents go through the gateway (B2) so they never hold an expiring token |

## Epic G — Asks for the EliteA team (not our code)

| ID | Ask | Why |
|---|---|---|
| G1 | Fix `bedrock/converse/*` rejecting Claude Code requests ("text content blocks must be non-empty") | It's the platform's **default** model; elitea-cli currently avoids it for Claude |
| G2 | Fix `reasoning.effort` → `thinking` mapping for `gpt-5.6-*` | 400 unless a summary is requested |
| G3 | Azure `gpt-5.4`: accept or strip the `image_generation` tool | Codex sends it by default |
| G4 | Confirm `X-Project-Id` is the supported header and how usage is billed for models in the public project | Current behaviour is inferred |
| G5 | Unknown project id → error instead of silent fallback | Avoids billing to the wrong project |
| G6 | Implement Claude Code's auto-mode classifier endpoint (optional) | Removes a warning, enables the newer auto mode |

## Known POC shortcuts

- Model family is guessed from the model name (`/anthropic|claude/`, `/openai|gpt/`); fine for today's catalog.
- The personal project is detected by `personal_project_id`; the project list endpoint is the one the
  web UI uses, not a documented API.
- `logout` clears only the token for the configured URL.
- No telemetry and no update check (on purpose, for now).
