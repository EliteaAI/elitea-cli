import { describe, expect, it, vi } from "vitest";
import { formatAgents } from "../src/commands/agents.js";
import { EliteaClient } from "../src/elitea.js";

const base = "/api/v2/elitea_core/applications/prompt_lib/4";

function agent(id: number, name: string, description = "", agentType = "openai") {
  return { id, name, description, status: "draft", agent_type: agentType };
}

function pagedFetch(all: ReturnType<typeof agent>[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    expect(u.pathname).toBe(base);
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset"));
    const q = u.searchParams.get("query");
    const type = u.searchParams.get("agents_type");
    const matching = all
      .filter((a) => (type === "classic" ? a.agent_type !== "pipeline" : type === "pipeline" ? a.agent_type === "pipeline" : true))
      .filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
    return Response.json({ total: matching.length, rows: matching.slice(offset, offset + limit) });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("listAgents", () => {
  const all = [agent(5, "Reviewer"), agent(4, "Attach 2"), agent(3, "Attach"), agent(2, "Docs"), agent(1, "Triage")];

  it("pages until total is reached", async () => {
    const fetchImpl = pagedFetch(all);
    const client = new EliteaClient("https://elitea.test", "tok", fetchImpl);
    expect((await client.listAgents(4, { pageSize: 2 })).map((a) => a.id)).toEqual([5, 4, 3, 2, 1]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("passes the search text as query", async () => {
    const client = new EliteaClient("https://elitea.test", "tok", pagedFetch(all));
    expect((await client.listAgents(4, { query: "attach" })).map((a) => a.name)).toEqual(["Attach 2", "Attach"]);
  });

  it("lists classic agents only by default; pipelines on request", async () => {
    const mixed = [...all, agent(9, "Nightly", "", "pipeline")];
    const fetchImpl = pagedFetch(mixed);
    const client = new EliteaClient("https://elitea.test", "tok", fetchImpl);
    expect((await client.listAgents(4)).map((a) => a.id)).toEqual([5, 4, 3, 2, 1]);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get("agents_type")).toBe("classic");
    expect((await client.listAgents(4, { type: "pipeline" })).map((a) => a.id)).toEqual([9]);
    expect(await client.listAgents(4, { type: "all" })).toHaveLength(6);
  });

  it("stops on an empty page even if total says otherwise", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ total: 10, rows: [] })) as unknown as typeof fetch;
    expect(await new EliteaClient("https://elitea.test", "tok", fetchImpl).listAgents(4)).toEqual([]);
  });
});

describe("formatAgents", () => {
  it("aligns columns and truncates long descriptions to the terminal width", () => {
    const lines = formatAgents([agent(2, "Attach 2", "short"), agent(10, "Reviewer", "x".repeat(200))], 60);
    expect(lines[0]).toBe("ID  NAME      TYPE    STATUS  DESCRIPTION");
    expect(lines[1]).toBe(" 2  Attach 2  openai  draft   short");
    expect(lines[2]).toHaveLength(60);
    expect(lines[2]!.endsWith("…")).toBe(true);
  });
});
