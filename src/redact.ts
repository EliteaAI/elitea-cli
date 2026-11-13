/** Keys whose values never appear in --debug output (AC-13), matched case-insensitively. */
const SECRET_KEY = /token|secret|password|api[_-]?key|private[_-]?key|client[_-]?secret/i;

export const MASK = "****";

function isSecretKey(key: string, extra: string[]): boolean {
  return SECRET_KEY.test(key) || extra.includes(key);
}

/** A copy of `value` with every secret field masked, at any depth. */
export function redactValue(value: unknown, extra: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extra));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, isSecretKey(k, extra) && v !== null && v !== "" ? MASK : redactValue(v, extra)]),
    );
  }
  return value;
}

/** A path with a query string whose secret parameters are masked. */
export function redactPath(path: string, extra: string[] = []): string {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const params = new URLSearchParams(path.slice(q + 1));
  for (const key of [...new Set(params.keys())]) {
    if (isSecretKey(key, extra)) params.set(key, MASK);
  }
  const query = params.toString().replaceAll(encodeURIComponent(MASK), MASK);
  return query ? `${path.slice(0, q)}?${query}` : path.slice(0, q);
}

/** A body for the debug log: JSON is parsed and masked; anything else is shown by size only. */
export function redactBody(text: string, extra: string[] = [], max = 2000): string {
  if (!text) return "";
  let shown: string;
  try {
    shown = JSON.stringify(redactValue(JSON.parse(text), extra));
  } catch {
    return `(${text.length} bytes, not JSON)`;
  }
  return shown.length > max ? `${shown.slice(0, max)}… (${shown.length} chars)` : shown;
}

/** Remove `secret` from any text (stack traces, messages). */
export function scrub(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join(MASK) : text;
}
