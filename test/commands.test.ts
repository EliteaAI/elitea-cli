import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLimit, parseStatuses } from "../src/commands/agents.js";
import { formatAgentDetails, formatVersions } from "../src/commands/inspect.js";
import { mergeVariables, parseTimeout, readInput, report, type RunReport } from "../src/commands/run.js";
import { AccessDeniedError, AuthError, EliteaClient, EliteaError, type AgentVersion, type EliteaAgentDetails } from "../src/elitea.js";
import { CliError, EXIT, exitCodeOf } from "../src/errors.js";
import { formatTable, parseFormat } from "../src/output.js";
import { resolveIn, resolveVersion } from "../src/resolve.js";

const exitOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return exitCodeOf(err);
  }
  return 0;
};
const asyncExitOf = async (p: Promise<unknown>) => p.then(() => 0, exitCodeOf);

describe("exit codes", () => {
  it("maps platform errors", () => {
    expect(exitCodeOf(new AuthError())).toBe(EXIT.auth);
    expect(exitCodeOf(new AccessDeniedError("/x"))).toBe(EXIT.denied);
    expect(exitCodeOf(new EliteaError("x", 404))).toBe(EXIT.notFound);
    expect(exitCodeOf(new EliteaError("x", 413))).toBe(EXIT.conflict);
    expect(exitCodeOf(new EliteaError("x", 500))).toBe(EXIT.general);
    expect(exitCodeOf(new CliError("x", 8))).toBe(8);
  });

  it("403 is access denied, not a rejected token", async () => {
    const client = new EliteaClient("https://elitea.test", "tok", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    const err = await client.getAgent(4, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect((err as Error).message).not.toContain("?");
  });
});

describe("output", () => {
  it("parses -o and the older --json", () => {
    expect(parseFormat({})).toBe("text");
    expect(parseFormat({ json: true })).toBe("json");
    expect(parseFormat({ output: "yaml" })).toBe("yaml");
    expect(exitOf(() => parseFormat({ output: "xml" }))).toBe(EXIT.usage);
    expect(exitOf(() => parseFormat({ output: "yaml", json: true }))).toBe(EXIT.usage);
  });

  it("formats a table and cuts the last column", () => {
    const lines = formatTable(["ID", "NAME", "NOTE"], [["1", "a", "x".repeat(50)]], 20);
    expect(lines[0]).toBe("ID  NAME  NOTE");
    expect(lines[1]).toHaveLength(20);
  });
});

describe("list filters", () => {
  it("validates --status and --limit", () => {
    expect(parseStatuses(["draft", "published,rejected"])).toEqual(["draft", "published", "rejected"]);
    expect(() => parseStatuses(["live"])).toThrow(/draft, published, on_moderation, rejected, user_approval, unpublished/);
    expect(exitOf(() => parseStatuses(["live"]))).toBe(EXIT.usage);
    expect(parseLimit("250")).toBe(250);
    expect(exitOf(() => parseLimit("0"))).toBe(EXIT.usage);
  });

  it("sends tags, statuses, author and caps the total", async () => {
    const urls: URL[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      urls.push(u);
      const limit = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset"));
      const rows = Array.from({ length: Math.max(0, Math.min(limit, 250 - offset)) }, (_, i) => ({ id: 250 - offset - i, name: `a${offset + i}` }));
      return Response.json({ total: 250, rows });
    }) as unknown as typeof fetch;
    const client = new EliteaClient("https://elitea.test", "tok", fetchImpl);

    expect(await client.listAgents(4, { type: "all" })).toHaveLength(250);
    expect(urls).toHaveLength(3);
    expect(urls[0]!.searchParams.has("agents_type")).toBe(false);

    urls.length = 0;
    const capped = await client.listAgents(4, { type: "pipeline", tagIds: [3, 5], statuses: ["draft"], authorId: 7, maxTotal: 120 });
    expect(capped).toHaveLength(120);
    expect(urls.map((u) => u.searchParams.get("limit"))).toEqual(["100", "20"]);
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ agents_type: "pipeline", tags: "3,5", statuses: "draft", author_id: "7" });
  });
});

