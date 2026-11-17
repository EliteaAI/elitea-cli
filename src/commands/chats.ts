import { confirm } from "@inquirer/prompts";
import { AgentChat, conversationUrl, groupText, type RunResult } from "../agentChat.js";
import { loadConfig } from "../config.js";
import { ctx } from "../context.js";
import {
  type AgentConversation,
  type ConversationParticipant,
  type ConversationRow,
  type EliteaClient,
  EliteaError,
  type MessageGroup,
} from "../elitea.js";
import { CliError, EXIT, exitCodeOf, notFoundError, usageError } from "../errors.js";
import { parseFormat, printData, printQuiet, render } from "../output.js";
import { isInteractive } from "../session.js";
import { parseLimit } from "./agents.js";
import { projectSession, withSpinner } from "./common.js";
import { type RunReport, type RunStatusOut, parseTimeout, readInput, report } from "./run.js";

export interface ChatOptions {
  search?: string;
  limit?: string;
  last?: string;
  all?: boolean;
  file?: string;
  to?: string;
  timeout?: string;
  wait?: boolean; // commander: --no-wait sets false
  yes?: boolean;
  project?: string;
  output?: string;
  json?: boolean;
}

/** `chats list` rows by default: each row costs one more request for its agents' names. */
export const DEFAULT_LIST_LIMIT = 20;
/** `chats show` messages by default. */
export const DEFAULT_LAST = 20;
const PAGE = 100;

// ---------------------------------------------------------------------------------------------
// Ids, dates, names
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The numeric chat id; the messages API fails with a uuid, so a uuid is refused before any request. */
export function parseChatId(value: string): number {
  if (UUID_RE.test(value.trim())) throw usageError("Use the numeric chat id (see elitea-cli chats list)");
  const id = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(id) || id <= 0) {
    throw usageError(`A chat id is a number (see elitea-cli chats list), got "${value}"`);
  }
  return id;
}

/**
 * EliteA dates: list rows say `2026-11-16T12:44:00+00:00Z` (offset and Z), message groups
 * `2026-11-13T09:33:06.737438` (naive UTC). Both are UTC.
 */
