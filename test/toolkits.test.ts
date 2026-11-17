import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ answers: [] as unknown[], asked: [] as string[] }));
vi.mock("@inquirer/prompts", async (orig) => {
  const next = (message: string) => {
    prompts.asked.push(message);
    if (prompts.answers.length === 0) throw new Error(`unexpected prompt: ${message}`);
    return prompts.answers.shift();
  };
  return {
    ...(await orig<typeof import("@inquirer/prompts")>()),
    confirm: async ({ message }: { message: string }) => next(message),
    password: async ({ message }: { message: string }) => next(message),
  };
});

import {
  addCommand,
  createCommand,
  deleteCommand,
  getCommand,
  listCommand,
  removeCommand,
  testCommand,
  toolsCommand,
  typesCommand,
  updateCommand,
} from "../src/commands/toolkits.js";
import { ctx, operationFor, resetContext } from "../src/context.js";
import type { Credential, Toolkit, ToolkitType } from "../src/elitea.js";
import { EliteaClient } from "../src/elitea.js";
import { EXIT, exitCodeOf } from "../src/errors.js";
import { ELITEA_PERMISSIONS, pluginFiles } from "../src/integrations/claudePlugin.js";
import {
  checkFileSecrets,
  credentialFields,
  enabledTools,
  isSelected,
  mainCredentialField,
  maskSettings,
  readToolkitFile,
  secretSettings,
  settingsOf,
  toolkitTools,
  updateBody,
} from "../src/toolkitsCore.js";

const P = 4;
const PERSONAL = 9;
const PUBLIC = 1;
/** The fake secret of AC-17: it must never appear anywhere. */
const FAKE = "s3cr3t-FAKE-zephyr-key-7532";
const CORE = "/api/v2/elitea_core";
const CFG = "/api/v2/configurations";

// Schemas as `toolkits/prompt_lib` returns them (SDK toolkit models, Provider Hub types).
const credRef = (def: string, types: string[]) => ({ $ref: `#/$defs/${def}`, configuration_types: types });
const types: Record<string, ToolkitType> = {
  jira: {
    title: "jira",
    metadata: { label: "Jira" },
    $defs: {
      JiraConfiguration: { metadata: { section: "credentials", type: "jira" }, properties: { api_key: { format: "password", writeOnly: true, type: "string" } } },
      PgVectorConfiguration: { metadata: { section: "vectorstorage", type: "pgvector" }, properties: {} },
    },
    required: ["jira_configuration"],
    properties: {
      jira_configuration: credRef("JiraConfiguration", ["jira"]),
      pgvector_configuration: { anyOf: [{ $ref: "#/$defs/PgVectorConfiguration" }, { type: "null" }], configuration_types: ["pgvector"], default: null },
      limit: { type: "integer", default: 5, description: "Maximum number of issues.\nMore text." },
      selected_tools: {
        type: "array",
        items: { enum: ["search_using_jql", "create_issue", "list_projects"], type: "string" },
        args_schemas: { search_using_jql: { description: "Search Jira with JQL.", properties: { jql: { type: "string" } } } },
      },
    },
  },
  zephyr_squad: {
    title: "zephyr_squad",
    metadata: { label: "Zephyr Squad" },
    required: ["account_id", "access_key"],
    properties: {
      account_id: { type: "string" },
      access_key: { type: "string", format: "password", writeOnly: true, secret: true },
      secret_key: { type: "string", format: "password", writeOnly: true, secret: true },
      selected_tools: { type: "array", items: { enum: ["get_test_step"], type: "string" } },
    },
  },
  openapi: {
    title: "openapi",
    metadata: { label: "OpenAPI" },
    properties: { spec: { type: "string" }, selected_tools: { type: "array", default: [], items: { type: "string" } } },
  },
  bigquery: { title: "bigquery", metadata: { label: "BigQuery", hidden: true }, properties: {} },
  mcp: { title: "mcp", metadata: { label: "Remote MCP" }, required: ["url"], properties: { url: { type: "string" }, client_secret: { anyOf: [{ format: "password", type: "string", writeOnly: true }, { type: "null" }] } } },
};

let dir: string;
let logs: string[];
let errors: string[];
let calls: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown>; raw?: string }>;

