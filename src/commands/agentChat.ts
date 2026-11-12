import { input } from "@inquirer/prompts";
import { AgentChat } from "../agentChat.js";
import type { EliteaAgent } from "../elitea.js";
import { usageError } from "../errors.js";
import { pickAgent, resolveAgent, resolveVersion } from "../resolve.js";
import { isInteractive } from "../session.js";
import { projectSession, withSpinner } from "./common.js";

export { findAgent } from "../resolve.js";

export interface AgentChatCommandOptions {
  agentVersion?: string;
  conversation?: string;
  project?: string;
  json?: boolean;
}

function parseConversation(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw usageError(`--conversation must be a numeric conversation id, got "${value}"`);
  return id;
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
  const { client, projectId } = await projectSession(opts.project);
  const { agent, agents } = await resolveAgent(client, projectId, agentQuery, "agent", 'elitea-cli agents chat <agent> "<message>"');
  const versionId = opts.agentVersion === undefined ? undefined : resolveVersion(await client.getAgent(projectId, agent.id), opts.agentVersion).id;
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

  if (!isInteractive()) throw usageError("No message given and not running in a terminal");
  await repl(chat, agent, agents, (a) => makeChat(a));
  if (chat.conversationUrl) console.error(`Conversation saved in EliteA: ${chat.conversationUrl}`);
}
