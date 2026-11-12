import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envAddCommand, envRemoveCommand, envUseCommand, listEnvironments } from "../src/commands/env.js";
import { loginCommand, logoutCommand } from "../src/commands/login.js";
import { statusCommand } from "../src/commands/status.js";
import { type Config, loadConfig, saveConfig } from "../src/config.js";
import { tokenStore } from "../src/credentials.js";
import { CliError } from "../src/errors.js";
import { requireSession, selectEnvironment, setEnvFlag } from "../src/session.js";
import { defaultEnvName, originKey, tryNormalizeUrl } from "../src/urls.js";

const ENV_VARS = ["ELITEA_CLI_TOKEN", "ELITEA_CLI_URL", "ELITEA_CLI_ENV", "ELITEA_CLI_PROJECT", "CI"];
const TOKEN_A = "token-for-server-a-0123456789";
const TOKEN_B = "token-for-server-b-0123456789";

let home: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "elitea-cli-env-test-"));
  process.env.ELITEA_CLI_HOME = home;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  for (const v of ENV_VARS) delete process.env[v];
  setEnvFlag(undefined);
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const userA = { id: 7, name: "Ada", email: "ada@a.test", personal_project_id: 4 };
const userB = { id: 9, name: "Bob", email: "bob@b.test", personal_project_id: 40 };

/** Fake EliteA servers by origin; records every request with the token it carried. */
function servers(byOrigin: Record<string, { token: string; user: typeof userA }>) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>).Authorization ?? "";
    calls.push({ url: url.href, auth });
    const server = byOrigin[url.origin];
    if (!server) throw new TypeError("fetch failed");
    if (auth !== `Bearer ${server.token}`) return new Response(null, { status: 401 });
    if (url.pathname === "/api/v2/auth/user/") return Response.json(server.user);
    if (url.pathname.startsWith("/api/v2/projects/project/default/")) {
      return Response.json([{ id: server.user.personal_project_id, name: `project_user_${server.user.id}` }, { id: 77, name: "Team" }]);
    }
    if (url.pathname.startsWith("/api/v2/configurations/models/")) return Response.json({ items: [] });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function twoEnvs(): Config {
  return {
    active: "a",
    environments: {
      a: { url: "https://a.test", user: { id: 7, name: "Ada", email: "ada@a.test" }, project: { id: 4, name: "Personal" }, integrations: { claude: { model: "m-a" } } },
      b: { url: "https://b.test", user: { id: 9, name: "Bob", email: "bob@b.test" }, project: { id: 40, name: "Personal" }, integrations: {} },
    },
    settings: {},
  };
}

async function expectCliError(promise: Promise<unknown>, message: string | RegExp, exitCode: number) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).message).toMatch(message);
  expect((err as CliError).exitCode).toBe(exitCode);
}

describe("URL normalization (AC-3, AC-4)", () => {
  it("normalizes to scheme://host[:port]", () => {
    expect(tryNormalizeUrl("HTTPS://Dev.Elitea.ai:443/app/chat/")).toBe("https://dev.elitea.ai");
    expect(tryNormalizeUrl("http://LOCALHOST:80/")).toBe("http://localhost");
    expect(tryNormalizeUrl("http://localhost:8080/x?y=1")).toBe("http://localhost:8080");
    expect(tryNormalizeUrl("  https://a.test/  ")).toBe("https://a.test");
  });

  it("refuses empty, scheme-less and invalid values", () => {
    for (const v of ["", "dev.elitea.ai", "ftp://a.test", "https://", "https://exa mple.com"]) expect(tryNormalizeUrl(v)).toBeUndefined();
  });

  it("derives origin keys and default names", () => {
    expect(originKey("http://localhost:8080")).toBe("localhost:8080");
    expect(defaultEnvName("http://localhost:8080")).toBe("localhost-8080");
    expect(defaultEnvName("https://dev.elitea.ai")).toBe("dev.elitea.ai");
    expect(defaultEnvName(`https://${"a".repeat(60)}.test`)).toHaveLength(40);
  });
});