const apps = [
  { id: 1, name: "Code reviewer", agent_type: "openai" },
  { id: 2, name: "Release notes", agent_type: "pipeline" },
  { id: 3, name: "Release checker", agent_type: "openai" },
];

describe("resolveIn", () => {
  it("finds agents and pipelines by id or name", () => {
    expect(resolveIn(apps, "2", "agent").name).toBe("Release notes");
    expect(resolveIn(apps, "release notes", "pipeline").id).toBe(2);
  });

  it("keeps today's texts and exits 5 for unknown or ambiguous names", () => {
    expect(() => resolveIn(apps, "nope", "agent")).toThrow('Agent "nope" not found — run `elitea-cli agents`');
    expect(() => resolveIn(apps, "release", "agent")).toThrow(/matches several: Release notes \(2\), Release checker \(3\)/);
    expect(exitOf(() => resolveIn(apps, "nope", "agent"))).toBe(EXIT.notFound);
    expect(() => resolveIn(apps, "nope", "pipeline")).toThrow("run `elitea-cli pipelines list`");
  });

  it("refuses a classic agent as a pipeline", () => {
    expect(() => resolveIn(apps, "Code reviewer", "pipeline")).toThrow('"Code reviewer" is an agent, not a pipeline — use `elitea-cli agents get 1`');
    expect(exitOf(() => resolveIn(apps, "1", "pipeline"))).toBe(EXIT.notFound);
  });
});

const details: EliteaAgentDetails = {
  id: 1,
  name: "Code reviewer",
  description: "Reviews\ncode",
  agent_type: "openai",
  tags: [{ name: "qa" }],
  versions: [
    { id: 10, name: "base", status: "published", created_at: "2026-10-01T09:30:00", author_name: "Ada" },
    { id: 11, name: "v2", status: "draft", created_at: "2026-11-01T12:00:00.123", author_email: "bo@example.com" },
  ],
  version_details: { id: 10, name: "base" },
};

describe("versions", () => {
  it("resolves by name or id, the default without one", () => {
    expect(resolveVersion(details).id).toBe(10);
    expect(resolveVersion(details, "v2").id).toBe(11);
    expect(resolveVersion(details, "11").name).toBe("v2");
    expect(() => resolveVersion(details, "v9")).toThrow("Versions: base, v2");
  });

  it("marks the default version", () => {
    expect(formatVersions(details)).toEqual([
      "ID  NAME  STATUS     DEFAULT  AUTHOR          CREATED",
      "10  base  published  *        Ada             2026-10-01 09:30",
      "11  v2    draft               bo@example.com  2026-11-01 12:00",
    ]);
  });
});

describe("formatAgentDetails", () => {
  const version: AgentVersion = {
    id: 10,
    name: "base",
    status: "published",
    agent_type: "openai",
    instructions: Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n"),
    llm_settings: { model_name: "gpt-5" },
    tools: [{ name: "jira", type: "jira" }],
    variables: [{ name: "lang", value: "uk" }, { name: "empty", value: "" }],
    conversation_starters: ["Review my PR"],
    welcome_message: "Hi",
  };

  it("shows the configuration with the first 20 lines of instructions", () => {
    const out = formatAgentDetails(details, version, [{ name: "git" }]).join("\n");
    expect(out).toContain("Description:     Reviews code");
    expect(out).toContain("Default version: base (10)");
    expect(out).toContain("Model:           gpt-5");
    expect(out).toContain("Toolkits:        jira (jira)");
    expect(out).toContain("Skills:          git");
    expect(out).toContain("Variables:       lang=uk, empty");
    expect(out).toContain("Starters:        Review my PR");
    expect(out).toContain("  line 20\n  … 5 more lines");
    expect(out).not.toContain("line 21");
  });

  it("shows a pipeline's YAML in full", () => {
    const out = formatAgentDetails({ ...details, agent_type: "pipeline" }, { ...version, agent_type: "pipeline" }, []).join("\n");
    expect(out).toContain("Pipeline YAML:");
    expect(out).toContain("line 25");
    expect(out).toContain("Skills:          (none)");
  });
});

