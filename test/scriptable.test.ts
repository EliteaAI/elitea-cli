import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFields, parseHeaders, parseMethod, parsePath } from "../src/commands/api.js";
import { completionScript } from "../src/commands/completion.js";
import { envRemoveCommand } from "../src/commands/env.js";
import { configGetCommand, configListCommand, configSetCommand } from "../src/commands/settings.js";
import { parseTimeout } from "../src/commands/run.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { ctx, operationFor, resetContext } from "../src/context.js";
import { AccessDeniedError, AuthError, EliteaClient, EliteaError } from "../src/elitea.js";
import { CliError, EXIT, errorJson, exitCodeOf } from "../src/errors.js";
import { claimStdin, confirmDestructive } from "../src/interaction.js";
import { defaultFormat, parseFormat, printQuiet, render } from "../src/output.js";
import { parseErrorBody } from "../src/platformError.js";
import { MASK, redactBody, redactPath, redactValue, scrub } from "../src/redact.js";

const TOKEN = "tok-0123456789abcdef";
let logs: string[];
let errors: string[];

beforeEach(async () => {
  resetContext();
  process.env.ELITEA_CLI_HOME = await mkdtemp(join(tmpdir(), "elitea-cli-02-"));
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  for (const v of ["ELITEA_CLI_OUTPUT", "ELITEA_CLI_TIMEOUT", "NO_COLOR", "ELITEA_CLI_DEBUG", "CI"]) delete process.env[v];
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetContext();
});

/** A client whose every request gets this response. */
function answering(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  }) as unknown as typeof fetch;
  return { client: new EliteaClient("https://elitea.test", TOKEN, fetchImpl), calls };
}

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

describe("exit codes (AC-7, AC-7b)", () => {
  it.each([
    [401, EXIT.auth],
    [403, EXIT.denied],
    [404, EXIT.notFound],
    [400, EXIT.conflict],
    [409, EXIT.conflict],
    [422, EXIT.conflict],
    [429, EXIT.limit],
    [500, EXIT.general],
  ])("HTTP %i → exit %i", async (status, exit) => {
    const err = await failure(answering(status, { error: "x" }).client.getUser());
    expect(exitCodeOf(err)).toBe(exit);
  });

  it("a redirect to the login page is a rejected token (exit 3)", async () => {
    const err = await failure(answering(302, undefined, { location: "/forward-auth/login" }).client.getUser());
    expect(err).toBeInstanceOf(AuthError);
    expect(exitCodeOf(err)).toBe(3);
  });

  it("Ctrl-C in a prompt is 130", () => {
    const err = Object.assign(new Error("x"), { name: "ExitPromptError" });
    expect(exitCodeOf(err)).toBe(130);
  });
});