describe("migration from the 0.1.0 config (AC-24…AC-25c)", () => {
  const v1 = { url: "https://Next.Elitea.ai/", user: { id: 7, name: "Ada", email: "ada@a.test" }, project: { id: 4, name: "Personal" }, integrations: { claude: { model: "m" } } };

  it("converts to one active environment, keeps a backup and the 0.1.0 keys, and finds the old token", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify(v1));
    // 0.1.0 saved file-store tokens under the URL as typed.
    await writeFile(join(home, "credentials.json"), JSON.stringify({ "https://next.elitea.ai/": TOKEN_A }));

    const config = await loadConfig();
    expect(config.active).toBe("next.elitea.ai");
    expect(config.environments["next.elitea.ai"]).toEqual({ ...v1, url: "https://next.elitea.ai" });
    expect(JSON.parse(await readFile(join(home, "config.v1.json"), "utf8"))).toEqual(v1);

    const file = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(file).toMatchObject({ version: 2, active: "next.elitea.ai", url: "https://next.elitea.ai", user: v1.user, project: v1.project, integrations: v1.integrations });

    const session = await requireSession();
    expect(session.token).toBe(TOKEN_A);
  });

  it("runs once and never overwrites an existing backup", async () => {
    await writeFile(join(home, "config.v1.json"), "older backup");
    await writeFile(join(home, "config.json"), JSON.stringify(v1));
    await loadConfig();
    const after = await readFile(join(home, "config.json"), "utf8");
    await loadConfig();
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(after);
    expect(await readFile(join(home, "config.v1.json"), "utf8")).toBe("older backup");
  });

  it("creates no environment for a config without url", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ integrations: {} }));
    expect(await loadConfig()).toEqual({ environments: {}, settings: {} });
  });

  it("reports a read-only config directory and leaves the old file unchanged", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    await writeFile(join(home, "config.json"), JSON.stringify(v1));
    await chmod(home, 0o500);
    try {
      await expectCliError(loadConfig(), /^Cannot update .*config\.json: /, 1);
      expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual(v1);
    } finally {
      await chmod(home, 0o700);
    }
  });
});

describe("selecting the environment (AC-17…AC-21, AC-31)", () => {
  it("fails without an active environment and contacts no server", async () => {
    const calls = servers({});
    await expectCliError(requireSession(), "No active environment — run `elitea-cli login` or `elitea-cli env use <name>`", 3);
    expect(await statusCommand()).toBe(1);
    expect(logs).toEqual(["No active environment — run `elitea-cli login`"]);
    expect(calls).toEqual([]);
  });

  it("uses --env over ELITEA_CLI_ENV over ELITEA_CLI_URL over the active one", async () => {
    await saveConfig(twoEnvs());
    expect((await selectEnvironment()).name).toBe("a");
    process.env.ELITEA_CLI_URL = "https://B.test/app";
    expect((await selectEnvironment()).name).toBe("b");
    process.env.ELITEA_CLI_ENV = "a";
    expect((await selectEnvironment()).name).toBe("a");
    setEnvFlag("b");
    expect((await selectEnvironment()).name).toBe("b");
    expect((await loadConfig()).active).toBe("a");
  });

  it("refuses an unknown --env without contacting a server", async () => {
    await saveConfig(twoEnvs());
    const calls = servers({});
    setEnvFlag("nope");
    await expectCliError(requireSession(), "No environment nope — run `elitea-cli env list`", 5);
    await expectCliError(loginCommand({ tokenStdin: true }), "No environment nope — run `elitea-cli env list`", 5);
    expect(calls).toEqual([]);
  });

  it("never sends one server's stored token to another, even with ELITEA_CLI_URL pointing elsewhere", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    await tokenStore.set("https://b.test", TOKEN_B);
    process.env.ELITEA_CLI_URL = "https://b.test";
    setEnvFlag("a");
    const session = await requireSession();
    expect(session).toMatchObject({ name: "a", url: "https://a.test", token: TOKEN_A });

    setEnvFlag(undefined);
    expect(await requireSession()).toMatchObject({ name: "b", url: "https://b.test", token: TOKEN_B });

    process.env.ELITEA_CLI_URL = "https://c.test";
    await expectCliError(requireSession(), "Not logged in to https://c.test — run `elitea-cli login --url https://c.test`", 3);
  });

  it("works from ELITEA_CLI_URL + ELITEA_CLI_TOKEN alone with a temporary environment", async () => {
    servers({ "https://c.test": { token: TOKEN_A, user: userA } });
    process.env.ELITEA_CLI_URL = "https://c.test/";
    process.env.ELITEA_CLI_TOKEN = TOKEN_A;
    const session = await requireSession();
    expect(session).toMatchObject({ temporary: true, url: "https://c.test", projectId: 4 });
    process.env.ELITEA_CLI_PROJECT = "77";
    expect((await requireSession()).projectId).toBe(77);
    expect(await loadConfig()).toEqual({ environments: {}, settings: {} });
  });

  it("points at login --env for an environment without a token", async () => {
    await saveConfig(twoEnvs());
    setEnvFlag("b");
    await expectCliError(requireSession(), "Not logged in to b — run `elitea-cli login --env b`", 3);
  });
});

