import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ answers: [] as unknown[], asked: [] as string[] }));
vi.mock("@inquirer/prompts", async (orig) => ({
  ...(await orig<typeof import("@inquirer/prompts")>()),
  confirm: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    if (prompts.answers.length === 0) throw new Error(`unexpected prompt: ${message}`);
    return prompts.answers.shift();
  },
}));

// The run loop polls once a second; tests answer at once.
vi.mock("../src/agentChat.js", async (orig) => {
  const mod = await orig<typeof import("../src/agentChat.js")>();
  class FastChat extends mod.AgentChat {
    constructor(...args: ConstructorParameters<typeof mod.AgentChat>) {
      super(args[0], args[1], { ...args[2], pollIntervalMs: 0 });
    }
  }
  return { ...mod, AgentChat: FastChat };
});

import { agentChatCommand } from "../src/commands/agentChat.js";
import {
  deleteCommand,
  deleteQuestion,
  isLiveRun,
  listCommand,
  localTime,
  parseChatId,
  parseUtc,
  sendCommand,
  showCommand,
} from "../src/commands/chats.js";
import { ctx, operationFor, resetContext } from "../src/context.js";
import type { ConversationParticipant, MessageGroup } from "../src/elitea.js";
import { EXIT, exitCodeOf } from "../src/errors.js";
import { ELITEA_PERMISSIONS } from "../src/integrations/claudePlugin.js";

const P = 4;
const CORE = "/api/v2/elitea_core";
const ME = 7;
const OTHER = 8;

let dir: string;
let logs: string[];
let errors: string[];
let calls: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }>;

const user = (id: number, uid: number, name: string): ConversationParticipant => ({ id, entity_name: "user", entity_meta: { id: uid }, meta: { user_name: name } });
const agent = (id: number, aid: number, name: string, extra: Partial<ConversationParticipant> = {}): ConversationParticipant => ({
  id,
  entity_name: "application",
  entity_meta: { id: aid, project_id: P },
  meta: { name },
  entity_settings: { version_id: aid * 10 },
  ...extra,
});
const dummy: ConversationParticipant = { id: 2, entity_name: "dummy", entity_meta: {}, meta: { name: "Alita" } };

/** Minutes ago, naive UTC like the messages API. */
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace("Z", "");

interface Chat {
  id: number;
  name: string;
  author_id: number;
  is_private: boolean;
  updated_at: string;
  participants: ConversationParticipant[];
  messages: MessageGroup[];
}

const text = (id: number, author: number, content: string, extra: Partial<MessageGroup> = {}): MessageGroup => ({
  id,
  uuid: `g-${id}`,
  author_participant_id: author,
  is_streaming: false,
  created_at: ago(60 - id / 100),
  message_items: [{ item_type: "text_message", item_details: { content } }],
  ...extra,
});

