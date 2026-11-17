import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  createCommand,
  deleteCommand,
  getCommand,
  listCommand,
  testCommand,
  typesCommand,
  updateCommand,
} from "../src/commands/credentials.js";
import { ctx, operationFor, resetContext } from "../src/context.js";
import {
  checkFileSecrets,
  createBody,
  fieldsOf,
  findCredentials,
  maskCredential,
  needsSignIn,
  readCredentialFile,
  scopeOf,
  secretPaths,
  statusOf,
  updateBody,
} from "../src/credentialsCore.js";
import type { Credential, CredentialType } from "../src/elitea.js";
import { EXIT, exitCodeOf } from "../src/errors.js";
import { ELITEA_PERMISSIONS } from "../src/integrations/claudePlugin.js";

const P = 4;
const PERSONAL = 9;
const PUBLIC = 1;
/** The fake secret of AC-14: it must never appear anywhere. */
const FAKE = "s3cr3t-FAKE-jira-token-7531";
const CFG = "/api/v2/configurations";

// Schemas as `configurations/available` returns them (Pydantic v2 model_json_schema of the SDK models).
const optionalSecret = { anyOf: [{ format: "password", type: "string", writeOnly: true }, { type: "null" }], default: null };
const types: CredentialType[] = [
  {
    type: "jira",
    section: "credentials",
    has_test_connection: true,
    config_schema: {
      title: "Jira",
      properties: {
        data: {
          type: "object",
          required: ["base_url"],
          properties: {
            hosting: { anyOf: [{ enum: ["Auto", "Cloud", "Server"], type: "string" }, { type: "null" }] },
            base_url: { type: "string" },
            username: { anyOf: [{ type: "string" }, { type: "null" }] },
            api_key: optionalSecret,
            token: optionalSecret,
          },
        },
      },
    },
  },
  {
    type: "teams",
    section: "credentials",
    has_test_connection: true,
    config_schema: {
      title: "Microsoft Teams",
      properties: {
        data: {
          type: "object",
          properties: {
            client_id: { type: "string" },
            client_secret: optionalSecret,
            oauth_discovery_endpoint: { type: "string" },
            refresh_token: { ...optionalSecret, hidden: true },
          },
        },
      },
    },
  },
  {
    type: "open_ai",
    section: "ai_credentials",
    has_test_connection: false,
    config_schema: { title: "OpenAI", properties: { data: { type: "object", properties: { api_key: { format: "password", type: "string", writeOnly: true } } } } },
  },
];

let dir: string;
let logs: string[];
let errors: string[];
let calls: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown>; raw?: string }>;

