import { readFile } from "node:fs/promises";
import { AgentChat, conversationUrl, type RunResult } from "../agentChat.js";
import { loadConfig } from "../config.js";
import type { AgentVariable, EliteaAgent } from "../elitea.js";
import { EXIT, usageError } from "../errors.js";
import { readStdin } from "../interaction.js";
import { type OutputFormat, parseFormat, printData, printQuiet } from "../output.js";
import { TIMEOUT_RANGE } from "./settings.js";
import { type ItemKind, isPipeline, resolveAgent, resolveVersion } from "../resolve.js";
import { projectSession, withSpinner } from "./common.js";

export interface RunOptions {
  file?: string;
  agentVersion?: string;
  timeout?: string;
  wait?: boolean; // commander: --no-wait sets false
  var?: string[];
  project?: string;
  output?: string;
}

export { TIMEOUT_RANGE };

/** Minutes: the flag, else ELITEA_CLI_TIMEOUT, else `settings.timeout` in the config, else 30. Out of range exits 2. */
export function parseTimeout(flag: string | undefined, configured: unknown): number {
  const env = process.env.ELITEA_CLI_TIMEOUT || undefined;
  const stored = configured === undefined || configured === null ? undefined : String(configured);
  const raw = flag ?? env ?? stored;
  if (raw === undefined) return TIMEOUT_RANGE.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < TIMEOUT_RANGE.min || n > TIMEOUT_RANGE.max) {
    const source = flag !== undefined ? "--timeout" : env !== undefined ? "ELITEA_CLI_TIMEOUT" : "settings.timeout in the config";
    throw usageError(`${source} must be a whole number of minutes from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}, got "${raw}"`);
  }
  return n;
}

/** The message: the argument, or `-f file` / `-f -` (stdin). */
export async function readInput(
  kind: ItemKind,
  message: string | undefined,
  file: string | undefined,
  read: { file: (p: string) => Promise<string>; stdin: () => Promise<string> } = {
    file: (p) => readFile(p, "utf8"),
    stdin: () => readStdin("-f -"),
  },
): Promise<string> {
  if (message !== undefined && file !== undefined) throw usageError("Give the input as an argument or with -f, not both");
  let text: string;
  if (file !== undefined) {
    try {
      text = file === "-" ? await read.stdin() : await read.file(file);
    } catch (err) {
      throw usageError(`Cannot read ${file}: ${(err as Error).message}`);
    }
  } else if (message !== undefined) {
    text = message;
  } else {
    throw usageError(`Give the ${kind} input as an argument or with -f <file>`);
  }
  if (!text.trim()) throw usageError("Input is empty");
  return text;
}

/** `--var k=v` over the version's variables; the conversation takes the full list. */
export function mergeVariables(defined: AgentVariable[], vars: string[] | undefined): AgentVariable[] | undefined {
  if (!vars?.length) return undefined;
  const merged = defined.map((v) => ({ name: v.name, value: v.value ?? "" }));
  for (const pair of vars) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw usageError(`--var must be key=value, got "${pair}"`);
    const name = pair.slice(0, eq);
    const target = merged.find((v) => v.name === name);
    if (!target) {
      const known = defined.map((v) => v.name);
      throw usageError(`Unknown variable "${name}". ${known.length ? `Variables: ${known.join(", ")}` : "This version has no variables"}`);
    }
    target.value = pair.slice(eq + 1);
  }
  return merged;
}

export type RunStatusOut = RunResult["status"] | "running";

export interface RunReport {
  status: RunStatusOut;
  answer: string | null;
  conversation_id: number;
  conversation_url: string;
  agent: { id: number; name: string; type: string };
  version: { id: number; name: string };
}

const EXIT_BY_STATUS: Record<RunStatusOut, number> = {
  finished: 0,
  running: 0,
  failed: EXIT.general,
  timeout: EXIT.timeout,
  waiting_for_input: EXIT.timeout,
  interrupted: EXIT.interrupted,
};

/** Print the outcome; returns the exit code. Notes for people go to stderr in every format. */
export function report(format: OutputFormat, r: RunReport, error?: string): number {
  const url = r.conversation_url;
  // -q: the conversation id with --no-wait (AC-5); a finished run still prints its answer.
  if (r.status === "running" && printQuiet(r.conversation_id)) return EXIT_BY_STATUS.running;
  if (format === "text") {
    if (r.status === "finished") console.log(r.answer ?? "");
    if (r.status === "running") console.log(String(r.conversation_id));
  } else {
    printData(format, r);
  }
  const note: Record<RunStatusOut, string | undefined> = {
    finished: format === "text" ? `\nconversation: ${r.conversation_id} (${url})` : undefined,
    running: url,
    failed: `${error || "The run failed"}\nconversation: ${url}`,
    timeout: `Still running on EliteA: ${url}`,
    waiting_for_input: `Waiting for input on EliteA: ${url}`,
    interrupted: `Stopped waiting; the run continues: ${url}`,
  };
  if (note[r.status]) console.error(note[r.status]);
  return EXIT_BY_STATUS[r.status];
}

/** `agents run` / `pipelines run`: one message in a new private conversation, for scripts and CI. */
export async function runCommand(kind: ItemKind, query: string, message: string | undefined, opts: RunOptions): Promise<number> {
  const format = parseFormat(opts, true);
  const timeoutMin = parseTimeout(opts.timeout, (await loadConfig()).settings.timeout);
  const text = await readInput(kind, message, opts.file);

  const { client, projectId, baseUrl } = await projectSession(opts.project);
  const { agent } = await resolveAgent(client, projectId, query, kind, `elitea-cli ${kind}s run <${kind}> "<input>"`);
  const details = await client.getAgent(projectId, agent.id);
  const version = resolveVersion(details, opts.agentVersion);
  let variables: AgentVariable[] | undefined;
  if (opts.var?.length) {
    const full = await client.getVersion(projectId, agent.id, version.id);
    variables = mergeVariables(full.variables ?? [], opts.var);
  }

  const chat = new AgentChat(client, projectId, {
    agentId: agent.id,
    agentName: agent.name,
    // The default version is what EliteA uses anyway; passing it pins the run to what we report.
    versionId: version.id,
    variables,
  });
  const run = await chat.start(text);
  const base = (status: RunStatusOut, answer: string | null): RunReport => ({
    status,
    answer,
    conversation_id: run.conversationId,
    conversation_url: conversationUrl(baseUrl, run.conversationId),
    agent: { id: agent.id, name: agent.name, type: typeLabel(agent) },
    version: { id: version.id, name: version.name },
  });
  if (opts.wait === false) return report(format, base("running", null));

  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);
  let result: RunResult;
  try {
    result = await withSpinner(`${agent.name} is working…`, chat.waitFor(run, { timeoutMs: timeoutMin * 60_000, signal: abort.signal }));
  } finally {
    process.off("SIGINT", onSigint);
  }
  const answer = result.status === "finished" ? result.answer : result.status === "failed" ? (result.error ?? result.answer) : null;
  return report(format, base(result.status, answer), result.error);
}

/** The platform agent_type (openai, pipeline, …), as in `agents list`. */
function typeLabel(agent: EliteaAgent): string {
  return agent.agent_type ?? (isPipeline(agent) ? "pipeline" : "");
}

