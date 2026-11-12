import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eliteaCliHome } from "./config.js";
import { writeFileAtomic } from "./fsutil.js";
import { tryNormalizeUrl } from "./urls.js";

const SERVICE = "elitea-cli";

/**
 * PAT storage: OS keychain when available, otherwise a 0600 file in ~/.elitea-cli.
 * Keychain entries are keyed by host[:port], file entries by normalized URL, so a token
 * stored for one server is never returned for another.
 * ELITEA_CLI_TOKEN always wins so CI can run without any stored secret.
 */
export interface TokenStore {
  /** ELITEA_CLI_TOKEN when set, else the token stored for this server. */
  get(url: string): Promise<string | undefined>;
  /** The token stored for this server only, ignoring ELITEA_CLI_TOKEN. */
  getStored(url: string): Promise<string | undefined>;
  set(url: string, token: string): Promise<"keychain" | "file">;
  delete(url: string): Promise<void>;
}

type KeyringEntry = { getPassword(): string | null | undefined; setPassword(p: string): void; deletePassword(): boolean | void };

async function keyringEntry(url: string): Promise<KeyringEntry | undefined> {
  if (process.env.ELITEA_CLI_NO_KEYCHAIN) return undefined;
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, new URL(url).host) as KeyringEntry;
  } catch {
    return undefined;
  }
}

function credentialsPath(): string {
  return join(eliteaCliHome(), "credentials.json");
}

async function readFileStore(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeFileStore(store: Record<string, string>): Promise<void> {
  if (Object.keys(store).length === 0) {
    await rm(credentialsPath(), { force: true });
    return;
  }
  await writeFileAtomic(credentialsPath(), JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

/** File-store keys for this server: an older CLI may have saved it with a trailing slash or other case. */
function matchingKeys(store: Record<string, string>, url: string): string[] {
  const norm = tryNormalizeUrl(url) ?? url;
  return Object.keys(store).filter((key) => key === url || (tryNormalizeUrl(key) ?? key) === norm);
}

async function storedToken(url: string): Promise<string | undefined> {
  const entry = await keyringEntry(url);
  if (entry) {
    try {
      const token = entry.getPassword();
      if (token) return token;
    } catch {
      // fall through to file store
    }
  }
  const store = await readFileStore();
  const key = matchingKeys(store, url)[0];
  return key === undefined ? undefined : store[key];
}

async function dropFromFileStore(url: string): Promise<void> {
  const store = await readFileStore();
  const keys = matchingKeys(store, url);
  if (keys.length === 0) return;
  for (const key of keys) delete store[key];
  await writeFileStore(store);
}

export const tokenStore: TokenStore = {
  async get(url) {
    if (process.env.ELITEA_CLI_TOKEN) return process.env.ELITEA_CLI_TOKEN;
    return storedToken(url);
  },

  getStored: storedToken,

  async set(url, token) {
    const entry = await keyringEntry(url);
    if (entry) {
      try {
        entry.setPassword(token);
        await dropFromFileStore(url);
        return "keychain";
      } catch {
        // keychain unavailable (headless Linux etc.) — use the file
      }
    }
    const store = await readFileStore();
    for (const key of matchingKeys(store, url)) delete store[key];
    store[tryNormalizeUrl(url) ?? url] = token;
    await writeFileStore(store);
    return "file";
  },

  async delete(url) {
    const entry = await keyringEntry(url);
    try {
      entry?.deletePassword();
    } catch {
      // nothing stored
    }
    await dropFromFileStore(url);
  },
};