function world() {
  const row = (id: number, extra: Partial<Credential>): Credential => ({
    id,
    uuid: `uuid-${id}`,
    project_id: P,
    elitea_title: `cred_${id}`,
    label: `Cred ${id}`,
    type: "jira",
    section: "credentials",
    data: {},
    meta: {},
    shared: false,
    status_ok: false,
    status_logs: null,
    author_id: 7,
    created_at: "2026-11-01T10:00:00",
    updated_at: "2026-11-01T10:00:00",
    ...extra,
  });
  return {
    rows: [
      row(1, { elitea_title: "jira_el", label: "Jira EL", status_ok: true, data: { base_url: "https://jira.test", username: "ada", api_key: "{{secret.jira_el_api_key}}" } }),
      row(2, { elitea_title: "teams_main", label: "Teams", type: "teams", status_logs: "boom", data: { client_id: "abc", client_secret: "{{secret.t_cs}}" } }),
      row(3, { elitea_title: "jira_staging", label: "Jira staging", data: { base_url: "https://staging.test" } }),
    ],
    shared: [row(50, { project_id: PUBLIC, elitea_title: "public_jira", label: "Public Jira", shared: true, data: { base_url: "https://pub.test" } })],
    nextId: 100,
    /** The next write fails with this status and body. */
    refuse: undefined as undefined | { status: number; body: unknown },
    /** Answer of check_connection. */
    check: { status: 200, body: { success: true } as Record<string, unknown> },
    /** Change the row between the update's two reads (AC-7a). */
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
    if (path === `${CFG}/available/${P}`) {
      const sections = url.searchParams.getAll("section");
      return json(types.filter((t) => sections.length === 0 || sections.includes(t.section)));
    }
    if (path === `${CFG}/configurations/${P}` && method === "GET") {
      const type = url.searchParams.getAll("type");
      const filter = (rows: Credential[]) => rows.filter((r) => type.length === 0 || type.includes(r.type));
      const own = filter(w.rows);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const out: Record<string, unknown> = { total: own.length, items: own.slice(offset, offset + limit), offset, limit };
      if (url.searchParams.get("include_shared") === "true") {
        const so = Number(url.searchParams.get("shared_offset") ?? 0);
        const sl = Number(url.searchParams.get("shared_limit") ?? 20);
        const shared = filter(w.shared);
        out.shared = { total: shared.length, items: shared.slice(so, so + sl) };
      }
      return json(out);
    }
    if (path === `${CFG}/configurations/${P}` && method === "POST") {
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      if (w.rows.some((r) => r.elitea_title === body!.elitea_title)) {
        return json({ error: `Credential with ID '${String(body!.elitea_title)}' already exists`, field: "elitea_title" }, 400);
      }
      const data = { ...(body!.data as Record<string, unknown>) };
      // The platform stores secrets in the vault and keeps a reference in the row.
      for (const k of ["api_key", "token", "client_secret"]) if (typeof data[k] === "string" && !String(data[k]).startsWith("{{")) data[k] = `{{secret.${String(body!.elitea_title)}_${k}}}`;
      const created = { ...w.rows[0]!, id: w.nextId++, uuid: "uuid-new", elitea_title: String(body!.elitea_title), label: String(body!.label), type: String(body!.type), data, status_ok: false };
      w.rows.push(created);
      return json(created);
    }
    if ((m = path.match(new RegExp(`^${CFG}/configuration/(\\d+)/(\\d+)$`)))) {
      const rows = Number(m[1]) === PUBLIC ? w.shared : w.rows;
      const row = rows.find((r) => String(r.id) === m![2]);
      if (!row) return json({ error: "Configuration not found" }, 404);
      if (method === "GET") {
        if (w.bumpOnRead > 0 && --w.bumpOnRead === 0) {
          const snapshot = structuredClone(row);
          row.updated_at = "2026-11-17T09:00:00";
          return json(snapshot);
        }
        return json(row);
      }
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      if (method === "PUT") {
        const stored = structuredClone(body!);
        const data = stored.data as Record<string, unknown> | undefined;
        if (data) for (const k of ["api_key", "token", "client_secret"]) if (typeof data[k] === "string" && !String(data[k]).startsWith("{{")) data[k] = `{{secret.new_${k}}}`;
        Object.assign(row, stored, { updated_at: "2026-11-17T10:00:00" });
        return json(row);
      }
      if (method === "DELETE") {
        w.rows = w.rows.filter((r) => r !== row);
        return new Response(null, { status: 204 });
      }
    }
    if ((m = path.match(new RegExp(`^${CFG}/check_connection/${P}/(\\w+)$`))) && method === "POST") {
      return json(w.check.body, w.check.status);
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

function stdin(text: string) {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from(text);
  } as never);
}

const JIRA_FILE = "elitea_title: jira_new\nlabel: Jira new\ntype: jira\ndata:\n  base_url: https://jira.test\n  username: ada\n";

beforeEach(async () => {
  resetContext();
  dir = await mkdtemp(join(tmpdir(), "elitea-cli-05a-"));
  process.env.ELITEA_CLI_HOME = dir;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  process.env.ELITEA_CLI_URL = "https://elitea.test";
  process.env.ELITEA_CLI_TOKEN = "tok-0123456789abcdef";
  process.env.ELITEA_CLI_PROJECT = String(P);
  for (const v of ["ELITEA_CLI_OUTPUT", "ELITEA_CLI_ENV", "CI", "NO_COLOR", "JIRA_TOKEN"]) delete process.env[v];
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
  for (const v of ["ELITEA_CLI_URL", "ELITEA_CLI_TOKEN", "ELITEA_CLI_PROJECT", "JIRA_TOKEN"]) delete process.env[v];
  resetContext();
});

// ---------------------------------------------------------------------------------------------

describe("type schemas (AC-1)", () => {
  it("reads required and secret flags; Optional[SecretStr] counts as secret", () => {
    const fields = fieldsOf(types[0]);
    expect(fields.map((f) => [f.name, f.required, f.secret])).toEqual([
      ["hosting", false, false],
      ["base_url", true, false],
      ["username", false, false],
      ["api_key", false, true],
      ["token", false, true],
    ]);
    expect(fields[0]!.type).toBe("Auto|Cloud|Server");
    expect(secretPaths(types[1])).toEqual(["client_secret", "refresh_token"]);
  });

  it("finds a secret one object deep", () => {
    const t: CredentialType = {
      type: "x",
      section: "credentials",
      config_schema: { properties: { data: { properties: { auth: { type: "object", properties: { password: { format: "password", type: "string" }, user: { type: "string" } } } } } } },
    };
    expect(secretPaths(t)).toEqual(["auth.password"]);
  });

  it("types lists TYPE, TITLE, SECTION and the fields with markers", async () => {
    await typesCommand({});
    expect(logs[0]).toMatch(/^TYPE\s+TITLE\s+SECTION\s+FIELDS/);
    const jira = logs.find((l) => l.startsWith("jira"))!;
    expect(jira).toContain("base_url*");
    expect(jira).toContain("api_key (secret)");
    // A field the platform sets (sign-in) is not offered.
    expect(logs.find((l) => l.startsWith("teams"))).not.toContain("refresh_token");
    expect(calls[0]!.query.getAll("section")).toEqual(["credentials", "ai_credentials"]);
  });

  it("-o json gives the full schema", async () => {
    await typesCommand({ output: "json", type: "jira" });
    const out = JSON.parse(logs.join(""));
    expect(out).toHaveLength(1);
    expect(out[0].config_schema.properties.data.properties.api_key).toEqual(optionalSecret);
  });

  it("an unknown --type exits 5", async () => {
    expect(exitCodeOf(await failure(typesCommand({ type: "nope" })))).toBe(EXIT.notFound);
  });
});

describe("list (AC-2, AC-12)", () => {
  it("shows ID, TITLE, TYPE, SCOPE and the stored STATUS; runs no check", async () => {
    await listCommand({});
    expect(logs[0]).toMatch(/^ID\s+TITLE\s+TYPE\s+SCOPE\s+STATUS/);
    const line = (title: string) => logs.find((l) => l.includes(title))!.split(/\s{2,}/);
    expect(line("jira_el").slice(0, 5)).toEqual(["1", "jira_el", "jira", "project", "ok"]);
    expect(line("teams_main").slice(3, 5)).toEqual(["project", "failed"]);
    expect(line("jira_staging").slice(3, 5)).toEqual(["project", "unknown"]);
    expect(line("public_jira").slice(3, 5)).toEqual(["shared", "unknown"]);
    expect(calls.some((c) => c.path.includes("check_connection"))).toBe(false);
  });

  it("--type filters on the server", async () => {
    await listCommand({ type: "teams" });
    expect(calls.find((c) => c.path.endsWith(`/configurations/${P}`))!.query.getAll("type")).toEqual(["teams"]);
    expect(logs.filter((l) => /^\d/.test(l))).toHaveLength(1);
  });

  it("no rows → 'No credentials found' (story 02 AC-6), exit 0", async () => {
    w.rows = [];
    w.shared = [];
    await listCommand({});
    expect(errors).toContain("No credentials found");
    expect(logs).toEqual([]);
  });

  it("reads every page", async () => {
    w.rows = Array.from({ length: 230 }, (_, i) => ({ ...w.rows[0]!, id: 1000 + i, elitea_title: `c${i}` }));
    await listCommand({ output: "json" });
    expect(JSON.parse(logs.join("")).filter((r: Credential) => r.project_id === P)).toHaveLength(230);
  });

  it("-o json masks secrets and adds scope and status", async () => {
    await listCommand({ output: "json" });
    const rows = JSON.parse(logs.join(""));
    expect(rows[0].data.api_key).toBe("****");
    expect(rows[0]).toMatchObject({ scope: "project", status: "ok" });
  });

  it("scope: personal project and shared rows", () => {
    const c = { project_id: PERSONAL, shared: false } as Credential;
    expect(scopeOf(c, PERSONAL, PERSONAL)).toBe("personal");
    expect(scopeOf(c, P, PERSONAL)).toBe("shared");
    expect(scopeOf({ ...c, project_id: P, shared: true }, P, PERSONAL)).toBe("shared");
    expect(statusOf({ status_ok: false, status_logs: "" })).toBe("unknown");
  });
});

describe("get (AC-3, AC-11)", () => {
  it("prints every field; secrets as **** whatever the API returns", async () => {
    w.rows[0]!.data.api_key = FAKE; // even a raw value from the API is masked
    await getCommand("jira_el", {});
    const text = logs.join("\n");
    expect(text).toContain("api_key:");
    expect(text).toMatch(/api_key:\s+\*\*\*\*/);
    expect(text).toMatch(/base_url:\s+https:\/\/jira.test/);
    expect(text).toMatch(/token:\s+\(not set\)/);
    expect(text).not.toContain(FAKE);
  });

  it("json and yaml mask too; unknown fields print as returned", async () => {
    w.rows[0]!.data.extra_field = "as is";
    await getCommand("1", { output: "json" });
    const json = JSON.parse(logs.join(""));
    expect(json.data).toMatchObject({ api_key: "****", extra_field: "as is", base_url: "https://jira.test" });
    logs = [];
    await getCommand("Jira EL", { output: "yaml" });
    expect(logs.join("")).toContain("api_key: \"****\"");
  });

  it("finds by id, title, label; ambiguous or unknown → exit 5", async () => {
    await getCommand("JIRA_EL", { output: "json" });
    expect(JSON.parse(logs.join("")).id).toBe(1);
    expect(findCredentials(w.rows, "jira").map((c) => c.id)).toEqual([1, 3]);
    const err = await failure(getCommand("jira", {}));
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    expect(err!.message).toContain("matches several");
    expect(exitCodeOf(await failure(getCommand("nothing", {})))).toBe(EXIT.notFound);
  });

  it("an OAuth type without a sign-in says where to sign in", async () => {
    await getCommand("teams_main", {});
    expect(errors.join("\n")).toContain(`Sign-in required: open ELITEA → Credentials → Teams to sign in (https://elitea.test/app/${P}/credentials/all/2)`);
    expect(needsSignIn(types[1], { ...w.rows[1]!, data: { refresh_token: "{{secret.x}}" } })).toBe(false);
    expect(needsSignIn(types[1], { ...w.rows[1]!, data: { auth_mode: "entra_delegated" } })).toBe(false);
    expect(needsSignIn(types[0], w.rows[0]!)).toBe(false);
  });

  it("a shared credential is read from its own project", async () => {
    await getCommand("public_jira", { output: "json" });
    expect(calls.some((c) => c.path === `${CFG}/configuration/${PUBLIC}/50`)).toBe(true);
  });
});

describe("files and secrets (AC-4…AC-6)", () => {
  const jira = types[0];
  const secrets = secretPaths(jira);

  it("a secret value in the file is refused, exit 2, nothing sent", async () => {
    const path = await file("c.yaml", `${JIRA_FILE}  api_key: ${FAKE}\n`);
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("Secret field must come from --secret or --secret-env, not from the file");
    expect(err!.message).not.toContain(FAKE);
    expect(writes()).toEqual([]);
  });

  it("**** anywhere in the file is refused, exit 2", async () => {
    const path = await file("c.yaml", `${JIRA_FILE}  api_key: "****"\n`);
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("Field contains '****'; leave secret fields out to keep stored values");
    expect(writes()).toEqual([]);
  });

  it("a {{secret.…}} reference copied from get is left out, not refused", () => {
    const f = readCredentialFile({ type: "jira", elitea_title: "a", data: { base_url: "u", api_key: "{{secret.a}}" } }, "f");
    expect(() => checkFileSecrets(f, secrets, "f")).not.toThrow();
    expect((createBody(f, secrets, {}).data as Record<string, unknown>).api_key).toBeUndefined();
  });

  it("server fields of a get -o yaml file are ignored; unknown top-level fields exit 2", () => {
    expect(() => readCredentialFile({ id: 1, status_ok: true, type: "jira", data: {} }, "f")).not.toThrow();
    expect(() => readCredentialFile({ type: "jira", passwrd: "x" }, "f")).toThrow(/unknown field passwrd/);
  });

  it("--secret reads one value from stdin; a trailing newline is dropped", async () => {
    stdin(`${FAKE}\n`);
    const path = await file("c.yaml", JIRA_FILE);
    await createCommand({ file: path, secret: ["api_key"] });
    const post = writes()[0]!;
    expect(post.body).toMatchObject({ type: "jira", elitea_title: "jira_new", label: "Jira new", data: { base_url: "https://jira.test", api_key: FAKE } });
    expect(logs).toEqual([`Created credential jira_new (100)`]);
  });

  it("--secret prompts (masked) in a terminal, for each field", async () => {
    tty(true);
    prompts.answers = [FAKE, `${FAKE}-2`];
    const path = await file("c.yaml", JIRA_FILE);
    await createCommand({ file: path, secret: ["api_key", "token"] });
    expect(prompts.asked).toEqual(["api_key (jira)", "token (jira)"]);
    expect(writes()[0]!.body!.data).toMatchObject({ api_key: FAKE, token: `${FAKE}-2` });
  });

  it("two --secret without a terminal → story 02 AC-21b, exit 2", async () => {
    const path = await file("c.yaml", JIRA_FILE);
    const err = await failure(createCommand({ file: path, secret: ["api_key", "token"] }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("Only one option can read stdin");
    expect(writes()).toEqual([]);
  });

  it("-f - with --secret both want stdin → exit 2", async () => {
    const err = await failure(createCommand({ file: "-", secret: ["api_key"] }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
  });

  it("--secret-env takes the value from the environment; unset or empty → exit 2", async () => {
    const path = await file("c.yaml", JIRA_FILE);
    let err = await failure(createCommand({ file: path, secretEnv: ["api_key=JIRA_TOKEN"] }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("Environment variable is not set");
    process.env.JIRA_TOKEN = "";
    err = await failure(createCommand({ file: path, secretEnv: ["api_key=JIRA_TOKEN"] }));
    expect(err!.message).toContain("Environment variable is not set");
    expect(writes()).toEqual([]);
    process.env.JIRA_TOKEN = FAKE;
    await createCommand({ file: path, secretEnv: ["api_key=JIRA_TOKEN"] });
    expect(writes()[0]!.body!.data).toMatchObject({ api_key: FAKE });
  });

  it("a --secret that is not a secret field of the type → exit 2 with the secret fields", async () => {
    const path = await file("c.yaml", JIRA_FILE);
    const err = await failure(createCommand({ file: path, secret: ["base_url"] }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("secret fields: api_key, token");
  });

  it("--secret-env without = → exit 2", async () => {
    const path = await file("c.yaml", JIRA_FILE);
    expect(exitCodeOf(await failure(createCommand({ file: path, secretEnv: ["api_key"] })))).toBe(EXIT.usage);
  });

  it("no option takes a secret value inline: --secret names a field, --secret-env a variable", async () => {
    const cli = await readFile(join(import.meta.dirname, "../src/cli.ts"), "utf8");
    const block = cli.slice(cli.indexOf('credentials.command("create")'), cli.indexOf('credentials.command("test")'));
    const options = [...block.matchAll(/\.option\("([^"]+)"/g)].map((m) => m[1]);
    expect(options.filter((o) => /secret/.test(o!))).toEqual(["--secret <field>", "--secret-env <field=VAR>", "--secret <field>", "--secret-env <field=VAR>"]);
    expect(block).not.toMatch(/--(secret-value|password|api-key|token)\b/);
  });
});

describe("create refusals (AC-8, AC-12)", () => {
  it("a duplicate title: the platform's text, exit 6", async () => {
    const path = await file("c.yaml", JIRA_FILE.replace("jira_new", "jira_el"));
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("elitea_title: Credential with ID 'jira_el' already exists");
  });

  it("a missing required field: the platform's text, exit 6", async () => {
    w.refuse = { status: 400, body: { error: "Field required", field: "base_url" } };
    const path = await file("c.yaml", "elitea_title: x\ntype: jira\ndata: {}\n");
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("base_url: Field required");
  });

  it("an admin-managed type: the platform's text, exit 6", async () => {
    w.refuse = { status: 403, body: { error: "This configuration is managed in the Admin Portal", field: "type" } };
    const path = await file("c.yaml", JIRA_FILE);
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("This configuration is managed in the Admin Portal");
  });

  it("a viewer is refused with story 02 AC-8, exit 4", async () => {
    w.refuse = { status: 403, body: { error: "Forbidden" } };
    const path = await file("c.yaml", JIRA_FILE);
    const err = await failure(createCommand({ file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.denied);
    expect(err!.message).toContain("your role in project 4 does not allow this");
  });

  it("a scoped token without build gets story 02 AC-9", async () => {
    ctx.operation = operationFor("credentials create");
    w.refuse = { status: 403, body: { error: "TOKEN_SCOPE_OPERATION" } };
    const path = await file("c.yaml", JIRA_FILE);
    const err = await failure(createCommand({ file: path }));
    expect(err!.message).toContain("Create a token with the 'build' operation");
    expect(operationFor("credentials test")).toBe("run");
  });

  it("a type the catalog doesn't list is sent: the platform answers (exit 6)", async () => {
    w.refuse = { status: 400, body: { error: "Configuration type was not found", field: "type" } };
    const err = await failure(createCommand({ file: await file("a.yaml", "elitea_title: a\ntype: nope\ndata: {}\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("Configuration type was not found");
  });

  it("a missing title or type exits 2, nothing sent", async () => {
    expect(exitCodeOf(await failure(createCommand({ file: await file("b.yaml", "elitea_title: a\ndata: {}\n") })))).toBe(EXIT.usage);
    expect(exitCodeOf(await failure(createCommand({ file: await file("c.yaml", "type: jira\ndata: {}\n") })))).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
  });

  it("an OAuth type can be created; the sign-in is not done by the CLI (AC-11)", async () => {
    const path = await file("t.yaml", "elitea_title: t2\ntype: teams\ndata:\n  client_id: abc\n");
    await createCommand({ file: path });
    expect(logs[0]).toBe("Created credential t2 (100)");
    expect(errors.join("\n")).toContain("Sign-in required: open ELITEA → Credentials → t2 to sign in");
  });

  it("-q prints the id, -o json the masked object", async () => {
    stdin(FAKE);
    ctx.quiet = true;
    await createCommand({ file: await file("c.yaml", JIRA_FILE), secret: ["api_key"] });
    expect(logs).toEqual(["100"]);
    ctx.quiet = false;
    logs = [];
    stdin(FAKE);
    await createCommand({ file: await file("d.yaml", JIRA_FILE.replace("jira_new", "jira_d")), secret: ["api_key"], output: "json" });
    expect(JSON.parse(logs.join("")).data.api_key).toBe("****");
  });
});

describe("update (AC-7)", () => {
  it("changes the given fields; stored secrets keep their reference; **** is never sent", async () => {
    const path = await file("u.yaml", "data:\n  username: bob\n");
    await updateCommand("jira_el", { file: path });
    const put = writes()[0]!;
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual({ data: { base_url: "https://jira.test", username: "bob", api_key: "{{secret.jira_el_api_key}}" } });
    expect(put.raw).not.toContain("****");
    expect(logs).toEqual(["Updated credential jira_el (1)"]);
  });

  it("a file from get -o yaml (masked) is refused; with secrets left out it updates", async () => {
    await getCommand("jira_el", { output: "yaml" });
    const yaml = logs.join("");
    logs = [];
    const masked = await file("m.yaml", yaml.replace("username: ada", "username: eve"));
    const err = await failure(updateCommand("jira_el", { file: masked }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toContain("leave secret fields out");
    const clean = await file("n.yaml", yaml.replace("username: ada", "username: eve").replace(/ {2}api_key: "\*\*\*\*"\n/, ""));
    await updateCommand("jira_el", { file: clean });
    expect(writes()[0]!.body).toEqual({ data: { base_url: "https://jira.test", username: "eve", api_key: "{{secret.jira_el_api_key}}" } });
  });

  it("--secret replaces one stored secret", async () => {
    stdin(FAKE);
    await updateCommand("1", { file: await file("u.yaml", "label: Jira EL\n"), secret: ["api_key"] });
    expect(writes()[0]!.body).toEqual({ data: { base_url: "https://jira.test", username: "ada", api_key: FAKE } });
  });

  it("only top-level fields that changed are sent; nothing changed → 'No changes'", async () => {
    await updateCommand("jira_el", { file: await file("u.yaml", "label: Jira EL\n") });
    expect(writes()).toEqual([]);
    expect(errors).toContain("No changes");
    await updateCommand("jira_el", { file: await file("v.yaml", "label: Jira (EL)\n") });
    expect(writes()[0]!.body).toEqual({ label: "Jira (EL)" });
  });

  it("null clears a field", () => {
    const stored = w.rows[0]!;
    const body = updateBody(stored, readCredentialFile({ data: { username: null } }, "f"), ["api_key", "token"], {});
    expect(body.data).toEqual({ base_url: "https://jira.test", api_key: "{{secret.jira_el_api_key}}" });
  });

  it("changed by someone else between the read and the write → exit 6, nothing sent", async () => {
    w.bumpOnRead = 1; // someone saves right after the CLI read the details; the re-read sees it
    const err = await failure(updateCommand("jira_el", { file: await file("u.yaml", "data:\n  username: bob\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("Jira EL was changed by someone else; run the command again");
    expect(writes()).toEqual([]);
  });

  it("the platform's own generation conflict maps to the same text", async () => {
    w.refuse = { status: 400, body: { error: "Configuration was modified concurrently", field: "generation" } };
    const err = await failure(updateCommand("jira_el", { file: await file("u.yaml", "data:\n  username: bob\n") }));
    expect(err!.message).toBe("Jira EL was changed by someone else; run the command again");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
  });

  it("a type change in the file is refused, exit 2", async () => {
    expect(exitCodeOf(await failure(updateCommand("jira_el", { file: await file("u.yaml", "type: teams\n") })))).toBe(EXIT.usage);
  });

  it("a shared credential from another project is changed there, exit 4", async () => {
    const err = await failure(updateCommand("public_jira", { file: await file("u.yaml", "label: x\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.denied);
    expect(err!.message).toContain(`-p ${PUBLIC}`);
  });

  it("only a project admin changes a team sign-in: platform text, exit 6", async () => {
    w.refuse = { status: 403, body: { error: "Only project admins can log in or out on a team credential", field: "refresh_token" } };
    const err = await failure(updateCommand("teams_main", { file: await file("u.yaml", "data:\n  client_id: zzz\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("Only project admins can log in or out on a team credential");
  });
});

describe("test (AC-9)", () => {
  it("Connection OK, exit 0; sends the stored data and the uuid", async () => {
    expect(await testCommand("jira_el", {})).toBe(EXIT.ok);
    expect(logs).toEqual(["Connection OK"]);
    const post = writes()[0]!;
    expect(post.path).toBe(`${CFG}/check_connection/${P}/jira`);
    expect(post.query.get("configuration_uuid")).toBe("uuid-1");
    expect(post.body).toEqual(w.rows[0]!.data);
  });

  it("Connection failed: <reason>, exit 1", async () => {
    w.check = { status: 400, body: { success: false, message: "401 Unauthorized from Jira" } };
    expect(await testCommand("jira_el", {})).toBe(EXIT.general);
    expect(logs).toEqual(["Connection failed: 401 Unauthorized from Jira"]);
  });

  it("a sign-in the type needs: failed, with where to sign in", async () => {
    w.check = { status: 401, body: { success: false, requires_authorization: true, message: "Authorization required" } };
    expect(await testCommand("teams_main", {})).toBe(EXIT.general);
    expect(errors.join("\n")).toContain("Sign-in required");
  });

  it("without the secret permission: 403 → story 02 AC-8, exit 4", async () => {
    w.check = { status: 403, body: { error: "Forbidden" } };
    const err = await failure(testCommand("jira_el", {}));
    expect(exitCodeOf(err)).toBe(EXIT.denied);
  });

  it("-o json: {ok, message, credential}", async () => {
    await testCommand("1", { output: "json" });
    expect(JSON.parse(logs.join(""))).toMatchObject({ ok: true, credential: { id: 1, title: "jira_el", type: "jira" } });
  });
});

describe("delete (AC-10, AC-10a)", () => {
  it("confirms, deletes, and list no longer shows it", async () => {
    tty(true);
    prompts.answers = [true];
    await deleteCommand("jira_staging", {});
    expect(prompts.asked).toEqual(["Delete credential 'jira_staging' (3)?"]);
    expect(errors).toContain("Toolkits that use it stop working until they get another credential.");
    expect(logs).toEqual(["Deleted credential jira_staging (3)"]);
    logs = [];
    await listCommand({});
    expect(logs.join("\n")).not.toContain("jira_staging");
  });

  it("no terminal and no --yes → exit 2, nothing deleted", async () => {
    expect(exitCodeOf(await failure(deleteCommand("3", {})))).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
  });

  it("a refusal prints the platform's text, with its exit code", async () => {
    w.refuse = { status: 400, body: { error: "Credential is used by 2 toolkits", field: "id" } };
    const err = await failure(deleteCommand("3", { yes: true }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toContain("Credential is used by 2 toolkits");
  });
});

describe("secret hygiene (AC-14)", () => {
  /** Every place a secret could leak: stdout, stderr, files under the CLI home and tmp. */
  async function leaks(): Promise<string[]> {
    const found: string[] = [];
    if ([...logs, ...errors].some((l) => l.includes(FAKE))) found.push("output");
    const walk = async (root: string): Promise<void> => {
      for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const p = join(root, e.name);
        if (e.isDirectory()) await walk(p);
        else if ((await readFile(p, "utf8").catch(() => "")).includes(FAKE)) found.push(p);
      }
    };
    await walk(dir);
    for (const name of await readdir(tmpdir())) {
      if (name.startsWith("elitea-cli-") && !name.startsWith("elitea-cli-05a-")) {
        const p = join(tmpdir(), name);
        if ((await readFile(p, "utf8").catch(() => "")).includes(FAKE)) found.push(p);
      }
    }
    return found;
  }

  it("create, update, get, list, test with --debug: the fake secret appears nowhere", async () => {
    ctx.debug = true;
    stdin(FAKE);
    await createCommand({ file: await file("c.yaml", JIRA_FILE), secret: ["api_key"] });
    stdin(FAKE);
    await updateCommand("jira_new", { file: await file("u.yaml", "data:\n  username: bob\n"), secret: ["api_key"] });
    // Even if the platform echoed a value back, it is masked by the schema.
    w.rows.find((r) => r.elitea_title === "jira_new")!.data.api_key = FAKE;
    await getCommand("jira_new", {});
    await getCommand("jira_new", { output: "json" });
    await listCommand({ output: "yaml" });
    await testCommand("jira_new", {});
    // The request really carried the secret (it was sent), but nothing printed it.
    expect(calls.filter((c) => c.raw?.includes(FAKE)).length).toBeGreaterThan(0);
    expect(errors.some((l) => l.startsWith("POST /api/v2/configurations/configurations/4"))).toBe(true);
    expect(await leaks()).toEqual([]);
  });

  it("a platform error that quotes the secret is masked before it is printed", async () => {
    ctx.debug = true;
    w.refuse = { status: 400, body: { error: `Value ${FAKE} is not a valid token`, field: "api_key" } };
    stdin(FAKE);
    const err = await failure(createCommand({ file: await file("c.yaml", JIRA_FILE), secret: ["api_key"] }));
    // The CLI's fail() scrubs ctx.secretValues; the values are known to it.
    expect(ctx.secretValues).toContain(FAKE);
    const { scrubAll } = await import("../src/redact.js");
    expect(scrubAll(err!.message, ctx.secretValues)).not.toContain(FAKE);
    expect(errors.some((l) => l.includes(FAKE))).toBe(false);
  });

  it("maskCredential leaves empty secrets empty and does not touch the input", () => {
    const c = { data: { api_key: "", token: null, base_url: "u", nested: { password: "p" } } } as unknown as Credential;
    const out = maskCredential(c, ["api_key", "token", "nested.password"]);
    expect(out.data).toEqual({ api_key: "", token: null, base_url: "u", nested: { password: "****" } });
    expect((c.data.nested as Record<string, unknown>).password).toBe("p");
  });
});

describe("found on dev.elitea.ai (2026-11-17)", () => {
  it("a type missing from the catalog: vault references and secret-named fields print as ****", async () => {
    w.rows.push({ ...w.rows[0]!, id: 40, elitea_title: "google_ld", label: "Google", type: "browser", data: { google_cse_id: "072fda70", google_api_key: "{{secret.abc}}", password: "plain" } });
    await getCommand("google_ld", { output: "json" });
    expect(JSON.parse(logs.join("")).data).toEqual({ google_cse_id: "072fda70", google_api_key: "****", password: "****" });
  });

  it("an admin-managed type (hidden from the catalog) gets the platform's refusal, exit 6", async () => {
    w.refuse = { status: 403, body: { error: "This configuration is managed in the Admin Portal", field: "type" } };
    const err = await failure(createCommand({ file: await file("oa.yaml", "elitea_title: oa\ntype: oauth_app\ndata: {}\n") }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("This configuration is managed in the Admin Portal");
    expect(writes()).toHaveLength(1);
  });

  it("a type missing from the catalog: a secret-named field in the file is refused; --secret exits 5", async () => {
    const path = await file("zz.yaml", "elitea_title: zz\ntype: no_such_type\ndata:\n  password: x\n");
    expect(exitCodeOf(await failure(createCommand({ file: path })))).toBe(EXIT.usage);
    const ok = await file("zz2.yaml", "elitea_title: zz\ntype: no_such_type\ndata: {}\n");
    expect(exitCodeOf(await failure(createCommand({ file: ok, secret: ["password"] })))).toBe(EXIT.notFound);
    expect(writes()).toEqual([]);
  });

  it("the platform's Python repr of validation errors reads as <field>: <message>", async () => {
    const { readableValidation } = await import("../src/commands/credentials.js");
    const raw = "Value error, [{'type': 'missing', 'loc': ('base_url',), 'msg': 'Field required', 'input': {'username': 'x'}}]";
    expect(readableValidation(raw)).toBe("base_url: Field required");
    expect(readableValidation("Plain text")).toBe("Plain text");
    w.refuse = { status: 400, body: { error: raw, field: "data" } };
    const err = await failure(createCommand({ file: await file("r.yaml", "elitea_title: r\ntype: jira\ndata:\n  username: x\n") }));
    expect(err!.message).toBe("base_url: Field required");
  });

  it("the same data again (key order, nulls the API returns) is 'No changes', nothing sent", async () => {
    w.rows[0]!.data = { api_key: "{{secret.k}}", base_url: "https://jira.test", username: "ada", token: null };
    await updateCommand("jira_el", { file: await file("u.yaml", "data:\n  username: ada\n  base_url: https://jira.test\n") });
    expect(errors).toContain("No changes");
    expect(writes()).toEqual([]);
  });
});

describe("Claude Code plugin (story 02 AC-23)", () => {
  it("credentials list|get|types run without asking; writes and test ask", () => {
    for (const c of ["list", "get", "types"]) expect(ELITEA_PERMISSIONS.allow).toContain(`Bash(elitea-cli credentials ${c}:*)`);
    for (const c of ["create", "update", "delete", "test"]) expect(ELITEA_PERMISSIONS.ask).toContain(`Bash(elitea-cli credentials ${c}:*)`);
  });
});
