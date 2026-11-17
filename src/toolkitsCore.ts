import { MASK_IN_FILE, SECRET_IN_FILE, isSecretSchema, isVaultReference, setPath } from "./credentialsCore.js";
import type { Credential, DiscoveredTools, JsonSchema, Toolkit, ToolkitType } from "./elitea.js";
import { usageError } from "./errors.js";
import { MASK, isSecretKey } from "./redact.js";

/**
 * Toolkits (story 05b) without I/O: what a type's schema says (fields, secrets, the credential
 * field, tools), masking, the toolkit file and the bodies sent for create and update.
 */

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Type schemas
// ---------------------------------------------------------------------------------------------

/** MCP types: the remote MCP type, prebuilt MCP servers (`mcp_<name>`) and local MCP servers. */
export const isMcpType = (type: string, schema?: ToolkitType) => type === "mcp" || type.startsWith("mcp_") || schema?.metadata?.mcp === true;

export const typeTitle = (type: string, schema: ToolkitType | undefined) => schema?.metadata?.label || (schema?.title !== type ? schema?.title : undefined) || type;

function deref(schema: JsonSchema, root: ToolkitType): JsonSchema {
  const refs = [schema.$ref, ...(schema.anyOf ?? []).map((s) => s.$ref)].filter((r): r is string => typeof r === "string");
  const name = refs[0]?.replace(/^#\/\$defs\//, "");
  return (name && root.$defs?.[name]) || schema;
}

/** Credential fields (`<x>_configuration`) point at a saved credential, by its title. */
export interface CredentialField {
  name: string;
  /** Credential types it accepts (`configuration_types`). */
  types: string[];
  /** `credentials`, or `vectorstorage` for the PgVector store of indexes. */
  section?: string;
  required: boolean;
}

export function credentialFields(schema: ToolkitType | undefined): CredentialField[] {
  if (!schema) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([, p]) => Array.isArray(p.configuration_types) || Array.isArray(p.configuration_sections))
    .map(([name, p]) => ({
      name,
      types: ((p.configuration_types as string[] | undefined) ?? []).map(String),
      section: (deref(p, schema).metadata?.section as string | undefined) ?? undefined,
      required: required.has(name),
    }));
}

/** The field `credential: "<title>"` in a toolkit file fills: the one that is not the vector store. */
export function mainCredentialField(schema: ToolkitType | undefined): CredentialField | undefined {
  const fields = credentialFields(schema).filter((f) => f.section !== "vectorstorage");
  return fields.length === 1 ? fields[0] : undefined;
}

/** Settings the platform keeps in the vault: `secret: true` (Provider Hub) or a SecretStr (`format: password`). */
export function secretSettings(schema: ToolkitType | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([name, p]) => name !== "selected_tools" && !p.$ref && (p.secret === true || isSecretSchema(p)))
    .map(([name]) => name);
}

function typeName(p: JsonSchema): string {
  if (Array.isArray(p.enum)) return p.enum.map(String).join("|");
  if (p.type) return p.type === "array" && isObject(p.items) && (p.items as JsonSchema).type ? `${(p.items as JsonSchema).type}[]` : p.type;
  const options = (p.anyOf ?? []).filter((o) => o.type !== "null");
  if (options.length) return options.map(typeName).join("|");
  return p.$ref ? "credential" : "any";
}

/** One setting, as `toolkits types <type>` describes it (AC-1). */
export interface SettingInfo {
  name: string;
  type: string;
  required: boolean;
  secret: boolean;
  /** Credential types for a credential field. */
  credential?: string[];
  default?: unknown;
  description?: string;
}

export function settingsOf(schema: ToolkitType | undefined): SettingInfo[] {
  if (!schema) return [];
  const required = new Set(schema.required ?? []);
  const secrets = new Set(secretSettings(schema));
  const creds = new Map(credentialFields(schema).map((f) => [f.name, f.types]));
  return Object.entries(schema.properties ?? {})
    .filter(([name, p]) => name !== "selected_tools" && p.hidden !== true)
    .map(([name, p]) => ({
      name,
      type: creds.has(name) ? "credential" : typeName(p),
      required: required.has(name),
      secret: secrets.has(name),
      ...(creds.has(name) ? { credential: creds.get(name) } : {}),
      ...(p.default !== undefined && p.default !== null ? { default: p.default } : {}),
      ...(typeof p.description === "string" ? { description: p.description.split("\n")[0] } : {}),
    }));
}

/** A tool a toolkit can expose. */
export interface ToolInfo {
  name: string;
  description: string;
}

const firstLine = (v: unknown) => (typeof v === "string" ? v.trim().split("\n")[0]!.trim() : "");

