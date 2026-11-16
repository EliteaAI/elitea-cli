import { parseDocument as parseYaml } from "yaml";
import { colorEnabled } from "./context.js";
import { type AgentVersion, EliteaError, type PipelineIssue, type PipelineValidation } from "./elitea.js";
import { CliError, EXIT, usageError } from "./errors.js";
import type { ItemKind } from "./resolve.js";

/**
 * Pure helpers of story 04 (create/update/edit/version/delete from files): reading the files,
 * building request bodies in the platform's own shape, diffs and platform refusals.
 */

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** First YAML/JSON error as "line <n>: <reason>". */
function yamlError(text: string): string | undefined {
  const doc = parseYaml(text);
  const err = doc.errors[0];
  if (!err) return undefined;
  const reason = err.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
  const line = err.linePos?.[0]?.line;
  return line === undefined ? reason : `line ${line}: ${reason}`;
}

/**
 * A JSON or YAML file holding one object (AC-5). YAML is the same structure as the JSON
 * (PO decision 2026-11-11). Anything else exits 2 before a request is sent.
 */
export function parseDocument(text: string, source: string): Doc {
  if (!text.trim()) throw usageError(`${source}: empty file`);
  let value: unknown;
  let parsed = false;
  if (/^\s*[{[]/.test(text)) {
    try {
      value = JSON.parse(text);
      parsed = true;
    } catch {
      // Flow-style YAML ({a: 1}) is not JSON; YAML gets the second try and reports the position.
    }
  }
  if (!parsed) {
    const problem = yamlError(text);
    if (problem) throw usageError(`${source}: not valid JSON or YAML (${problem})`);
    value = parseYaml(text).toJS();
  }
  if (!isObject(value)) throw usageError(`${source}: expected an object of fields, got ${Array.isArray(value) ? "a list" : typeof value}`);
  return value;
}

/** Pipeline YAML (sent as text, unchanged): it must parse to an object. */
export function checkPipelineYaml(text: string, source: string): void {
  if (!text.trim()) throw usageError(`${source}: empty file`);
  const problem = yamlError(text);
  if (problem) throw usageError(`${source}: not valid YAML (${problem})`);
  const value: unknown = parseYaml(text).toJS();
  if (!isObject(value)) throw usageError(`${source}: a pipeline YAML must be a mapping (nodes, entry_point, …)`);
}

/** Fields of a version that a create file may give at the top level (AC-2). */
export const VERSION_FIELDS = [
  "instructions",
  "llm_settings",
  "agent_type",
  "tools",
  "variables",
  "conversation_starters",
  "welcome_message",
  "tags",
  "pipeline_settings",
  "notes",
] as const;

/**
 * The create body (AC-1, AC-2): the file as is, or, without `versions`, one version built from the
 * top-level version fields. Nothing is added except a missing version name (`base`) and
 * `agent_type: pipeline` for `pipelines create`.
 */
export function createBody(doc: Doc, kind: ItemKind): Doc {
  const body = structuredClone(doc);
  if (body.versions === undefined) {
    const version: Doc = {};
    for (const key of VERSION_FIELDS) {
      if (key in body) {
        version[key] = body[key];
        delete body[key];
      }
    }
    body.versions = [version];
  }
  if (Array.isArray(body.versions)) {
    for (const v of body.versions) {
      // The platform's model defaults the name to base but drops unset fields: no name → HTTP 500.
      if (isObject(v) && v.name === undefined) v.name = "base";
    }
  }
  if (kind === "pipeline" && Array.isArray(body.versions)) {
    for (const v of body.versions) {
      if (!isObject(v)) continue;
      // Without agent_type the platform creates a classic agent (its default is openai).
      if (v.agent_type === undefined) v.agent_type = "pipeline";
      else if (v.agent_type !== "pipeline") {
        throw usageError(`The file has agent_type "${String(v.agent_type)}": pipelines create makes pipelines — use \`elitea-cli agents create\``);
      }
    }
  }
  return body;
}

/** Set by the server (or added by `get -o json`); removed from a file before it is sent (AC-8). */
export const SERVER_FIELDS = [
  "id",
  "application_id",
  "author",
  "author_id",
  "author_name",
  "author_email",
  "created_at",
  "updated_at",
  "status",
  "instructions_sha256",
  "cli",
  "shared_id",
  "shared_owner_id",
  "is_forked",
  "icon_meta",
  "project_id",
  "owner_id",
  "user_id",
  "mcp_backup_version",
] as const;

/** A version (or a version file) without the server-set fields and without `tools`. */
export function editableView(version: Doc): Doc {
  const view = structuredClone(version);
  for (const key of SERVER_FIELDS) delete view[key];
  delete view.tools;
  return view;
}

/** JSON with sorted keys, to compare values whatever their key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

type Tool = NonNullable<AgentVersion["tools"]>[number];

const toolKey = (tools: unknown): string =>
  stableJson(
    (Array.isArray(tools) ? tools : [])
      .map((t) => (isObject(t) ? { id: t.id ?? null, settings: t.settings ?? null } : t))
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  );

/** "github (12), jira (13)"; "(none)" for an empty list. */
export function toolsSummary(tools: unknown): string {
  const list = (Array.isArray(tools) ? tools : []).filter(isObject) as Tool[];
  if (list.length === 0) return "(none)";
  return list
    .map((t) => {
      const name = t.toolkit_name ?? t.name ?? t.type;
      if (name === undefined) return t.id === undefined ? "?" : String(t.id);
      return t.id === undefined ? name : `${name} (${t.id})`;
    })
    .join(", ");
}

/**
 * The version PUT ignores `tools` (toolkits are attached with their own endpoint): a file whose
 * tools differ from the attached ones gets a note on stderr instead of a silent no-op (AC-8b).
 */
export function toolsNote(fileTools: unknown, currentTools: unknown, kind: ItemKind): string | undefined {
  if (fileTools === undefined || toolKey(fileTools) === toolKey(currentTools ?? [])) return undefined;
  return (
    `The file changes the attached toolkits (${toolsSummary(currentTools)} → ${toolsSummary(fileTools)}); ` +
    `update does not change toolkits — use \`elitea-cli ${kind}s toolkits add|remove\``
  );
}

/** Fields of `file` whose value differs from `current` (both editable views; `name` is never one). */
export function changedFields(current: Doc, file: Doc): Doc {
  const changes: Doc = {};
  for (const [key, value] of Object.entries(file)) {
    if (key === "name" || key === "tools") continue;
    if (stableJson(value) !== stableJson(current[key])) changes[key] = value;
  }
  return changes;
}

/**
 * The PUT body: the version's own name (required by the PUT; a file never renames a version),
 * its agent_type (so the platform validates pipeline YAML and the model against the right type)
 * and only the changed fields — fields left out keep their value on the server (AC-8a).
 */
export function updateBody(target: { name: string; agent_type?: string }, current: Doc, changes: Doc): Doc {
  const body: Doc = { name: target.name, ...(target.agent_type ? { agent_type: target.agent_type } : {}), ...changes };
  // The platform stores notes inside meta: a new meta without notes would drop them.
  if ("meta" in changes && !("notes" in changes) && current.notes !== undefined) body.notes = current.notes;
  return body;
}

/** The body of a new version copied from `source` (AC-15): its content, its toolkits by id, its skills. */
export function newVersionBody(source: AgentVersion, name: string): Doc {
  const body = editableView(source as Doc);
  body.name = name;
  if (Array.isArray(source.tools)) {
    body.tools = source.tools.map((t) => {
      const { author_id: _author, ...tool } = t as Doc;
      return tool;
    });
  }
  if (Array.isArray(source.variables)) body.variables = source.variables.map((v) => ({ name: v.name, value: v.value ?? "" }));
  body.copy_skills_from_version_id = source.id;
  return body;
}

export const versionCreateHint = (kind: ItemKind) => `Create a new version with \`elitea-cli ${kind}s version create\``;
export const REPLACE_HINT = "Pass --replace-with <version> to move them to another version first";
export const CHANGED_ON_SERVER = "Changed by someone else; run the command again";

/**
 * A platform refusal of a write, printed as the platform's own text and field errors (story 02
 * AC-11), exit 6, with the hint that helps: a new version for a published one (AC-13), --replace-with
 * for a version in use (AC-20a). Other errors are returned unchanged.
 */
export function writeRefusal(err: unknown, hints: { notUpdatable?: string; inUse?: string } = {}): unknown {
  if (!(err instanceof EliteaError) || ![400, 409, 422].includes(err.status)) return err;
  if (err.status === 409) return new CliError(CHANGED_ON_SERVER, EXIT.conflict);
  const text = err.platform?.text ?? "";
  const lines = [text, ...(err.platform?.fields ?? [])].filter(Boolean);
  if (lines.length === 0) lines.push(err.message);
  if (hints.notUpdatable && /is (published|embedded) and can ?not be updated/i.test(text)) lines.push(hints.notUpdatable);
  if (hints.inUse && /\bin use\b/i.test(text)) lines.push(hints.inUse);
  return new CliError(lines.join("\n"), EXIT.conflict);
}

/** True for a refusal the user can fix by editing (not a published version, not a permission). */
export function isFixable(err: unknown): boolean {
  return err instanceof CliError && err.exitCode === EXIT.conflict && !(err instanceof NotSentError) && !/can ?not be updated|Changed by someone else/i.test(err.message);
}

/** The user (or a non-terminal) declined to overwrite a version changed on the server (AC-22). */
export class NotSentError extends CliError {
  constructor(message: string) {
    super(message, EXIT.conflict);
    this.name = "NotSentError";
  }
}

function issueLine(label: string, issue: PipelineIssue): string {
  const where = [issue.node_id, issue.field].filter(Boolean).join(".");
  return `${label} ${where ? `${where} ` : ""}[${issue.code}]: ${issue.message}`;
}

/** AC-18: one line per error and warning, then the summary. */
export function formatValidation(result: PipelineValidation): string[] {
  const errors = result.errors ?? [];
  const warnings = result.warnings ?? [];
  const lines = [...errors.map((i) => issueLine("ERROR", i)), ...warnings.map((i) => issueLine("WARN", i))];
  if (result.valid) lines.push(warnings.length ? `Valid, ${warnings.length} warning(s)` : "Valid");
  else lines.push(`${errors.length} error(s), ${warnings.length} warning(s)`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Unified diff (AC-14): Myers' O(ND) line diff.
// ---------------------------------------------------------------------------------------------

interface Op {
  type: " " | "-" | "+";
  line: string;
}

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const t = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && t[offset + k - 1]! < t[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = t[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: " ", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "+", line: b[y - 1]! });
      else ops.push({ type: "-", line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** `--- from` / `+++ to` and hunks with 3 lines of context; "" when the texts are equal. */
export function unifiedDiff(before: string, after: string, from: string, to: string, context = 3): string {
  let ai = 1;
  let bi = 1;
  const rows = diffLines(lines(before), lines(after)).map((op) => {
    const row = { ...op, a: ai, b: bi };
    if (op.type !== "+") ai++;
    if (op.type !== "-") bi++;
    return row;
  });
  if (!rows.some((r) => r.type !== " ")) return "";
  const color = colorEnabled() && Boolean(process.stdout.isTTY);
  const paint = (type: Op["type"], text: string) =>
    !color || type === " " ? text : `${type === "-" ? "\x1b[31m" : "\x1b[32m"}${text}\x1b[0m`;
  const out = [`--- ${from}`, `+++ ${to}`];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.type === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    let j = i;
    while (j < rows.length) {
      if (rows[j]!.type !== " ") {
        end = j++;
        continue;
      }
      let k = j;
      while (k < rows.length && rows[k]!.type === " ") k++;
      if (k < rows.length && k - j <= 2 * context) j = k;
      else break;
    }
    const stop = Math.min(rows.length, end + context + 1);
    const hunk = rows.slice(start, stop);
    const aLen = hunk.filter((r) => r.type !== "+").length;
    const bLen = hunk.filter((r) => r.type !== "-").length;
    const aStart = aLen ? hunk[0]!.a : hunk[0]!.a - 1;
    const bStart = bLen ? hunk[0]!.b : hunk[0]!.b - 1;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const r of hunk) out.push(paint(r.type, `${r.type}${r.line}`));
    i = stop;
  }
  return `${out.join("\n")}\n`;
}