function world() {
  const tk = (id: number, extra: Partial<Toolkit>): Toolkit => ({
    id,
    type: "jira",
    name: `Toolkit ${id}`,
    toolkit_name: `Toolkit${id}`,
    description: null,
    author_id: 7,
    settings: {},
    meta: {},
    created_at: "2026-11-01T10:00:00",
    ...extra,
  });
  const cred = (id: number, extra: Partial<Credential>): Credential => ({
    id,
    uuid: `uuid-${id}`,
    project_id: P,
    elitea_title: `cred_${id}`,
    label: `Cred ${id}`,
    type: "jira",
    section: "credentials",
    data: {},
    ...extra,
  });
  return {
    toolkits: [
      tk(1, { name: "Jira EL", settings: { jira_configuration: { elitea_title: "jira_el", private: false }, limit: 5, selected_tools: ["search_using_jql", "create_issue"] } }),
      tk(2, { name: "Squad", type: "zephyr_squad", settings: { account_id: "acc", access_key: "{{secret.squad_access_key}}", secret_key: "{{secret.squad_secret_key}}" } }),
      // Seen on dev.elitea.ai: an OpenAPI toolkit whose nested api_key the platform returns in plain text.
      tk(3, { name: "Petstore", type: "openapi", settings: { spec: "openapi: 3.0.0", authentication: { type: "api_key", settings: { api_key: FAKE, auth_type: "Bearer" } }, selected_tools: [{ name: "getPet", description: "Get a pet" }] } }),
      tk(4, { name: "Jira staging", settings: { jira_configuration: { elitea_title: "jira_staging", private: true } } }),
    ],
    mcpToolkits: [tk(5, { name: "Remote", type: "mcp", meta: { mcp: true }, settings: { url: "https://mcp.test", headers: { Authorization: `Bearer ${FAKE}` } } })],
    credentials: [
      cred(10, { elitea_title: "jira_el", label: "Jira EL" }),
      cred(11, { elitea_title: "dup_a", label: "Dup" }),
      cred(12, { elitea_title: "dup_b", label: "Dup" }),
      cred(13, { elitea_title: "gh", type: "github" }),
    ],
    personal: [cred(20, { project_id: PERSONAL, elitea_title: "my_jira", label: "My Jira" })],
    shared: [cred(30, { project_id: PUBLIC, elitea_title: "public_jira", label: "Public Jira", shared: true })],
    agents: [
      { id: 40, name: "Release bot", agent_type: "openai" },
      { id: 41, name: "Flow", agent_type: "pipeline" },
    ],
    versions: [
      { id: 400, name: "base", status: "draft", tools: [{ id: 1, name: "Jira EL", toolkit_name: "JiraEL", type: "jira" }] as Array<Record<string, unknown>> },
      { id: 401, name: "v1", status: "published", tools: [] as Array<Record<string, unknown>> },
    ],
    nextId: 100,
    refuse: undefined as undefined | { status: number; body: unknown },
    test: { status: 200, body: { result: { success: true, result: { total: 1, issues: ["EL-1"] } } } as unknown },
    /** Someone else attaches this toolkit right before the next PATCH. */
    raceAttach: undefined as undefined | Record<string, unknown>,
    /** Someone else changes the toolkit right before this read (1 = the first). */
    bumpOnRead: 0,
  };
}

let w: ReturnType<typeof world>;