/** The tools a type declares (`selected_tools.items.enum`), with what their args schemas say. */
export function schemaTools(schema: ToolkitType | undefined): ToolInfo[] {
  const st = schema?.properties?.selected_tools;
  const items = isObject(st?.items) ? (st!.items as JsonSchema) : undefined;
  const names = Array.isArray(items?.enum) ? items!.enum.map(String) : [];
  const args = isObject(st?.args_schemas) ? (st!.args_schemas as Record<string, JsonSchema>) : {};
  return names.map((name) => ({ name, description: firstLine(args[name]?.description) }));
}

/** Tool names a toolkit has selected; OpenAPI toolkits keep `{name, description, …}` objects. */
export function selectedNames(settings: Doc | undefined): string[] {
  const list = settings?.selected_tools;
  if (!Array.isArray(list)) return [];
  return list.map((t) => (typeof t === "string" ? t : isObject(t) && typeof t.name === "string" ? t.name : "")).filter(Boolean);
}

/**
 * Every tool of a toolkit: the type's own list; for toolkits whose tools come from a server or
 * a spec (MCP, OpenAPI) the discovered ones; else what its settings select.
 */
export function toolkitTools(schema: ToolkitType | undefined, toolkit: Pick<Toolkit, "settings">, discovered?: DiscoveredTools): ToolInfo[] {
  const declared = schemaTools(schema);
  if (declared.length) return declared;
  const found = (discovered?.tools ?? []).filter((t) => t?.name).map((t) => ({ name: t.name, description: firstLine(t.description) }));
  if (found.length) return found;
  const list = Array.isArray(toolkit.settings?.selected_tools) ? (toolkit.settings.selected_tools as unknown[]) : [];
  return list
    .map((t) => (typeof t === "string" ? { name: t, description: "" } : isObject(t) ? { name: String(t.name ?? ""), description: firstLine(t.description) } : undefined))
    .filter((t): t is ToolInfo => Boolean(t?.name));
}

/** An empty selection means every tool is on: the platform and the SDK read it that way. */
export function isSelected(settings: Doc | undefined, tool: string): boolean {
  const names = selectedNames(settings);
  return names.length === 0 || names.includes(tool);
}

/** The tools an agent can be given from this toolkit: its selected ones, or all when none are. */
export function enabledTools(schema: ToolkitType | undefined, toolkit: Pick<Toolkit, "settings">, discovered?: DiscoveredTools): string[] {
  const all = toolkitTools(schema, toolkit, discovered).map((t) => t.name);
  const selected = selectedNames(toolkit.settings);
  return selected.length ? selected : all;
}

// ---------------------------------------------------------------------------------------------
// Masking (story 05a AC-3, AC-14)
// ---------------------------------------------------------------------------------------------

/** Header-like keys whose value is a credential (`headers: {Authorization: "Bearer …"}`). */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key)$/i;

const looksSecret = (key: string) => isSecretKey(key) || SECRET_HEADER.test(key);

/**
 * A copy of `settings` safe to print: secret settings of the schema, any `{{secret.…}}` at any
 * depth, and string values under secret-looking keys inside nested objects and in settings the
 * schema doesn't describe read `****`. Some stored toolkits hold plain secrets the platform
 * returns as they are (seen on dev.elitea.ai: an OpenAPI toolkit's api_key), so the schema alone
 * is not enough. An empty value stays empty so "not set" can still be told apart.
 */
export function maskSettings(settings: unknown, schema: ToolkitType | undefined): Doc {
  if (!isObject(settings)) return {};
  const secrets = new Set(secretSettings(schema));
  const known = new Set(Object.keys(schema?.properties ?? {}));
  const deep = (value: unknown, key?: string): unknown => {
    if (isVaultReference(value)) return MASK;
    if (typeof value === "string" && key !== undefined && looksSecret(key) && value !== "") return MASK;
    if (Array.isArray(value)) return value.map((v) => deep(v));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, k)]));
    return value;
  };
  return Object.fromEntries(
    Object.entries(settings).map(([k, v]) => {
      if (secrets.has(k)) return [k, v === undefined || v === null || v === "" ? v : MASK];
      // A setting the schema describes as not secret is shown; what it nests is masked by name.
      return [k, known.has(k) ? deep(v) : deep(v, k)];
    }),
  );
}

/** A toolkit safe to print: masked settings, and no author block (an email). */
export function maskToolkit(toolkit: Toolkit, schema: ToolkitType | undefined): Toolkit {
  const { author: _author, ...rest } = toolkit as Toolkit & { author?: unknown };
  return { ...rest, settings: maskSettings(toolkit.settings, schema) };
}

/** Exact key names to mask in --debug output for this type (AC-17). */
export const debugSecretKeys = (schema: ToolkitType | undefined) => [...secretSettings(schema), "Authorization", "authorization"];

