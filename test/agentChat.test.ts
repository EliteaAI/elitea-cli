import { describe, expect, it, vi } from "vitest";
import { AgentChat, conversationName } from "../src/agentChat.js";
import { findAgent } from "../src/commands/agentChat.js";
import { EliteaClient, EliteaError } from "../src/elitea.js";

const api = "/api/v2/elitea_core";
const conversation = {
  id: 7,
  uuid: "conv-uuid",
  name: "x",
  participants: [
    { id: 2, entity_name: "user", entity_meta: { id: 24 } },
    { id: 5, entity_name: "application", entity_meta: { id: 9, project_id: 4 } },
  ],
};

function group(id: number, content: string, streaming = false) {
  return { id, uuid: `g${id}`, author_participant_id: 5, is_streaming: streaming, message_items: [{ item_type: "text_message", item_details: { content } }] };
}

/** Records requests; GET messages returns the next queued page. */
function fakeEliteA(pages: unknown[][]) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://elitea.test", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path === `${api}/conversations/prompt_lib/4`) return Response.json(conversation, { status: 201 });
    if (method === "GET" && path.startsWith(`${api}/conversation/prompt_lib/4/7`)) return Response.json(conversation);
    if (method === "POST" && path === `${api}/messages/prompt_lib/4/conv-uuid`) {
      return Response.json({ request_message_group_id: 10, response_message_group_id: 11 });
    }
    if (method === "GET" && path.startsWith(`${api}/messages/prompt_lib/4/7`)) return Response.json({ total: 2, rows: pages.shift() ?? [] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { client: new EliteaClient("https://elitea.test", "tok", fetchImpl), calls };
}

const fast = { pollIntervalMs: 0, sleep: async () => {} };

describe("AgentChat", () => {
  it("creates a conversation, sends in background mode and polls until the reply is done", async () => {
    const { client, calls } = fakeEliteA([[group(11, "", true)], [group(11, "4"), group(10, "2+2?")]]);
    const chat = new AgentChat(client, 4, { agentId: 9, agentName: "Calc", versionId: 3, ...fast });

    expect(await chat.send("2+2?")).toEqual({ answer: "4", conversationId: 7 });
    expect(calls[0]!.body).toEqual({
      name: "Calc: 2+2?",
      is_private: true,
      participants: [{ entity_name: "application", entity_meta: { id: 9, project_id: 4 }, entity_settings: { version_id: 3 } }],
    });
    expect(calls[1]!.body).toEqual({ user_input: "2+2?", participant_id: 5, await_task_timeout: 0, return_task_id: true });
    expect(calls.filter((c) => c.path.startsWith(`${api}/messages/prompt_lib/4/7`))).toHaveLength(2);
  });

  it("reuses the conversation for follow-ups and starts over after reset", async () => {
    const { client, calls } = fakeEliteA([[group(11, "a")], [group(11, "b")], [group(11, "c")]]);
    const chat = new AgentChat(client, 4, { agentId: 9, agentName: "Calc", ...fast });
    await chat.send("one");
    await chat.send("two");
    chat.reset();
    await chat.send("three");
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/conversations/prompt_lib/4"))).toHaveLength(2);
  });

  it("continues an existing conversation by id", async () => {
    const { client, calls } = fakeEliteA([[group(11, "again")]]);
    const chat = new AgentChat(client, 4, { agentId: 9, agentName: "Calc", conversation: 7, ...fast });
    expect((await chat.send("hi")).answer).toBe("again");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/conversations/prompt_lib/4"))).toBe(false);
  });

  it("fails clearly when the conversation is with a different agent", async () => {
    const { client } = fakeEliteA([]);
    const chat = new AgentChat(client, 4, { agentId: 99, agentName: "Other", conversation: 7, ...fast });
    await expect(chat.send("hi")).rejects.toThrow(/does not include agent "Other"/);
  });

  it("gives up after the timeout and points to the conversation in EliteA", async () => {
    const { client } = fakeEliteA(Array.from({ length: 5 }, () => [group(11, "", true)]));
    const chat = new AgentChat(client, 4, { agentId: 9, agentName: "Calc", ...fast, timeoutMs: -1 });
    await expect(chat.send("slow")).rejects.toThrow("https://elitea.test/app/chat/7");
  });
});

describe("EliteaClient errors", () => {
  it("reports budget exhaustion and validation errors readably", async () => {
    const respond = (res: Response) => new EliteaClient("https://elitea.test", "tok", (async () => res) as unknown as typeof fetch);
    await expect(respond(new Response("{}", { status: 429 })).listAgents(4)).rejects.toThrow(/budget/);
    const invalid = Response.json([{ loc: ["name"], msg: "String should have at most 50 characters" }], { status: 400 });
    const err = await respond(invalid).createConversation(4, { name: "x", agentId: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EliteaError);
    expect((err as Error).message).toContain("name: String should have at most 50 characters");
  });
});

describe("conversationName", () => {
  it("fits EliteA's 3–50 character limit", () => {
    expect(conversationName("Calc", "  2 +\n 2 ")).toBe("Calc: 2 + 2");
    const long = conversationName("Attach 2", "My favourite number is 42. Reply: noted please");
    expect(long).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("findAgent", () => {
  const agents = [
    { id: 2, name: "Attach 2" },
    { id: 1, name: "attach" },
    { id: 3, name: "Code reviewer" },
  ];
  it("matches id, exact name, case-insensitive name, then a unique substring", () => {
    expect(findAgent(agents, "2")?.name).toBe("Attach 2");
    expect(findAgent(agents, "attach")?.id).toBe(1);
    expect(findAgent(agents, "ATTACH 2")?.id).toBe(2);
    expect(findAgent(agents, "review")?.id).toBe(3);
  });
  it("refuses ambiguous or unknown names", () => {
    expect(findAgent(agents, "att")).toBeUndefined();
    expect(findAgent(agents, "nope")).toBeUndefined();
  });
});
