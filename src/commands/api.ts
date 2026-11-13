import { readFile, writeFile } from "node:fs/promises";
import { type HttpMethod, isLoginRedirect } from "../elitea.js";
import { CliError, EXIT, exitCodeForStatus, usageError } from "../errors.js";
import { readStdin } from "../interaction.js";
import { projectSession } from "./common.js";

export interface ApiOptions {
  file?: string;
  field?: string[];
  header?: string[];
  include?: boolean;
  outputFile?: string;
  project?: string;
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function parseMethod(raw: string): HttpMethod {
  const m = raw.toUpperCase() as HttpMethod;
  if (!METHODS.includes(m)) throw usageError(`Method must be one of ${METHODS.join(", ")}, got "${raw}"`);
  return m;
}

/**
 * The request path: `/…` as given, or a full URL on the environment's own origin (AC-15, AC-18).
 * Any other origin is refused, so the token never leaves the environment.
 */
export function parsePath(raw: string, envUrl?: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // Origin checked once the environment is known; here only the shape.
    if (envUrl === undefined) return raw;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw usageError(`Not a valid URL: ${raw}`);
    }
    if (url.origin !== new URL(envUrl).origin) throw usageError(`api only calls the active environment (${envUrl})`);
    return `${url.pathname}${url.search}`;
  }
  if (!raw.startsWith("/")) throw usageError(`The path must start with /, for example /api/v2/auth/user/, got "${raw}"`);
  return raw;
}

/** `--field k=v`: numbers and true/false/null are typed, everything else is a string. */
export function parseFields(pairs: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw usageError(`--field must be key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    out[key] =
      raw === "true" ? true
      : raw === "false" ? false
      : raw === "null" ? null
      : raw.trim() !== "" && Number.isFinite(Number(raw)) && !/^0\d/.test(raw) ? Number(raw)
      : raw;
  }
  return out;
}

/** `-H 'Name: value'`; an Authorization header is refused in any letter case (AC-16). */
export function parseHeaders(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of values ?? []) {
    const colon = h.indexOf(":");
    if (colon <= 0) throw usageError(`-H must be 'Name: value', got "${h}"`);
    const name = h.slice(0, colon).trim();
    if (name.toLowerCase() === "authorization") throw usageError("api sends the stored token itself; -H Authorization is not allowed");
    out[name] = h.slice(colon + 1).trim();
  }
  return out;
}

function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

/** `api <METHOD> <path>`: a raw call with the stored token; the response unchanged (AC-15…AC-18). */
export async function apiCommand(methodArg: string, pathArg: string, opts: ApiOptions): Promise<number> {
  const method = parseMethod(methodArg);
  parsePath(pathArg);
  const headers = parseHeaders(opts.header);
  const fields = parseFields(opts.field);
  const hasFields = Object.keys(fields).length > 0;
  if (opts.file !== undefined && hasFields) throw usageError("Give the body with -f or with --field, not both");
  if (opts.file !== undefined && method === "GET") throw usageError("GET takes no body; use --field for query parameters");

  let body: string | undefined;
  if (opts.file !== undefined) {
    try {
      body = opts.file === "-" ? await readStdin("-f -") : await readFile(opts.file, "utf8");
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw usageError(`Cannot read ${opts.file}: ${(err as Error).message}`);
    }
  }

  const { client, projectId, baseUrl } = await projectSession(opts.project);
  let path = parsePath(pathArg, baseUrl).replaceAll("{project}", String(projectId));
  let jsonBody: unknown;
  if (hasFields && (method === "GET" || method === "DELETE")) {
    const params = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]));
    path = `${path}${path.includes("?") ? "&" : "?"}${params}`;
  } else if (hasFields) {
    jsonBody = fields;
  }
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = prettyJson(body) === undefined ? "text/plain" : "application/json";
  }

  const res = await client.send(method, path, { body: jsonBody, raw: body, headers });

  if (opts.include) {
    process.stderr.write(`HTTP ${res.status} ${res.statusText}\n`);
    res.headers.forEach((value, name) => process.stderr.write(`${name}: ${value}\n`));
    process.stderr.write("\n");
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    if (isLoginRedirect(location)) throw new CliError("EliteA rejected the token — run `elitea-cli login` again", EXIT.auth);
    console.error(`Redirect (${res.status}) to ${location || "(no location)"}`);
    return EXIT.general;
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  const isJson = type.includes("json");
  const text = () => {
    const raw = bytes.toString("utf8");
    return (isJson && prettyJson(raw)) || raw;
  };

  if (!res.ok) {
    const out = text();
    if (out) process.stderr.write(out.endsWith("\n") ? out : `${out}\n`);
    return exitCodeForStatus(res.status);
  }
  if (opts.outputFile !== undefined) {
    await writeFile(opts.outputFile, bytes);
    console.error(`Saved ${bytes.length} bytes to ${opts.outputFile}`);
    return EXIT.ok;
  }
  if (isJson) {
    const out = text();
    if (out) console.log(out);
  } else {
    process.stdout.write(bytes);
  }
  return EXIT.ok;
}
