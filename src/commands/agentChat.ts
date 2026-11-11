import { input, search } from "@inquirer/prompts";
import { AgentChat } from "../agentChat.js";
import type { EliteaAgent, EliteaClient } from "../elitea.js";
import { isInteractive, requireSession } from "../session.js";
import { chooseProject } from "./project.js";

export interface AgentChatCommandOptions {
  agentVersion?: string;
  conversation?: string;
  project?: string;
  json?: boolean;
}

/** Match by id, then exact name, then case-insensitive name; a unique substring match also counts. */
export function findAgent(agents: EliteaAgent[], query: string): EliteaAgent | undefined {
  const q = query.trim().toLowerCase();
  const exact =
    agents.find((a) => String(a.id) === query.trim()) ??
    agents.find((a) => a.name === query) ??
    agents.find((a) => a.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = agents.filter((a) => a.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

async function pickAgent(agents: EliteaAgent[]): Promise<EliteaAgent> {
  return search<EliteaAgent>({
    message: "Agent",
    pageSize: 12,
    source: (term) => {
      const t = (term ?? "").toLowerCase();
      return agents
        .filter((a) => !t || a.name.toLowerCase().includes(t) || String(a.id) === t)
        .map((a) => ({ name: `${a.name}  (${a.id})`, value: a, description: a.description ?? undefined }));
    },
  });
}

async function resolveAgent(agents: EliteaAgent[], query: string | undefined, projectId: number): Promise<EliteaAgent> {
  if (agents.length === 0) throw new Error(`No agents in project ${projectId}`);
  if (query === undefined) {
    if (!isInteractive()) throw new Error("Name the agent: elitea-cli agents chat <agent> \"<message>\"");
    return pickAgent(agents);
  }
  const agent = findAgent(agents, query);
  if (agent) return agent;
  const close = agents.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));
  const hint = close.length > 1 ? `matches several: ${close.map((a) => `${a.name} (${a.id})`).join(", ")}` : "not found";
  throw new Error(`Agent "${query}" ${hint} — run \`elitea-cli agents\``);
}

async function resolveVersion(client: EliteaClient, projectId: number, agent: EliteaAgent, version?: string): Promise<number | undefined> {
  if (version === undefined) return undefined;
  const details = await client.getAgent(projectId, agent.id);
  const match = details.versions.find((v) => v.name === version || String(v.id) === version);
  if (!match) {
    throw new Error(`Agent "${agent.name}" has no version "${version}". Versions: ${details.versions.map((v) => v.name).join(", ")}`);
  }
  return match.id;
}

function parseConversation(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`--conversation must be a numeric conversation id, got "${value}"`);
  return id;
}

/** Minimal stderr spinner; nothing is drawn when stderr is not a terminal. */
async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return work;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label} ${seconds}s`);
  }, 100);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K");
  }
}

const HELP = `Commands:
  /new     start a new conversation with the same agent
  /agent   switch to another agent (new conversation)
  /help    show this help
  /exit    quit (or Ctrl-C)`;

async function repl(chat: AgentChat, agent: EliteaAgent, agents: EliteaAgent[], makeChat: (a: EliteaAgent) => AgentChat): Promise<void> {
  console.error(`Chatting with ${agent.name} (${agent.id}). Type /help for commands.`);
  for (;;) {
    const text = (await input({ message: ">", theme: { prefix: "" } })).trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") return;
    if (text === "/help") {
      console.error(HELP);
      continue;
    }
    if (text === "/new") {
      chat.reset();
      console.error("Started a new conversation.");
      continue;
    }
    if (text === "/agent") {
      agent = await pickAgent(agents);
      chat = makeChat(agent);
      console.error(`Chatting with ${agent.name} (${agent.id}).`);
      continue;
    }
    try {
      const reply = await withSpinner(`${agent.name} is thinking…`, chat.send(text));
      console.log(`\n${reply.answer || "(empty answer)"}\n`);
    } catch (err) {
      // Keep the session alive; auth errors still end it.
      if ((err as Error).name === "AuthError") throw err;
      console.error(`error: ${(err as Error).message}`);
    }
  }
}

export async function agentChatCommand(
  agentQuery: string | undefined,
  message: string | undefined,
  opts: AgentChatCommandOptions,
): Promise<void> {
  const { client, projectId: activeProjectId } = await requireSession();
  const projectId =
    opts.project === undefined ? activeProjectId : (await chooseProject(client, await client.getUser(), { requested: opts.project })).id;
  const agents = await client.listAgents(projectId);
  const agent = await resolveAgent(agents, agentQuery, projectId);
  const versionId = await resolveVersion(client, projectId, agent, opts.agentVersion);
  const conversation = parseConversation(opts.conversation);
  const makeChat = (a: EliteaAgent, conv?: number) =>
    new AgentChat(client, projectId, { agentId: a.id, agentName: a.name, versionId: a === agent ? versionId : undefined, conversation: conv });
  const chat = makeChat(agent, conversation);

  if (message !== undefined) {
    const reply = await withSpinner(`${agent.name} is thinking…`, chat.send(message));
    if (opts.json) {
      console.log(JSON.stringify({ answer: reply.answer, conversation_id: reply.conversationId, agent: { id: agent.id, name: agent.name } }, null, 2));
    } else {
      console.log(reply.answer);
      console.error(`\nconversation: ${reply.conversationId} (continue with --conversation ${reply.conversationId})`);
    }
    return;
  }

  if (!isInteractive()) throw new Error("No message given and not running in a terminal");
  await repl(chat, agent, agents, (a) => makeChat(a));
  if (chat.conversationUrl) console.error(`Conversation saved in EliteA: ${chat.conversationUrl}`);
}
