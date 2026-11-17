import type { Credential, CredentialType, JsonSchema } from "./elitea.js";
import { usageError } from "./errors.js";
import { isSecretKey, MASK } from "./redact.js";

/**
 * Credentials (story 05a) without I/O: which fields a type keeps secret, masking, and the bodies
 * sent for create and update. A secret value never comes from a file and is never printed.
 */

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** One field of a type's `data`, as `credentials types` lists it (AC-1). */
export interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  secret: boolean;
  /** Set by the platform (sign-in, …), not by the user. */
  hidden: boolean;
  description?: string;
}

/** The type's `data` schema; `{}` when the catalog gives none. */
export function dataSchema(type: CredentialType | undefined): JsonSchema {
  const data = type?.config_schema?.properties?.data;
  return isObject(data) ? (data as JsonSchema) : {};
}

/** `$ref: "#/$defs/X"` resolved against the type's schema, once (Pydantic nests one level). */
function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = ref.replace(/^#\/\$defs\//, "");
  return root.$defs?.[name] ?? schema;
}

/** Pydantic marks SecretStr as `format: password` (also inside `anyOf` for Optional[SecretStr]). */
export function isSecretSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.format === "password" || schema.writeOnly === true) return true;
  return [...(schema.anyOf ?? []), ...(schema.allOf ?? [])].some((s) => isObject(s) && (s.format === "password" || s.writeOnly === true));
}

function typeName(schema: JsonSchema, root: JsonSchema): string {
  const s = deref(schema, root);
  if (Array.isArray(s.enum)) return s.enum.map(String).join("|");
  if (s.type) return s.type;
  const options = (s.anyOf ?? []).map((o) => deref(o, root)).filter((o) => o.type !== "null");
  if (options.length === 1) return typeName(options[0]!, root);
  if (options.length > 1) return options.map((o) => typeName(o, root)).join("|");
  return s.$ref ? String(s.$ref).split("/").pop()! : "any";
}

/** The fields of a type's data, in schema order. */
export function fieldsOf(type: CredentialType | undefined): FieldInfo[] {
  const schema = dataSchema(type);
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, field]) => ({
    name,
    type: typeName(field, schema),
    required: required.has(name),
    secret: isSecretSchema(deref(field, schema)),
    hidden: field.hidden === true,
    ...(typeof field.description === "string" ? { description: field.description } : {}),
  }));
}

/**
 * Secret paths of a type's data: top-level names, and `parent.child` for secrets one object
 * deep (nested credentials). The type schema decides; nothing is guessed from field names.
 */
export function secretPaths(type: CredentialType | undefined): string[] {
  const schema = dataSchema(type);
  const out: string[] = [];
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const f = deref(field, schema);
    if (isSecretSchema(f)) out.push(name);
    const nested = f.properties ?? (f.anyOf ?? []).map((o) => deref(o, schema)).find((o) => o.properties)?.properties;
    for (const [child, sub] of Object.entries(nested ?? {})) if (isSecretSchema(deref(sub, schema))) out.push(`${name}.${child}`);
  }
  return out;
}

const get = (data: Doc, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), data);

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * A copy of `credential` whose secret fields read `****`, whatever the API returned (AC-3).
 * An empty secret stays empty so "not set" can still be told apart.
 */
export function maskCredential<T extends { data?: unknown }>(credential: T, secrets: string[]): T {
  if (!isObject(credential.data)) return credential;
  const data = maskVaultValues(structuredClone(credential.data)) as Doc;
  for (const path of secrets) {
    const keys = path.split(".");
    const last = keys.pop()!;
    const parent = keys.reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), data);
    if (isObject(parent) && hasValue(parent[last])) parent[last] = MASK;
  }
  return { ...credential, data };
}

/**
 * Any value the platform keeps in the vault is a secret, whether or not a schema says so (a type
 * missing from the catalog, a field added since): `{{secret.…}}` is masked at any depth.
 */
function maskVaultValues(value: unknown): unknown {
  if (isVaultReference(value)) return MASK;
  if (Array.isArray(value)) return value.map(maskVaultValues);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskVaultValues(v)]));
  return value;
}

/** Secret paths when the catalog has no schema for the type: fields named like secrets. */
export function guessedSecretPaths(data: unknown): string[] {
  if (!isObject(data)) return [];
  return Object.keys(data).filter((k) => isSecretKey(k));
}

