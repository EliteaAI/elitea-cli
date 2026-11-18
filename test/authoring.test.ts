import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ answers: [] as boolean[], asked: [] as string[] }));
vi.mock("@inquirer/prompts", async (orig) => ({
  ...(await orig<typeof import("@inquirer/prompts")>()),
  confirm: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    const next = prompts.answers.shift();
    if (next === undefined) throw new Error(`unexpected prompt: ${message}`);
    return next;
  },
}));

import {
  changedFields,
  createBody,
  diffLines,
  editableView,
  formatValidation,
  newVersionBody,
  parseDocument,
  toolsNote,
  unifiedDiff,
  updateBody,
} from "../src/authoring.js";
import {
  createCommand,
  deleteCommand,
  editCommand,
  updateCommand,
  validateCommand,
  versionCreateCommand,
  versionDefaultCommand,
} from "../src/commands/authoring.js";
import { ctx, operationFor, resetContext } from "../src/context.js";
import { editorCommand } from "../src/editor.js";
import { CliError, EXIT, exitCodeOf } from "../src/errors.js";

const BASE = "/api/v2/elitea_core";
const P = 4;

let dir: string;
let logs: string[];
let errors: string[];
let calls: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }>;

interface Version {
  id: number;
  name: string;
  status: string;
  agent_type: string;
  instructions: string;
  llm_settings: Record<string, unknown>;
  tools: Array<Record<string, unknown>>;
  variables: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

/** One agent (1, "Reviewer") and one pipeline (2, "Notes") with their versions, as EliteA keeps them. */
function world() {
  const version = (id: number, name: string, extra: Partial<Version> = {}): Version => ({
    id,
    name,
    status: "draft",
    agent_type: "openai",
    instructions: "Review the diff.",
    llm_settings: { model_name: "gpt-5", temperature: 0.2 },
    tools: [{ id: 12, name: "github", type: "github", toolkit_name: "github", settings: { repo: "a/b" }, author_id: 7 }],
    variables: [],
    conversation_starters: [],
    welcome_message: "",
    tags: [],
    meta: { step_limit: 25 },
    pipeline_settings: {},
    created_at: "2026-11-01T10:00:00",
    author: { id: 7, email: "ada@a.test" },
    author_id: 7,
    application_id: 0,
    is_forked: false,
    icon_meta: {},
    ...extra,
  });
  return {
    apps: [
      { id: 1, name: "Reviewer", agent_type: "openai", default: 10, versions: [version(10, "base"), version(11, "v2", { status: "published" })] },
      {
        id: 2,
        name: "Notes",
        agent_type: "pipeline",
        default: 20,
        versions: [version(20, "base", { agent_type: "pipeline", instructions: "entry_point: a\nnodes:\n  - id: a\n", tools: [] })],
      },
    ],
    nextId: 100,
    /** Set to make the next PUT/DELETE fail with this status and body. */
    refuse: undefined as undefined | { status: number; body: unknown },
    validation: { valid: true, errors: [], warnings: [] } as Record<string, unknown>,
  };
}

let w: ReturnType<typeof world>;

const sha = (s: string) => `sha:${s.length}:${s}`;

function versionJson(app: (typeof w.apps)[number], v: Version) {
  return { ...v, application_id: app.id, instructions_sha256: sha(v.instructions) };
}

function serve() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname;
    calls.push({ method, path, query: url.searchParams, body });
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const app = (id: string) => w.apps.find((a) => String(a.id) === id);
    let m: RegExpMatchArray | null;

