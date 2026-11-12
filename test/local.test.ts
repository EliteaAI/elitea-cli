import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { tokenStore } from "../src/credentials.js";
import { writeWithBackup } from "../src/fsutil.js";
import { findExecutable, mergeEnv } from "../src/process.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "elitea-cli-test-"));
  process.env.ELITEA_CLI_HOME = home;
  process.env.ELITEA_CLI_NO_KEYCHAIN = "1";
  delete process.env.ELITEA_CLI_TOKEN;
});

describe("config", () => {
  it("has no environment and no server when nothing is saved, and round-trips", async () => {
    expect(await loadConfig()).toEqual({ environments: {}, settings: {} });
    await saveConfig({
      active: "x",
      environments: { x: { url: "https://x.test", project: { id: 4, name: "p" }, integrations: { claude: { model: "m" } } } },
      settings: {},
    });
    expect((await loadConfig()).environments.x?.project).toEqual({ id: 4, name: "p" });
    expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("tokenStore (file fallback)", () => {
  it("stores per server URL with 0600 permissions and deletes", async () => {
    expect(await tokenStore.set("https://a.test", "tok-a")).toBe("file");
    await tokenStore.set("https://b.test", "tok-b");
    expect(await tokenStore.get("https://a.test")).toBe("tok-a");
    expect((await stat(join(home, "credentials.json"))).mode & 0o777).toBe(0o600);
    await tokenStore.delete("https://a.test");
    expect(await tokenStore.get("https://a.test")).toBeUndefined();
    expect(await tokenStore.get("https://b.test")).toBe("tok-b");
  });

  it("prefers ELITEA_CLI_TOKEN", async () => {
    await tokenStore.set("https://a.test", "stored");
    process.env.ELITEA_CLI_TOKEN = "from-env";
    expect(await tokenStore.get("https://a.test")).toBe("from-env");
  });
});

describe("writeWithBackup", () => {
  it("skips unchanged files and backs up before overwriting", async () => {
    const file = join(home, "settings.json");
    const backups = join(home, "backup");
    expect(await writeWithBackup(file, "v1", backups)).toBe(true);
    expect(await writeWithBackup(file, "v1", backups)).toBe(false);
    expect(await writeWithBackup(file, "v2", backups)).toBe(true);
    expect(await readFile(file, "utf8")).toBe("v2");
    const saved = await readdir(backups);
    expect(saved).toHaveLength(1);
    expect(await readFile(join(backups, saved[0]!), "utf8")).toBe("v1");
  });
});

describe("process helpers", () => {
  it("finds executables on PATH, then in fallbacks", async () => {
    const bin = join(home, "bin");
    const tool = join(bin, "tool");
    await import("node:fs/promises").then((fs) => fs.mkdir(bin));
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    expect(findExecutable("tool", [], bin)).toBe(tool);
    expect(findExecutable("tool", [tool], "/nonexistent")).toBe(tool);
    expect(findExecutable("tool", [], "/nonexistent")).toBeUndefined();
  });

  it("merges env, with undefined meaning unset and empty string kept", () => {
    expect(mergeEnv({ A: "1", B: "2" }, { B: undefined, C: "", A: "x" })).toEqual({ A: "x", C: "" });
  });
});