/** What a credential file may set; everything else the platform owns. */
const FILE_FIELDS = ["elitea_title", "label", "type", "shared", "data", "meta"] as const;

/** Fields a `credentials get -o yaml` file carries that are dropped quietly on create/update. */
const SERVER_FIELDS = new Set([
  "id",
  "uuid",
  "project_id",
  "section",
  "status_ok",
  "status_logs",
  "source",
  "author_id",
  "created_at",
  "updated_at",
  "is_pinned",
  "folder_id",
  "folder_name",
  "options",
  "generation",
]);

/** The file's fields that create/update send, after AC-5's checks. */
export interface CredentialFile {
  elitea_title?: string;
  label?: string;
  type?: string;
  shared?: boolean;
  data: Doc;
  meta?: Doc;
}

/** Shape checks on a parsed credential file; secrets are checked once the type is known. */
export function readCredentialFile(doc: Doc, source: string): CredentialFile {
  const unknown = Object.keys(doc).filter((k) => !(FILE_FIELDS as readonly string[]).includes(k) && !SERVER_FIELDS.has(k));
  if (unknown.length) throw usageError(`${source}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (allowed: ${FILE_FIELDS.join(", ")})`);
  if (doc.data !== undefined && !isObject(doc.data)) throw usageError(`${source}: data must be an object of fields`);
  if (doc.meta !== undefined && doc.meta !== null && !isObject(doc.meta)) throw usageError(`${source}: meta must be an object`);
  for (const key of ["elitea_title", "label", "type"] as const) {
    if (doc[key] !== undefined && typeof doc[key] !== "string") throw usageError(`${source}: ${key} must be a string`);
  }
  if (doc.shared !== undefined && typeof doc.shared !== "boolean") throw usageError(`${source}: shared must be true or false`);
  const out: CredentialFile = { data: isObject(doc.data) ? structuredClone(doc.data) : {} };
  for (const key of ["elitea_title", "label", "type"] as const) if (typeof doc[key] === "string") out[key] = doc[key] as string;
  if (typeof doc.shared === "boolean") out.shared = doc.shared;
  if (isObject(doc.meta)) out.meta = doc.meta;
  return out;
}

export const SECRET_IN_FILE = "Secret field must come from --secret or --secret-env, not from the file";
export const MASK_IN_FILE = "Field contains '****'; leave secret fields out to keep stored values";

/**
 * AC-5: a secret field that holds a value in the file is refused (exit 2), and so is `****` in
 * any field. A `{{secret.…}}` reference copied from `credentials get` is not a value: it is left
 * out, so the stored secret stays.
 */
export function checkFileSecrets(file: CredentialFile, secrets: string[], source: string): void {
  const masked = findMask(file.data);
  if (masked) throw usageError(`${source}: data.${masked}: ${MASK_IN_FILE}`);
  for (const path of secrets) {
    const value = get(file.data, path);
    if (!hasValue(value) || isVaultReference(value)) continue;
    throw usageError(`${source}: data.${path}: ${SECRET_IN_FILE}`);
  }
}

function findMask(value: unknown, prefix = ""): string | undefined {
  if (value === MASK) return prefix || "(value)";
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const hit = findMask(v, prefix ? `${prefix}.${k}` : k);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The platform keeps secrets in the vault and stores `{{secret.<name>}}` in the row. */
export const isVaultReference = (v: unknown) => typeof v === "string" && /^\{\{secret\.[^}]+\}\}$/.test(v);

/** A secret path's value set into `data` (one level of nesting, as secretPaths returns). */
export function setPath(data: Doc, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let target = data;
  for (const k of keys) {
    if (!isObject(target[k])) target[k] = {};
    target = target[k] as Doc;
  }
  target[last] = value;
}

/** Drop a secret path (a `{{secret.…}}` copied from `get`, or a field to keep as stored). */
function deletePath(data: Doc, path: string): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), data);
  if (isObject(parent)) delete parent[last];
}

/** `--secret <field>`: a field the type marks secret (exit 2 otherwise, with the secret fields). */
export function checkSecretField(field: string, secrets: string[], typeName: string): void {
  if (secrets.includes(field)) return;
  const list = secrets.length ? secrets.join(", ") : "none";
  throw usageError(`"${field}" is not a secret field of ${typeName} (secret fields: ${list})`);
}

