export const URL_HINT = "Enter a full URL, for example https://<your-server>";
export const ENV_NAME_HINT = "Use 1–40 letters, digits, '.', '-' or '_'";

const ENV_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

/**
 * `scheme://host[:port]`: scheme and host lower-cased, default port, path, query and
 * trailing slash dropped. Undefined for anything that is not a full http(s) URL.
 */
export function tryNormalizeUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!url.hostname || url.username || url.password) return undefined;
  return `${url.protocol}//${url.host}`;
}

/** `host[:port]` of a normalized URL; also the OS keychain account name (credentials.ts). */
export function originKey(url: string): string {
  return new URL(url).host;
}

export function urlScheme(url: string): string {
  return new URL(url).protocol.replace(/:$/, "");
}

/** Suggested environment name: the origin key with `:` (and anything else not allowed) as `-`. */
export function defaultEnvName(url: string): string {
  return originKey(url).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
}

export function isLocalUrl(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}