describe("platform error messages (AC-7d…AC-12)", () => {
  it("reads code, then error, then message; non-JSON → first 300 characters", () => {
    expect(parseErrorBody(JSON.stringify({ code: "too_many_drafts", error: "Too many drafts." }))).toMatchObject({ code: "too_many_drafts", text: "Too many drafts." });
    expect(parseErrorBody(JSON.stringify({ error: "TOKEN_SCOPE_PROJECT", message: "no" }))).toMatchObject({ code: "TOKEN_SCOPE_PROJECT", text: "no" });
    expect(parseErrorBody(JSON.stringify({ message: "Only text" }))).toMatchObject({ text: "Only text" });
    expect(parseErrorBody("<html>" + "x".repeat(500)).text).toHaveLength(300);
    expect(parseErrorBody("", "17").retryAfter).toBe(17);
  });

  it("403: Forbidden, the platform text and the project hint (AC-8)", async () => {
    ctx.projectId = 77;
    const err = await failure(answering(403, { error: "Not a member" }).client.getUser());
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect(err!.message).toBe("Forbidden: Not a member\nThe token may lack permissions, or your role in project 77 does not allow this");
    const bare = await failure(answering(403).client.getUser());
    expect(bare!.message.split("\n")[0]).toBe("Forbidden");
  });

  it("TOKEN_SCOPE_* names the operation the command needs, and nothing else (AC-9)", async () => {
    ctx.projectId = 77;
    ctx.operation = operationFor("agents run");
    const body = { error: "TOKEN_SCOPE_OPERATION", message: "This API token may not do that." };
    const err = await failure(answering(403, body).client.getUser());
    expect(err!.message).toBe("This token is not allowed to do this (TOKEN_SCOPE_OPERATION). Create a token with the 'run' operation for project 77");
    expect(exitCodeOf(err)).toBe(4);
    ctx.operation = operationFor("agents list");
    expect((await failure(answering(403, body).client.getUser()))!.message).toBe("This token is not allowed to do this (TOKEN_SCOPE_OPERATION).");
  });

  it("maps the AC-9 operation table", () => {
    expect(operationFor("agents create")).toBe("build");
    expect(operationFor("pipelines version default")).toBe("build");
    expect(operationFor("credentials test")).toBe("run");
    expect(operationFor("chats delete")).toBeUndefined();
    expect(operationFor("api")).toBeUndefined();
  });

  it("429: budget only when the platform says so; retry-after when given (AC-10)", async () => {
    const budget = { error: { message: "The budget has been reached.", type: "budget_exceeded", code: "project_budget_exceeded" } };
    expect((await failure(answering(429, budget).client.getUser()))!.message).toMatch(/^EliteA budget for this project is exhausted/);
    const cap = await failure(answering(429, { error: "webhook_cap_reached", message: "Too many runs", retry_after: 12 }).client.getUser());
    expect(cap!.message).not.toMatch(/budget/);
    expect(cap!.message).toContain("Too many runs (webhook_cap_reached)");
    expect(cap!.message).toContain("Retry after 12 s");
    expect(exitCodeOf(cap)).toBe(7);
  });

  it("400/409/422: one field error per line (AC-11)", async () => {
    const err = await failure(answering(422, [{ loc: ["body", "name"], msg: "Field required" }, { loc: ["tags", 0], msg: "Bad" }]).client.getUser());
    expect(err!.message).toBe("body.name: Field required\ntags.0: Bad");
    expect(exitCodeOf(err)).toBe(6);
  });

  it("network failure and 503 (AC-12): writes are not retried, reads are once", async () => {
    const down = new EliteaClient("https://down.test", TOKEN, (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND down.test") });
    }) as unknown as typeof fetch);
    const err = await failure(down.getUser());
    expect(err!.message).toBe("Cannot reach https://down.test: getaddrinfo ENOTFOUND down.test");
    expect(exitCodeOf(err)).toBe(1);

    const busy = answering(503, { error: "temporarily_unavailable", retry_after: 0.001 });
    const post = await failure(busy.client.request("POST", "/x", { body: {} }));
    expect(post!.message).toBe("EliteA is busy (503); nothing was retried — try again");
    expect(busy.calls).toHaveLength(1);
    busy.calls.length = 0;
    await failure(busy.client.request("GET", "/x"));
    expect(busy.calls).toHaveLength(2);
  });

  it("errors as one JSON line in JSON mode (AC-7c)", async () => {
    const err = await failure(answering(429, { error: "webhook_cap_reached", message: "Too many" }).client.getUser());
    expect(JSON.parse(errorJson(err))).toEqual({ error: { status: 429, code: "webhook_cap_reached", message: err!.message, exit: 7 } });
    expect(JSON.parse(errorJson(new CliError("bad", 2)))).toEqual({ error: { status: null, code: null, message: "bad", exit: 2 } });
  });
});