    if (path === `/api/v2/configurations/models/${P}`) {
      return json({ items: [{ name: "gpt-5", display_name: "GPT-5", project_id: 1 }], default_model_name: "gpt-5" });
    }
    if (path === `${BASE}/applications/prompt_lib/${P}` && method === "GET") {
      const q = url.searchParams.get("query")?.toLowerCase();
      const rows = w.apps
        .filter((a) => !q || a.name.toLowerCase().includes(q))
        .map((a) => ({ id: a.id, name: a.name, agent_type: a.agent_type, status: "draft" }));
      return json({ total: rows.length, rows });
    }
    if (path === `${BASE}/applications/prompt_lib/${P}` && method === "POST") {
      const versions = body!.versions as Array<Record<string, unknown>>;
      if (versions.length !== 1) return json([{ loc: ["versions"], msg: "Value error, Only 1 version can be created" }], 400);
      const v = { ...world().apps[0]!.versions[0]!, tools: [], ...versions[0], id: w.nextId++, name: "base" } as Version;
      const created = { id: w.nextId++, name: String(body!.name), agent_type: v.agent_type ?? "openai", default: v.id, versions: [v] };
      w.apps.push(created);
      return json({ id: created.id, name: created.name, versions: [{ id: v.id, name: v.name }], version_details: versionJson(created, v) }, 201);
    }
    if ((m = path.match(new RegExp(`^${BASE}/application/prompt_lib/${P}/(\\d+)$`)))) {
      const a = app(m[1]!);
      if (!a) return json({ error: "not found" }, 404);
      if (method === "DELETE") {
        if (w.refuse) return json(w.refuse.body, w.refuse.status);
        w.apps = w.apps.filter((x) => x !== a);
        return new Response(null, { status: 204 });
      }
      const def = a.versions.find((v) => v.id === a.default)!;
      return json({
        id: a.id,
        name: a.name,
        agent_type: a.agent_type,
        versions: a.versions.map((v) => ({ id: v.id, name: v.name, status: v.status })),
        version_details: { id: def.id, name: def.name, agent_type: def.agent_type },
      });
    }
    if ((m = path.match(new RegExp(`^${BASE}/version/prompt_lib/${P}/(\\d+)/(\\d+)$`)))) {
      const a = app(m[1]!)!;
      const v = a.versions.find((x) => String(x.id) === m![2]);
      if (!v) return json({ error: `Application[${a.id}] version[${m[2]}] not found` }, 400);
      if (method === "GET") return json(versionJson(a, v));
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      if (method === "PUT") {
        if (v.status === "published") return json({ error: `Version id ${v.id} is published and can not be updated` }, 400);
        const { tools: _ignored, ...rest } = body!;
        Object.assign(v, rest);
        return json(versionJson(a, v), 201);
      }
      if (method === "DELETE") {
        a.versions = a.versions.filter((x) => x !== v);
        return json({ ok: true });
      }
    }
    if ((m = path.match(new RegExp(`^${BASE}/versions/prompt_lib/${P}/(\\d+)$`))) && method === "POST") {
      const a = app(m[1]!)!;
      const v = { ...(body as Version), id: w.nextId++, status: "draft" };
      a.versions.push(v);
      return json(versionJson(a, v), 201);
    }
    if ((m = path.match(new RegExp(`^${BASE}/default_version/prompt_lib/${P}/(\\d+)$`))) && method === "PATCH") {
      const a = app(m[1]!)!;
      a.default = Number(body!.version_id);
      return json({ id: a.id, name: a.name });
    }
    if (path === `${BASE}/validate_pipeline/prompt_lib/${P}` && method === "POST") return json(w.validation);
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
  dir = await mkdtemp(join(tmpdir(), "elitea-cli-04-"));
  process.env.ELITEA_CLI_HOME = dir;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  process.env.ELITEA_CLI_URL = "https://elitea.test";
  process.env.ELITEA_CLI_TOKEN = "tok-0123456789abcdef";
  process.env.ELITEA_CLI_PROJECT = String(P);
  for (const v of ["ELITEA_CLI_OUTPUT", "ELITEA_CLI_ENV", "CI", "NO_COLOR"]) delete process.env[v];
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  tty(false);
  // Temp files `edit` keeps on purpose ("Your edits are kept in …"), and the test home.
  for (const name of await readdir(tmpdir())) {
    if (/^elitea-cli-[0-9a-f]{8}-(Reviewer|Notes)-/.test(name)) await rm(join(tmpdir(), name), { force: true });
  }
  await rm(dir, { recursive: true, force: true });
  for (const v of ["ELITEA_CLI_URL", "ELITEA_CLI_TOKEN", "ELITEA_CLI_PROJECT"]) delete process.env[v];
  resetContext();
});

