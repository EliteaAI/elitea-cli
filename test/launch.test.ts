import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The login flow is mocked: AC-6 only checks that launch hands over to it and goes on.
const login = vi.hoisted(() => ({ calls: [] as unknown[], onLogin: undefined as undefined | (() => Promise<void>) }));
vi.mock("../src/commands/login.js", () => ({
  loginCommand: async (opts: unknown) => {
    login.calls.push(opts);
    await login.onLogin?.();
  },
}));

const prompts = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("@inquirer/prompts", async (orig) => ({
  ...(await orig<typeof import("@inquirer/prompts")>()),
  select: async ({ message, default: d }: { message: string; default?: unknown }) => {
    prompts.asked.push(message);
    return d;
  },
}));

import { NOT_LOGGED_IN, agentCatalog, launchCommand, slotQuestion, versionAtLeast } from "../src/commands/launch.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { resetContext } from "../src/context.js";
import { tokenStore } from "../src/credentials.js";
import { EXIT, exitCodeOf } from "../src/errors.js";
import { claude } from "../src/integrations/claude.js";
import { codex } from "../src/integrations/codex.js";
import { catalog } from "./fixtures.js";

const URL_ = "https://elitea.test";
const P = 4;
const OTHER_P = 19;
const TOKEN = "tok-0123456789abcdef";

let dir: string;
let logs: string[];
let errors: string[];
let calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: Record<string, unknown> }>;
let w: { tokenOk: boolean; catalogs: Record<number, typeof catalog>; probeStatus: number; probeBody: unknown };

function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const raw = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, headers: (init?.headers ?? {}) as Record<string, string>, body: raw ? JSON.parse(raw) : undefined });
      const json = (data: unknown, status = 200) => Response.json(data, { status });
      if (!w.tokenOk) return new Response(null, { status: 302, headers: { location: `${URL_}/forward-auth/login` } });
      if (url.pathname === "/api/v2/auth/user/") return json({ id: 7, name: "Ada", email: "ada@a.test", personal_project_id: 9 });
      if (url.pathname.startsWith("/api/v2/projects/project/default/")) return json([{ id: P, name: "Team" }, { id: OTHER_P, name: "Other" }, { id: 9, name: "project_user_7" }]);
      const m = url.pathname.match(/^\/api\/v2\/configurations\/models\/(\d+)$/);
      if (m) return json(w.catalogs[Number(m[1])] ?? { items: [] });
      if (url.pathname.startsWith("/llm/v1/")) return json(w.probeBody, w.probeStatus);
      return new Response("unexpected", { status: 500 });
    }),
  );
}