export function parseUtc(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  let s = value.trim().replace(" ", "T");
  if (/[+-]\d\d:?\d\dZ$/.test(s)) s = s.slice(0, -1);
  else if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `YYYY-MM-DD HH:MM` in the local time zone. */
export function localTime(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The same instant as ISO UTC (`…Z`), for JSON/YAML. */
const isoUtc = (value: string | null | undefined) => parseUtc(value)?.toISOString() ?? value ?? null;

/** Who wrote a message group: the participant's display name. */
export function participantName(p: ConversationParticipant | undefined, id: number): string {
  if (!p) return `participant ${id}`;
  const name = p.meta?.user_name ?? p.meta?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (p.entity_name === "dummy") return "EliteA";
  return p.entity_name === "user" ? `user ${p.entity_meta?.id ?? id}` : `${p.entity_name} ${p.entity_meta?.id ?? id}`;
}

/** Agent (and pipeline) participants: the ones that can answer a message. */
export const chatAgents = (c: AgentConversation) => c.participants.filter((p) => p.entity_name === "application");

// The server's rule for "running" (elitea_core utils/running_conversations.py, EL-7385): a
// streaming reply whose run was dispatched or may still be starting, and is not older than any run.
const NOT_STARTED_GRACE_MS = 5 * 60_000;
const RUN_MAX_AGE_MS = 24 * 3_600_000;

export function isLiveRun(g: MessageGroup, now = Date.now()): boolean {
  if (!g.is_streaming) return false;
  const created = parseUtc(g.created_at)?.getTime();
  if (created === undefined) return Boolean(g.task_id);
  if (created <= now - RUN_MAX_AGE_MS) return false;
  return Boolean(g.task_id) || created > now - NOT_STARTED_GRACE_MS;
}

/** A reply in the chat is still being written. The newest groups are enough: a run is the last reply. */
async function chatRunning(client: EliteaClient, projectId: number, chatId: number): Promise<boolean> {
  return (await client.recentMessages(projectId, chatId, 3)).some((g) => isLiveRun(g));
}

/** The chat, or "Chat not found" (exit 5): EliteA answers 400 for an unknown, foreign or hidden id. */
async function findChat(client: EliteaClient, projectId: number, chatId: number): Promise<AgentConversation> {
  try {
    return await client.getConversation(projectId, chatId);
  } catch (err) {
    throw notFound(err);
  }
}

function notFound(err: unknown): unknown {
  if (err instanceof EliteaError && (err.status === 404 || (err.status === 400 && /no such conversation|not found/i.test(err.message)))) {
    return notFoundError("Chat not found");
  }
  return err;
}

/** Run `work` on every item, at most `width` at a time, keeping the order. */
async function mapLimited<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

export interface ChatSummary {
  id: number;
  uuid: string;
  name: string;
  agents: Array<{ id?: number; name: string; project_id?: number }>;
  created_at: string | null;
  updated_at: string | null;
  running: boolean;
  private: boolean;
  author_id: number;
  messages?: number;
}

function summary(row: ConversationRow, details: AgentConversation | undefined): ChatSummary {
  return {
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    agents: details
      ? chatAgents(details).map((p) => ({ id: p.entity_meta?.id, name: participantName(p, p.id), project_id: p.entity_meta?.project_id }))
      : [],
    created_at: isoUtc(row.created_at),
    updated_at: isoUtc(row.updated_at ?? row.created_at),
    running: Boolean(row.has_running_task),
    private: row.is_private,
    author_id: row.author_id,
    messages: row.message_groups_count,
  };
}

/** `chats list` (AC-1, AC-2): the chat list of the web UI, most recently updated first. */
export async function listCommand(opts: ChatOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const limit = parseLimit(opts.limit) ?? DEFAULT_LIST_LIMIT;
  const { client, projectId } = await projectSession(opts.project);
  const { total, rows } = await client.listConversations(projectId, { query: opts.search, limit });
  // The list rows only count participants; their names come with each chat.
  const details = await mapLimited(rows, 8, (r) => client.getConversation(projectId, r.id).catch(() => undefined));
  const chats = rows.map((r, i) => summary(r, details[i]));
  render(
    chats,
    [
      { header: "ID", value: (c) => c.id },
      { header: "NAME", value: (c) => c.name },
      { header: "PARTICIPANTS", value: (c) => c.agents.map((a) => a.name).join(", ") },
      { header: "UPDATED", value: (c) => localTime(c.updated_at) },
      { header: "RUNNING", value: (c) => (c.running ? "yes" : "") },
    ],
    format,
    "chats",
  );
  if (format === "text" && total > chats.length && chats.length > 0) {
    console.error(`Showing ${chats.length} of ${total}; use --limit or --search for more`);
  }
}

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

export interface ChatMessage {
  id: number;
  author: string;
  author_type: string;
  created_at: string | null;
  text: string;
  is_streaming: boolean;
  error?: string;
  /** Text view only: a streaming reply whose run died (stuck row) is not "still running". */
  live?: boolean;
}

/** The newest `last` message groups (all with `undefined`), oldest first. */
async function readMessages(client: EliteaClient, projectId: number, chatId: number, last: number | undefined): Promise<MessageGroup[]> {
  const groups: MessageGroup[] = [];
  for (;;) {
    const want = last === undefined ? PAGE : Math.min(PAGE, last - groups.length);
    if (want <= 0) break;
    const page = await client.listMessages(projectId, chatId, { limit: want, offset: groups.length });
    groups.push(...page.rows);
    if (page.rows.length === 0 || groups.length >= page.total) break;
  }
  return groups.reverse();
}

function toMessage(g: MessageGroup, byId: Map<number, ConversationParticipant>): ChatMessage {
  const p = byId.get(g.author_participant_id);
  const error = g.meta?.is_error && typeof g.meta.error === "string" && g.meta.error.trim() ? g.meta.error.trim() : undefined;
  return {
    id: g.id,
    author: participantName(p, g.author_participant_id),
    author_type: p?.entity_name ?? "unknown",
    created_at: isoUtc(g.created_at),
    text: groupText(g),
    is_streaming: g.is_streaming,
    ...(error ? { error } : {}),
  };
}

export function formatMessages(messages: ChatMessage[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (lines.length) lines.push("");
    const state = !m.is_streaming ? "" : m.live === false ? " (never finished)" : " (still running)";
    lines.push(`${m.author} (${localTime(m.created_at)}):${state}`);
    if (m.text) lines.push(m.text);
    // A traceback's last line is its message; the full error is in -o json.
    const error = m.error?.trim().split("\n").pop()?.trim();
    if (error && !m.text.includes(error.replace(/^[\w.]+(Error|Exception): /, ""))) lines.push(`error: ${error}`);
  }
  return lines;
}

/** `chats show <id>` (AC-3…AC-5): the messages, oldest first, full text. */
export async function showCommand(id: string, opts: ChatOptions): Promise<void> {
  const chatId = parseChatId(id);
  const format = parseFormat(opts, true);
  if (opts.all && opts.last !== undefined) throw usageError("Use --last or --all, not both");
  const last = opts.all ? undefined : (parseLimit(opts.last, "--last") ?? DEFAULT_LAST);
  const { client, projectId } = await projectSession(opts.project);
  // The messages API answers an unknown id with an empty page; the chat itself says "not found".
  const chat = await findChat(client, projectId, chatId);
  const byId = new Map(chat.participants.map((p) => [p.id, p]));
  const groups = await readMessages(client, projectId, chatId, last);
  const messages = groups.map((g) => toMessage(g, byId));
  if (format !== "text") {
    printData(format, messages);
    return;
  }
  groups.forEach((g, i) => (messages[i]!.live = isLiveRun(g)));
  if (messages.length === 0) {
    console.error("No messages in this chat");
    return;
  }
  for (const line of formatMessages(messages)) console.log(line);
}

// ---------------------------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------------------------

/** The agent participant that answers: the only one, or the one `--to` names (id or name). */
export function pickRecipient(chat: AgentConversation, to: string | undefined): ConversationParticipant {
  const agents = chatAgents(chat);
  if (agents.length === 0) throw usageError("Chat has no agent to answer");
  const names = agents.map((p) => participantName(p, p.id));
  if (to === undefined) {
    if (agents.length === 1) return agents[0]!;
    throw usageError(`Chat has several agents: ${names.join(", ")} — pass --to <agent>`);
  }
  const wanted = to.trim();
  const byId = agents.filter((p) => String(p.entity_meta?.id) === wanted);
  const byName = byId.length ? byId : agents.filter((p) => participantName(p, p.id) === wanted);
  const matches = byName.length ? byName : agents.filter((p) => participantName(p, p.id).toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw usageError(`"${to}" matches several agents in this chat; pass --to <agent id>: ${agents.map((p) => `${participantName(p, p.id)} (${p.entity_meta?.id})`).join(", ")}`);
  throw notFoundError(`No agent "${to}" in this chat; its agents: ${names.join(", ")}`);
}

/** `chats send <id>` (AC-6…AC-7a): `agents run` on an existing chat — same input, output and exit codes. */
export async function sendCommand(id: string, message: string | undefined, opts: ChatOptions): Promise<number> {
  const chatId = parseChatId(id);
  const format = parseFormat(opts, true);
  const timeoutMin = parseTimeout(opts.timeout, (await loadConfig()).settings.timeout);
  const text = await readInput("agent", message, opts.file);

  const { client, projectId, baseUrl } = await projectSession(opts.project);
  const chat = await findChat(client, projectId, chatId);
  const recipient = pickRecipient(chat, opts.to);
  if (await chatRunning(client, projectId, chatId)) {
    throw new CliError(`Chat is still running; wait for it or check elitea-cli chats show ${chatId}`, EXIT.conflict);
  }

  // The agent may live in another project (public agents): read it there. A deleted agent fails here.
  const agentId = recipient.entity_meta?.id;
  if (agentId === undefined) throw new CliError(`The agent of participant ${recipient.id} has no id`, EXIT.general);
  const details = await client.getAgent(recipient.entity_meta?.project_id ?? projectId, agentId);
  const versionId = recipient.entity_settings?.version_id ?? details.version_details?.id;
  const version = details.versions.find((v) => v.id === versionId) ?? details.version_details ?? { id: versionId ?? 0, name: "" };
  const agentType = recipient.entity_settings?.agent_type ?? details.version_details?.agent_type ?? details.agent_type ?? "";

  const run = new AgentChat(client, projectId, { agentId, agentName: details.name, conversation: chatId, loaded: chat, participantId: recipient.id });
  const started = await run.start(text);
  const base = (status: RunStatusOut, answer: string | null): RunReport => ({
    status,
    answer,
    conversation_id: started.conversationId,
    conversation_url: conversationUrl(baseUrl, started.conversationId),
    agent: { id: agentId, name: details.name, type: agentType },
    version: { id: version.id, name: version.name },
  });
  if (opts.wait === false) return report(format, base("running", null));

  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);
  let result: RunResult;
  try {
    result = await withSpinner(`${details.name} is working…`, run.waitFor(started, { timeoutMs: timeoutMin * 60_000, signal: abort.signal }));
  } finally {
    process.off("SIGINT", onSigint);
  }
  const answer = result.status === "finished" ? result.answer : result.status === "failed" ? (result.error ?? result.answer) : null;
  return report(format, base(result.status, answer), result.error);
}

// ---------------------------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------------------------

interface Target {
  id: number;
  chat?: AgentConversation;
  running?: boolean;
  error?: unknown;
}

const SCRIPT_FILES = "Files created by skill scripts";

/** The question of AC-8 / AC-9 / AC-10. */
export function deleteQuestion(targets: Array<{ id: number; name: string; running: boolean }>): { lines: string[]; question: string } {
  if (targets.length === 1) {
    const t = targets[0]!;
    return t.running
      ? { lines: [], question: `Chat '${t.name}' (${t.id}) is still running. Delete it anyway? ${SCRIPT_FILES} are deleted too.` }
      : { lines: [], question: `Delete chat '${t.name}' (${t.id})? ${SCRIPT_FILES} in it are deleted too.` };
  }
  const lines = targets.map((t) => `  ${t.name} (${t.id})${t.running ? " — still running" : ""}`);
  const running = targets.filter((t) => t.running).length;
  const anyway = running ? ` ${running === 1 ? "One is" : `${running} are`} still running.` : "";
  return { lines, question: `Delete these ${targets.length} chats?${anyway} ${SCRIPT_FILES} in them are deleted too.` };
}

/** `chats delete <id>…` (AC-8…AC-10): one question for all, then each deleted; one failure does not stop the others. */
export async function deleteCommand(ids: string[], opts: ChatOptions): Promise<number> {
  const chatIds = [...new Set(ids.map(parseChatId))];
  const { client, projectId } = await projectSession(opts.project);

  const targets: Target[] = await mapLimited(chatIds, 4, async (id): Promise<Target> => {
    try {
      const chat = await findChat(client, projectId, id);
      return { id, chat, running: await chatRunning(client, projectId, id) };
    } catch (err) {
      return { id, error: err };
    }
  });
  const found = targets.filter((t) => t.chat);
  const batch = chatIds.length > 1;
  // A single id that cannot be read fails as itself; a batch reports it in the summary.
  if (!batch && targets[0]!.error) throw targets[0]!.error;

  if (found.length && !(opts.yes || ctx.yes)) {
    const { lines, question } = deleteQuestion(found.map((t) => ({ id: t.id, name: t.chat!.name, running: Boolean(t.running) })));
    if (!isInteractive()) {
      const what = batch ? `${found.length} chats` : `chat '${found[0]!.chat!.name}'`;
      throw new CliError(`Refusing to delete ${what} without --yes in a non-interactive shell`, EXIT.usage);
    }
    for (const line of lines) console.error(line);
    if (!(await confirm({ message: question, default: false }))) return EXIT.ok;
  }

  for (const t of found) {
    try {
      await client.deleteConversation(projectId, t.id);
    } catch (err) {
      t.error = notFound(err);
    }
  }
  const deleted = found.filter((t) => !t.error);
  const failed = targets.filter((t) => t.error);

  if (!batch) {
    if (failed.length) throw failed[0]!.error;
    const t = deleted[0]!;
    if (!printQuiet(t.id)) console.log(`Deleted chat '${t.chat!.name}' (${t.id})`);
    return EXIT.ok;
  }
  if (ctx.quiet) {
    for (const t of deleted) console.log(String(t.id));
  } else {
    console.log(`Deleted: ${deleted.map((t) => t.id).join(", ") || "none"}`);
  }
  if (failed.length) {
    const reason = (err: unknown) => ((err as Error).message ?? String(err)).split("\n")[0];
    console.error(`Failed: ${failed.map((t) => `${t.id} (${reason(t.error)})`).join(", ")}`);
    return exitCodeOf(failed[0]!.error);
  }
  return EXIT.ok;
}