describe("files (AC-2, AC-5)", () => {
  it("reads JSON and YAML as the same structure", () => {
    expect(parseDocument('{"name": "a", "instructions": "x"}', "a.json")).toEqual({ name: "a", instructions: "x" });
    expect(parseDocument("name: a\ninstructions: x\n", "a.yaml")).toEqual({ name: "a", instructions: "x" });
    expect(parseDocument("{name: a}", "flow.yaml")).toEqual({ name: "a" });
  });

  it("refuses a broken file with its line, exit 2", () => {
    const err = (() => {
      try {
        parseDocument("name: a\n  bad: [1,\n", "agent.yaml");
      } catch (e) {
        return e as CliError;
      }
    })()!;
    expect(err.message).toMatch(/^agent\.yaml: not valid JSON or YAML \(line \d+: .+\)$/);
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(() => parseDocument("- a\n- b\n", "list.yaml")).toThrow(/expected an object/);
    expect(() => parseDocument("  \n", "e.yaml")).toThrow(/empty file/);
  });

  it("builds one base version from top-level fields and sends nothing else", () => {
    expect(createBody({ name: "a", instructions: "x", llm_settings: { model_name: "m" } }, "agent")).toEqual({
      name: "a",
      versions: [{ instructions: "x", llm_settings: { model_name: "m" }, name: "base" }],
    });
    const full = { name: "a", versions: [{ name: "base", agent_type: "openai" }] };
    expect(createBody(full, "agent")).toEqual(full);
  });

  it("a version without a name is sent as base (the platform answers 500 otherwise)", () => {
    expect(createBody({ name: "a", versions: [{ instructions: "x" }] }, "agent").versions).toEqual([{ instructions: "x", name: "base" }]);
    expect(createBody({ name: "a", versions: [{ name: "v1" }] }, "agent").versions).toEqual([{ name: "v1" }]);
  });

  it("the README examples parse into create bodies", async () => {
    const agent = createBody(parseDocument(await readFile("examples/agent.yaml", "utf8"), "agent.yaml"), "agent");
    expect(agent).toMatchObject({ name: "Code reviewer", versions: [{ name: "base", llm_settings: {} }] });
    const pipeline = createBody(parseDocument(await readFile("examples/pipeline.yaml", "utf8"), "pipeline.yaml"), "pipeline");
    const version = (pipeline.versions as Array<Record<string, unknown>>)[0]!;
    expect(version.agent_type).toBe("pipeline");
    expect(String(version.instructions)).toMatch(/^entry_point: draft\n/);
  });

  it("pipelines create sets agent_type pipeline when the file has none, refuses another type", () => {
    expect(createBody({ name: "p", instructions: "nodes: []" }, "pipeline").versions).toEqual([{ instructions: "nodes: []", name: "base", agent_type: "pipeline" }]);
    expect(() => createBody({ name: "p", agent_type: "openai" }, "pipeline")).toThrow(/agents create/);
  });
});

