import { confirm } from "@inquirer/prompts";
import { parseDocument, versionCreateHint, writeRefusal } from "../authoring.js";
import { ctx } from "../context.js";
import {
  AccessDeniedError,
  type AgentVersion,
  type Credential,
  type EliteaAgentDetails,
  type EliteaClient,
  EliteaError,
  type Toolkit,
  type ToolkitType,
  PUBLIC_PROJECT_ID,
} from "../elitea.js";
import { CliError, EXIT, needsTerminal, notFoundError, usageError } from "../errors.js";
import { confirmDestructive, readStdin } from "../interaction.js";
import { type OutputFormat, formatTable, parseFormat, printData, printQuiet, render } from "../output.js";
import { resolveAgent, resolveVersion } from "../resolve.js";
import { isInteractive } from "../session.js";
import {
  type CredentialLevel,
  type CredentialRef,
  type ToolInfo,
  type ToolkitFile,
  checkFileSecrets,
  createBody,
  credentialFields,
  credentialLabel,
  credentialRefs,
  debugSecretKeys,
  enabledTools,
  findToolkits,
  isMcpType,
  isSelected,
  mainCredentialField,
  maskSettings,
  maskToolkit,
  matchCredentialTitle,
  parseToolList,
  readToolkitFile,
  referenceTo,
  secretSettings,
  selectedNames,
  settingsOf,
  stable,
  toolkitName,
  toolkitTools,
  typeTitle,
  updateBody,
} from "../toolkitsCore.js";
import { isSecretKey } from "../redact.js";
import { projectSession, withSpinner } from "./common.js";
import { collectSecrets, readSource, readableValidation } from "./credentials.js";

export interface ToolkitOptions {
  type?: string[];
  search?: string;
  mcp?: boolean;
  all?: boolean;
  file?: string;
  secret?: string[];
  secretEnv?: string[];
  args?: string;
  argsFile?: string;
  timeout?: string;
  tools?: string;
  agentVersion?: string;
  yes?: boolean;
  project?: string;
  output?: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Session: the project, its type catalog (read once, only when needed) and its toolkits
// ---------------------------------------------------------------------------------------------

class Session {
  private catalog?: Promise<Record<string, ToolkitType>>;
  private mcpCatalog?: Promise<Record<string, ToolkitType>>;

  constructor(
    readonly client: EliteaClient,
    readonly projectId: number,
    readonly baseUrl: string,
  ) {}

  /** Types of the default catalog; it also lists the prebuilt MCP servers (`mcp_<name>`). */
  types(): Promise<Record<string, ToolkitType>> {
    this.catalog ??= this.client.listToolkitTypes(this.projectId);
    return this.catalog;
  }

  /** MCP types: those of the default catalog, and the MCP servers the platform adds with `mcp=true`. */
  async mcpTypes(): Promise<Record<string, ToolkitType>> {
    this.mcpCatalog ??= this.client.listToolkitTypes(this.projectId, { mcp: true }).catch(() => ({}));
    const all = await this.types();
    return { ...Object.fromEntries(Object.entries(all).filter(([t, s]) => isMcpType(t, s))), ...(await this.mcpCatalog) };
  }

  /** The schema of a type, or undefined when the project can't use it (blocked, missing dependency…). */
  async schema(type: string): Promise<ToolkitType | undefined> {
    const found = (await this.types())[type] ?? (isMcpType(type) ? (await this.mcpTypes())[type] : undefined);
    // Secret settings never show in --debug, whatever key holds them (AC-17).
    if (found) ctx.secretKeys = [...new Set([...ctx.secretKeys, ...debugSecretKeys(found)])];
    return found;
  }

  /** Every toolkit of the project: the list API returns MCP toolkits only when asked, so both. */
  async toolkits(): Promise<Toolkit[]> {
    const [plain, mcp] = await Promise.all([this.client.listToolkits(this.projectId), this.client.listToolkits(this.projectId, { mcp: true })]);
    const seen = new Set<number>();
    return [...plain, ...mcp].filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id)));
  }
}