describe("run input and options", () => {
  const read = { file: async (p: string) => (p === "in.txt" ? "from file" : p === "empty.txt" ? "  \n" : Promise.reject(new Error("ENOENT"))), stdin: async () => "from stdin" };

  it("reads the argument, a file or stdin", async () => {
    expect(await readInput("agent", "hello", undefined, read)).toBe("hello");
    expect(await readInput("agent", undefined, "in.txt", read)).toBe("from file");
    expect(await readInput("pipeline", undefined, "-", read)).toBe("from stdin");
  });

  it("refuses missing, empty, unreadable or doubled input with exit 2", async () => {
    await expect(readInput("pipeline", undefined, undefined, read)).rejects.toThrow("Give the pipeline input as an argument or with -f <file>");
    await expect(readInput("agent", undefined, "empty.txt", read)).rejects.toThrow("Input is empty");
    expect(await asyncExitOf(readInput("agent", "", undefined, read))).toBe(EXIT.usage);
    expect(await asyncExitOf(readInput("agent", undefined, "missing.txt", read))).toBe(EXIT.usage);
    expect(await asyncExitOf(readInput("agent", "x", "in.txt", read))).toBe(EXIT.usage);
  });

  it("takes the timeout from the flag, then the config, then 30", () => {
    expect(parseTimeout(undefined, undefined)).toBe(30);
    expect(parseTimeout(undefined, 45)).toBe(45);
    expect(parseTimeout("240", 45)).toBe(240);
    expect(exitOf(() => parseTimeout("0", undefined))).toBe(EXIT.usage);
    expect(exitOf(() => parseTimeout("241", undefined))).toBe(EXIT.usage);
    expect(exitOf(() => parseTimeout(undefined, "soon"))).toBe(EXIT.usage);
  });

  it("merges --var into the version's variables", () => {
    const defined = [{ name: "lang", value: "en" }, { name: "tone" }];
    expect(mergeVariables(defined, undefined)).toBeUndefined();
    expect(mergeVariables(defined, ["lang=uk", "tone=a=b"])).toEqual([
      { name: "lang", value: "uk" },
      { name: "tone", value: "a=b" },
    ]);
    expect(() => mergeVariables(defined, ["nope=1"])).toThrow("Variables: lang, tone");
    expect(exitOf(() => mergeVariables(defined, ["lang"]))).toBe(EXIT.usage);
  });
});

describe("run report", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    out.mockClear();
    err.mockClear();
  });
  const r = (status: RunReport["status"], answer: string | null = null): RunReport => ({
    status,
    answer,
    conversation_id: 7,
    conversation_url: "https://e/app/chat/7",
    agent: { id: 2, name: "Release notes", type: "pipeline" },
    version: { id: 10, name: "base" },
  });

  it.each([
    ["finished", 0, "the answer", undefined],
    ["running", 0, "7", "https://e/app/chat/7"],
    ["failed", 1, undefined, "Node failed\nconversation: https://e/app/chat/7"],
    ["timeout", 8, undefined, "Still running on EliteA: https://e/app/chat/7"],
    ["waiting_for_input", 8, undefined, "Waiting for input on EliteA: https://e/app/chat/7"],
    ["interrupted", 130, undefined, "Stopped waiting; the run continues: https://e/app/chat/7"],
  ] as const)("text %s → exit %i", (status, code, stdout, stderr) => {
    expect(report("text", r(status, status === "finished" ? "the answer" : null), "Node failed")).toBe(code);
    if (stdout) expect(out).toHaveBeenCalledWith(stdout);
    else expect(out).not.toHaveBeenCalled();
    if (stderr) expect(err).toHaveBeenCalledWith(stderr);
  });

  it("prints the JSON report on stdout with the same exit code", () => {
    expect(report("json", r("timeout"))).toBe(8);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual(r("timeout"));
    expect(err).toHaveBeenCalledWith("Still running on EliteA: https://e/app/chat/7");
  });
});