/** The create body: the file's fields, the secrets given, and no vault references. */
export function createBody(file: CredentialFile, secrets: string[], given: Record<string, string>): Doc {
  const data = structuredClone(file.data);
  for (const path of secrets) if (isVaultReference(get(data, path))) deletePath(data, path);
  for (const [path, value] of Object.entries(given)) setPath(data, path, value);
  const body: Doc = { type: file.type, elitea_title: file.elitea_title, label: file.label ?? file.elitea_title, data };
  if (file.shared !== undefined) body.shared = file.shared;
  if (file.meta !== undefined) body.meta = file.meta;
  return body;
}

/**
 * The update body (AC-7). The platform replaces `data` wholesale, so the stored data is the base:
 * the file's fields change it, and secret fields keep their stored `{{secret.…}}` reference
 * unless `--secret` gives a new value. `****` is never sent back.
 */
export function updateBody(stored: Credential, file: CredentialFile, secrets: string[], given: Record<string, string>): Doc {
  const body: Doc = {};
  for (const key of ["elitea_title", "label", "shared", "meta"] as const) {
    if (file[key] !== undefined && JSON.stringify(file[key]) !== JSON.stringify(stored[key] ?? (key === "meta" ? {} : undefined))) body[key] = file[key];
  }
  const changes = structuredClone(file.data);
  for (const path of secrets) if (isVaultReference(get(changes, path))) deletePath(changes, path);
  const data = mergeData(structuredClone(stored.data ?? {}), changes);
  for (const [path, value] of Object.entries(given)) setPath(data, path, value);
  // A secret given always counts as a change: the CLI cannot compare it with the stored value.
  if (Object.keys(given).length > 0 || !sameData(data, stored.data ?? {})) body.data = data;
  return body;
}

/** Equal data, whatever the key order; a missing key and `null` are the same (the API returns both). */
function sameData(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    isObject(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== null && v[k] !== undefined).map((k) => [k, norm(v[k])]))
      : Array.isArray(v)
        ? v.map(norm)
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** `changes` over `base`, one object level deep for nested credentials; `null` clears a field. */
function mergeData(base: Doc, changes: Doc): Doc {
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete base[k];
    else if (isObject(v) && isObject(base[k])) base[k] = { ...(base[k] as Doc), ...v };
    else base[k] = v;
  }
  return base;
}

/** SCOPE in `credentials list` (AC-2, AC-12). */
export function scopeOf(credential: Credential, projectId: number, personalProjectId: number | undefined): "project" | "personal" | "shared" {
  if (credential.project_id !== projectId) return "shared";
  if (credential.shared) return "shared";
  return projectId === personalProjectId ? "personal" : "project";
}

/** STATUS in `credentials list`: the stored result of the last check; no check is run (AC-2). */
export function statusOf(credential: Pick<Credential, "status_ok" | "status_logs">): "ok" | "failed" | "unknown" {
  if (credential.status_ok === true) return "ok";
  if (credential.status_logs) return "failed";
  return "unknown";
}

/** Types whose credential holds a browser sign-in (Microsoft login) in `refresh_token` (AC-11). */
export function needsSignIn(type: CredentialType | undefined, credential: Credential): boolean {
  const field = dataSchema(type).properties?.refresh_token;
  if (!field || !isSecretSchema(deref(field, dataSchema(type)))) return false;
  // The credential acts with each person's own Microsoft sign-in: nothing to store here.
  if (credential.data?.auth_mode === "entra_delegated") return false;
  return !hasValue(credential.data?.refresh_token);
}

/** Exact id, exact title, title case-insensitively, then label; ambiguity is reported by the caller. */
export function findCredentials(rows: Credential[], query: string): Credential[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  for (const match of [
    (c: Credential) => String(c.id) === q,
    (c: Credential) => c.elitea_title === q,
    (c: Credential) => c.elitea_title.toLowerCase() === lower,
    (c: Credential) => c.label === q,
    (c: Credential) => (c.label ?? "").toLowerCase() === lower,
  ]) {
    const hits = rows.filter(match);
    if (hits.length) return hits;
  }
  return rows.filter((c) => c.elitea_title.toLowerCase().includes(lower) || (c.label ?? "").toLowerCase().includes(lower));
}

/** The name shown for a credential: its label, else its title. */
export const titleOf = (c: Pick<Credential, "label" | "elitea_title">) => c.label || c.elitea_title;