async function session(opts: Pick<ToolkitOptions, "project">): Promise<Session> {
  const { client, projectId, baseUrl } = await projectSession(opts.project);
  ctx.secretKeys = [...new Set([...ctx.secretKeys, "Authorization", "authorization"])];
  return new Session(client, projectId, baseUrl);
}

const NOT_AVAILABLE = (type: string) => `Toolkit type ${type} is not available in this project — run \`elitea-cli toolkits types\``;

/** One toolkit by id or name (story 02 AC-21a); unknown or ambiguous → exit 5. */
async function resolveToolkit(s: Session, query: string): Promise<Toolkit> {
  const hits = findToolkits(await s.toolkits(), query);
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw notFoundError(`Toolkit "${query}" not found in project ${s.projectId} — run \`elitea-cli toolkits list\``);
  throw notFoundError(`Toolkit "${query}" matches several: ${hits.map((t) => `${toolkitName(t)} (${t.id})`).join(", ")} — use the id`);
}

/** The toolkit as stored (the list rows are enriched for the UI). */
async function loadToolkit(s: Session, query: string): Promise<{ toolkit: Toolkit; schema: ToolkitType | undefined }> {
  const found = await resolveToolkit(s, query);
  const toolkit = await s.client.getToolkit(s.projectId, found.id);
  return { toolkit, schema: await s.schema(toolkit.type) };
}

/**
 * Every tool of the toolkit. Types that discover their tools at run time (MCP servers, OpenAPI
 * specs) declare none; then the platform is asked, and failing that the toolkit's own selection.
 */