describe("login (AC-5…AC-11)", () => {
  function stdin(token: string) {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(token);
    } as never);
  }

  it("needs a server in a script", async () => {
    stdin(TOKEN_A);
    await expectCliError(loginCommand({ tokenStdin: true }), "No server: pass --url <url> or --env <name>", 2);
    process.env.ELITEA_CLI_TOKEN = TOKEN_A;
    await expectCliError(loginCommand({}), "No server: pass --url <url> or --env <name>", 2);
  });

  it("refuses a malformed --url", async () => {
    stdin(TOKEN_A);
    await expectCliError(loginCommand({ tokenStdin: true, url: "dev.elitea.ai" }), "Enter a full URL, for example https://<your-server>", 2);
  });

  it("creates and activates an environment named after the host, with today's output plus Environment:", async () => {
    servers({ "https://a.test": { token: TOKEN_A, user: userA } });
    stdin(TOKEN_A);
    await loginCommand({ tokenStdin: true, url: "HTTPS://A.test:443/app/chat/" });
    expect(logs).toEqual([
      "Logged in to https://a.test as Ada <ada@a.test>",
      "Environment: a.test",
      "Project: Personal (4)",
      `Token saved to ${join(home, "credentials.json")}`,
      "\nNext: `elitea-cli launch claude`",
    ]);
    const config = await loadConfig();
    expect(config.active).toBe("a.test");
    expect(config.environments["a.test"]).toMatchObject({ url: "https://a.test", project: { id: 4, name: "Personal" } });
  });

  it("re-uses the environment of a known server and keeps the other environment untouched", async () => {
    await saveConfig({ ...twoEnvs(), active: "b" });
    servers({ "https://a.test": { token: TOKEN_A, user: userA } });
    stdin(TOKEN_A);
    await loginCommand({ tokenStdin: true, url: "https://a.test/" });
    expect(logs[0]).toBe("Using environment a (https://a.test)");
    const config = await loadConfig();
    expect(config.active).toBe("a");
    expect(Object.keys(config.environments)).toEqual(["a", "b"]);
    // same account + same project: model choices kept
    expect(config.environments.a?.integrations).toEqual({ claude: { model: "m-a" } });
    expect(config.environments.b).toEqual(twoEnvs().environments.b);
  });

  it("refuses the same host over the other scheme", async () => {
    await saveConfig(twoEnvs());
    stdin(TOKEN_A);
    await expectCliError(loginCommand({ tokenStdin: true, url: "http://a.test", allowHttp: true }), "Environment a already uses a.test over https", 6);
  });

  it("--env with a different --url is refused; --env <new> --url creates it", async () => {
    await saveConfig(twoEnvs());
    servers({ "https://c.test": { token: TOKEN_A, user: userA } });
    stdin(TOKEN_A);
    setEnvFlag("a");
    await expectCliError(loginCommand({ tokenStdin: true, url: "https://c.test" }), "Environment a already points to https://a.test", 6);
    setEnvFlag("c-env");
    await loginCommand({ tokenStdin: true, url: "https://c.test" });
    expect((await loadConfig()).environments["c-env"]?.url).toBe("https://c.test");
  });

  it("saves nothing when the token is rejected (exit 3) or the server is unreachable (exit 1)", async () => {
    servers({ "https://a.test": { token: "another-token-0123456789", user: userA } });
    stdin(TOKEN_A);
    const rejected = await loginCommand({ tokenStdin: true, url: "https://a.test" }).catch((e: Error) => e);
    expect((rejected as Error).message).toBe("EliteA at https://a.test rejected this token — check it and try again");
    expect((rejected as Error).name).toBe("AuthError");
    const down = await loginCommand({ tokenStdin: true, url: "https://down.test" }).catch((e: Error) => e);
    expect((down as Error).message).toMatch(/^Cannot reach https:\/\/down\.test: /);
    expect(await loadConfig()).toEqual({ environments: {}, settings: {} });
    expect(await tokenStore.getStored("https://a.test")).toBeUndefined();
  });

  it("refuses plain http outside a terminal without --allow-http", async () => {
    stdin(TOKEN_A);
    await expectCliError(loginCommand({ tokenStdin: true, url: "http://intranet.test" }), /--allow-http/, 2);
    expect(errors).toContain("Warning: http://intranet.test is not HTTPS; your token will be sent unencrypted");
  });
});

