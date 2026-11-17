import { password, search } from "@inquirer/prompts";
import { readFile } from "node:fs/promises";
import { parseDocument } from "../authoring.js";
import { ctx } from "../context.js";
import {
  type CredentialFile,
  checkFileSecrets,
  checkSecretField,
  createBody,
  fieldsOf,
  findCredentials,
  guessedSecretPaths,
  maskCredential,
  needsSignIn,
  readCredentialFile,
  scopeOf,
  secretPaths,
  statusOf,
  titleOf,
  updateBody,
} from "../credentialsCore.js";
import { AccessDeniedError, type Credential, type CredentialType, type EliteaClient, EliteaError } from "../elitea.js";
import { CliError, EXIT, needsTerminal, notFoundError, usageError } from "../errors.js";
import { claimStdin, confirmDestructive, readStdin } from "../interaction.js";
import { type OutputFormat, parseFormat, printData, printQuiet, render } from "../output.js";
import { isInteractive } from "../session.js";
import { projectSession } from "./common.js";

export interface CredentialOptions {
  type?: string;
  file?: string;
  secret?: string[];
  secretEnv?: string[];
  yes?: boolean;
  project?: string;
  output?: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Session, types and lookup
// ---------------------------------------------------------------------------------------------

interface Session {
  client: EliteaClient;
  projectId: number;
  baseUrl: string;
  types: CredentialType[];
}

async function session(opts: CredentialOptions): Promise<Session> {
  const { client, projectId, baseUrl } = await projectSession(opts.project);
  const types = await client.listCredentialTypes(projectId);
  return { client, projectId, baseUrl, types };
}

const typeOf = (s: Session, name: string) => s.types.find((t) => t.type === name);

/**
 * The type's secret fields, also masked in --debug for the rest of the command (AC-3, AC-14).
 * A type missing from the catalog has no schema: then fields of `data` named like secrets count.
 */
function secretsOf(type: CredentialType | undefined, data?: unknown): string[] {
  const paths = type ? secretPaths(type) : guessedSecretPaths(data);
  ctx.secretKeys = [...new Set([...ctx.secretKeys, ...paths.map((p) => p.split(".").pop()!)])];
  return paths;
}

/**
 * The type a file names. A type the catalog does not list (admin-managed ones are hidden from it,
 * others don't exist) is still sent: the platform's refusal is the answer (AC-8). With no schema
 * the CLI cannot tell secret fields apart, so then --secret is refused and the file may hold none.
 */
function requireType(s: Session, name: string | undefined, source: string): CredentialType | undefined {
  if (!name) throw usageError(`${source}: type is missing — run \`elitea-cli credentials types\``);
  return typeOf(s, name);
}

/** Credentials this project can use: its own and those shared with it (AC-2). */
const visible = (s: Session, type?: string) => s.client.listCredentials(s.projectId, { type, includeShared: true });

/** One credential by id or title (story 02 AC-21a); unknown or ambiguous → exit 5. */
async function resolveCredential(s: Session, query: string | undefined, verb: string): Promise<Credential> {
  const rows = await visible(s);
  if (query === undefined) {
    if (!isInteractive()) throw needsTerminal("The credential picker", `name the credential: elitea-cli credentials ${verb} <credential>`);
    if (rows.length === 0) throw notFoundError(`No credentials in project ${s.projectId}`);
    return search<Credential>({
      message: "Credential",
      pageSize: 12,
      source: (term) =>
        rows
          .filter((c) => !term || `${c.elitea_title} ${c.label ?? ""} ${c.id}`.toLowerCase().includes(term.toLowerCase()))
          .map((c) => ({ name: `${titleOf(c)}  (${c.id}, ${c.type})`, value: c })),
    });
  }
  const hits = findCredentials(rows, query);
  // The same id can come from this project and from the shared list: prefer this project's.
  const own = hits.filter((c) => c.project_id === s.projectId);
  const pick = hits.length > 1 && own.length === 1 && String(own[0]!.id) === query.trim() ? own : hits;
  if (pick.length === 1) return pick[0]!;
  if (pick.length === 0) throw notFoundError(`Credential "${query}" not found — run \`elitea-cli credentials list\``);
  throw notFoundError(`Credential "${query}" matches several: ${pick.map((c) => `${c.elitea_title} (${c.id})`).join(", ")} — use the id`);
}

/** Writes go to the credential's own project: a shared one lives in the public project. */
function ownProject(s: Session, c: Credential, verb: string): number {
  if (c.project_id === s.projectId) return s.projectId;
  throw new CliError(
    `${titleOf(c)} (${c.id}) is shared from project ${c.project_id}; ${verb} it there: elitea-cli credentials ${verb} ${c.id} -p ${c.project_id}`,
    EXIT.denied,
  );
}

const projectUrl = (s: Session, c: Credential) => `${s.baseUrl}/app/${c.project_id}/credentials/all/${c.id}`;

/** AC-11: the CLI never signs in; it says where to. */
const signInText = (s: Session, c: Credential) => `Sign-in required: open ELITEA → Credentials → ${titleOf(c)} to sign in (${projectUrl(s, c)})`;

// ---------------------------------------------------------------------------------------------
// types, list, get
// ---------------------------------------------------------------------------------------------

/** `credentials types` (AC-1): TYPE, TITLE, SECTION and the fields; -o json the full schema. */
export async function typesCommand(opts: CredentialOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const types = opts.type ? s.types.filter((t) => t.type === opts.type) : s.types;
  if (opts.type && types.length === 0) throw notFoundError(`Unknown credential type "${opts.type}" — run \`elitea-cli credentials types\``);
  if (format !== "text") {
    printData(format, types);
    return;
  }
  const fieldText = (t: CredentialType) =>
    fieldsOf(t)
      .filter((f) => !f.hidden)
      .map((f) => `${f.name}${f.required ? "*" : ""}${f.secret ? " (secret)" : ""}`)
      .join(", ");
  render(
    types,
    [
      { header: "TYPE", value: (t) => t.type },
      { header: "TITLE", value: (t) => t.config_schema?.title ?? t.type },
      { header: "SECTION", value: (t) => t.section },
      { header: "FIELDS", value: fieldText },
    ],
    format,
    "credential types",
  );
  if (types.length) console.error("* required · (secret) give with --secret <field> or --secret-env <field>=<VAR>");
}

/** `credentials list [--type]` (AC-2): no connection check is run; STATUS is the stored one. */
export async function listCommand(opts: CredentialOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const rows = await visible(s, opts.type);
  const user = await s.client.getUser().catch(() => undefined);
  const personal = user?.personal_project_id;
  if (format !== "text") {
    printData(format, rows.map((c) => ({ ...maskCredential(c, secretsOf(typeOf(s, c.type), c.data)), scope: scopeOf(c, s.projectId, personal), status: statusOf(c) })));
    return;
  }
  render(
    rows,
    [
      { header: "ID", value: (c) => c.id },
      { header: "TITLE", value: (c) => c.elitea_title },
      { header: "TYPE", value: (c) => c.type },
      { header: "SCOPE", value: (c) => scopeOf(c, s.projectId, personal) },
      { header: "STATUS", value: (c) => statusOf(c) },
      { header: "NAME", value: (c) => c.label ?? "" },
    ],
    format,
    "credentials",
  );
}

/** Human view: every field, secret ones as ****; fields the schema doesn't know as returned. */
function formatCredential(c: Credential, type: CredentialType | undefined, scope: string): string[] {
  const fields = fieldsOf(type);
  const known = new Set(fields.map((f) => f.name));
  const show = (v: unknown) => (v === undefined || v === null || v === "" ? "(not set)" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const width = Math.max(14, ...Object.keys(c.data ?? {}).map((k) => k.length + 2));
  const line = (k: string, v: unknown) => `  ${`${k}:`.padEnd(width)} ${show(v)}`;
  const data = c.data ?? {};
  const out = [
    `ID:      ${c.id}`,
    `Title:   ${c.elitea_title}`,
    `Name:    ${c.label ?? ""}`,
    `Type:    ${c.type}${type?.config_schema?.title ? ` (${type.config_schema.title})` : ""}`,
    `Scope:   ${scope}`,
    `Status:  ${statusOf(c)}`,
    "Fields:",
    ...fields.filter((f) => !f.hidden || data[f.name] !== undefined).map((f) => line(f.name, data[f.name])),
    ...Object.keys(data).filter((k) => !known.has(k)).map((k) => line(k, data[k])),
  ];
  return out;
}

/** `credentials get <cred>` (AC-3, AC-11). */
export async function getCommand(query: string | undefined, opts: CredentialOptions): Promise<void> {
  const format = parseFormat(opts, true);
  const s = await session(opts);
  const found = await resolveCredential(s, query, "get");
  const c = await s.client.getCredential(found.project_id, found.id);
  const type = typeOf(s, c.type);
  const masked = maskCredential(c, secretsOf(type, c.data));
  const signIn = needsSignIn(type, c);
  if (format !== "text") printData(format, masked);
  else {
    const user = await s.client.getUser().catch(() => undefined);
    for (const line of formatCredential(masked, type, scopeOf(c, s.projectId, user?.personal_project_id))) console.log(line);
  }
  if (signIn) console.error(signInText(s, c));
}

// ---------------------------------------------------------------------------------------------
// create, update
// ---------------------------------------------------------------------------------------------

async function readSource(path: string): Promise<{ text: string; source: string }> {
  try {
    return { text: path === "-" ? await readStdin("-f -") : await readFile(path, "utf8"), source: path === "-" ? "stdin" : path };
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

/** --secret-env field=VAR, checked before anything is read. */
function parseSecretEnv(values: string[]): Array<{ field: string; variable: string }> {
  return values.map((v) => {
    const eq = v.indexOf("=");
    if (eq <= 0 || eq === v.length - 1) throw usageError(`--secret-env takes <field>=<ENV_VAR>, got "${v}"`);
    return { field: v.slice(0, eq), variable: v.slice(eq + 1) };
  });
}

/**
 * AC-4, AC-6: secret values from a masked prompt (terminal), stdin (exactly one --secret) or
 * environment variables. Nothing is ever taken from the command line itself.
 */
async function collectSecrets(opts: CredentialOptions, secrets: string[], typeName: string): Promise<Record<string, string>> {
  const prompted = opts.secret ?? [];
  const fromEnv = parseSecretEnv(opts.secretEnv ?? []);
  const fields = [...prompted, ...fromEnv.map((e) => e.field)];
  const twice = fields.find((f, i) => fields.indexOf(f) !== i);
  if (twice) throw usageError(`Secret field "${twice}" is given twice`);
  for (const f of fields) checkSecretField(f, secrets, typeName);

  const out: Record<string, string> = {};
  for (const { field, variable } of fromEnv) {
    const value = process.env[variable];
    if (!value) throw usageError(`Environment variable is not set: ${variable} (for --secret-env ${field})`);
    out[field] = value;
  }
  if (prompted.length === 0) return out;
  if (isInteractive()) {
    for (const field of prompted) out[field] = await password({ message: `${field} (${typeName})`, mask: "*", validate: (v) => (v ? true : "Enter a value") });
  } else {
    // AC-6 / story 02 AC-21b: stdin can carry one value only.
    if (prompted.length > 1) throw new CliError("Only one option can read stdin: give one --secret, the others with --secret-env", EXIT.usage);
    claimStdin(`--secret ${prompted[0]}`);
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    // One trailing newline (echo, here-strings) is not part of the secret.
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!value) throw usageError(`--secret ${prompted[0]}: stdin is empty`);
    out[prompted[0]!] = value;
  }
  return out;
}

/** Keep every value given out of all later output (AC-14), even in platform messages. */
function remember(given: Record<string, string>): void {
  ctx.secretValues.push(...Object.values(given));
}

/** Output of a write: -q the id, -o json|yaml the masked object, else the sentence. */
function report(format: OutputFormat, c: Credential, secrets: string[], sentence: string): void {
  if (printQuiet(c.id)) return;
  if (format !== "text") printData(format, maskCredential(c, secrets));
  else console.log(sentence);
}

export const CHANGED_BY_SOMEONE = (title: string) => `${title} was changed by someone else; run the command again`;

/** AC-8: refusals print the platform's text unchanged; 400/409 → exit 6, 403 → story 02 AC-8 (exit 4). */
function refusal(err: unknown, title?: string): unknown {
  if (err instanceof EliteaError && err.platform?.field === "generation" && title) return new CliError(CHANGED_BY_SOMEONE(title), EXIT.conflict);
  if (err instanceof AccessDeniedError) {
    // An admin-managed type and a team sign-in are platform rules, not missing permissions (AC-8, AC-12).
    const text = err.platform?.text;
    if (text && /managed (in|by)|Only project admins|Tracing configurations/i.test(text)) return new CliError(text, EXIT.conflict);
    return err;
  }
  if (!(err instanceof EliteaError) || ![400, 409, 422].includes(err.status)) return err;
  const raw = err.platform?.text;
  const text = readableValidation(raw);
  // The field is named in a parsed validation text already.
  const field = text !== raw ? undefined : err.platform?.field;
  const lines = [text && field && !["unknown", "database"].includes(field) && !text.includes(field) ? `${field}: ${text}` : text, ...(err.platform?.fields ?? [])].filter(Boolean);
  return new CliError(lines.length ? lines.join("\n") : err.message, EXIT.conflict);
}

/**
 * The platform words a failed type validation as a Python repr of Pydantic's errors:
 * `Value error, [{'type': 'missing', 'loc': ('base_url',), 'msg': 'Field required', …}]`.
 * Each error becomes `<loc>: <msg>`; any other text is kept as it is.
 */
export function readableValidation(text: string | undefined): string | undefined {
  if (!text || !text.includes("'loc'")) return text;
  const errors = [...text.matchAll(/'loc':\s*\(([^)]*)\),\s*'msg':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => {
    const loc = [...m[1]!.matchAll(/'([^']*)'|(\d+)/g)].map((p) => p[1] ?? p[2]).join(".");
    return loc ? `${loc}: ${m[2]}` : m[2]!;
  });
  return errors.length ? errors.join("\n") : text;
}

/** The file, parsed and checked (AC-5) before anything is read from stdin or sent. */
async function readFileFor(opts: CredentialOptions): Promise<{ file: CredentialFile; source: string }> {
  if (opts.file === undefined) throw usageError("Give the credential as a YAML or JSON file: -f <file>");
  if (opts.file === "-" && (opts.secret ?? []).length > 0 && !isInteractive()) {
    throw new CliError("Only one option can read stdin: -f - and --secret both read it", EXIT.usage);
  }
  const { text, source } = await readSource(opts.file);
  return { file: readCredentialFile(parseDocument(text, source), source), source };
}

/** `credentials create -f cred.yaml [--secret f] [--secret-env f=VAR]` (AC-4…AC-6, AC-8, AC-13). */
export async function createCommand(opts: CredentialOptions): Promise<void> {
  const format = parseFormat(opts);
  const { file, source } = await readFileFor(opts);
  if (!file.elitea_title) throw usageError(`${source}: elitea_title is missing (the credential's unique id, letters, digits and _)`);
  const s = await session(opts);
  const type = requireType(s, file.type, source);
  // No schema: a field whose name looks secret is treated as one, so no value slips through a file.
  const secrets = secretsOf(type, file.data);
  checkFileSecrets(file, secrets, source);
  if (!type && ((opts.secret ?? []).length || (opts.secretEnv ?? []).length)) {
    throw notFoundError(`Unknown credential type "${file.type}" — run \`elitea-cli credentials types\``);
  }
  const given = await collectSecrets(opts, secrets, file.type!);
  remember(given);

  let created: Credential;
  try {
    created = await s.client.createCredential(s.projectId, createBody(file, secrets, given));
  } catch (err) {
    throw refusal(err);
  }
  report(format, created, secrets, `Created credential ${created.elitea_title} (${created.id})`);
  // AC-13: today the create answer carries no governance status (open question 3); a message the
  // platform adds is printed as it says it.
  const said = (created as Record<string, unknown>).message;
  if (typeof said === "string" && said) console.error(said);
  if (needsSignIn(type, created)) console.error(signInText(s, created));
}

/**
 * AC-7a (the platform's PUT takes no generation): the credential must be the one that was read.
 * It is read again right before the PUT; a change in between → exit 6, nothing sent.
 */
async function ensureUnchanged(s: Session, projectId: number, read: Credential): Promise<void> {
  const now = await s.client.getCredential(projectId, read.id);
  const same = now.updated_at === read.updated_at && JSON.stringify(now.data) === JSON.stringify(read.data);
  if (!same) throw new CliError(CHANGED_BY_SOMEONE(titleOf(read)), EXIT.conflict);
}

/** `credentials update <cred> -f cred.yaml [--secret …]` (AC-7, AC-8). */
export async function updateCommand(query: string, opts: CredentialOptions): Promise<void> {
  const format = parseFormat(opts);
  const { file, source } = await readFileFor(opts);
  const s = await session(opts);
  const found = await resolveCredential(s, query, "update");
  const projectId = ownProject(s, found, "update");
  const stored = await s.client.getCredential(projectId, found.id);
  if (file.type !== undefined && file.type !== stored.type) {
    throw usageError(`${source}: type is ${file.type}, but ${titleOf(stored)} is a ${stored.type} credential (a type cannot change)`);
  }
  const type = typeOf(s, stored.type);
  const secrets = secretsOf(type, stored.data);
  checkFileSecrets(file, secrets, source);
  const given = await collectSecrets(opts, secrets, stored.type);
  remember(given);

  const body = updateBody(stored, file, secrets, given);
  if (Object.keys(body).length === 0) {
    console.error("No changes");
    return;
  }
  await ensureUnchanged(s, projectId, stored);
  let updated: Credential;
  try {
    updated = await s.client.updateCredential(projectId, stored.id, body);
  } catch (err) {
    throw refusal(err, titleOf(stored));
  }
  report(format, updated, secrets, `Updated credential ${updated.elitea_title} (${updated.id})`);
}

// ---------------------------------------------------------------------------------------------
// test, delete
// ---------------------------------------------------------------------------------------------

/** `credentials test <cred>` (AC-9): exit 0 connected, 1 not; no secret permission → 403, exit 4. */
export async function testCommand(query: string, opts: CredentialOptions): Promise<number> {
  const format = parseFormat(opts);
  const s = await session(opts);
  const found = await resolveCredential(s, query, "test");
  const c = await s.client.getCredential(found.project_id, found.id);
  const type = typeOf(s, c.type);
  secretsOf(type, c.data);
  if (type && type.has_test_connection === false) throw usageError(`${c.type} credentials have no connection check`);
  const result = await s.client.checkCredential(s.projectId, c);
  if (format !== "text") printData(format, { credential: { id: c.id, title: c.elitea_title, type: c.type }, ...result });
  else if (result.ok) console.log("Connection OK");
  else console.log(`Connection failed: ${result.message ?? "no reason given"}`);
  if (result.signInRequired || (!result.ok && needsSignIn(type, c))) console.error(signInText(s, c));
  return result.ok ? EXIT.ok : EXIT.general;
}

/** `credentials delete <cred>` (AC-10, AC-10a): confirmed, then deleted; refusals as the platform says. */
export async function deleteCommand(query: string, opts: CredentialOptions): Promise<void> {
  const s = await session(opts);
  const found = await resolveCredential(s, query, "delete");
  const projectId = ownProject(s, found, "delete");
  const ok = await confirmDestructive({
    action: "delete",
    type: "credential",
    name: found.elitea_title,
    id: found.id,
    note: "Toolkits that use it stop working until they get another credential.",
    yes: opts.yes,
  });
  if (!ok) return;
  try {
    await s.client.deleteCredential(projectId, found.id);
  } catch (err) {
    throw refusal(err);
  }
  if (!printQuiet(found.id)) console.log(`Deleted credential ${found.elitea_title} (${found.id})`);
}