// ---------------------------------------------------------------------------------------------
// Credentials referenced by a toolkit
// ---------------------------------------------------------------------------------------------

/** What a credential field stores: a reference by title, `private` = the user's personal project. */
export interface CredentialRef {
  elitea_title?: string;
  private?: boolean;
  configuration_uuid?: string;
  configuration_project_id?: number;
}

/** The credential(s) a toolkit names, as `field → reference`, the vector store left out unless asked. */
export function credentialRefs(settings: Doc | undefined, schema?: ToolkitType, withVectorStore = false): Array<{ field: string; ref: CredentialRef }> {
  const fields = schema ? credentialFields(schema) : undefined;
  const names = fields
    ? fields.filter((f) => withVectorStore || f.section !== "vectorstorage").map((f) => f.name)
    : Object.keys(settings ?? {}).filter((k) => k.endsWith("_configuration") && (withVectorStore || k !== "pgvector_configuration"));
  return names
    .map((field) => ({ field, ref: settings?.[field] }))
    .filter((e): e is { field: string; ref: CredentialRef } => isObject(e.ref) && (typeof e.ref.elitea_title === "string" || typeof e.ref.configuration_uuid === "string"));
}

/** `Jira EL`, `Jira EL (personal)`: CREDENTIAL in `toolkits list` and Credential in `get`. */
export function credentialLabel(settings: Doc | undefined, schema?: ToolkitType): string {
  return credentialRefs(settings, schema)
    .map(({ ref }) => `${ref.elitea_title ?? ref.configuration_uuid}${ref.private ? " (personal)" : ""}`)
    .join(", ");
}

/** Where a credential named in a toolkit file was found (AC-5): the first level with a match wins. */
export type CredentialLevel = "project" | "personal" | "shared";

/** A credential by title: exact title, title case-insensitively, then the label the same way. */
export function matchCredentialTitle(rows: Credential[], title: string): Credential[] {
  const q = title.trim();
  const lower = q.toLowerCase();
  for (const match of [
    (c: Credential) => c.elitea_title === q,
    (c: Credential) => c.elitea_title.toLowerCase() === lower,
    (c: Credential) => c.label === q,
    (c: Credential) => (c.label ?? "").toLowerCase() === lower,
  ]) {
    const hits = rows.filter(match);
    if (hits.length) return hits;
  }
  return [];
}

/** The reference saved in the toolkit, as the web UI saves it: by title, `private` for personal. */
export const referenceTo = (c: Credential, level: CredentialLevel): CredentialRef => ({ elitea_title: c.elitea_title, private: level === "personal" });

// ---------------------------------------------------------------------------------------------
// The toolkit file
// ---------------------------------------------------------------------------------------------

/** What a toolkit file may set: the platform's shape, plus `credential: "<title>"`. */
const FILE_FIELDS = ["type", "name", "description", "settings", "meta", "credential"] as const;

/** Fields a `toolkits get -o yaml` file carries that are dropped quietly. */
const SERVER_FIELDS = new Set([
  "id",
  "toolkit_name",
  "author",
  "author_id",
  "agent_type",
  "created_at",
  "updated_at",
  "online",
  "icon_meta",
  "variables",
  "is_pinned",
  "indexes_count",
  "folder_id",
  "folder_name",
  "project_id",
  "owner_id",
  "shared_owner_id",
  "shared_id",
]);

export interface ToolkitFile {
  type?: string;
  name?: string;
  description?: string;
  settings: Doc;
  meta?: Doc;
  /** A credential title, resolved to the type's credential field. */
  credential?: string;
}

export function readToolkitFile(doc: Doc, source: string): ToolkitFile {
  const unknown = Object.keys(doc).filter((k) => !(FILE_FIELDS as readonly string[]).includes(k) && !SERVER_FIELDS.has(k));
  if (unknown.length) throw usageError(`${source}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (allowed: ${FILE_FIELDS.join(", ")})`);
  if (doc.settings !== undefined && doc.settings !== null && !isObject(doc.settings)) throw usageError(`${source}: settings must be an object of fields`);
  if (doc.meta !== undefined && doc.meta !== null && !isObject(doc.meta)) throw usageError(`${source}: meta must be an object`);
  for (const key of ["type", "name", "description", "credential"] as const) {
    if (doc[key] !== undefined && doc[key] !== null && typeof doc[key] !== "string") throw usageError(`${source}: ${key} must be a string`);
  }
  const out: ToolkitFile = { settings: isObject(doc.settings) ? structuredClone(doc.settings) : {} };
  for (const key of ["type", "name", "description", "credential"] as const) if (typeof doc[key] === "string") out[key] = doc[key] as string;
  if (isObject(doc.meta)) out.meta = structuredClone(doc.meta);
  return out;
}

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

