import type { TokenOperation } from "./context.js";

/** What an EliteA error response says, read as AC-7d describes. */
export interface PlatformError {
  /** Human text: `error` (when it is a sentence), else `message`. */
  text?: string;
  /** Stable code: `code`, or an identifier-like `error` (`TOKEN_SCOPE_PROJECT`, `too_many_drafts`). */
  code?: string;
  /** Field errors as `<field>: <message>` (Pydantic lists). */
  fields: string[];
  /** Seconds, from the body's `retry_after` or the Retry-After header. */
  retryAfter?: number;
  /** The platform says it is a budget limit. */
  budget: boolean;
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function flatten(list: unknown[]): string[] {
  return list.map((e) => {
    if (!isObject(e)) return String(e);
    const loc = Array.isArray(e.loc) ? e.loc.join(".") : str(e.field) ?? "";
    const msg = str(e.msg) ?? str(e.message) ?? JSON.stringify(e);
    return loc ? `${loc}: ${msg}` : msg;
  });
}

/**
 * Bodies seen on EliteA: `{"error": "<text or CODE>", "message"?, "code"?, "retry_after"?}`,
 * `{"error": {"message", "type", "code"}}` (budget refusals), Pydantic `[{loc, msg}]`, or not
 * JSON at all (first 300 characters).
 */
export function parseErrorBody(raw: string, retryAfterHeader?: string | null): PlatformError {
  const out: PlatformError = { fields: [], budget: false };
  const header = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(header) && header > 0) out.retryAfter = header;
  if (!raw.trim()) return out;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    out.text = raw.trim().slice(0, 300);
    return out;
  }
  if (Array.isArray(body)) {
    out.fields = flatten(body);
    return out;
  }
  if (!isObject(body)) {
    out.text = String(body).slice(0, 300);
    return out;
  }
  const retry = Number(body.retry_after);
  if (Number.isFinite(retry) && retry > 0) out.retryAfter = retry;

  const nested = isObject(body.error) ? body.error : undefined;
  const src = nested ?? body;
  let errorText = nested ? undefined : str(body.error);
  out.code = str(src.code);
  if (!out.code && errorText && CODE_RE.test(errorText)) {
    out.code = errorText;
    errorText = undefined;
  }
  out.text = errorText ?? str(src.message) ?? (typeof body.detail === "string" ? str(body.detail) : undefined);
  for (const list of [body.error, body.errors, body.detail]) if (Array.isArray(list)) out.fields.push(...flatten(list));
  out.budget = str(src.type) === "budget_exceeded" || /budget/i.test(out.code ?? "");
  return out;
}

/** `<text> (<code>)`, or whichever of the two there is. */
export function platformText(err: PlatformError): string | undefined {
  if (err.text && err.code) return `${err.text} (${err.code})`;
  return err.text ?? err.code;
}

export const BUSY_MESSAGE = "EliteA is busy (503); nothing was retried — try again";

export interface ErrorContext {
  projectId?: number;
  operation?: TokenOperation;
}

/** The CLI's message for an HTTP error status (AC-8…AC-11). `path` has no query string. */
export function httpErrorMessage(status: number, path: string, err: PlatformError, where: ErrorContext = {}): string {
  const text = platformText(err);
  const project = where.projectId === undefined ? "this project" : `project ${where.projectId}`;
  if (status === 403) {
    if (err.code?.startsWith("TOKEN_SCOPE_")) {
      const first = `This token is not allowed to do this (${err.code}).`;
      return where.operation ? `${first} Create a token with the '${where.operation}' operation for ${project}` : first;
    }
    return `Forbidden${text ? `: ${text}` : ""}\nThe token may lack permissions, or your role in ${project} does not allow this`;
  }
  if (status === 429) {
    const head = err.budget ? `EliteA budget for this project is exhausted (429)` : "EliteA refused the request: limit reached (429)";
    const lines = [text ? `${head}: ${text}` : head];
    if (err.retryAfter !== undefined) lines.push(`Retry after ${err.retryAfter} s`);
    return lines.join("\n");
  }
  if ([400, 409, 413, 422].includes(status) && err.fields.length > 0) {
    return [...(text ? [text] : []), ...err.fields].join("\n");
  }
  return `EliteA ${path} failed: HTTP ${status}${text ? ` — ${text}` : ""}`;
}