async function toolsOf(s: Session, toolkit: Toolkit, schema: ToolkitType | undefined): Promise<ToolInfo[]> {
  const declared = toolkitTools(schema, { settings: {} });
  if (declared.length) return declared;
  const discovered = await s.client.discoverToolkitTools(s.projectId, toolkit.id).catch(() => undefined);
  return toolkitTools(schema, toolkit, discovered);
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

const ERROR_TYPES: Record<string, (e: Record<string, unknown>) => string> = {
  credential_not_found: (e) => `Credential "${String(e.credential_id)}" not found`,
  private_credential_not_found: (e) => `Personal credential "${String(e.credential_id)}" not found`,
  credential_type_mismatch: (e) => `Credential "${String(e.credential_id)}" is a ${String(e.actual_type)} credential; this toolkit needs ${String(e.expected_type)}`,
  configuration_model_not_found: (e) => `Model "${String(e.model_name)}" is not available in this project (${String(e.section)})`,
};

/** The platform words credential problems as JSON inside the message: said as a sentence. */
function readableLine(line: string): string {
  return line.replace(/\{"error_type":[^{}]*\}/g, (json) => {
    try {
      const e = JSON.parse(json) as Record<string, unknown>;
      return ERROR_TYPES[String(e.error_type)]?.(e) ?? json;
    } catch {
      return json;
    }
  });
}

/**
 * AC-7: a refused write shows the platform's text and its field errors, exit 6. A blocked type and
 * the sharing rules are platform rules (403), not missing permissions; other 403s → story 02 AC-8.
 */
function refusal(err: unknown): unknown {
  if (err instanceof AccessDeniedError) {
    const text = err.platform?.text;
    if (!err.code?.startsWith("TOKEN_SCOPE_") && text && /not available in this deployment|shar(ed|ing)|public project/i.test(text)) return new CliError(text, EXIT.conflict);
    return err;
  }
  if (!(err instanceof EliteaError) || ![400, 409, 422].includes(err.status)) return err;
  const lines = [err.platform?.text, ...(err.platform?.fields ?? [])]
    .filter((l): l is string => Boolean(l))
    .flatMap((l) => (readableValidation(l) ?? l).split("\n"))
    .map(readableLine);
  return new CliError(lines.length ? [...new Set(lines)].join("\n") : err.message, EXIT.conflict);
}

const CHANGED_BY_SOMEONE = (what: string) => `${what} was changed by someone else; run the command again`;

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

/** `toolkits types [type] [--mcp] [--all]` (AC-1, AC-2). */
export async function typesCommand(type: string | undefined, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  if (type !== undefined) {
    const schema = await s.schema(type);
    if (!schema) throw notFoundError(NOT_AVAILABLE(type));
    const settings = settingsOf(schema);
    const tools = toolkitTools(schema, { settings: {} });
    const credential = mainCredentialField(schema);
    if (format !== "text") {
      printData(format, { type, title: typeTitle(type, schema), mcp: isMcpType(type, schema), credential_field: credential?.name ?? null, settings, tools, schema });
      return;
    }
    console.log(`Type:        ${type} (${typeTitle(type, schema)})`);
    if (credential) console.log(`Credential:  ${credential.name} — a ${credential.types.join(" or ")} credential; in a file: credential: "<title>"`);
    console.log("Settings:");
    const rows = settings
      .filter((f) => f.name !== credential?.name)
      .map((f) => [`  ${f.name}${f.required ? "*" : ""}`, f.type, f.secret ? "secret" : "", f.default === undefined ? "" : JSON.stringify(f.default), f.description ?? ""]);
    for (const line of formatTable(["  NAME", "TYPE", "SECRET", "DEFAULT", "DESCRIPTION"], rows, process.stdout.columns)) console.log(line);
    console.log(tools.length ? `Tools:       ${tools.length} — ${tools.map((t) => t.name).join(", ")}` : "Tools:       discovered when the toolkit connects");
    console.error("* required · secret: give with --secret <setting> or --secret-env <setting>=<VAR>");
    return;
  }
  const catalog = opts.mcp ? await s.mcpTypes() : Object.fromEntries(Object.entries(await s.types()).filter(([t, v]) => !isMcpType(t, v)));
  const rows = Object.entries(catalog)
    .filter(([, v]) => opts.all || v.metadata?.hidden !== true)
    .map(([t, v]) => ({ type: t, title: typeTitle(t, v), credential: mainCredentialField(v)?.types.join("|") ?? "", tools: toolkitTools(v, { settings: {} }).length }))
    .sort((a, b) => a.type.localeCompare(b.type));
  render(
    rows,
    [
      { header: "TYPE", value: (r) => r.type },
      { header: "TITLE", value: (r) => r.title },
      { header: "CREDENTIAL", value: (r) => r.credential },
      { header: "TOOLS", value: (r) => r.tools || "" },
    ],
    format,
    opts.mcp ? "MCP toolkit types" : "toolkit types",
  );
}

// ---------------------------------------------------------------------------------------------
// list, get, tools
// ---------------------------------------------------------------------------------------------

/** `toolkits list [--type t] [--search text] [--mcp]` (AC-3). */
export async function listCommand(opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const rows = await s.client.listToolkits(s.projectId, { query: opts.search, types: opts.type, mcp: opts.mcp });
  if (format !== "text") {
    // The list stays small: the settings and the tools are in `toolkits get` (AC-3, AC-4).
    printData(
      format,
      rows.map((t) => ({
        id: t.id,
        name: toolkitName(t),
        type: t.type,
        description: t.description ?? null,
        credential: credentialLabel(t.settings) || null,
        selected_tools: selectedNames(t.settings),
        mcp: isMcpType(t.type) || t.meta?.mcp === true,
        created_at: t.created_at ?? null,
      })),
    );
    return;
  }
  render(
    rows,
    [
      { header: "ID", value: (t) => t.id },
      { header: "NAME", value: (t) => toolkitName(t) },
      { header: "TYPE", value: (t) => t.type },
      { header: "CREDENTIAL", value: (t) => credentialLabel(t.settings) },
    ],
    format,
    "toolkits",
  );
}

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "(not set)";
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return text.length > 100 ? `${text.slice(0, 99).replace(/\s+/g, " ")}… (${text.length} chars, full with -o yaml)` : text.replace(/\s+/g, " ");
};