describe("HTTP client verbs (scope)", () => {
  it("sends PUT/PATCH/DELETE with JSON, multipart forms, queries; 204 → undefined", async () => {
    const { client, calls } = answering(204);
    expect(await client.request("PUT", "/a", { body: { x: 1 }, query: { q: "y", skip: undefined } })).toBeUndefined();
    await client.request("PATCH", "/b", { body: [1] });
    await client.request("DELETE", "/c");
    const form = new FormData();
    form.set("file", new Blob(["hi"]), "a.txt");
    await client.request("POST", "/d", { form });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://elitea.test", "")}`)).toEqual(["PUT /a?q=y", "PATCH /b", "DELETE /c", "POST /d"]);
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[3]!.init.body).toBe(form);
    expect((calls[3]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(calls[0]!.init.redirect).toBe("manual");
  });
});

describe("--debug never shows secrets (AC-13)", () => {
  it("masks secret keys at any depth, in queries and in text", () => {
    expect(redactValue({ name: "a", api_key: "k", nested: [{ Client_Secret: "s", PASSWORD: "p", ok: 1 }] })).toEqual({
      name: "a",
      api_key: MASK,
      nested: [{ Client_Secret: MASK, PASSWORD: MASK, ok: 1 }],
    });
    expect(redactValue({ host: "h", custom: "c" }, ["custom"])).toEqual({ host: "h", custom: MASK });
    expect(redactPath("/x?access_token=abc&limit=5")).toBe("/x?access_token=****&limit=5");
    expect(redactBody('{"private_key":"-----BEGIN"}')).toBe('{"private_key":"****"}');
    expect(scrub(`Bearer ${TOKEN} failed`, TOKEN)).toBe("Bearer **** failed");
  });

  it("logs METHOD path → status (ms) without the Authorization header", async () => {
    ctx.debug = true;
    const { client } = answering(200, { token: "server-secret", id: 1 });
    await client.request("POST", "/api/x?secret=s1", { body: { password: "pw", name: "n" } });
    const out = errors.join("\n");
    expect(out).toMatch(/^POST \/api\/x\?secret=\*\*\*\* → 200 \(\d+ ms\)/);
    expect(out).toContain('{"password":"****","name":"n"}');
    expect(out).toContain('{"token":"****","id":1}');
    for (const secret of [TOKEN, "server-secret", "pw", "s1", "Authorization"]) expect(out).not.toContain(secret);
  });
});

describe("output (AC-1, AC-2, AC-5, AC-6, AC-6a)", () => {
  it("-o table|json|yaml; --json = -o json; table = text", () => {
    expect(parseFormat({ output: "table" })).toBe("text");
    expect(parseFormat({ output: "JSON" })).toBe("json");
    expect(parseFormat({ json: true, output: "json" })).toBe("json");
    expect(() => parseFormat({ json: true, output: "yaml" })).toThrow(CliError);
  });

  it("defaults: -o > ELITEA_CLI_OUTPUT > settings.output > table, for new commands only", () => {
    ctx.settings = { output: "yaml" };
    expect(parseFormat({}, true)).toBe("yaml");
    expect(parseFormat({})).toBe("text");
    process.env.ELITEA_CLI_OUTPUT = "json";
    expect(defaultFormat()).toBe("json");
    expect(parseFormat({ output: "table" }, true)).toBe("text");
    process.env.ELITEA_CLI_OUTPUT = "xml";
    expect(exitCodeOf((() => { try { defaultFormat(); } catch (e) { return e; } })())).toBe(2);
  });

  it("render: 'No <items> found' on stderr for an empty table, [] for JSON", () => {
    const cols = [{ header: "ID", value: (r: { id: number }) => r.id }];
    render([], cols, "text", "toolkits");
    expect(errors).toEqual(["No toolkits found"]);
    expect(logs).toEqual([]);
    render([], cols, "json", "toolkits");
    expect(logs).toEqual(["[]"]);
  });

  it("-q prints only the id", () => {
    expect(printQuiet(5)).toBe(false);
    ctx.quiet = true;
    expect(printQuiet(5)).toBe(true);
    expect(logs).toEqual(["5"]);
  });
});

describe("confirmation and terminals (AC-14, AC-21b, AC-21c)", () => {
  it("refuses a destructive action outside a terminal without --yes, and changes nothing", async () => {
    await saveConfig({ active: "a", environments: { a: { url: "https://a.test", integrations: {} } }, settings: {} });
    const err = await failure(envRemoveCommand("a", {}));
    expect(err!.message).toBe("Refusing to remove environment 'a' without --yes in a non-interactive shell");
    expect(exitCodeOf(err)).toBe(2);
    expect(Object.keys((await loadConfig()).environments)).toEqual(["a"]);
    ctx.yes = true;
    await envRemoveCommand("a", {});
    expect((await loadConfig()).environments).toEqual({});
  });

  it("--yes (command or global) skips the question", async () => {
    expect(await confirmDestructive({ action: "delete", type: "agent", name: "x", id: 1, yes: true })).toBe(true);
  });

  it("only one option may read stdin", () => {
    claimStdin("-f -");
    claimStdin("-f -");
    expect(() => claimStdin("--token-stdin")).toThrow("Only one option can read stdin");
  });
});

describe("api (AC-15…AC-18)", () => {
  it("validates method, path, fields and headers", () => {
    expect(parseMethod("patch")).toBe("PATCH");
    expect(() => parseMethod("HEAD")).toThrow(CliError);
    expect(parsePath("/api/v2/x?y=1", "https://e.test")).toBe("/api/v2/x?y=1");
    expect(parsePath("https://e.test/api?q=1", "https://e.test")).toBe("/api?q=1");
    expect(() => parsePath("api/v2", "https://e.test")).toThrow(/must start with \//);
    expect(() => parsePath("https://evil.test/api", "https://e.test")).toThrow("api only calls the active environment (https://e.test)");
    expect(() => parsePath("http://e.test/api", "https://e.test")).toThrow(/only calls the active environment/);
    expect(parseFields(["n=3", "ok=true", "no=false", "s=hi", "zip=007", "e="])).toEqual({ n: 3, ok: true, no: false, s: "hi", zip: "007", e: "" });
    expect(parseHeaders(["X-Test: a: b"])).toEqual({ "X-Test": "a: b" });
    for (const h of ["Authorization: x", "authorization:x", "AUTHORIZATION: x"]) {
      expect(exitCodeOf((() => { try { parseHeaders([h]); } catch (e) { return e; } })())).toBe(2);
    }
  });

  it("the stored token always wins over extra headers", async () => {
    const { client, calls } = answering(200, {});
    await client.send("GET", "/x", { headers: { Authorization: "Bearer other" } });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("config (AC-21)", () => {
  it("sets, gets and lists settings; env vars win; bad keys and values exit 2", async () => {
    await configSetCommand("output", "JSON");
    await configSetCommand("timeout", "60");
    expect((await loadConfig()).settings).toEqual({ output: "json", timeout: 60 });
    logs = [];
    await configGetCommand("timeout");
    expect(logs).toEqual(["60"]);
    process.env.ELITEA_CLI_TIMEOUT = "5";
    logs = [];
    await configListCommand({ output: "json" });
    expect(JSON.parse(logs.join("\n"))).toEqual([
      { key: "output", value: "json", source: "config", allowed: "table|json|yaml" },
      { key: "color", value: "auto", source: "default", allowed: "auto|never" },
      { key: "timeout", value: "5", source: "env", allowed: "1–240 minutes" },
    ]);
    expect(parseTimeout(undefined, 60)).toBe(5);
    expect(exitCodeOf(await failure(configSetCommand("colour", "never")))).toBe(2);
    expect((await failure(configSetCommand("color", "always")))!.message).toBe('color must be one of auto, never, got "always"');
    expect(exitCodeOf(await failure(configSetCommand("timeout", "0")))).toBe(2);
  });
});

describe("completion (AC-19)", () => {
  const program = new Command().name("elitea-cli").option("--env <name>");
  program.command("agents").option("--json").command("list").option("-o, --output <f>");
  program.command("status");

  it.each(["bash", "zsh", "fish", "powershell"])("%s script covers commands and flags", (shell) => {
    const script = completionScript(shell, program);
    const flags = shell === "fish" ? ["-l json", "-l output", "-s o", "-l env"] : ["--json", "--output", "--env"];
    for (const word of ["agents", "list", "status", ...flags]) expect(script).toContain(word);
  });

  it("refuses unknown shells with exit 2", () => {
    expect(exitCodeOf((() => { try { completionScript("tcsh", program); } catch (e) { return e; } })())).toBe(2);
  });
});

describe("env list output (AC-1)", () => {
  it("accepts table, json and yaml", async () => {
    await saveConfig({ active: "a", environments: { a: { url: "https://a.test", integrations: {} } }, settings: {} });
    const { envListCommand } = await import("../src/commands/env.js");
    await envListCommand({ output: "json" });
    expect(JSON.parse(logs.join("\n"))[0]).toMatchObject({ name: "a", url: "https://a.test", active: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await envListCommand({ output: "yaml" });
    expect(String(write.mock.calls[0]![0])).toContain("name: a");
    logs = [];
    await envListCommand({ output: "table" });
    expect(logs[0]).toMatch(/NAME\s+URL/);
  });
});

describe("compatibility (AC-22)", () => {
  it("an EliteaError still carries status and code", () => {
    const err = new EliteaError("x", 409, "conflict");
    expect([err.status, err.code, exitCodeOf(err)]).toEqual([409, "conflict", 6]);
  });
});