describe("create (AC-1…AC-7)", () => {
  it("creates from a file and prints the sentence", async () => {
    const path = await file("agent.yaml", "name: Helper\ninstructions: Be brief.\nllm_settings:\n  model_name: gpt-5\n");
    await createCommand("agent", { file: path });
    const post = writes()[0]!;
    expect(post.path).toBe(`${BASE}/applications/prompt_lib/${P}`);
    expect(post.body).toEqual({ name: "Helper", versions: [{ instructions: "Be brief.", llm_settings: { model_name: "gpt-5" }, name: "base" }] });
    expect(logs).toEqual([expect.stringMatching(/^Created agent "Helper" \(\d+\), version base \(\d+\)$/)]);
  });

  it("-q prints only the id, -o json the object", async () => {
    const path = await file("a.json", JSON.stringify({ name: "Q", instructions: "x", llm_settings: {} }));
    ctx.quiet = true;
    await createCommand("agent", { file: path });
    expect(logs).toEqual([expect.stringMatching(/^\d+$/)]);
    ctx.quiet = false;
    logs = [];
    await createCommand("agent", { file: path, output: "json" });
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ name: "Q", version_details: { name: "base" } });
  });

  it("a broken file sends nothing (AC-5)", async () => {
    const path = await file("bad.json", '{"name": ');
    const err = await failure(createCommand("agent", { file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("pipelines create --name --yaml without --model sends no model_name (AC-3)", async () => {
    const yaml = await file("p.yaml", "entry_point: a\nnodes:\n  - id: a\n");
    await createCommand("pipeline", { name: "Release", yaml, description: "notes" });
    const post = writes()[0]!;
    expect(post.body).toEqual({
      name: "Release",
      description: "notes",
      versions: [{ name: "base", agent_type: "pipeline", instructions: "entry_point: a\nnodes:\n  - id: a\n", llm_settings: {} }],
    });
    expect(logs[0]).toMatch(/^Created pipeline "Release" \(\d+\), version base \(\d+\)$/);
  });

  it("--model resolves the model of the project; unknown → exit 5", async () => {
    const yaml = await file("p.yaml", "nodes: []\n");
    await createCommand("pipeline", { name: "R", yaml, model: "GPT-5" });
    expect((writes()[0]!.body!.versions as Array<Record<string, unknown>>)[0]!.llm_settings).toEqual({ model_name: "gpt-5", model_project_id: 1 });
    expect(exitCodeOf(await failure(createCommand("pipeline", { name: "R", yaml, model: "nope" })))).toBe(EXIT.notFound);
  });

  it("platform validation errors are printed per field, exit 6 (AC-4)", async () => {
    const path = await file("two.json", JSON.stringify({ name: "T", versions: [{ name: "base" }, { name: "x" }] }));
    const err = await failure(createCommand("agent", { file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("versions: Value error, Only 1 version can be created");
  });

  it("warns about an existing item with the same name, and still creates it (AC-7)", async () => {
    const path = await file("dup.yaml", "name: Reviewer\ninstructions: x\nllm_settings: {}\n");
    await createCommand("agent", { file: path });
    expect(errors).toEqual(['Another agent named "Reviewer" already exists (1)']);
    expect(writes()).toHaveLength(1);
  });
});

describe("update (AC-8…AC-9, AC-13, AC-14, AC-22)", () => {
  it("sends only the changed fields, with the version's name, after stripping server fields", async () => {
    const got = { ...versionJson(w.apps[0]!, w.apps[0]!.versions[0]!), cli: { agent: { id: 1 } } };
    const path = await file("v.json", JSON.stringify({ ...got, instructions: "Review carefully." }));
    await updateCommand("agent", "Reviewer", { file: path });
    const put = writes()[0]!;
    expect(put.method).toBe("PUT");
    expect(put.path).toBe(`${BASE}/version/prompt_lib/${P}/1/10`);
    expect(put.body).toEqual({ name: "base", agent_type: "openai", instructions: "Review carefully." });
    expect(logs).toEqual(["Updated Reviewer/base"]);
    expect(errors).toEqual([]);
  });

  it("a file without tools leaves toolkits alone; changed tools get a note and are not sent (AC-8a/b)", async () => {
    const path = await file("v.yaml", "instructions: New\ntools:\n  - id: 13\n    settings: {}\n");
    await updateCommand("agent", "1", { file: path });
    expect(writes()[0]!.body).not.toHaveProperty("tools");
    expect(errors[0]).toBe(
      "The file changes the attached toolkits (github (12) → 13); update does not change toolkits — use `elitea-cli agents toolkits add|remove`",
    );
  });

  it("no change → 'No changes', nothing sent", async () => {
    const path = await file("same.json", JSON.stringify(versionJson(w.apps[0]!, w.apps[0]!.versions[0]!)));
    await updateCommand("agent", "Reviewer", { file: path });
    expect(writes()).toEqual([]);
    expect(errors).toEqual(["No changes"]);
  });

  it("pipelines update --yaml changes only the instructions of the version (AC-9)", async () => {
    const yaml = await file("p.yaml", "entry_point: b\nnodes:\n  - id: b\n");
    await updateCommand("pipeline", "Notes", { yaml });
    expect(writes().map((c) => c.path)[0]).toBe(`${BASE}/validate_pipeline/prompt_lib/${P}`);
    expect(writes()[1]!.body).toEqual({ name: "base", agent_type: "pipeline", instructions: "entry_point: b\nnodes:\n  - id: b\n" });
  });

  it("pipelines update validates the YAML first: errors → exit 6, nothing saved", async () => {
    w.validation = { valid: false, errors: [{ code: "unknown_entrypoint", node_id: null, field: "entry_point", message: "no such node", severity: "error" }], warnings: [] };
    const yaml = await file("p.yaml", "entry_point: x\nnodes:\n  - id: b\n");
    expect(exitCodeOf(await failure(updateCommand("pipeline", "Notes", { yaml })))).toBe(EXIT.conflict);
    expect(writes().map((c) => c.path)).toEqual([`${BASE}/validate_pipeline/prompt_lib/${P}`]);
    expect(errors).toContain("ERROR entry_point [unknown_entrypoint]: no such node");
  });

  it("pipelines update refuses a classic agent (exit 5)", async () => {
    const yaml = await file("p.yaml", "nodes: []\n");
    expect(exitCodeOf(await failure(updateCommand("pipeline", "Reviewer", { yaml })))).toBe(EXIT.notFound);
  });

  it("a published version prints the platform text and the new-version hint, exit 6 (AC-13)", async () => {
    const path = await file("v.yaml", "instructions: x\n");
    const err = await failure(updateCommand("agent", "Reviewer", { file: path, agentVersion: "v2" }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toBe("Version id 11 is published and can not be updated\nCreate a new version with `elitea-cli agents version create`");
  });

  it("other 400s print only the platform text (AC-13)", async () => {
    w.refuse = { status: 400, body: { error: "conversation_starters: at most 4" } };
    const path = await file("v.yaml", "instructions: x\n");
    const err = await failure(updateCommand("agent", "Reviewer", { file: path }));
    expect(err!.message).toBe("conversation_starters: at most 4");
  });

  it("a 409 prints 'Changed by someone else' (AC-22)", async () => {
    w.refuse = { status: 409, body: { error: "conflict" } };
    const path = await file("v.yaml", "instructions: x\n");
    const err = await failure(updateCommand("agent", "Reviewer", { file: path }));
    expect([err!.message, exitCodeOf(err)]).toEqual(["Changed by someone else; run the command again", EXIT.conflict]);
  });

  it("--dry-run prints a unified diff and sends nothing (AC-14)", async () => {
    const path = await file("v.yaml", "instructions: Review carefully.\n");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    await updateCommand("agent", "Reviewer", { file: path, dryRun: true });
    expect(writes()).toEqual([]);
    const diff = out.join("");
    expect(diff).toContain("--- Reviewer/base (EliteA)");
    expect(diff).toContain(`+++ ${path}`);
    expect(diff).toContain("-instructions: Review the diff.");
    expect(diff).toContain("+instructions: Review carefully.");
  });

  it("a version changed on the server meanwhile: no terminal → exit 6, nothing sent; --yes overwrites (AC-22)", async () => {
    const path = await file("v.yaml", "instructions: Mine\n");
    let reads = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      // Someone saves between our first read and the check before the PUT.
      if (String(input).endsWith("/version/prompt_lib/4/1/10") && (init?.method ?? "GET") === "GET" && ++reads === 2) {
        w.apps[0]!.versions[0]!.instructions = "Theirs";
      }
      return realFetch(input, init);
    });
    const err = await failure(updateCommand("agent", "Reviewer", { file: path }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message).toContain("Reviewer/base was changed on the server since you opened it");
    expect(writes()).toEqual([]);

    reads = 0;
    w.apps[0]!.versions[0]!.instructions = "Review the diff.";
    ctx.yes = true;
    await updateCommand("agent", "Reviewer", { file: path });
    expect(writes()).toHaveLength(1);
  });
});

describe("edit (AC-10…AC-12)", () => {
  /** An editor that writes `content` (or exits with `code`) and records the file it got. */
  const editor = (content: string | ((before: string) => string), code = 0) => {
    const seen: string[] = [];
    const run = async (path: string) => {
      seen.push(path);
      const before = await readFile(path, "utf8");
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      if (code === 0) await writeFile(path, typeof content === "string" ? content : content(before));
      return code;
    };
    return { run, seen };
  };
  const exists = (p: string) => stat(p).then(() => true, () => false);

  it("needs a terminal (AC-10a)", async () => {
    const err = await failure(editCommand("agent", "Reviewer", {}));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(err!.message).toBe("elitea-cli agents edit needs a terminal; use `elitea-cli agents update -f <file>`");
    expect(calls).toEqual([]);
  });

  it("saves the edited YAML and deletes the temp file (AC-10, AC-10b)", async () => {
    tty(true);
    const ed = editor((before) => before.replace("Review the diff.", "Review it twice."));
    await editCommand("agent", "Reviewer", {}, ed.run);
    expect(writes()[0]!.body).toEqual({ name: "base", agent_type: "openai", instructions: "Review it twice." });
    expect(ed.seen[0]!.startsWith(tmpdir())).toBe(true);
    expect(await exists(ed.seen[0]!)).toBe(false);
  });

  it("the editor shows the version without server fields and without tools", async () => {
    tty(true);
    let shown = "";
    await editCommand("agent", "Reviewer", {}, async (p) => ((shown = await readFile(p, "utf8")), 0));
    expect(shown).toContain("instructions: Review the diff.");
    for (const key of ["instructions_sha256", "created_at", "author_id", "tools:", "status:"]) expect(shown).not.toContain(key);
  });

  it("closing without a change prints 'No changes' and sends nothing", async () => {
    tty(true);
    const ed = editor((b) => b);
    await editCommand("agent", "Reviewer", {}, ed.run);
    expect(writes()).toEqual([]);
    expect(errors).toEqual(["No changes"]);
    expect(await exists(ed.seen[0]!)).toBe(false);
  });

  it("an editor exiting non-zero: exit 1, nothing saved; an empty file: exit 2 (AC-10a)", async () => {
    tty(true);
    const err = await failure(editCommand("agent", "Reviewer", {}, editor("", 3).run));
    expect([err!.message, exitCodeOf(err)]).toEqual(["Editor exited with code 3; nothing saved", EXIT.general]);
    const empty = await failure(editCommand("agent", "Reviewer", {}, editor("\n").run));
    expect([empty!.message, exitCodeOf(empty)]).toEqual(["Empty file; nothing saved", EXIT.usage]);
    expect(writes()).toEqual([]);
  });

  it("a refusal asks 'Edit again?'; n keeps the file and exits 6 (AC-11)", async () => {
    tty(true);
    w.refuse = { status: 400, body: [{ loc: ["llm_settings", "temperature"], msg: "must be at most 1" }] };
    prompts.answers = [false];
    const ed = editor((b) => b.replace("temperature: 0.2", "temperature: 5"));
    const err = await failure(editCommand("agent", "Reviewer", {}, ed.run));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(prompts.asked).toEqual(["Edit again?"]);
    expect(errors).toContain("llm_settings.temperature: must be at most 1");
    expect(errors).toContain(`Your edits are kept in ${ed.seen[0]} (delete it when done)`);
    expect(await readFile(ed.seen[0]!, "utf8")).toContain("temperature: 5");
  });

  it("y reopens the editor with the same file and saves the fix", async () => {
    tty(true);
    w.refuse = { status: 400, body: [{ loc: ["name"], msg: "bad" }] };
    prompts.answers = [true];
    let round = 0;
    const run = async (p: string) => {
      const before = await readFile(p, "utf8");
      if (round++ === 1) w.refuse = undefined;
      await writeFile(p, before.replace(/^instructions: .*$/m, `instructions: Round ${round}`));
      return 0;
    };
    await editCommand("agent", "Reviewer", {}, run);
    expect(writes().map((c) => c.body!.instructions)).toEqual(["Round 1", "Round 2"]);
    expect(logs).toEqual(["Updated Reviewer/base"]);
  });

  it("pipelines edit opens only the YAML and validates it before saving (AC-12)", async () => {
    tty(true);
    w.validation = { valid: false, errors: [{ code: "missing_entry_point", node_id: null, field: "entry_point", message: "required", severity: "error" }], warnings: [] };
    prompts.answers = [false];
    let shown = "";
    const run = async (p: string) => {
      shown = await readFile(p, "utf8");
      await writeFile(p, "nodes:\n  - id: a\n");
      return 0;
    };
    const err = await failure(editCommand("pipeline", "Notes", {}, run));
    expect(shown).toBe("entry_point: a\nnodes:\n  - id: a\n");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(errors).toContain("ERROR entry_point [missing_entry_point]: required");
    expect(writes().map((c) => c.path)).toEqual([`${BASE}/validate_pipeline/prompt_lib/${P}`]);
  });

  it("pipeline warnings alone don't block the save", async () => {
    tty(true);
    w.validation = { valid: true, errors: [], warnings: [{ code: "w", node_id: "a", field: null, message: "unused", severity: "warning" }] };
    await editCommand("pipeline", "Notes", {}, async (p) => (await writeFile(p, "entry_point: a\nnodes:\n  - id: a\n  - id: b\n"), 0));
    expect(errors).toContain("WARN a [w]: unused");
    expect(writes().map((c) => c.method)).toEqual(["POST", "PUT"]);
  });

  it("uses $VISUAL, then $EDITOR, then vi / notepad", () => {
    expect(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" }, "darwin")).toBe("code --wait");
    expect(editorCommand({ EDITOR: "nano" }, "linux")).toBe("nano");
    expect(editorCommand({}, "linux")).toBe("vi");
    expect(editorCommand({}, "win32")).toBe("notepad");
  });
});

describe("versions (AC-15…AC-17)", () => {
  it("version create copies the default version, its toolkits by id and its skills", async () => {
    await versionCreateCommand("agent", "Reviewer", "v3", {});
    const post = writes()[0]!;
    expect(post.path).toBe(`${BASE}/versions/prompt_lib/${P}/1`);
    expect(post.body).toMatchObject({ name: "v3", instructions: "Review the diff.", copy_skills_from_version_id: 10 });
    expect(post.body!.tools).toEqual([{ id: 12, name: "github", type: "github", toolkit_name: "github", settings: { repo: "a/b" } }]);
    for (const key of ["id", "status", "author_id", "created_at", "instructions_sha256"]) expect(post.body).not.toHaveProperty(key);
    expect(logs).toEqual([expect.stringMatching(/^Created version v3 \(\d+\) of Reviewer, from base$/)]);
  });

  it("--from picks the source; -q prints the version id", async () => {
    ctx.quiet = true;
    await versionCreateCommand("agent", "Reviewer", "v3", { from: "v2" });
    expect(writes()[0]!.body!.copy_skills_from_version_id).toBe(11);
    expect(logs).toEqual([expect.stringMatching(/^\d+$/)]);
  });

  it("a duplicate name exits 6 and sends nothing", async () => {
    const err = await failure(versionCreateCommand("agent", "Reviewer", "v2", {}));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(writes()).toEqual([]);
  });

  it("version default sets the default (works under pipelines too)", async () => {
    await versionDefaultCommand("agent", "Reviewer", "v2", {});
    expect(writes()[0]).toMatchObject({ method: "PATCH", path: `${BASE}/default_version/prompt_lib/${P}/1`, body: { version_id: 11 } });
    expect(w.apps[0]!.default).toBe(11);
    await versionCreateCommand("pipeline", "Notes", "v2", {});
    expect(writes()[1]!.body).toMatchObject({ name: "v2", agent_type: "pipeline" });
  });

  it("an unknown version name exits 5", async () => {
    expect(exitCodeOf(await failure(versionDefaultCommand("agent", "Reviewer", "nope", {})))).toBe(EXIT.notFound);
  });
});

describe("delete (AC-19…AC-21)", () => {
  it("refuses outside a terminal without --yes and deletes nothing", async () => {
    const err = await failure(deleteCommand("agent", "Reviewer", {}));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
  });

  it("asks, then deletes the agent with all versions (AC-19)", async () => {
    tty(true);
    prompts.answers = [true];
    await deleteCommand("agent", "Reviewer", {});
    expect(prompts.asked).toEqual(["Delete agent 'Reviewer' (1)?"]);
    expect(writes()[0]).toMatchObject({ method: "DELETE", path: `${BASE}/application/prompt_lib/${P}/1` });
    expect(logs).toEqual(['Deleted agent "Reviewer" (1)']);
  });

  it("n deletes nothing", async () => {
    tty(true);
    prompts.answers = [false];
    await deleteCommand("agent", "Reviewer", {});
    expect(writes()).toEqual([]);
  });

  it("--agent-version deletes one version and warns about schedules (AC-20)", async () => {
    tty(true);
    prompts.answers = [true];
    await deleteCommand("agent", "Reviewer", { agentVersion: "v2" });
    expect(errors).toEqual(["Its schedules will be disabled."]);
    expect(prompts.asked).toEqual(["Delete version 'Reviewer/v2' (11)?"]);
    expect(writes()[0]).toMatchObject({ method: "DELETE", path: `${BASE}/version/prompt_lib/${P}/1/11` });
    expect(writes()[0]!.query.has("replacement_version_id")).toBe(false);
  });

  it("a version in use: the platform text and the --replace-with hint, exit 6; --replace-with sends the id (AC-20a)", async () => {
    w.refuse = { status: 400, body: { ok: false, error: "Version is in use and no replacement version provided. Use check_version_in_use first to get replacement options." } };
    ctx.yes = true;
    const err = await failure(deleteCommand("agent", "Reviewer", { agentVersion: "v2" }));
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(err!.message.split("\n")[1]).toBe("Pass --replace-with <version> to move them to another version first");

    w.refuse = undefined;
    await deleteCommand("agent", "Reviewer", { agentVersion: "v2", replaceWith: "base" });
    expect(writes()[1]!.query.get("replacement_version_id")).toBe("10");
    expect(exitCodeOf(await failure(deleteCommand("agent", "Reviewer", { agentVersion: "base", replaceWith: "nope" })))).toBe(EXIT.notFound);
  });

  it("a refused whole delete shows the platform's answer (AC-20b)", async () => {
    w.refuse = { status: 400, body: { ok: false, error: "Cannot delete application with published or embedded versions. Unpublish first." } };
    ctx.yes = true;
    const err = await failure(deleteCommand("agent", "Reviewer", {}));
    expect([err!.message, exitCodeOf(err)]).toEqual(["Cannot delete application with published or embedded versions. Unpublish first.", EXIT.conflict]);
  });

  it("pipelines delete refuses a classic agent (AC-21)", async () => {
    ctx.yes = true;
    const err = await failure(deleteCommand("pipeline", "Reviewer", {}));
    expect(exitCodeOf(err)).toBe(EXIT.notFound);
    expect(err!.message).toBe('"Reviewer" is an agent, not a pipeline — use `elitea-cli agents get 1`');
    expect(writes()).toEqual([]);
  });
});

describe("validate (AC-18)", () => {
  it("prints the items and exits by `valid`, not by HTTP", async () => {
    const path = await file("p.yaml", "nodes: []\n");
    w.validation = {
      valid: false,
      errors: [{ code: "missing_entry_point", node_id: null, field: "entry_point", message: "entry_point is required", severity: "error" }],
      warnings: [{ code: "unused_node", node_id: "b", field: null, message: "never reached", severity: "warning" }],
    };
    expect(await validateCommand({ file: path })).toBe(EXIT.conflict);
    expect(logs).toEqual(["ERROR entry_point [missing_entry_point]: entry_point is required", "WARN b [unused_node]: never reached", "1 error(s), 1 warning(s)"]);
    expect(writes()[0]!.body).toEqual({ pipeline_yaml: "nodes: []\n" });
  });

  it("valid with warnings exits 0; -o json returns the platform response", async () => {
    const path = await file("p.yaml", "nodes: []\n");
    w.validation = { valid: true, errors: [], warnings: [] };
    expect(await validateCommand({ yaml: path })).toBe(EXIT.ok);
    expect(logs).toEqual(["Valid"]);
    logs = [];
    expect(await validateCommand({ file: path, output: "json" })).toBe(EXIT.ok);
    expect(JSON.parse(logs.join("\n"))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("formats node.field, node only and neither", () => {
    const i = (node_id: string | null, field: string | null) => ({ code: "c", node_id, field, message: "m", severity: "error" as const });
    expect(formatValidation({ valid: false, errors: [i("n", "f"), i("n", null), i(null, null)], warnings: [] }).slice(0, 3)).toEqual([
      "ERROR n.f [c]: m",
      "ERROR n [c]: m",
      "ERROR [c]: m",
    ]);
  });
});

describe("helpers", () => {
  it("editableView drops server fields and tools", () => {
    expect(editableView({ id: 1, name: "base", instructions: "x", tools: [], status: "draft", cli: {}, instructions_sha256: "s" })).toEqual({
      name: "base",
      instructions: "x",
    });
  });

  it("changedFields ignores key order and the name", () => {
    expect(changedFields({ llm_settings: { a: 1, b: 2 }, name: "base" }, { llm_settings: { b: 2, a: 1 }, name: "other" })).toEqual({});
    expect(changedFields({ welcome_message: "" }, { welcome_message: "Hi" })).toEqual({ welcome_message: "Hi" });
  });

  it("updateBody keeps notes when meta changes (notes live inside meta)", () => {
    expect(updateBody({ name: "base" }, { notes: "keep" }, { meta: { step_limit: 5 } })).toEqual({ name: "base", meta: { step_limit: 5 }, notes: "keep" });
  });

  it("toolsNote compares by id and settings only", () => {
    const current = [{ id: 1, name: "x", settings: { a: 1 }, author_id: 7 }];
    expect(toolsNote(undefined, current, "agent")).toBeUndefined();
    expect(toolsNote([{ id: 1, settings: { a: 1 } }], current, "agent")).toBeUndefined();
    expect(toolsNote([], current, "agent")).toContain("(x (1) → (none))");
  });

  it("newVersionBody keeps toolkits by id without their author", () => {
    const body = newVersionBody({ id: 5, name: "base", tools: [{ id: 2, name: "t", type: "t", author_id: 9 } as never], variables: [{ name: "v" }] }, "v2");
    expect(body).toEqual({ name: "v2", tools: [{ id: 2, name: "t", type: "t" }], variables: [{ name: "v", value: "" }], copy_skills_from_version_id: 5 });
  });

  it("diffs lines and renders hunks", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"]).map((o) => o.type + o.line)).toEqual([" a", "-b", "+x", " c"]);
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x", "y")).toBe("");
    expect(unifiedDiff("a\nb\nc\n", "a\nc\nd\n", "old", "new")).toBe("--- old\n+++ new\n@@ -1,3 +1,3 @@\n a\n-b\n c\n+d\n");
    expect(unifiedDiff("", "a\n", "old", "new")).toBe("--- old\n+++ new\n@@ -0,0 +1,1 @@\n+a\n");
  });

  it("every write command needs the build operation of a scoped token; validate is not a write (AC-6)", () => {
    for (const r of ["agents", "pipelines"]) {
      for (const v of ["create", "update", "edit", "delete", "version create", "version default"]) expect(operationFor(`${r} ${v}`)).toBe("build");
    }
    expect(operationFor("pipelines validate")).toBeUndefined();
  });
});