/** Human view of a toolkit: settings masked, credentials by title, tools with SELECTED (AC-4). */
function formatToolkit(t: Toolkit, schema: ToolkitType | undefined, tools: ToolInfo[]): string[] {
  const settings = maskSettings(t.settings, schema);
  const refs = new Map(credentialRefs(t.settings, schema, true).map((r) => [r.field, r.ref]));
  const shown = Object.entries(settings).filter(([k]) => k !== "selected_tools");
  const width = Math.max(14, ...shown.map(([k]) => k.length + 2));
  const line = (k: string, v: unknown) => {
    const ref = refs.get(k);
    return `  ${`${k}:`.padEnd(width)} ${ref ? `credential ${ref.elitea_title ?? ref.configuration_uuid}${ref.private ? " (personal)" : ""}` : show(v)}`;
  };
  const selected = tools.filter((tool) => isSelected(t.settings, tool.name)).length;
  const out = [
    `ID:          ${t.id}`,
    `Name:        ${toolkitName(t)}`,
    `Type:        ${t.type}${schema ? ` (${typeTitle(t.type, schema)})` : ""}`,
    `Description: ${(t.description ?? "").replace(/\s+/g, " ").trim() || "(none)"}`,
    `Credential:  ${credentialLabel(t.settings, schema) || "(none)"}`,
    "Settings:",
    ...(shown.length ? shown.map(([k, v]) => line(k, v)) : ["  (none)"]),
    "",
  ];
  if (tools.length === 0) {
    out.push("Tools:       (none found)");
    return out;
  }
  out.push(`Tools (${selected} of ${tools.length} selected):`);
  out.push(...formatTable(["  NAME", "SELECTED"], tools.map((tool) => [`  ${tool.name}`, isSelected(t.settings, tool.name) ? "yes" : "no"])));
  return out;
}

/** `toolkits get <toolkit>` (AC-4). */
export async function getCommand(query: string, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const { toolkit, schema } = await loadToolkit(s, query);
  const tools = await toolsOf(s, toolkit, schema);
  if (format !== "text") {
    printData(format, {
      ...maskToolkit(toolkit, schema),
      cli: {
        credential: credentialLabel(toolkit.settings, schema) || null,
        tools: tools.map((tool) => ({ ...tool, selected: isSelected(toolkit.settings, tool.name) })),
      },
    });
    return;
  }
  for (const line of formatToolkit(toolkit, schema, tools)) console.log(line);
}

/** `toolkits tools <toolkit>` (AC-9): NAME, DESCRIPTION, SELECTED. */
export async function toolsCommand(query: string, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const { toolkit, schema } = await loadToolkit(s, query);
  const tools = (await toolsOf(s, toolkit, schema)).map((tool) => ({ ...tool, selected: isSelected(toolkit.settings, tool.name) }));
  render(
    tools,
    [
      { header: "NAME", value: (t) => t.name },
      { header: "DESCRIPTION", value: (t) => (t.description.length > 80 ? `${t.description.slice(0, 79)}…` : t.description) },
      { header: "SELECTED", value: (t) => (t.selected ? "yes" : "no") },
    ],
    format,
    "tools",
  );
}

// ---------------------------------------------------------------------------------------------
// create, update
// ---------------------------------------------------------------------------------------------

async function readFileFor(opts: ToolkitOptions): Promise<{ file: ToolkitFile; source: string }> {
  if (opts.file === undefined) throw usageError("Give the toolkit as a YAML or JSON file: -f <file>");
  if (opts.file === "-" && (opts.secret ?? []).length > 0 && !isInteractive()) {
    throw new CliError("Only one option can read stdin: -f - and --secret both read it", EXIT.usage);
  }
  const { text, source } = await readSource(opts.file);
  return { file: readToolkitFile(parseDocument(text, source), source), source };
}

/**
 * AC-5: `credential: "<title>"` → the credential: this project's first, then the user's personal
 * ones, then those the public project shares. Only credentials of the types the field accepts
 * count. No match, or two at the first level that has one → exit 5, nothing is sent.
 */