function world() {
  const chats: Chat[] = [
    {
      id: 101,
      name: "Reviewer: check diff",
      author_id: ME,
      is_private: true,
      updated_at: "2026-11-16T12:44:00+00:00Z",
      participants: [user(1, ME, "Ada"), dummy, agent(42, 255, "Reviewer")],
      messages: [text(1, 1, "check diff"), text(2, 42, "Looks good.\nTwo nits.")],
    },
    {
      id: 102,
      name: "Two agents",
      author_id: ME,
      is_private: true,
      updated_at: "2026-11-15T08:00:00+00:00Z",
      participants: [user(1, ME, "Ada"), dummy, agent(43, 255, "Reviewer"), agent(44, 31, "Business Analyst", { entity_meta: { id: 31, project_id: 1 } })],
      messages: [],
    },
    {
      id: 103,
      name: "Long pipeline",
      author_id: ME,
      is_private: true,
      updated_at: "2026-11-14T08:00:00+00:00Z",
      participants: [user(1, ME, "Ada"), dummy, agent(45, 260, "Flow")],
      messages: [text(5, 1, "go"), text(6, 45, "", { is_streaming: true, task_id: "t-1", created_at: ago(2) })],
    },
    {
      id: 104,
      name: "Shared by Bob",
      author_id: OTHER,
      is_private: false,
      updated_at: "2026-11-13T08:00:00+00:00Z",
      participants: [user(1, OTHER, "Bob"), dummy, agent(46, 255, "Reviewer")],
      messages: [text(7, 1, "hi from Bob")],
    },
    {
      id: 105,
      name: "Plain model chat",
      author_id: ME,
      is_private: true,
      updated_at: "2026-11-12T08:00:00+00:00Z",
      participants: [user(1, ME, "Ada"), dummy],
      messages: [],
    },
  ];
  return {
    chats,
    agents: [
      { id: 255, name: "Reviewer", agent_type: "openai", project: P },
      { id: 260, name: "Flow", agent_type: "pipeline", project: P },
      { id: 31, name: "Business Analyst", agent_type: "openai", project: 1 },
    ],
    nextGroup: 1000,
    /** The reply the agent writes to the next message. */
    reply: { text: "Answer.", streaming: false } as { text: string; streaming: boolean; meta?: MessageGroup["meta"] },
    refuseDelete: {} as Record<number, { status: number; body: unknown }>,
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
    calls.push({ method, path, query: url.searchParams, body });
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const visible = (c: Chat) => !c.is_private || c.author_id === ME || c.participants.some((p) => p.entity_name === "user" && p.entity_meta?.id === ME);
    let m: RegExpMatchArray | null;

    if (path === "/api/v2/auth/user/") return json({ id: ME, name: "Ada", email: "ada@a.test", personal_project_id: 9 });
    if (path === `${CORE}/conversations/prompt_lib/${P}`) {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const rows = w.chats
        .filter((c) => visible(c) && c.name.toLowerCase().includes(q))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .map((c) => ({
          id: c.id,
          uuid: `uuid-${c.id}`,
          name: c.name,
          is_private: c.is_private,
          author_id: c.author_id,
          created_at: c.updated_at,
          updated_at: c.updated_at,
          participants_count: c.participants.length,
          users_count: 1,
          message_groups_count: c.messages.length,
          has_running_task: c.messages.some((g) => g.is_streaming),
        }));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
      return json({ total: rows.length, rows: rows.slice(offset, offset + limit) });
    }
    if ((m = path.match(new RegExp(`^${CORE}/conversation/prompt_lib/${P}/(\\d+)$`)))) {
      const c = w.chats.find((x) => String(x.id) === m![1]);
      if (method === "GET") {
        if (!c || !visible(c)) return json({ error: `No such conversation with id ${m[1]}` }, 400);
        const { messages: _m, ...rest } = c;
        return json({ ...rest, uuid: `uuid-${c.id}` });
      }
      if (method === "DELETE") {
        if (w.refuseDelete[Number(m[1])]) return json(w.refuseDelete[Number(m[1])]!.body, w.refuseDelete[Number(m[1])]!.status);
        if (!c || !visible(c)) return json({ error: "Conversation not found" }, 404);
        if (c.author_id !== ME) return json({ error: "Only the conversation author or a project admin can do this" }, 403);
        w.chats = w.chats.filter((x) => x !== c);
        return new Response(null, { status: 204 });
      }
    }
    if ((m = path.match(new RegExp(`^${CORE}/messages/prompt_lib/${P}/([^/]+)$`)))) {
      if (method === "GET") {
        const c = w.chats.find((x) => String(x.id) === m![1]);
        const rows = [...(c?.messages ?? [])].reverse();
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 10);
        return json({ total: rows.length, rows: rows.slice(offset, offset + limit) });
      }
      const c = w.chats.find((x) => `uuid-${x.id}` === m![1])!;
      const userGroup = text(w.nextGroup++, 1, String(body!.user_input), { created_at: ago(0) });
      const replyGroup = text(w.nextGroup++, Number(body!.participant_id), w.reply.text, {
        is_streaming: w.reply.streaming,
        task_id: "t-new",
        created_at: ago(0),
        meta: w.reply.meta,
      });
      c.messages.push(userGroup, replyGroup);
      return json({ request_message_group_id: userGroup.id, response_message_group_id: replyGroup.id });
    }
    if ((m = path.match(new RegExp(`^${CORE}/application/prompt_lib/(\\d+)/(\\d+)$`)))) {
      const a = w.agents.find((x) => String(x.id) === m![2] && String(x.project) === m![1]);
      if (!a) return json({ error: "Application not found" }, 404);
      return json({
        id: a.id,
        name: a.name,
        agent_type: a.agent_type,
        versions: [{ id: a.id * 10, name: "base" }, { id: a.id * 10 + 1, name: "v2" }],
        version_details: { id: a.id * 10 + 1, name: "v2", agent_type: a.agent_type },
      });
    }
    if (path === `${CORE}/applications/prompt_lib/${P}`) {
      const rows = w.agents.filter((a) => a.project === P);
      return json({ total: rows.length, rows });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const writes = () => calls.filter((c) => c.method !== "GET");
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

function tty(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

beforeEach(async () => {
  resetContext();
  dir = await mkdtemp(join(tmpdir(), "elitea-cli-06-"));
  process.env.ELITEA_CLI_HOME = dir;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  process.env.ELITEA_CLI_URL = "https://elitea.test";
  process.env.ELITEA_CLI_TOKEN = "tok-0123456789abcdef";
  process.env.ELITEA_CLI_PROJECT = String(P);
  process.env.TZ = "UTC";
  for (const v of ["ELITEA_CLI_OUTPUT", "ELITEA_CLI_ENV", "ELITEA_CLI_TIMEOUT", "CI", "NO_COLOR"]) delete process.env[v];
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
  for (const v of ["ELITEA_CLI_URL", "ELITEA_CLI_TOKEN", "ELITEA_CLI_PROJECT"]) delete process.env[v];
  resetContext();
});

// ---------------------------------------------------------------------------------------------

describe("chat ids and dates", () => {
  it("takes the numeric id; a uuid is refused before any request", () => {
    expect(parseChatId("784")).toBe(784);
    for (const bad of ["fe079a7a-efa8-4a5e-a522-7dcaf427ccdf", "abc", "0", "-3", "1.5"]) {
      expect(exitCodeOf(captured(() => parseChatId(bad)))).toBe(EXIT.usage);
    }
    expect((captured(() => parseChatId("fe079a7a-efa8-4a5e-a522-7dcaf427ccdf")) as Error).message).toBe(
      "Use the numeric chat id (see elitea-cli chats list)",
    );
  });

  it("reads both date shapes EliteA sends as UTC", () => {
    expect(parseUtc("2026-11-16T12:44:00+00:00Z")?.toISOString()).toBe("2026-11-16T12:44:00.000Z");
    expect(parseUtc("2026-11-13T09:33:06.737438")?.toISOString()).toBe("2026-11-13T09:33:06.737Z");
    expect(parseUtc("2026-11-13T09:33:06+02:00")?.toISOString()).toBe("2026-11-13T07:33:06.000Z");
    expect(localTime("2026-11-16T12:44:00+00:00Z")).toBe("2026-11-16 12:44");
    expect(localTime(undefined)).toBe("");
  });

  it("counts a streaming reply as running the way the server does", () => {
    const g = (minutes: number, task: string | null): MessageGroup => text(1, 1, "", { is_streaming: true, task_id: task, created_at: ago(minutes) });
    expect(isLiveRun(g(2, "t"))).toBe(true);
    expect(isLiveRun(g(2, null))).toBe(true); // may still be starting
    expect(isLiveRun(g(10, null))).toBe(false); // the send broke before dispatch
    expect(isLiveRun(g(25 * 60, "t"))).toBe(false); // older than any run
    expect(isLiveRun({ ...g(2, "t"), is_streaming: false })).toBe(false);
  });
});

describe("chats list (AC-1, AC-2)", () => {
  it("shows the UI's chat list, newest first, with agent names and RUNNING", async () => {
    await listCommand({});
    expect(logs[0]).toMatch(/^ID\s+NAME\s+PARTICIPANTS\s+UPDATED\s+RUNNING$/);
    const starts = ["NAME", "PARTICIPANTS", "UPDATED", "RUNNING"].map((h) => logs[0]!.indexOf(h));
    const cells = (l: string) => [0, ...starts].map((s, i, all) => l.slice(s, all[i + 1]).trim()).filter((c, i, row) => c || row.slice(i + 1).some(Boolean));
    expect(logs.slice(1).map(cells)).toEqual([
      ["101", "Reviewer: check diff", "Reviewer", "2026-11-16 12:44"],
      ["102", "Two agents", "Reviewer, Business Analyst", "2026-11-15 08:00"],
      ["103", "Long pipeline", "Flow", "2026-11-14 08:00", "yes"],
      ["104", "Shared by Bob", "Reviewer", "2026-11-13 08:00"],
      ["105", "Plain model chat", "", "2026-11-12 08:00"],
    ]);
    const list = calls.find((c) => c.path === `${CORE}/conversations/prompt_lib/${P}`)!;
    expect(Object.fromEntries(list.query)).toMatchObject({ sort_by: "updated_at", sort_order: "desc", limit: "20", offset: "0" });
  });

  it("--search goes to the server; --limit caps the rows and says there are more", async () => {
    await listCommand({ search: "agents" });
    expect(calls.find((c) => c.path.includes("/conversations/"))!.query.get("query")).toBe("agents");
    expect(logs).toHaveLength(2);
    logs = [];
    errors = [];
    await listCommand({ limit: "2" });
    expect(logs).toHaveLength(3);
    expect(errors).toEqual(["Showing 2 of 5; use --limit or --search for more"]);
    expect(exitCodeOf(await failure(listCommand({ limit: "0" })))).toBe(EXIT.usage);
  });

  it("json: the chats with agents and UTC dates", async () => {
    await listCommand({ output: "json", limit: "1" });
    expect(JSON.parse(logs.join(""))).toEqual([
      {
        id: 101,
        uuid: "uuid-101",
        name: "Reviewer: check diff",
        agents: [{ id: 255, name: "Reviewer", project_id: P }],
        created_at: "2026-11-16T12:44:00.000Z",
        updated_at: "2026-11-16T12:44:00.000Z",
        running: false,
        private: true,
        author_id: ME,
        messages: 2,
      },
    ]);
  });

  it("no chats: 'No chats found' on stderr, [] in JSON/YAML, exit 0", async () => {
    await listCommand({ search: "nothing" });
    expect(logs).toEqual([]);
    expect(errors).toEqual(["No chats found"]);
    await listCommand({ search: "nothing", output: "json" });
    expect(logs).toEqual(["[]"]);
    logs = [];
    await listCommand({ search: "nothing", output: "yaml" });
    expect(logs.join("").trim()).toBe("[]");
  });

  it("another user's private chat is not listed (AC-11)", async () => {
    w.chats.push({ ...w.chats[0]!, id: 106, name: "Bob's secret", author_id: OTHER, participants: [user(1, OTHER, "Bob"), dummy] });
    await listCommand({ output: "json" });
    expect((JSON.parse(logs.join("")) as Array<{ id: number }>).map((c) => c.id)).not.toContain(106);
  });
});

describe("chats show (AC-3…AC-5)", () => {
  it("prints the messages oldest first with author and local time, in full", async () => {
    await showCommand("101", {});
    expect(logs.join("\n")).toMatch(/^Ada \(\d{4}-\d\d-\d\d \d\d:\d\d\):\ncheck diff\n\nReviewer \(\d{4}-\d\d-\d\d \d\d:\d\d\):\nLooks good\.\nTwo nits\.$/);
  });

  it("defaults to the last 20; --last N; --all reads every page", async () => {
    const c = w.chats[0]!;
    c.messages = Array.from({ length: 230 }, (_, i) => text(i + 1, i % 2 ? 42 : 1, `m${i + 1}`));
    await showCommand("101", { output: "json" });
    let out = JSON.parse(logs.join("")) as Array<{ text: string }>;
    expect(out).toHaveLength(20);
    expect(out[0]!.text).toBe("m211");
    expect(out[19]!.text).toBe("m230");
    logs = [];
    await showCommand("101", { last: "1", output: "json" });
    expect((JSON.parse(logs.join("")) as Array<{ text: string }>).map((m) => m.text)).toEqual(["m230"]);
    logs = [];
    calls = [];
    await showCommand("101", { all: true, output: "json" });
    out = JSON.parse(logs.join(""));
    expect(out).toHaveLength(230);
    expect(out[0]!.text).toBe("m1");
    expect(calls.filter((x) => x.path.includes("/messages/")).map((x) => x.query.get("offset") ?? "0")).toEqual(["0", "100", "200"]);
  });

  it("--last with --all → exit 2, no request", async () => {
    expect(exitCodeOf(await failure(showCommand("101", { all: true, last: "3" })))).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("a reply still streaming is marked (still running)", async () => {
    await showCommand("103", {});
    expect(logs.at(-1)).toMatch(/^Flow \(.*\): \(still running\)$/);
  });

  it("json/yaml: author, created_at, text, is_streaming", async () => {
    await showCommand("103", { output: "json" });
    expect(JSON.parse(logs.join(""))[1]).toEqual({
      id: 6,
      author: "Flow",
      author_type: "application",
      created_at: expect.stringMatching(/Z$/),
      text: "",
      is_streaming: true,
    });
    logs = [];
    await showCommand("101", { output: "yaml" });
    expect(logs.join("")).toMatch(/- id: 1\n {2}author: Ada\n {2}author_type: user\n {2}created_at: .*\n {2}text: check diff\n {2}is_streaming: false/);
  });

  it("a failed reply shows the last line of its error; json keeps all of it", async () => {
    w.chats[0]!.messages.push(text(3, 42, "Pipeline has no nodes.", { meta: { is_error: true, error: "Traceback\n  File x\nPipelineConfigurationError: Pipeline has no nodes." } }));
    w.chats[0]!.messages.push(text(4, 42, "", { meta: { is_error: true, error: "Traceback\nValueError: boom" } }));
    await showCommand("101", {});
    expect(logs.join("\n")).toMatch(/Pipeline has no nodes\.\n\nReviewer \(.*\):\nerror: ValueError: boom$/);
    logs = [];
    await showCommand("101", { output: "json" });
    expect(JSON.parse(logs.join("")).at(-1).error).toBe("Traceback\nValueError: boom");
  });

  it("unknown, foreign or hidden id → 'Chat not found', exit 5 (AC-5, AC-11)", async () => {
    w.chats.push({ ...w.chats[0]!, id: 106, author_id: OTHER, participants: [user(1, OTHER, "Bob"), dummy] });
    for (const id of ["999", "106"]) {
      const err = await failure(showCommand(id, {}));
      expect(err?.message).toBe("Chat not found");
      expect(exitCodeOf(err)).toBe(EXIT.notFound);
    }
  });

  it("a uuid → exit 2 and no request", async () => {
    const err = await failure(showCommand("fe079a7a-efa8-4a5e-a522-7dcaf427ccdf", {}));
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("a chat shared with the user can be read (AC-11)", async () => {
    await showCommand("104", {});
    expect(logs.join("\n")).toMatch(/^Bob \(.*\):\nhi from Bob$/);
  });
});

describe("chats send (AC-6…AC-7a, AC-12)", () => {
  it("sends to the chat's only agent and prints the answer like agents run", async () => {
    expect(await sendCommand("101", "And the tests?", {})).toBe(EXIT.ok);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: `${CORE}/messages/prompt_lib/${P}/uuid-101`,
      body: { user_input: "And the tests?", participant_id: 42, await_task_timeout: 0, return_task_id: true },
    });
    expect(logs).toEqual(["Answer."]);
    expect(errors).toEqual(["\nconversation: 101 (https://elitea.test/app/chat/101)"]);
  });

  it("json: the agents run shape, version from the chat's settings", async () => {
    await sendCommand("101", "hi", { output: "json" });
    expect(JSON.parse(logs.join(""))).toEqual({
      status: "finished",
      answer: "Answer.",
      conversation_id: 101,
      conversation_url: "https://elitea.test/app/chat/101",
      agent: { id: 255, name: "Reviewer", type: "openai" },
      version: { id: 2550, name: "base" },
    });
  });

  it("--no-wait prints the id; -q only the id", async () => {
    w.reply.streaming = true;
    expect(await sendCommand("101", "hi", { wait: false })).toBe(EXIT.ok);
    expect(logs).toEqual(["101"]);
    expect(errors).toEqual(["https://elitea.test/app/chat/101"]);
  });

  it("input rules of agents run: -f, both → exit 2, empty → exit 2", async () => {
    expect(exitCodeOf(await failure(sendCommand("101", "hi", { file: "x.txt" })))).toBe(EXIT.usage);
    expect(exitCodeOf(await failure(sendCommand("101", undefined, {})))).toBe(EXIT.usage);
    expect(exitCodeOf(await failure(sendCommand("101", "   ", {})))).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
  });

  it("statuses and exit codes of agents run: failed 1, timeout 8, waiting for input 8", async () => {
    w.reply = { text: "", streaming: false, meta: { is_error: true, error: "boom" } };
    expect(await sendCommand("101", "hi", {})).toBe(EXIT.general);
    expect(errors[0]).toMatch(/^boom\nconversation:/);
    w.reply = { text: "", streaming: false, meta: { hitl_interrupts: [{}] } };
    expect(await sendCommand("101", "hi", {})).toBe(EXIT.timeout);
  });

  it("several agents need --to (name or id); none → exit 2", async () => {
    const err = await failure(sendCommand("102", "hi", {}));
    expect(err?.message).toBe("Chat has several agents: Reviewer, Business Analyst — pass --to <agent>");
    expect(exitCodeOf(err)).toBe(EXIT.usage);
    await sendCommand("102", "hi", { to: "business analyst" });
    expect(writes()[0]!.body).toMatchObject({ participant_id: 44 });
    await sendCommand("102", "hi", { to: "255" });
    expect(writes()[1]!.body).toMatchObject({ participant_id: 43 });
    // The agent of another project is read in its own project.
    expect(calls.some((c) => c.path === `${CORE}/application/prompt_lib/1/31`)).toBe(true);
    expect(exitCodeOf(await failure(sendCommand("102", "hi", { to: "Nobody" })))).toBe(EXIT.notFound);

    const none = await failure(sendCommand("105", "hi", {}));
    expect(none?.message).toBe("Chat has no agent to answer");
    expect(exitCodeOf(none)).toBe(EXIT.usage);
  });

  it("a deleted agent → the platform's 404, exit 5, nothing sent", async () => {
    w.agents = w.agents.filter((a) => a.id !== 255);
    expect(exitCodeOf(await failure(sendCommand("101", "hi", {})))).toBe(EXIT.notFound);
    expect(writes()).toEqual([]);
  });

  it("a chat still running → exit 6, nothing sent (AC-7a)", async () => {
    const err = await failure(sendCommand("103", "hi", {}));
    expect(err?.message).toBe("Chat is still running; wait for it or check elitea-cli chats show 103");
    expect(exitCodeOf(err)).toBe(EXIT.conflict);
    expect(writes()).toEqual([]);
  });

  it("not found and uuid as for show", async () => {
    expect(exitCodeOf(await failure(sendCommand("999", "hi", {})))).toBe(EXIT.notFound);
    expect(exitCodeOf(await failure(sendCommand("fe079a7a-efa8-4a5e-a522-7dcaf427ccdf", "hi", {})))).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
  });

  it("a shared chat can be sent to (AC-11)", async () => {
    expect(await sendCommand("104", "hi", {})).toBe(EXIT.ok);
    expect(writes()[0]!.path).toBe(`${CORE}/messages/prompt_lib/${P}/uuid-104`);
  });

  it("agents chat -c <id> sends the same request (AC-12)", async () => {
    await sendCommand("101", "same", {});
    await agentChatCommand("Reviewer", "same", { conversation: "101" });
    const [a, b] = writes();
    expect(b!.path).toBe(a!.path);
    expect(b!.body).toEqual(a!.body);
  });

  it("needs the run operation of a scoped token (AC-11a)", () => {
    expect(operationFor("chats send")).toBe("run");
    for (const c of ["chats list", "chats show", "chats delete"]) expect(operationFor(c)).toBeUndefined();
  });
});

describe("chats delete (AC-8…AC-11)", () => {
  it("asks with the chat's name and the note about script files, then deletes it", async () => {
    tty(true);
    prompts.answers = [true];
    expect(await deleteCommand(["101"], {})).toBe(EXIT.ok);
    expect(prompts.asked).toEqual(["Delete chat 'Reviewer: check diff' (101)? Files created by skill scripts in it are deleted too."]);
    expect(writes()).toEqual([expect.objectContaining({ method: "DELETE", path: `${CORE}/conversation/prompt_lib/${P}/101` })]);
    expect(logs).toEqual(["Deleted chat 'Reviewer: check diff' (101)"]);
    logs = [];
    await listCommand({ output: "json" });
    expect((JSON.parse(logs.join("")) as Array<{ id: number }>).map((c) => c.id)).not.toContain(101);
  });

  it("no → nothing deleted, exit 0; outside a terminal --yes is needed", async () => {
    tty(true);
    prompts.answers = [false];
    expect(await deleteCommand(["101"], {})).toBe(EXIT.ok);
    expect(writes()).toEqual([]);
    tty(false);
    expect(exitCodeOf(await failure(deleteCommand(["101"], {})))).toBe(EXIT.usage);
    expect(writes()).toEqual([]);
    expect(await deleteCommand(["101"], { yes: true })).toBe(EXIT.ok);
    expect(writes()).toHaveLength(1);
  });

  it("a running chat gets the other question (AC-10); global --yes skips it", async () => {
    tty(true);
    prompts.answers = [true];
    await deleteCommand(["103"], {});
    expect(prompts.asked).toEqual(["Chat 'Long pipeline' (103) is still running. Delete it anyway? Files created by skill scripts are deleted too."]);
    tty(false);
    ctx.yes = true;
    expect(await deleteCommand(["101"], {})).toBe(EXIT.ok);
    expect(prompts.asked).toHaveLength(1);
  });

  it("several ids: asked once, listing them all (AC-9)", async () => {
    tty(true);
    prompts.answers = [true];
    expect(await deleteCommand(["101", "103", "105"], {})).toBe(EXIT.ok);
    expect(prompts.asked).toEqual(["Delete these 3 chats? One is still running. Files created by skill scripts in them are deleted too."]);
    expect(errors).toEqual(["  Reviewer: check diff (101)", "  Long pipeline (103) — still running", "  Plain model chat (105)"]);
    expect(logs).toEqual(["Deleted: 101, 103, 105"]);
  });

  it("a failure does not stop the others; summary; exit of the first failure (AC-9a, AC-11)", async () => {
    // 999 does not exist; 104 is Bob's (shared, 403 for a non-author).
    expect(await deleteCommand(["101", "999", "104", "105"], { yes: true })).toBe(EXIT.notFound);
    expect(writes().map((c) => c.path.split("/").pop())).toEqual(["101", "104", "105"]);
    expect(logs).toEqual(["Deleted: 101, 105"]);
    expect(errors).toEqual(["Failed: 999 (Chat not found), 104 (Forbidden: Only the conversation author or a project admin can do this)"]);
    errors = [];
    expect(await deleteCommand(["104", "102"], { yes: true })).toBe(EXIT.denied);
  });

  it("a single id: not found → exit 5, non-author → exit 4 (AC-11)", async () => {
    expect(exitCodeOf(await failure(deleteCommand(["999"], { yes: true })))).toBe(EXIT.notFound);
    const err = await failure(deleteCommand(["104"], { yes: true }));
    expect(exitCodeOf(err)).toBe(EXIT.denied);
    expect(err?.message).toMatch(/Only the conversation author or a project admin can do this/);
  });

  it("-q prints only the deleted ids; a uuid among the ids → exit 2, nothing deleted", async () => {
    ctx.quiet = true;
    await deleteCommand(["101", "105"], { yes: true });
    expect(logs).toEqual(["101", "105"]);
    expect(exitCodeOf(await failure(deleteCommand(["102", "fe079a7a-efa8-4a5e-a522-7dcaf427ccdf"], { yes: true })))).toBe(EXIT.usage);
    expect(writes()).toHaveLength(2);
  });

  it("the question texts", () => {
    expect(deleteQuestion([{ id: 1, name: "a", running: false }, { id: 2, name: "b", running: true }, { id: 3, name: "c", running: true }]).question).toBe(
      "Delete these 3 chats? 2 are still running. Files created by skill scripts in them are deleted too.",
    );
  });
});

describe("Claude Code permissions", () => {
  it("list and show run without asking; send and delete always ask", () => {
    for (const c of ["chats list", "chats show"]) expect(ELITEA_PERMISSIONS.allow).toContain(`Bash(elitea-cli ${c}:*)`);
    for (const c of ["chats send", "chats delete"]) expect(ELITEA_PERMISSIONS.ask).toContain(`Bash(elitea-cli ${c}:*)`);
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}