function findMask(value: unknown, prefix: string): string | undefined {
  if (value === MASK) return prefix;
  if (isObject(value) || Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const hit = findMask(v, `${prefix}.${k}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * AC-6, AC-8: a secret setting with a value in the file is refused (exit 2), and so is `****` in
 * any setting. A `{{secret.…}}` copied from `toolkits get -o json` is not a value: it keeps the
 * stored secret.
 */
export function checkFileSecrets(file: ToolkitFile, secrets: string[], source: string): void {
  const masked = findMask(file.settings, "settings");
  if (masked) throw usageError(`${source}: ${masked}: ${MASK_IN_FILE}`);
  for (const name of secrets) {
    const v = file.settings[name];
    if (hasValue(v) && !isVaultReference(v)) throw usageError(`${source}: settings.${name}: ${SECRET_IN_FILE}`);
  }
}

/** The file's settings with the credential and the secrets given; vault references dropped. */
function settingsFrom(file: ToolkitFile, secrets: string[], given: Record<string, string>, credential?: { field: string; ref: CredentialRef }): Doc {
  const settings = structuredClone(file.settings);
  for (const name of secrets) if (isVaultReference(settings[name])) delete settings[name];
  if (credential) settings[credential.field] = credential.ref;
  for (const [path, value] of Object.entries(given)) setPath(settings, path, value);
  return settings;
}

/** The create body (AC-5): the file's fields; the platform sets the author and the project. */
export function createBody(file: ToolkitFile, secrets: string[], given: Record<string, string>, credential?: { field: string; ref: CredentialRef }): Doc {
  const body: Doc = { type: file.type, name: file.name, settings: settingsFrom(file, secrets, given, credential) };
  if (file.description !== undefined) body.description = file.description;
  if (file.meta !== undefined) body.meta = file.meta;
  return body;
}

/**
 * The update body (AC-8). The platform's PUT replaces the toolkit, so the stored toolkit is the
 * base: the file's fields change it, a setting set to null is cleared, and secret settings keep
 * their stored `{{secret.…}}` unless a new value is given. `changed` is false when nothing differs.
 */
export function updateBody(
  stored: Toolkit,
  file: ToolkitFile,
  secrets: string[],
  given: Record<string, string>,
  credential?: { field: string; ref: CredentialRef },
): { body: Doc; changed: boolean } {
  const changes = settingsFrom(file, secrets, given, credential);
  const settings = structuredClone(stored.settings ?? {});
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete settings[k];
    else settings[k] = v;
  }
  const body: Doc = {
    type: stored.type,
    name: file.name ?? stored.name ?? stored.toolkit_name,
    description: file.description ?? stored.description ?? null,
    author_id: stored.author_id,
    settings,
    meta: file.meta === undefined ? (stored.meta ?? {}) : { ...(stored.meta ?? {}), ...file.meta },
  };
  const before = { name: stored.name ?? stored.toolkit_name, description: stored.description ?? null, settings: stored.settings ?? {}, meta: stored.meta ?? {} };
  const after = { name: body.name, description: body.description, settings: body.settings, meta: body.meta };
  // A secret given always counts as a change: the CLI cannot compare it with the stored value.
  return { body, changed: Object.keys(given).length > 0 || stable(before) !== stable(after) };
}

/** JSON with sorted keys, so key order never counts as a change. */
export function stable(value: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, norm(v[k])])) : v;
  return JSON.stringify(norm(value));
}

// ---------------------------------------------------------------------------------------------
// Finding a toolkit
// ---------------------------------------------------------------------------------------------

export const toolkitName = (t: Pick<Toolkit, "name" | "toolkit_name" | "id">) => t.name || t.toolkit_name || `toolkit ${t.id}`;

/** Exact id, exact name, name case-insensitively, the sanitized name, then a substring of the name. */
export function findToolkits(rows: Toolkit[], query: string): Toolkit[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  for (const match of [
    (t: Toolkit) => String(t.id) === q,
    (t: Toolkit) => t.name === q,
    (t: Toolkit) => (t.name ?? "").toLowerCase() === lower,
    (t: Toolkit) => (t.toolkit_name ?? "").toLowerCase() === lower,
  ]) {
    const hits = rows.filter(match);
    if (hits.length) return hits;
  }
  return rows.filter((t) => (t.name ?? "").toLowerCase().includes(lower));
}

/** `--tools a,b` (AC-12): names, trimmed, each once. */
export function parseToolList(value: string): string[] {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw usageError("--tools takes tool names separated by commas, e.g. --tools search_issues,create_issue");
  return [...new Set(names)];
}