async function resolveCredential(s: Session, title: string, types: string[]): Promise<{ credential: Credential; level: CredentialLevel }> {
  const user = await s.client.getUser();
  const fits = (c: Credential) => types.length === 0 || types.includes(c.type);
  const own = await s.client.listCredentials(s.projectId, { includeShared: true });
  const levels: Array<[CredentialLevel, () => Promise<Credential[]>]> = [
    ["project", async () => own.filter((c) => c.project_id === s.projectId)],
    ["personal", async () => (user.personal_project_id === s.projectId ? [] : s.client.listCredentials(user.personal_project_id).catch(() => []))],
    ["shared", async () => own.filter((c) => c.project_id !== s.projectId && (c.project_id === PUBLIC_PROJECT_ID || c.shared))],
  ];
  for (const [level, rows] of levels) {
    const hits = matchCredentialTitle((await rows()).filter(fits), title);
    if (hits.length === 1) return { credential: hits[0]!, level };
    if (hits.length > 1) throw notFoundError(`Credential "${title}" matches several: ${hits.map((c) => `${c.elitea_title} (${c.id})`).join(", ")} — use its title (elitea_title)`);
  }
  const hint = types.length ? ` (this toolkit needs a ${types.join(" or ")} credential)` : "";
  throw notFoundError(`Credential "${title}" not found in project ${s.projectId}${hint} — run \`elitea-cli credentials list${types.length === 1 ? ` --type ${types[0]}` : ""}\``);
}

/** The credential field and reference for a file's `credential:`; undefined when the file has none. */
async function credentialFor(s: Session, file: ToolkitFile, schema: ToolkitType | undefined, source: string): Promise<{ field: string; ref: CredentialRef } | undefined> {
  if (file.credential === undefined) return undefined;
  const field = mainCredentialField(schema);
  if (!field) {
    const fields = credentialFields(schema).map((f) => f.name);
    throw usageError(`${source}: ${file.type ?? "this"} toolkits take no credential${fields.length ? `; set ${fields.join(" or ")} in settings instead` : ""}`);
  }
  if (file.settings[field.name] !== undefined) throw usageError(`${source}: give credential or settings.${field.name}, not both`);
  const { credential, level } = await resolveCredential(s, file.credential, field.types);
  return { field: field.name, ref: referenceTo(credential, level) };
}

/** A selection in the file names tools of the type (AC-7): an unknown one → exit 6, nothing sent. */
function checkSelectedTools(file: ToolkitFile, schema: ToolkitType | undefined, type: string): void {
  const known = toolkitTools(schema, { settings: {} }).map((t) => t.name);
  if (known.length === 0) return;
  const unknown = selectedNames(file.settings).filter((n) => !known.includes(n));
  if (unknown.length) throw new CliError(`Toolkit type ${type} has no tool ${unknown.map((n) => `"${n}"`).join(", ")} — run \`elitea-cli toolkits types ${type}\``, EXIT.conflict);
}

/** Secret settings for a type with no schema: those whose names look like secrets. */
const guessedSecrets = (settings: Record<string, unknown>) => Object.keys(settings).filter((k) => isSecretKey(k));

function report(format: OutputFormat, t: Toolkit, schema: ToolkitType | undefined, sentence: string): void {
  if (printQuiet(t.id)) return;
  if (format !== "text") printData(format, maskToolkit(t, schema));
  else console.log(sentence);
}

/** `toolkits create -f toolkit.yaml [--secret s] [--secret-env s=VAR]` (AC-5…AC-7). */
export async function createCommand(opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts);
  const { file, source } = await readFileFor(opts);
  if (!file.type) throw usageError(`${source}: type is missing — run \`elitea-cli toolkits types\``);
  if (!file.name?.trim()) throw usageError(`${source}: name is missing`);
  const s = await session(opts);
  const schema = await s.schema(file.type);
  // A type the catalog does not list is blocked or lacks a platform dependency: the platform would
  // save it without checking its settings, so the CLI refuses it (AC-2).
  if (!schema) throw notFoundError(NOT_AVAILABLE(file.type));
  const secrets = secretSettings(schema);
  checkFileSecrets(file, secrets, source);
  checkSelectedTools(file, schema, file.type);
  const credential = await credentialFor(s, file, schema, source);
  const given = await collectSecrets(opts, secrets, file.type);
  ctx.secretValues.push(...Object.values(given));

  const twin = (await s.client.listToolkits(s.projectId, { query: file.name, types: [file.type] }).catch(() => [])).find((t) => t.name === file.name);
  let created: Toolkit;
  try {
    created = await s.client.createToolkit(s.projectId, createBody(file, secrets, given, credential));
  } catch (err) {
    throw refusal(err);
  }
  if (twin) console.error(`Another ${file.type} toolkit named "${twin.name}" already exists (${twin.id})`);
  report(format, created, schema, `Created toolkit ${toolkitName(created)} (${created.id})`);
}

