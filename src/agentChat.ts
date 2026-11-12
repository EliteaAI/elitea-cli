import type { AgentConversation, AgentVariable, EliteaClient, MessageGroup } from "./elitea.js";

export interface AgentReply {
  answer: string;
  conversationId: number;
}

/**
 * How a run ended for the CLI. `timeout`, `waiting_for_input` and `interrupted` only mean the
 * CLI stopped waiting: the run goes on on EliteA.
 */
export type RunStatus = "finished" | "failed" | "waiting_for_input" | "timeout" | "interrupted";

export interface RunResult {
  status: RunStatus;
  /** Reply text (finished, and failed when the platform put the failure in the answer). */
  answer: string;
  /** Failure text (failed only). */
  error?: string;
}

export interface StartedRun {
  conversationId: number;
  replyId: number;
}

export interface AgentChatOptions {
  agentId: number;
  agentName: string;
  versionId?: number;
  /** Full variable list for a new conversation (replaces the version's defaults). */
  variables?: AgentVariable[];
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

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function groupText(group: MessageGroup): string {
  return group.message_items
    .map((item) => item.item_details?.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join("\n\n");
}

/** A failed model call that the SDK returned as the answer text (the server checks the same, utils/error_text.py). */
const PROVIDER_ERROR_ANSWER = /^Error: (?:Error code: [45]\d\d\b|LLM stream (?:stalled|interrupted)\b)/;

/** Classify a reply group that is no longer streaming. */
export function replyOutcome(group: MessageGroup): RunResult {
  const answer = groupText(group);
  const meta = group.meta ?? {};
  const pendingInterrupts =
    (Array.isArray(meta.hitl_interrupts) && meta.hitl_interrupts.length > 0) ||
    (meta.hitl_interrupt !== undefined && meta.hitl_interrupt !== null) ||
    (Array.isArray(meta.authorization_requests) && meta.authorization_requests.length > 0);
  if (pendingInterrupts) return { status: "waiting_for_input", answer };
  if (meta.is_error || PROVIDER_ERROR_ANSWER.test(answer.trimStart())) {
    const error = (typeof meta.error === "string" && meta.error.trim()) || answer || "The run failed";
    return { status: "failed", answer, error };
  }
  return { status: "finished", answer };
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
    return this.conversation && conversationUrl(this.client.baseUrl, this.conversation.id);
  }

  /** Forget the conversation; the next message starts a new one. */
  reset(): void {
    this.conversation = undefined;
    this.participantId = undefined;
    this.opts.conversation = undefined;
  }

  /** Send `text`; resolves once EliteA accepted it (the reply is still being written). */
  async start(text: string): Promise<StartedRun> {
    await this.ensureConversation(text);
    const conversation = this.conversation!;
    const { response_message_group_id: replyId } = await this.client.sendMessage(
      this.projectId,
      conversation.uuid,
      this.participantId!,
      text,
    );
    return { conversationId: conversation.id, replyId };
  }

  /** Poll until the reply is done, the timeout passes, or `signal` aborts. */
  async waitFor(run: StartedRun, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const interval = this.opts.pollIntervalMs ?? 1000;
    const deadline = Date.now() + (opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const wait = this.opts.sleep ?? sleep;
    for (;;) {
      if (opts.signal?.aborted) return { status: "interrupted", answer: "" };
      await abortable(wait(interval), opts.signal);
      if (opts.signal?.aborted) return { status: "interrupted", answer: "" };
      const reply = (await this.client.recentMessages(this.projectId, run.conversationId)).find((g) => g.id === run.replyId);
      if (reply && !reply.is_streaming) return replyOutcome(reply);
      if (Date.now() > deadline) return { status: "timeout", answer: "" };
    }
  }

  /** One message, one answer (agents chat). Stopping early is an error; a failed run returns its text. */
  async send(text: string): Promise<AgentReply> {
    const run = await this.start(text);
    const result = await this.waitFor(run);
    if (result.status === "timeout") {
      throw new Error(`The agent is still working; check the conversation in EliteA: ${this.conversationUrl}`);
    }
    if (result.status === "waiting_for_input") {
      throw new Error(`The agent is waiting for your input; answer it in EliteA: ${this.conversationUrl}`);
    }
    return { answer: result.answer || result.error || "", conversationId: run.conversationId };
  }

  private async ensureConversation(firstMessage: string): Promise<void> {
    if (this.conversation) return;
    const { agentId, agentName, versionId, variables } = this.opts;
    if (this.opts.conversation) {
      this.conversation = await this.client.getConversation(this.projectId, this.opts.conversation);
    } else {
      this.conversation = await this.client.createConversation(this.projectId, {
        name: conversationName(agentName, firstMessage),
        agentId,
        versionId,
        variables,
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

export function conversationUrl(baseUrl: string, conversationId: number): string {
  return `${baseUrl}/app/chat/${conversationId}`;
}

/** Resolve early when `signal` aborts. */
function abortable(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
