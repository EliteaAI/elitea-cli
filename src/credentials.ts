import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eliteaCliHome } from "./config.js";
import { writeFileAtomic } from "./fsutil.js";

const SERVICE = "elitea-cli";

/**
 * PAT storage: OS keychain when available, otherwise a 0600 file in ~/.elitea-cli.
 * ELITEA_CLI_TOKEN always wins so CI can run without any stored secret.
 */
export interface TokenStore {
  get(url: string): Promise<string | undefined>;
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

export const tokenStore: TokenStore = {
  async get(url) {
    if (process.env.ELITEA_CLI_TOKEN) return process.env.ELITEA_CLI_TOKEN;
    const entry = await keyringEntry(url);
    if (entry) {
      try {
        const token = entry.getPassword();
        if (token) return token;
      } catch {
        // fall through to file store
      }
    }
    return (await readFileStore())[url];
  },

  async set(url, token) {
    const entry = await keyringEntry(url);
    if (entry) {
      try {
        entry.setPassword(token);
        const store = await readFileStore();
        if (url in store) {
          delete store[url];
          await writeFileStore(store);
        }
        return "keychain";
      } catch {
        // keychain unavailable (headless Linux etc.) — use the file
      }
    }
    const store = await readFileStore();
    store[url] = token;
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
    const store = await readFileStore();
    if (url in store) {
      delete store[url];
      await writeFileStore(store);
    }
  },
};