/** `toolkits update <toolkit> -f toolkit.yaml [--secret …]` (AC-8): settings left out keep their value. */
export async function updateCommand(query: string, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts);
  const { file, source } = await readFileFor(opts);
  const s = await session(opts);
  const { toolkit: stored, schema } = await loadToolkit(s, query);
  if (file.type !== undefined && file.type !== stored.type) {
    throw usageError(`${source}: type is ${file.type}, but ${toolkitName(stored)} is a ${stored.type} toolkit (a type cannot change)`);
  }
  if (file.name !== undefined && !file.name.trim()) throw usageError(`${source}: name cannot be empty`);
  const secrets = schema ? secretSettings(schema) : guessedSecrets({ ...stored.settings, ...file.settings });
  checkFileSecrets(file, secrets, source);
  checkSelectedTools(file, schema, stored.type);
  const credential = await credentialFor(s, { ...file, type: stored.type }, schema, source);
  const given = await collectSecrets(opts, secrets, stored.type);
  ctx.secretValues.push(...Object.values(given));

  const { body, changed } = updateBody(stored, file, secrets, given, credential);
  if (!changed) {
    console.error("No changes");
    return;
  }
  // The PUT takes no version: the toolkit must still be the one read (story 05a AC-7a).
  const now = await s.client.getToolkit(s.projectId, stored.id);
  const view = (t: Toolkit) => stable({ name: t.name, description: t.description, settings: t.settings, meta: t.meta });
  if (view(now) !== view(stored)) throw new CliError(CHANGED_BY_SOMEONE(toolkitName(stored)), EXIT.conflict);
  let updated: Toolkit;
  try {
    updated = await s.client.updateToolkit(s.projectId, stored.id, body);
  } catch (err) {
    throw refusal(err);
  }
  report(format, updated, schema, `Updated toolkit ${toolkitName(updated)} (${updated.id})`);
}

// ---------------------------------------------------------------------------------------------
// test, delete
// ---------------------------------------------------------------------------------------------