/** A fake agent: prints its version, records its args and env, exits with $FAKE_EXIT. */
async function fakeAgent(name: string, version: string): Promise<string> {
  const bin = join(dir, "bin", name);
  await writeFile(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "debug" ]; then echo '{"models":[{"slug":"gpt-5.4","context_window":1}]}'; exit 0; fi\nprintf '%s\\n' "$@" > "${dir}/${name}.args"\nenv > "${dir}/${name}.env"\nexit \${FAKE_EXIT:-0}\n`,
  );
  await chmod(bin, 0o755);
  return bin;
}

async function loggedIn(project = P) {
  await saveConfig({
    active: "test",
    environments: { test: { url: URL_, user: { id: 7, name: "Ada", email: "ada@a.test" }, project: { id: project, name: "Team" }, integrations: {} } },
    settings: {},
  });
  await tokenStore.set(URL_, TOKEN);
}

function tty(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
const agentArgs = async (name: string) => (await readFile(join(dir, `${name}.args`), "utf8")).trim().split("\n");
const agentRan = async (name: string) => readFile(join(dir, `${name}.args`)).then(() => true, () => false);

beforeEach(async () => {
  resetContext();
  dir = await mkdtemp(join(tmpdir(), "elitea-cli-launch-"));
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "bin")));
  process.env.ELITEA_CLI_HOME = join(dir, "home");
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  process.env.PATH = `${join(dir, "bin")}:/usr/bin:/bin`;
  for (const v of ["ELITEA_CLI_URL", "ELITEA_CLI_TOKEN", "ELITEA_CLI_PROJECT", "ELITEA_CLI_ENV", "CI", "FAKE_EXIT", "CODEX_HOME"]) delete process.env[v];
  logs = [];
  errors = [];
  calls = [];
  login.calls = [];
  login.onLogin = undefined;
  prompts.asked = [];
  w = { tokenOk: true, catalogs: { [P]: catalog, 9: catalog, [OTHER_P]: { items: [catalog.items[5]!] } }, probeStatus: 200, probeBody: { ok: true } };
  serve();
  tty(false);
  await fakeAgent("claude", "2.1.285 (Claude Code)");
  await fakeAgent("codex", "codex-cli 0.169.0");
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
});

const savedPath = process.env.PATH;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  tty(false);
  process.env.PATH = savedPath;
  await rm(dir, { recursive: true, force: true });
  resetContext();
});

// ---------------------------------------------------------------------------------------------

describe("launch codex is listed again (AC-2)", () => {
  it("launch without a name lists claude and codex", async () => {
    expect(await launchCommand(undefined, [], {})).toBe(EXIT.usage);
    expect(logs.join("\n")).toMatch(/claude\s+Claude Code\n\s+codex\s+Codex CLI/);
  });

  it("starts Codex with the EliteA provider and says it has no EliteA agents", async () => {
    await loggedIn();
    expect(await launchCommand("codex", ["exec", "fix the failing test"], { model: "global.openai.gpt-5.6-terra" })).toBe(0);
    const args = await agentArgs("codex");
    expect(args).toContain('model_providers.elitea-cli.base_url="https://elitea.test/llm/v1"');
    expect(args.slice(-4)).toEqual(["-m", "global.openai.gpt-5.6-terra", "exec", "fix the failing test"]);
    expect(errors[0]).toMatch(/^Codex gets EliteA models only/);
    expect(errors[1]).toBe("Launching Codex CLI with GPT-5.6-Terra (environment test, project 4)");
  });

  it("returns the agent's own exit code (AC-5, AC-13)", async () => {
    await loggedIn();
    process.env.FAKE_EXIT = "3";
    expect(await launchCommand("claude", ["-p", "explain this repo"], {})).toBe(3);
    expect((await agentArgs("claude")).slice(-2)).toEqual(["-p", "explain this repo"]);
  });
});

describe("models offered to each agent (AC-3)", () => {
  it("every project model, the agent's own family first", () => {
    const forCodex = agentCatalog(catalog, codex).items.map((m) => m.name);
    expect(forCodex.slice(0, 2)).toEqual(["global.openai.gpt-5.6-luna", "global.openai.gpt-5.6-terra"]);
    expect(forCodex).toHaveLength(catalog.items.length);
    expect(agentCatalog(catalog, claude).items[0]!.name).toMatch(/anthropic/);
  });

  it("no models → the admin message, exit 1, nothing started", async () => {
    await loggedIn();
    w.catalogs[P] = { items: [] };
    const err = await failure(launchCommand("codex", [], {}));
    expect(err?.message).toBe("No models in project 4 work with Codex CLI. Ask your project admin to add a model.");
    expect(exitCodeOf(err)).toBe(EXIT.general);
    expect(await agentRan("codex")).toBe(false);
  });

  it("an unknown -m → exit 5", async () => {
    await loggedIn();
    expect(exitCodeOf(await failure(launchCommand("claude", [], { model: "nope" })))).toBe(EXIT.notFound);
  });
});

describe("first run and login (AC-6, AC-7)", () => {
  it("not logged in, no terminal → exit 3, no prompt, nothing started", async () => {
    const err = await failure(launchCommand("claude", ["-p", "hi"], {}));
    expect(err?.message).toBe(NOT_LOGGED_IN);
    expect(exitCodeOf(err)).toBe(EXIT.auth);
    expect(login.calls).toEqual([]);
    expect(await agentRan("claude")).toBe(false);
  });

  it("ELITEA_CLI_URL without a token, no terminal → the same", async () => {
    process.env.ELITEA_CLI_URL = URL_;
    expect(exitCodeOf(await failure(launchCommand("codex", [], {})))).toBe(EXIT.auth);
  });

  it("not logged in, in a terminal → the login flow, then the agent starts", async () => {
    tty(true);
    login.onLogin = () => loggedIn();
    expect(await launchCommand("claude", [], {})).toBe(0);
    expect(login.calls).toEqual([{ project: undefined, next: false }]);
    expect(await agentRan("claude")).toBe(true);
  });

  it("--check and --print never start a login", async () => {
    tty(true);
    expect(exitCodeOf(await failure(launchCommand("claude", [], { check: true })))).toBe(EXIT.auth);
    expect(exitCodeOf(await failure(launchCommand("claude", [], { print: true })))).toBe(EXIT.auth);
    expect(login.calls).toEqual([]);
  });

  it("CI: ELITEA_CLI_URL + ELITEA_CLI_TOKEN + -m, no saved config (AC-13)", async () => {
    process.env.ELITEA_CLI_URL = URL_;
    process.env.ELITEA_CLI_TOKEN = TOKEN;
    process.env.CI = "1";
    expect(await launchCommand("codex", ["exec", "hi"], { model: "global.openai.gpt-5.6-terra" })).toBe(0);
    // A temporary environment uses the personal project.
    expect(errors.at(-1)).toMatch(/project 9\)$/);
    expect((await loadConfig()).environments).toEqual({});
  });
});

describe("model picks (AC-9)", () => {
  it("first launch in a terminal asks for each slot, saying what it is for; later launches don't", async () => {
    await loggedIn();
    tty(true);
    await launchCommand("claude", [], {});
    expect(prompts.asked).toEqual([
      "Main model for Claude Code: your conversation, the opus and sonnet slots and subagents",
      "Fast model: background tasks and quick steps (Claude Code's haiku slot)",
    ]);
    prompts.asked = [];
    await launchCommand("claude", [], {});
    expect(prompts.asked).toEqual([]);
    expect(slotQuestion(codex, "main")).toBe("Model for Codex CLI: every request of the session");
  });
});

describe("checks before launching (AC-8, AC-10, AC-14)", () => {
  it("not installed → install hint, exit 1", async () => {
    await rm(join(dir, "bin", "codex"));
    const err = await failure(launchCommand("codex", [], {}));
    expect(err?.message).toBe("Codex CLI is not installed. Install it with:\n  npm install -g @openai/codex");
    expect(exitCodeOf(err)).toBe(EXIT.general);
  });

  it("older than the tested version → update hint, exit 1", async () => {
    await fakeAgent("codex", "codex-cli 0.100.0");
    const err = await failure(launchCommand("codex", [], {}));
    expect(err?.message).toMatch(/^Codex CLI 0\.100\.0 is older than the oldest tested version 0\.139\.0\. Update it:/);
    expect(exitCodeOf(err)).toBe(EXIT.general);
    expect(versionAtLeast("2.1.300", "2.1.284")).toBe(true);
    expect(versionAtLeast("2.0.99", "2.1.284")).toBe(false);
    expect(versionAtLeast("weird", "2.1.284")).toBe(true);
  });

  it("an expired token → the message of AC-10, exit 3, the agent does not start", async () => {
    await loggedIn();
    w.tokenOk = false;
    const err = await failure(launchCommand("claude", [], {}));
    expect(err?.message).toBe("Your ELITEA token for test has expired — run `elitea-cli login`");
    expect(exitCodeOf(err)).toBe(EXIT.auth);
    expect(await agentRan("claude")).toBe(false);
  });
});

describe("--check (AC-12)", () => {
  it("one tiny call per model in the agent's format, OK <model> <ms>, nothing started", async () => {
    await loggedIn();
    expect(await launchCommand("claude", [], { check: true, model: "eu.anthropic.claude-sonnet-5", fastModel: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" })).toBe(0);
    const probes = calls.filter((c) => c.path.startsWith("/llm/"));
    expect(probes.map((c) => [c.path, c.body?.model, c.headers["X-Project-Id"], c.headers["anthropic-version"]])).toEqual([
      ["/llm/v1/messages", "eu.anthropic.claude-sonnet-5", "4", "2023-06-01"],
      ["/llm/v1/messages", "eu.anthropic.claude-haiku-4-5-20251001-v1:0", "4", "2023-06-01"],
    ]);
    expect(logs.map((l) => l.replace(/\d+ ms$/, "N ms"))).toEqual(["OK eu.anthropic.claude-sonnet-5 N ms", "OK eu.anthropic.claude-haiku-4-5-20251001-v1:0 N ms"]);
    expect(await agentRan("claude")).toBe(false);
  });

  it("Codex probes /llm/v1/responses; a refused model → the platform's error, exit 1", async () => {
    await loggedIn();
    w.probeStatus = 403;
    w.probeBody = { error: { message: "The requested model is not available for this API key", type: "team_model_access_denied" } };
    expect(await launchCommand("codex", [], { check: true, model: "global.openai.gpt-5.6-terra" })).toBe(EXIT.general);
    expect(calls.find((c) => c.path.startsWith("/llm/"))?.path).toBe("/llm/v1/responses");
    expect(errors).toEqual([
      "FAIL global.openai.gpt-5.6-terra: /llm/v1/responses answered HTTP 403 — The requested model is not available for this API key (team_model_access_denied)",
    ]);
  });

  it("--check does not save a -m choice", async () => {
    await loggedIn();
    await launchCommand("codex", [], { check: true, model: "global.openai.gpt-5.6-terra" });
    expect((await loadConfig()).environments.test!.integrations).toEqual({});
  });
});

describe("--env, -p and --print (AC-15, AC-16)", () => {
  it("-p uses another project for this launch only: header, nothing saved", async () => {
    await loggedIn();
    expect(await launchCommand("codex", [], { project: "Other", model: "global.openai.gpt-5.6-terra" })).toBe(0);
    expect((await agentArgs("codex")).join(" ")).toContain('"X-Project-Id" = "19"');
    const env = (await loadConfig()).environments.test!;
    expect(env.project?.id).toBe(P);
    expect(env.integrations).toEqual({});
  });

  it("-p of an unknown project → exit 5", async () => {
    await loggedIn();
    expect(exitCodeOf(await failure(launchCommand("claude", [], { project: "nope" })))).toBe(EXIT.notFound);
  });

  it("--print shows env and command with the token redacted, and saves nothing", async () => {
    await loggedIn();
    expect(await launchCommand("claude", [], { print: true, model: "eu.anthropic.claude-sonnet-5" })).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/^# environment: test, project 4/);
    expect(out).toContain("export ANTHROPIC_AUTH_TOKEN='tok-01…cdef'");
    expect(out).not.toContain(TOKEN);
    expect((await loadConfig()).environments.test!.integrations).toEqual({});
    expect(await agentRan("claude")).toBe(false);
  });

  it("a launch with -m saves the choice for next time", async () => {
    await loggedIn();
    await launchCommand("codex", [], { model: "global.openai.gpt-5.6-terra" });
    expect((await loadConfig()).environments.test!.integrations).toEqual({ codex: { model: "global.openai.gpt-5.6-terra" } });
  });
});

describe("the user's own setup is never written (AC-4)", () => {
  it("Codex: every setting is a -c override, and the model catalog goes to elitea-cli's own home", async () => {
    await loggedIn();
    await launchCommand("codex", [], { model: "global.openai.gpt-5.6-terra" });
    const args = await agentArgs("codex");
    const settings = args.filter((_, i) => args[i - 1] === "-c");
    expect(settings.find((s) => s.startsWith("model_catalog_json="))).toBe(`model_catalog_json="${join(dir, "home", "codex-models.json")}"`);
    // Nothing else points Codex at a file: no --config-file, no profile.
    expect(args.filter((a) => a.startsWith("--") && !["--model"].includes(a))).toEqual([]);
    const fs = await import("node:fs/promises");
    expect(await fs.readdir(join(dir, "home"))).toContain("codex-models.json");
  });
});