function serve() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const path = url.pathname;
    calls.push({ method, path, query: url.searchParams, body, raw });
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    let m: RegExpMatchArray | null;

    if (path === "/api/v2/auth/user/") return json({ id: 7, name: "Ada", email: "ada@a.test", personal_project_id: PERSONAL });
    if (path === `${CORE}/toolkits/prompt_lib/${P}`) {
      const mcp = url.searchParams.get("mcp") === "true";
      return json(mcp ? { mcp_local: { title: "mcp_local", metadata: { label: "Local MCP" }, properties: {} } } : types);
    }
    if (path === `${CORE}/tools/prompt_lib/${P}` && method === "GET") {
      const mcp = url.searchParams.get("mcp") === "true";
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const typeFilter = url.searchParams.getAll("toolkit_type");
      const rows = (mcp ? w.mcpToolkits : w.toolkits).filter((t) => (!q || (t.name ?? "").toLowerCase().includes(q)) && (typeFilter.length === 0 || typeFilter.includes(t.type)));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      return json({ rows: rows.slice(offset, offset + limit).map((t) => ({ ...t, author: { id: 7, email: "ada@a.test" } })), total: rows.length });
    }
    if (path === `${CORE}/tools/prompt_lib/${P}` && method === "POST") {
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      const settings = { ...(body!.settings as Record<string, unknown>) };
      for (const k of ["access_key", "secret_key"]) if (typeof settings[k] === "string") settings[k] = `{{secret.new_${k}}}`;
      const created = { id: w.nextId++, type: String(body!.type), name: String(body!.name), toolkit_name: String(body!.name).replace(/\W/g, ""), author_id: 7, settings, meta: body!.meta ?? {} } as Toolkit;
      w.toolkits.push(created);
      return json(created, 201);
    }
    if ((m = path.match(new RegExp(`^${CORE}/tool/prompt_lib/${P}/(\\d+)$`)))) {
      const all = [...w.toolkits, ...w.mcpToolkits];
      const t = all.find((r) => String(r.id) === m![1]);
      if (!t) return json({ error: `No such tool with id ${m[1]}` }, 400);
      if (method === "GET") {
        // Someone else saves the toolkit right before the N-th read.
        if (w.bumpOnRead > 0 && --w.bumpOnRead === 0) t.settings = { ...t.settings, limit: 99 };
        return json(t);
      }
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      if (method === "PUT") {
        const settings = { ...(body!.settings as Record<string, unknown>) };
        for (const k of ["access_key", "secret_key"]) if (typeof settings[k] === "string" && !String(settings[k]).startsWith("{{")) settings[k] = `{{secret.upd_${k}}}`;
        Object.assign(t, { ...body, settings });
        return json(t);
      }
      if (method === "DELETE") {
        w.toolkits = w.toolkits.filter((r) => r !== t);
        for (const v of w.versions) v.tools = v.tools.filter((x) => x.id !== t.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const v = w.versions.find((x) => x.id === body!.entity_version_id)!;
        if (w.raceAttach) v.tools.push(w.raceAttach);
        if (v.status === "published") return json({ error: `Version id ${v.id} is published and can not be updated` }, 400);
        const linked = v.tools.some((x) => x.id === t.id);
        if (body!.has_relation && linked) return json({ error: `Already exists relation with toolkit id ${t.id}` }, 400);
        if (!body!.has_relation && !linked) return json({ error: `Already removed relation with toolkit id ${t.id}` }, 400);
        if (body!.has_relation) v.tools.push({ id: t.id, name: t.name, type: t.type, settings: { selected_tools: body!.selected_tools } });
        else v.tools = v.tools.filter((x) => x.id !== t.id);
        return json({ has_relation: body!.has_relation, tool_id: t.id }, 201);
      }
    }
    if ((m = path.match(new RegExp(`^${CORE}/toolkit_available_tools/prompt_lib/${P}/(\\d+)$`)))) {
      return json(m[1] === "5" ? { tools: [{ name: "fetch", description: "Fetch a URL" }], args_schemas: {} } : { tools: [], args_schemas: {} });
    }
    if (path === `${CORE}/test_toolkit_tool/prompt_lib/${P}`) return json(w.test.body, w.test.status);
    if (path === `${CORE}/applications/prompt_lib/${P}`) return json({ total: w.agents.length, rows: w.agents });
    if ((m = path.match(new RegExp(`^${CORE}/application/prompt_lib/${P}/(\\d+)$`)))) {
      const a = w.agents.find((x) => String(x.id) === m![1])!;
      return json({ ...a, versions: w.versions.map(({ id, name, status }) => ({ id, name, status })), version_details: { id: 400, name: "base" } });
    }
    if ((m = path.match(new RegExp(`^${CORE}/version/prompt_lib/${P}/(\\d+)/(\\d+)$`)))) {
      const v = w.versions.find((x) => String(x.id) === m![2])!;
      return json({ ...v, agent_type: "openai" });
    }
    if ((m = path.match(new RegExp(`^${CFG}/configurations/(\\d+)$`)))) {
      const pid = Number(m[1]);
      if (pid === PERSONAL) return json({ total: w.personal.length, items: w.personal });
      const out: Record<string, unknown> = { total: w.credentials.length, items: w.credentials };
      if (url.searchParams.get("include_shared") === "true") {
        out.items = Number(url.searchParams.get("limit")) === 1 ? [] : w.credentials;
        out.shared = { total: w.shared.length, items: Number(url.searchParams.get("shared_offset")) > 0 ? [] : w.shared };
      }
      return json(out);
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const writes = () => calls.filter((c) => c.method !== "GET");
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function tty(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

beforeEach(async () => {
  resetContext();
  dir = await mkdtemp(join(tmpdir(), "elitea-cli-05b-"));
  process.env.ELITEA_CLI_HOME = dir;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  process.env.ELITEA_CLI_URL = "https://elitea.test";
  process.env.ELITEA_CLI_TOKEN = "tok-0123456789abcdef";
  process.env.ELITEA_CLI_PROJECT = String(P);
  for (const v of ["ELITEA_CLI_OUTPUT", "ELITEA_CLI_ENV", "CI", "NO_COLOR", "SQUAD_KEY"]) delete process.env[v];
  logs = [];
  errors = [];
  calls = [];
  prompts.answers = [];
  prompts.asked = [];
  w = world();
  serve();
  tty(false);
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (logs.push(String(chunk)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  tty(false);
  await rm(dir, { recursive: true, force: true });
  for (const v of ["ELITEA_CLI_URL", "ELITEA_CLI_TOKEN", "ELITEA_CLI_PROJECT", "SQUAD_KEY"]) delete process.env[v];
  resetContext();
});

// ---------------------------------------------------------------------------------------------

describe("type schemas", () => {
  it("finds the credential field, leaving the vector store aside", () => {
    expect(credentialFields(types.jira).map((f) => [f.name, f.section])).toEqual([
      ["jira_configuration", "credentials"],
      ["pgvector_configuration", "vectorstorage"],
    ]);
    expect(mainCredentialField(types.jira)?.name).toBe("jira_configuration");
    expect(mainCredentialField(types.zephyr_squad)).toBeUndefined();
  });

  it("marks Provider Hub secrets and SecretStr settings secret, never a credential reference", () => {
    expect(secretSettings(types.zephyr_squad)).toEqual(["access_key", "secret_key"]);
    expect(secretSettings(types.mcp)).toEqual(["client_secret"]);
    expect(secretSettings(types.jira)).toEqual([]);
    const limit = settingsOf(types.jira).find((s) => s.name === "limit")!;
    expect(limit).toMatchObject({ type: "integer", required: false, secret: false, default: 5, description: "Maximum number of issues." });
    expect(settingsOf(types.jira).find((s) => s.name === "jira_configuration")).toMatchObject({ type: "credential", required: true, credential: ["jira"] });
  });

  it("lists the type's tools; an empty selection means every tool", () => {
    expect(toolkitTools(types.jira, { settings: {} }).map((t) => t.name)).toEqual(["search_using_jql", "create_issue", "list_projects"]);
    expect(toolkitTools(types.jira, { settings: {} })[0]!.description).toBe("Search Jira with JQL.");
    expect(isSelected({ selected_tools: ["create_issue"] }, "list_projects")).toBe(false);
    expect(isSelected({}, "list_projects")).toBe(true);
    expect(enabledTools(types.jira, { settings: {} })).toHaveLength(3);
    expect(enabledTools(types.openapi, { settings: { selected_tools: [{ name: "getPet" }] } })).toEqual(["getPet"]);
  });
});

describe("types (AC-1, AC-2)", () => {
  it("lists TYPE and TITLE, without MCP and hidden types", async () => {
    await typesCommand(undefined, {});
    expect(logs[0]).toMatch(/^TYPE\s+TITLE\s+CREDENTIAL\s+TOOLS$/);
    const shown = logs.slice(1).map((l) => l.split(/\s+/)[0]);
    expect(shown).toEqual(["jira", "openapi", "zephyr_squad"]);
  });

  it("--mcp lists MCP types, from the catalog and the MCP list; --all shows hidden ones", async () => {
    await typesCommand(undefined, { mcp: true });
    expect(logs.slice(1).map((l) => l.split(/\s+/)[0])).toEqual(["mcp", "mcp_local"]);
    logs = [];
    await typesCommand(undefined, { all: true });
    expect(logs.join("\n")).toContain("bigquery");
  });

  it("one type -o json gives its settings with required and secret, and the schema", async () => {
    await typesCommand("zephyr_squad", { output: "json" });
    const out = JSON.parse(logs.join(""));
    expect(out.settings).toEqual([
      { name: "account_id", type: "string", required: true, secret: false },
      { name: "access_key", type: "string", required: true, secret: true },
      { name: "secret_key", type: "string", required: false, secret: true },
    ]);
    expect(out.tools).toEqual([{ name: "get_test_step", description: "" }]);
    expect(out.schema.properties.access_key.secret).toBe(true);
  });

  it("an unknown or unavailable type → exit 5", async () => {
    const err = await failure(typesCommand("confluence", {}));
    expect(err?.message).toBe("Toolkit type confluence is not available in this project — run `elitea-cli toolkits types`");
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
  });
});

describe("list (AC-3)", () => {
  it("shows ID, NAME, TYPE, CREDENTIAL; personal credentials are marked", async () => {
    await listCommand({});
    expect(logs[0]).toMatch(/^ID\s+NAME\s+TYPE\s+CREDENTIAL$/);
    expect(logs[1]).toMatch(/^1\s+Jira EL\s+jira\s+jira_el$/);
    expect(logs.find((l) => l.startsWith("4 "))).toMatch(/jira_staging \(personal\)$/);
  });

  it("filters by type and search on the server; --mcp lists MCP toolkits", async () => {
    await listCommand({ type: ["jira"], search: "staging" });
    const q = calls.find((c) => c.path.endsWith(`/tools/prompt_lib/${P}`))!.query;
    expect(q.getAll("toolkit_type")).toEqual(["jira"]);
    expect(q.get("query")).toBe("staging");
    logs = [];
    await listCommand({ mcp: true });
    expect(logs[1]).toMatch(/^5\s+Remote\s+mcp/);
  });

  it("0 rows → No toolkits found", async () => {
    await listCommand({ search: "nothing" });
    expect(errors).toEqual(["No toolkits found"]);
  });

  it("-o json gives compact rows: no settings, no secrets, no author", async () => {
    await listCommand({ output: "json" });
    const text = logs.join("");
    expect(text).not.toContain(FAKE);
    expect(text).not.toContain("{{secret.");
    expect(text).not.toContain("ada@a.test");
    expect(JSON.parse(text)[0]).toEqual({
      id: 1,
      name: "Jira EL",
      type: "jira",
      description: null,
      credential: "jira_el",
      selected_tools: ["search_using_jql", "create_issue"],
      mcp: false,
      created_at: "2026-11-01T10:00:00",
    });
  });
});

describe("get and tools (AC-4, AC-9)", () => {
  it("shows settings with secrets as ****, the credential and tools with SELECTED", async () => {
    await getCommand("Jira EL", {});
    const out = logs.join("\n");
    expect(out).toContain("Credential:  jira_el");
    expect(out).toContain("jira_configuration:  credential jira_el");
    expect(out).toMatch(/Tools \(2 of 3 selected\):/);
    expect(out).toMatch(/list_projects\s+no/);
    expect(out).toMatch(/create_issue\s+yes/);
  });

  it("masks vault references and plain secrets the platform returns", async () => {
    await getCommand("2", {});
    expect(logs.join("\n")).toMatch(/access_key:\s+\*\*\*\*/);
    logs = [];
    await getCommand("Petstore", { output: "json" });
    const doc = JSON.parse(logs.join(""));
    expect(doc.settings.authentication.settings).toEqual({ api_key: "****", auth_type: "Bearer" });
    expect(doc.cli.tools).toEqual([{ name: "getPet", description: "Get a pet", selected: true }]);
  });

  it("MCP: headers holding a token are masked; tools come from the server", async () => {
    await getCommand("Remote", { output: "yaml" });
    expect(logs.join("")).not.toContain(FAKE);
    logs = [];
    await toolsCommand("5", {});
    expect(logs[0]).toMatch(/^NAME\s+DESCRIPTION\s+SELECTED$/);
    expect(logs[1]).toMatch(/^fetch\s+Fetch a URL\s+yes$/);
  });

  it("an unknown toolkit → exit 5; an ambiguous one names the matches", async () => {
    expect(exitCodeOf(await failure(getCommand("nope", {})))).toBe(EXIT.notFound);
    const err = await failure(getCommand("jira", {}));
    expect(err?.message).toBe('Toolkit "jira" matches several: Jira EL (1), Jira staging (4) — use the id');
  });
});

describe("create (AC-5…AC-7)", () => {
  it("resolves credential: to the project credential and prints Created toolkit <name> (<id>)", async () => {
    const f = await file("t.yaml", "type: jira\nname: Release Jira\ncredential: Jira EL\nsettings:\n  selected_tools: [search_using_jql]\n");
    await createCommand({ file: f });
    const post = writes()[0]!;
    expect(post.body).toEqual({ type: "jira", name: "Release Jira", settings: { selected_tools: ["search_using_jql"], jira_configuration: { elitea_title: "jira_el", private: false } } });
    expect(logs).toEqual(["Created toolkit Release Jira (100)"]);
  });

  it("then personal (private: true), then shared credentials", async () => {
    await createCommand({ file: await file("a.yaml", "type: jira\nname: A\ncredential: My Jira\n") });
    expect((writes()[0]!.body!.settings as Record<string, unknown>).jira_configuration).toEqual({ elitea_title: "my_jira", private: true });
    await createCommand({ file: await file("b.yaml", "type: jira\nname: B\ncredential: public_jira\n") });
    expect((writes()[1]!.body!.settings as Record<string, unknown>).jira_configuration).toEqual({ elitea_title: "public_jira", private: false });
  });

  it("no match → exit 5; two at the same level → matches several; another type's credential doesn't count; nothing sent", async () => {
    let err = await failure(createCommand({ file: await file("a.yaml", "type: jira\nname: A\ncredential: nothing\n") }));
    expect(err?.message).toBe('Credential "nothing" not found in project 4 (this toolkit needs a jira credential) — run `elitea-cli credentials list --type jira`');
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    err = await failure(createCommand({ file: await file("b.yaml", "type: jira\nname: B\ncredential: Dup\n") }));
    expect(err?.message).toBe('Credential "Dup" matches several: dup_a (11), dup_b (12) — use its title (elitea_title)');
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    err = await failure(createCommand({ file: await file("c.yaml", "type: jira\nname: C\ncredential: gh\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    expect(writes()).toEqual([]);
  });

  it("a secret value in the file is refused (exit 2); secrets come from --secret-env and are never shown", async () => {
    let err = await failure(createCommand({ file: await file("a.yaml", `type: zephyr_squad\nname: S\nsettings:\n  account_id: a\n  access_key: ${FAKE}\n`) }));
    expect(err?.message).toMatch(/settings\.access_key: Secret field must come from --secret or --secret-env/);
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    process.env.SQUAD_KEY = FAKE;
    await createCommand({ file: await file("b.yaml", "type: zephyr_squad\nname: S\nsettings:\n  account_id: a\n"), secretEnv: ["access_key=SQUAD_KEY"], output: "json" });
    expect((writes()[0]!.body!.settings as Record<string, unknown>).access_key).toBe(FAKE);
    expect(logs.join("")).not.toContain(FAKE);
    expect(ctx.secretValues).toContain(FAKE);
  });

  it("an unknown tool in selected_tools → exit 6; a type the project can't use → exit 5; nothing sent", async () => {
    let err = await failure(createCommand({ file: await file("a.yaml", "type: jira\nname: A\nsettings:\n  selected_tools: [nope]\n") }));
    expect(err?.message).toBe('Toolkit type jira has no tool "nope" — run `elitea-cli toolkits types jira`');
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    err = await failure(createCommand({ file: await file("b.yaml", "type: confluence\nname: B\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    expect(writes()).toEqual([]);
  });

  it("platform refusals: blocked type (403) and a missing setting (400) print its text, exit 6", async () => {
    w.refuse = { status: 403, body: { ok: false, error: "Toolkit type 'jira' is not available in this deployment" } };
    let err = await failure(createCommand({ file: await file("a.yaml", "type: jira\nname: A\n") }));
    expect(err?.message).toBe("Toolkit type 'jira' is not available in this deployment");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    w.refuse = { status: 400, body: { ok: false, error: [{ loc: ["jira_configuration"], msg: '{"error_type": "credential_not_found", "credential_id": "gone"}' }] } };
    err = await failure(createCommand({ file: await file("b.yaml", "type: jira\nname: B\n") }));
    expect(err?.message).toBe('jira_configuration: Credential "gone" not found');
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
  });

  it("a role refusal stays exit 4 (story 02 AC-8)", async () => {
    w.refuse = { status: 403, body: { error: "Forbidden" } };
    const err = await failure(createCommand({ file: await file("a.yaml", "type: jira\nname: A\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.denied);
  });

  it("file checks: unknown fields, missing type or name, credential and the field both", async () => {
    expect((await failure(createCommand({ file: await file("a.yaml", "type: jira\nname: A\nfoo: 1\n") })))?.message).toMatch(/unknown field foo/);
    expect((await failure(createCommand({ file: await file("b.yaml", "name: A\n") })))?.message).toMatch(/type is missing/);
    expect((await failure(createCommand({ file: await file("c.yaml", "type: jira\n") })))?.message).toMatch(/name is missing/);
    const both = await failure(createCommand({ file: await file("d.yaml", "type: jira\nname: A\ncredential: jira_el\nsettings:\n  jira_configuration: {elitea_title: x}\n") }));
    expect(both?.message).toMatch(/give credential or settings.jira_configuration, not both/);
    expect(writes()).toEqual([]);
  });
});

describe("update (AC-8)", () => {
  it("changes only the given settings; the PUT carries the whole toolkit", async () => {
    await updateCommand("Jira EL", { file: await file("u.yaml", "settings:\n  limit: 10\n") });
    const put = writes()[0]!;
    expect(put.method).toBe("PUT");
    expect(put.body).toMatchObject({ type: "jira", name: "Jira EL", author_id: 7 });
    expect(put.body!.settings).toEqual({ jira_configuration: { elitea_title: "jira_el", private: false }, limit: 10, selected_tools: ["search_using_jql", "create_issue"] });
    expect(logs).toEqual(["Updated toolkit Jira EL (1)"]);
  });

  it("secret settings not given keep their stored value; a new one replaces it", async () => {
    await updateCommand("Squad", { file: await file("u.yaml", "settings:\n  account_id: b\n") });
    expect(writes()[0]!.body!.settings).toMatchObject({ access_key: "{{secret.squad_access_key}}", secret_key: "{{secret.squad_secret_key}}" });
    process.env.SQUAD_KEY = FAKE;
    await updateCommand("Squad", { file: await file("v.yaml", "settings: {}\n"), secretEnv: ["access_key=SQUAD_KEY"] });
    expect(writes()[1]!.body!.settings).toMatchObject({ access_key: FAKE, secret_key: "{{secret.squad_secret_key}}" });
  });

  it("a literal **** → exit 2; a {{secret.…}} copied from get keeps the stored secret", async () => {
    const err = await failure(updateCommand("Squad", { file: await file("u.yaml", "settings:\n  access_key: '****'\n") }));
    expect(err?.message).toMatch(/settings\.access_key: Field contains '\*\*\*\*'; leave secret fields out to keep stored values/);
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    await updateCommand("Squad", { file: await file("v.yaml", "settings:\n  access_key: '{{secret.other}}'\n  account_id: c\n") });
    expect(writes()[0]!.body!.settings).toMatchObject({ access_key: "{{secret.squad_access_key}}" });
  });

  it("no changes → nothing sent; a type change → exit 2; credential: re-resolves", async () => {
    await updateCommand("Jira EL", { file: await file("u.yaml", "settings:\n  limit: 5\n") });
    expect(errors).toEqual(["No changes"]);
    expect(writes()).toEqual([]);
    expect(exitCodeOf(await failure(updateCommand("Jira EL", { file: await file("t.yaml", "type: github\n") })))).toBe(EXIT.usage);
    await updateCommand("Jira EL", { file: await file("c.yaml", "credential: My Jira\n") });
    expect((writes()[0]!.body!.settings as Record<string, unknown>).jira_configuration).toEqual({ elitea_title: "my_jira", private: true });
  });

  it("a change by someone else between the reads → exit 6, nothing sent", async () => {
    w.bumpOnRead = 2;
    const err = await failure(updateCommand("Jira EL", { file: await file("u.yaml", "settings:\n  limit: 10\n") }));
    expect(err?.message).toBe("Jira EL was changed by someone else; run the command again");
    expect(writes()).toEqual([]);
  });
});

describe("test (AC-10)", () => {
  it("runs the tool with --args and prints its result, exit 0", async () => {
    const code = await testCommand("Jira EL", "search_using_jql", { args: '{"jql": "project = EL"}', yes: true });
    expect(code).toBe(EXIT.ok);
    const post = writes()[0]!;
    expect(post.path).toBe(`${CORE}/test_toolkit_tool/prompt_lib/${P}`);
    expect(post.query.get("await_response")).toBe("true");
    expect(post.body).toMatchObject({ tool_name: "search_using_jql", tool_params: { jql: "project = EL" }, toolkit_config: { toolkit_id: 1, type: "jira" } });
    expect(JSON.parse(logs.join(""))).toEqual({ total: 1, issues: ["EL-1"] });
  });

  it("the tool's error → stderr, exit 1; -o json gives {ok, result, error}", async () => {
    w.test.body = { result: { success: false, error: "Jira said 401" } };
    expect(await testCommand("1", "search_using_jql", { yes: true })).toBe(EXIT.general);
    expect(errors).toEqual(["search_using_jql failed: Jira said 401"]);
    logs = [];
    expect(await testCommand("1", "search_using_jql", { yes: true, output: "json" })).toBe(EXIT.general);
    expect(JSON.parse(logs.join(""))).toMatchObject({ ok: false, result: null, error: "Jira said 401", tool: "search_using_jql" });
  });

  it("asks in a terminal; no runs nothing; a non-terminal without --yes → exit 2", async () => {
    tty(true);
    prompts.answers = [false];
    expect(await testCommand("1", "search_using_jql", {})).toBe(EXIT.ok);
    expect(prompts.asked).toEqual(["Run search_using_jql on Jira EL? It may change data in Jira."]);
    expect(writes()).toEqual([]);
    tty(false);
    const err = await failure(testCommand("1", "search_using_jql", {}));
    expect(err?.message).toBe("Confirming a tool run needs a terminal; pass --yes to run search_using_jql on Jira EL");
    expect(exitCodeOf(err)).toBe(EXIT.usage);
  });

  it("an unknown tool → exit 6; bad --args → exit 2; a timeout → exit 8", async () => {
    expect(exitCodeOf(await failure(testCommand("1", "nope", { yes: true })))).toBe(EXIT.conflict);
    expect(exitCodeOf(await failure(testCommand("1", "search_using_jql", { args: "[1]", yes: true })))).toBe(EXIT.usage);
    expect(exitCodeOf(await failure(testCommand("1", "search_using_jql", { args: "{", yes: true })))).toBe(EXIT.usage);
    w.test = { status: 400, body: { error: "Timeout" } };
    expect(exitCodeOf(await failure(testCommand("1", "search_using_jql", { yes: true, timeout: "5" })))).toBe(EXIT.timeout);
  });
});

describe("delete (AC-11)", () => {
  it("confirms; outside a terminal --yes is needed; the platform detaches it from agents", async () => {
    expect(exitCodeOf(await failure(deleteCommand("1", {})))).toBe(EXIT.usage);
    await deleteCommand("1", { yes: true });
    expect(writes()[0]).toMatchObject({ method: "DELETE", path: `${CORE}/tool/prompt_lib/${P}/1` });
    expect(logs).toEqual(["Deleted toolkit Jira EL (1)"]);
    expect(w.versions[0]!.tools).toEqual([]);
  });

  it("in a terminal it says what happens to agents before asking", async () => {
    tty(true);
    prompts.answers = [true];
    await deleteCommand("Squad", {});
    expect(errors[0]).toMatch(/EliteA removes it from every version, published ones too/);
    expect(prompts.asked).toEqual(["Delete toolkit 'Squad' (2)?"]);
  });
});

describe("agents toolkits add | remove (AC-12…AC-15)", () => {
  it("add attaches with all its selected tools; --tools picks some", async () => {
    await addCommand("Release bot", "Squad", {});
    expect(writes()[0]!.body).toEqual({ entity_id: 40, entity_version_id: 400, entity_type: "agent", has_relation: true });
    expect(logs).toEqual(["Attached Squad to Release bot/base (1 tool)"]);
    logs = [];
    await addCommand("Release bot", "4", { tools: "search_using_jql, create_issue" });
    expect(writes()[1]!.body).toMatchObject({ selected_tools: ["search_using_jql", "create_issue"] });
    expect(logs).toEqual(["Attached Jira staging to Release bot/base (2 tools)"]);
  });

  it("already attached → exit 0, nothing changed", async () => {
    await addCommand("Release bot", "Jira EL", {});
    expect(logs).toEqual(["Jira EL is already attached to Release bot/base"]);
    expect(writes()).toEqual([]);
  });

  it("an unknown tool in --tools → exit 6, nothing changed; only the toolkit's selected tools count", async () => {
    const err = await failure(addCommand("Release bot", "4", { tools: "nope" }));
    expect(err?.message).toBe('Jira staging has no tool "nope" — its tools: search_using_jql, create_issue, list_projects');
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    w.versions[0]!.tools = [];
    expect((await failure(addCommand("Release bot", "Jira EL", { tools: "list_projects" })))?.message).toMatch(/has no tool "list_projects"/);
    expect(writes()).toEqual([]);
  });

  it("remove detaches; not attached → exit 5", async () => {
    await removeCommand("Release bot", "Jira EL", {});
    expect(writes()[0]!.body).toMatchObject({ entity_version_id: 400, has_relation: false });
    expect(logs).toEqual(["Detached Jira EL from Release bot/base"]);
    const err = await failure(removeCommand("Release bot", "Squad", {}));
    expect(err?.message).toBe("Squad is not attached to Release bot/base");
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
  });

  it("a published version → story 04 AC-13 text, exit 6", async () => {
    const err = await failure(addCommand("Release bot", "Squad", { agentVersion: "v1" }));
    expect(err?.message).toBe("Version id 401 is published and can not be updated\nCreate a new version with `elitea-cli agents version create`");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
  });

  it("a link changed by someone else in between → story 04 AC-22, exit 6", async () => {
    // The version read says not attached; by the PATCH someone else attached it.
    w.versions[0]!.tools = [];
    w.raceAttach = { id: 2, name: "Squad" };
    const err = await failure(addCommand("Release bot", "Squad", {}));
    expect(err?.message).toBe("Release bot/base was changed on the server since you opened it; run the command again");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
  });
});

describe("secret hygiene (AC-17)", () => {
  it("masks secrets in the --debug log of every request", async () => {
    ctx.debug = true;
    process.env.SQUAD_KEY = FAKE;
    await createCommand({ file: await file("a.yaml", "type: zephyr_squad\nname: S\nsettings:\n  account_id: a\n"), secretEnv: ["access_key=SQUAD_KEY"] });
    await getCommand("Petstore", {});
    await getCommand("Remote", { output: "json" });
    expect([...errors, ...logs].join("\n")).not.toContain(FAKE);
  });

  it("maskSettings: schema secrets, vault refs, nested secret keys and auth headers", () => {
    const out = maskSettings(
      { access_key: "x", account_id: "a", nested: { token: "t", ok: "v" }, headers: { Authorization: "Bearer y" }, empty: "" , secret_key: "" },
      types.zephyr_squad,
    );
    expect(out).toEqual({ access_key: "****", account_id: "a", nested: { token: "****", ok: "v" }, headers: { Authorization: "****" }, empty: "", secret_key: "" });
  });

  it("checkFileSecrets and the update body never send ****", () => {
    const file = readToolkitFile({ settings: { access_key: "{{secret.k}}" } }, "f");
    expect(() => checkFileSecrets(file, ["access_key"], "f")).not.toThrow();
    const { body } = updateBody(w.toolkits[1]!, file, ["access_key"], {});
    expect((body.settings as Record<string, unknown>).access_key).toBe("{{secret.squad_access_key}}");
  });
});

describe("found on dev.elitea.ai (2026-11-17)", () => {
  it("--debug reads a large body once and still parses it (the type catalog is ~1.7 MB)", async () => {
    ctx.debug = true;
    const big = { jira: { ...types.jira, description: "x".repeat(2_000_000) } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(big)));
    const client = new EliteaClient("https://elitea.test", "tok-0123456789abcdef");
    const got = await client.listToolkitTypes(P);
    expect(Object.keys(got)).toEqual(["jira"]);
  });
});

describe("scoped tokens and Claude Code (AC-16, story 02 AC-9, AC-23)", () => {
  it("writes need build, test needs run", () => {
    for (const c of ["toolkits create", "toolkits update", "toolkits delete", "agents toolkits add", "agents toolkits remove"]) expect(operationFor(c)).toBe("build");
    expect(operationFor("toolkits test")).toBe("run");
    for (const c of ["toolkits list", "toolkits get", "toolkits types", "toolkits tools"]) expect(operationFor(c)).toBeUndefined();
  });

  it("reads run without a prompt; writes, test and attach always ask", () => {
    for (const c of ["list", "get", "types", "tools"]) expect(ELITEA_PERMISSIONS.allow).toContain(`Bash(elitea-cli toolkits ${c}:*)`);
    for (const c of ["toolkits create", "toolkits update", "toolkits delete", "toolkits test", "agents toolkits"]) expect(ELITEA_PERMISSIONS.ask).toContain(`Bash(elitea-cli ${c}:*)`);
  });

  it("the skill teaches toolkits and attach; /elitea:toolkits lists them", () => {
    const skill = pluginFiles()["skills/elitea/SKILL.md"]!;
    expect(skill).toContain("elitea-cli toolkits create -f");
    expect(skill).toContain("elitea-cli agents toolkits add <agent> <toolkit>");
    expect(skill).toContain("--secret-env <setting>=<ENV_VAR>");
    expect(skill).toMatch(/get their OK in the conversation first/);
    expect(pluginFiles()["commands/toolkits.md"]).toContain("elitea-cli toolkits list --json");
  });
});