/** --args '<json>' / --args-file f.json (- = stdin): one JSON object. */
async function toolArgs(opts: ToolkitOptions): Promise<Record<string, unknown>> {
  if (opts.args !== undefined && opts.argsFile !== undefined) throw usageError("Give --args or --args-file, not both");
  let text: string;
  let source: string;
  if (opts.args !== undefined) [text, source] = [opts.args, "--args"];
  else if (opts.argsFile !== undefined) [text, source] = [opts.argsFile === "-" ? await readStdin("--args-file -") : (await readSource(opts.argsFile)).text, opts.argsFile === "-" ? "stdin" : opts.argsFile];
  else return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw usageError(`${source}: not valid JSON: ${(err as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError(`${source}: the tool's arguments must be a JSON object, e.g. '{"issue_key": "EL-1"}'`);
  return value as Record<string, unknown>;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 300;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 900) throw usageError(`--timeout must be 1–900 seconds, got "${value}"`);
  return n;
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * `toolkits test <toolkit> <tool> [--args json | --args-file f]` (AC-10): runs the tool once on
 * EliteA. It acts on the real service, so a terminal asks first; --yes skips; a non-terminal
 * without --yes is refused (story 02 AC-21c). Exit 0 with its result, 1 with its error.
 */
export async function testCommand(query: string, tool: string, opts: ToolkitOptions): Promise<number> {
  const format = parseFormat(opts);
  const params = await toolArgs(opts);
  const timeout = parseTimeout(opts.timeout);
  const s = await session(opts);
  const { toolkit, schema } = await loadToolkit(s, query);
  const name = toolkitName(toolkit);
  const tools = await toolsOf(s, toolkit, schema);
  if (tools.length && !tools.some((t) => t.name === tool)) {
    throw new CliError(`${name} has no tool "${tool}" — run \`elitea-cli toolkits tools ${toolkit.id}\``, EXIT.conflict);
  }
  if (!opts.yes && !ctx.yes) {
    if (!isInteractive()) throw needsTerminal("Confirming a tool run", `pass --yes to run ${tool} on ${name}`);
    const service = typeTitle(toolkit.type, schema);
    if (!(await confirm({ message: `Run ${tool} on ${name}? It may change data in ${service}.`, default: false }))) return EXIT.ok;
  }
  let answer: Awaited<ReturnType<EliteaClient["testToolkitTool"]>>;
  try {
    answer = await withSpinner(`Running ${tool}`, s.client.testToolkitTool(s.projectId, toolkit, tool, params, timeout));
  } catch (err) {
    if (err instanceof EliteaError && err.status === 400 && /^timeout$/i.test(err.platform?.text ?? "")) {
      throw new CliError(`${tool} did not finish in ${timeout} s; the run was stopped (--timeout <seconds> waits longer)`, EXIT.timeout);
    }
    throw refusal(err);
  }
  const result = answer.result ?? {};
  const ok = result.success !== false && !result.error;
  const error = result.error || (ok ? undefined : "the tool failed without a message");
  if (format !== "text") {
    printData(format, { ok, result: result.result ?? null, error: error ?? null, tool, toolkit: { id: toolkit.id, name, type: toolkit.type }, execution_time_seconds: result.execution_time_seconds ?? null });
  } else if (ok) {
    const text = asText(result.result ?? "");
    process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
  } else {
    console.error(`${tool} failed: ${error}`);
  }
  if (result.requires_authorization) console.error(`Sign-in required: open ELITEA → Toolkits → ${name} to sign in (${s.baseUrl}/app/${s.projectId}/toolkits/all/${toolkit.id})`);
  return ok ? EXIT.ok : EXIT.general;
}

/** `toolkits delete <toolkit>` (AC-11): confirmed; the platform removes it from every agent version. */
export async function deleteCommand(query: string, opts: ToolkitOptions): Promise<void> {
  const s = await session(opts);
  const found = await resolveToolkit(s, query);
  const ok = await confirmDestructive({
    action: "delete",
    type: "toolkit",
    name: toolkitName(found),
    id: found.id,
    note: "Agents and pipelines that use it lose it: EliteA removes it from every version, published ones too.",
    yes: opts.yes,
  });
  if (!ok) return;
  try {
    await s.client.deleteToolkit(s.projectId, found.id);
  } catch (err) {
    if (err instanceof EliteaError && err.status === 400 && /not found/i.test(err.platform?.text ?? "")) {
      throw notFoundError(`Toolkit ${toolkitName(found)} (${found.id}) was already deleted`);
    }
    throw refusal(err);
  }
  if (!printQuiet(found.id)) console.log(`Deleted toolkit ${toolkitName(found)} (${found.id})`);
}

// ---------------------------------------------------------------------------------------------
// agents toolkits add | remove
// ---------------------------------------------------------------------------------------------

interface Target {
  s: Session;
  details: EliteaAgentDetails;
  version: AgentVersion;
  where: string;
}

async function agentTarget(agentQuery: string, opts: ToolkitOptions, verb: string): Promise<Target> {
  const s = await session(opts);
  const { agent } = await resolveAgent(s.client, s.projectId, agentQuery, "agent", `elitea-cli agents toolkits ${verb} <agent> <toolkit>`);
  const details = await s.client.getAgent(s.projectId, agent.id);
  const summary = resolveVersion(details, opts.agentVersion);
  const version = await s.client.getVersion(s.projectId, details.id, summary.id);
  return { s, details, version, where: `${details.name}/${version.name}` };
}

/**
 * A relation write refused (AC-15): a published version → story 04 AC-13; the link added or removed
 * by someone else since it was read → story 04 AC-22; anything else as the platform says it.
 */
function relationRefusal(err: unknown, where: string): unknown {
  const text = err instanceof EliteaError ? (err.platform?.text ?? "") : "";
  if (/Already (exists|removed) relation/i.test(text)) return new CliError(`${where} was changed on the server since you opened it; run the command again`, EXIT.conflict);
  const mapped = writeRefusal(err, { notUpdatable: versionCreateHint("agent") });
  return mapped === err ? refusal(err) : mapped;
}

const attachedIds = (v: AgentVersion) => new Set((v.tools ?? []).map((t) => t.id).filter((id): id is number => typeof id === "number"));

/** `agents toolkits add <agent> <toolkit> [--tools a,b] [--agent-version v]` (AC-12, AC-13, AC-15). */
export async function addCommand(agentQuery: string, toolkitQuery: string, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts);
  const wanted = opts.tools === undefined ? undefined : parseToolList(opts.tools);
  const { s, details, version, where } = await agentTarget(agentQuery, opts, "add");
  const found = await resolveToolkit(s, toolkitQuery);
  const name = toolkitName(found);
  if (attachedIds(version).has(found.id)) {
    console.log(`${name} is already attached to ${where}`);
    console.error("To change its tools: `agents toolkits remove`, then `agents toolkits add --tools …`");
    return;
  }
  const toolkit = await s.client.getToolkit(s.projectId, found.id);
  const schema = await s.schema(toolkit.type);
  const discovered = toolkitTools(schema, { settings: {} }).length ? undefined : await s.client.discoverToolkitTools(s.projectId, toolkit.id).catch(() => undefined);
  const enabled = enabledTools(schema, toolkit, discovered);
  if (wanted && enabled.length) {
    const missing = wanted.filter((t) => !enabled.includes(t));
    if (missing.length) {
      throw new CliError(`${name} has no tool ${missing.map((t) => `"${t}"`).join(", ")} — its tools: ${enabled.join(", ")}`, EXIT.conflict);
    }
  }
  try {
    await s.client.setToolkitRelation(s.projectId, toolkit.id, { agentId: details.id, versionId: version.id, attach: true, selectedTools: wanted });
  } catch (err) {
    throw relationRefusal(err, where);
  }
  const tools = wanted ?? enabled;
  if (printQuiet(toolkit.id)) return;
  if (format !== "text") {
    printData(format, { agent: { id: details.id, name: details.name }, version: { id: version.id, name: version.name }, toolkit: { id: toolkit.id, name, type: toolkit.type }, tools });
    return;
  }
  console.log(`Attached ${name} to ${where} (${tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "all tools"})`);
}