describe("logout (AC-22, AC-23)", () => {
  it("removes the token of the selected environment only and keeps the entry", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    await tokenStore.set("https://b.test", TOKEN_B);
    await logoutCommand({});
    expect(logs).toEqual(["Logged out of a (https://a.test)"]);
    expect(await tokenStore.getStored("https://a.test")).toBeUndefined();
    expect(await tokenStore.getStored("https://b.test")).toBe(TOKEN_B);
    expect(Object.keys((await loadConfig()).environments)).toEqual(["a", "b"]);
  });

  it("--all removes every token", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    await tokenStore.set("https://b.test", TOKEN_B);
    await logoutCommand({ all: true });
    expect(logs).toEqual(["Logged out of 2 environments"]);
    expect(await tokenStore.getStored("https://b.test")).toBeUndefined();
  });
});

describe("env commands (AC-12…AC-16)", () => {
  it("lists environments offline with token state", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    const calls = servers({});
    expect(await listEnvironments()).toEqual([
      { name: "a", url: "https://a.test", active: true, user_email: "ada@a.test", project_id: 4, project_name: "Personal", token: "stored" },
      { name: "b", url: "https://b.test", active: false, user_email: "bob@b.test", project_id: 40, project_name: "Personal", token: "missing" },
    ]);
    process.env.ELITEA_CLI_TOKEN = TOKEN_B;
    setEnvFlag("b");
    expect((await listEnvironments()).map((r) => r.token)).toEqual(["stored", "env"]);
    expect(calls).toEqual([]);
  });

  it("adds without activating, refuses a second environment on the same host", async () => {
    await saveConfig(twoEnvs());
    await envAddCommand("dev", { url: "https://dev.test/app" });
    const config = await loadConfig();
    expect(config.environments.dev).toEqual({ url: "https://dev.test", integrations: {} });
    expect(config.active).toBe("a");
    await expectCliError(envAddCommand("a2", { url: "https://a.test" }), "Environment a already uses a.test — run `elitea-cli login --env a`", 6);
    await expectCliError(envAddCommand("a", { url: "https://x.test" }), "Environment a already points to https://a.test", 6);
    await expectCliError(envAddCommand("bad name", { url: "https://x.test" }), "Use 1–40 letters, digits, '.', '-' or '_'", 2);
  });

  it("switches the active environment", async () => {
    await saveConfig(twoEnvs());
    await envUseCommand("b");
    expect(logs).toEqual(["Active environment: b (https://b.test)"]);
    expect((await loadConfig()).active).toBe("b");
    await expectCliError(envUseCommand("zzz"), "No environment zzz — run `elitea-cli env list`", 5);
  });

  it("removes an environment and its token; needs --yes outside a terminal", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    await expectCliError(envRemoveCommand("a", {}), /--yes/, 2);
    await envRemoveCommand("a", { yes: true });
    const config = await loadConfig();
    expect(Object.keys(config.environments)).toEqual(["b"]);
    expect(config.active).toBeUndefined();
    expect(await tokenStore.getStored("https://a.test")).toBeUndefined();
    const file = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(file.url).toBeUndefined();
  });
});

describe("status (AC-28)", () => {
  it("adds the environment line and supports -o json", async () => {
    await saveConfig(twoEnvs());
    await tokenStore.set("https://a.test", TOKEN_A);
    servers({ "https://a.test": { token: TOKEN_A, user: userA } });
    expect(await statusCommand()).toBe(0);
    expect(logs.slice(0, 3)).toEqual(["Environment: a", "Server:  https://a.test", "User:    Ada <ada@a.test>"]);
    logs = [];
    expect(await statusCommand({ output: "json" })).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toEqual({
      environment: "a",
      url: "https://a.test",
      user: { id: 7, name: "Ada", email: "ada@a.test" },
      project: { id: 4, name: "Personal" },
      token: "stored",
    });
  });
});
