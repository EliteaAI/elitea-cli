import type { AgentConversation, EliteaClient, MessageGroup } from "./elitea.js";

export interface AgentReply {
  answer: string;
  conversationId: number;
}

export interface AgentChatOptions {
  agentId: number;
  agentName: string;
  versionId?: number;
  /** Continue an existing conversation (its numeric id). */
  conversation?: number;
  pollIntervalMs?: number;
  /** Give up waiting after this long; the run keeps going on EliteA. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** EliteA conversation names are 3–50 characters. */
export function conversationName(agentName: string, firstMessage: string): string {
  const name = `${agentName}: ${firstMessage.replace(/\s+/g, " ").trim()}`;
  return name.length > 50 ? `${name.slice(0, 49)}…` : name.padEnd(3, ".");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function groupText(group: MessageGroup): string {
  return group.message_items
    .map((item) => item.item_details?.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join("\n\n");
}

/**
 * Multi-turn chat with one EliteA agent through the conversation API.
 *
 * Messages are sent in background mode and the reply is polled: with a blocking
 * `await_task_timeout`, EliteA cancels the run when the timeout expires.
 */
export class AgentChat {
  private conversation?: AgentConversation;
  private participantId?: number;

  constructor(
    private readonly client: EliteaClient,
    private readonly projectId: number,
    private readonly opts: AgentChatOptions,
  ) {}

  get conversationId(): number | undefined {
    return this.conversation?.id;
  }

  get conversationUrl(): string | undefined {
    return this.conversation && `${this.client.baseUrl}/app/chat/${this.conversation.id}`;
  }

  /** Forget the conversation; the next message starts a new one. */
  reset(): void {
    this.conversation = undefined;
    this.participantId = undefined;
    this.opts.conversation = undefined;
  }

  async send(text: string): Promise<AgentReply> {
    await this.ensureConversation(text);
    const conversation = this.conversation!;
    const { response_message_group_id: replyId } = await this.client.sendMessage(
      this.projectId,
      conversation.uuid,
      this.participantId!,
      text,
    );

    const interval = this.opts.pollIntervalMs ?? 1000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 30 * 60_000);
    const wait = this.opts.sleep ?? sleep;
    for (;;) {
      await wait(interval);
      const reply = (await this.client.recentMessages(this.projectId, conversation.id)).find((g) => g.id === replyId);
      if (reply && !reply.is_streaming) {
        return { answer: groupText(reply), conversationId: conversation.id };
      }
      if (Date.now() > deadline) {
        throw new Error(`The agent is still working; check the conversation in EliteA: ${this.conversationUrl}`);
      }
    }
  }

  private async ensureConversation(firstMessage: string): Promise<void> {
    if (this.conversation) return;
    const { agentId, agentName, versionId } = this.opts;
    if (this.opts.conversation) {
      this.conversation = await this.client.getConversation(this.projectId, this.opts.conversation);
    } else {
      this.conversation = await this.client.createConversation(this.projectId, {
        name: conversationName(agentName, firstMessage),
        agentId,
        versionId,
      });
    }
    const participant = this.conversation.participants.find(
      (p) => p.entity_name === "application" && p.entity_meta?.id === agentId,
    );
    if (!participant) {
      throw new Error(`Conversation ${this.conversation.id} does not include agent "${agentName}" (id ${agentId})`);
    }
    this.participantId = participant.id;
  }
}