/** `agents toolkits remove <agent> <toolkit> [--agent-version v]` (AC-14, AC-15). */
export async function removeCommand(agentQuery: string, toolkitQuery: string, opts: ToolkitOptions): Promise<void> {
  const format = parseFormat(opts);
  const { s, details, version, where } = await agentTarget(agentQuery, opts, "remove");
  // Attached toolkits first: they are what the user sees in `agents get`.
  const attached = (version.tools ?? []).filter((t): t is NonNullable<AgentVersion["tools"]>[number] & { id: number } => typeof t.id === "number");
  const asToolkits = attached.map((t) => ({ id: t.id, type: t.type ?? "", name: t.name, toolkit_name: t.toolkit_name, settings: {} }) as Toolkit);
  const hits = findToolkits(asToolkits, toolkitQuery);
  if (hits.length > 1) throw notFoundError(`Toolkit "${toolkitQuery}" matches several: ${hits.map((t) => `${toolkitName(t)} (${t.id})`).join(", ")} — use the id`);
  if (hits.length === 0) {
    const toolkit = await resolveToolkit(s, toolkitQuery);
    throw notFoundError(`${toolkitName(toolkit)} is not attached to ${where}`);
  }
  const toolkit = hits[0]!;
  try {
    await s.client.setToolkitRelation(s.projectId, toolkit.id, { agentId: details.id, versionId: version.id, attach: false });
  } catch (err) {
    throw relationRefusal(err, where);
  }
  if (printQuiet(toolkit.id)) return;
  if (format !== "text") {
    printData(format, { agent: { id: details.id, name: details.name }, version: { id: version.id, name: version.name }, toolkit: { id: toolkit.id, name: toolkitName(toolkit), type: toolkit.type } });
    return;
  }
  console.log(`Detached ${toolkitName(toolkit)} from ${where}`);
}
