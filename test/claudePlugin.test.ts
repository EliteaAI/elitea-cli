import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ELITEA_PERMISSIONS, pluginFiles, sessionContext, shimScript, writeClaudeTools } from "../src/integrations/claudePlugin.js";

describe("claude plugin", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "elitea-cli-plugin-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the shim and the plugin under the elitea-cli home", async () => {
    const tools = await writeClaudeTools({ home, nodePath: "/usr/bin/node", cliPath: "/opt/elitea cli/dist/cli.js" });
    expect(tools).toEqual({ shimDir: join(home, "bin"), pluginDir: join(home, "claude-plugin") });

    const shim = join(home, "bin", "elitea-cli");
    expect(await readFile(shim, "utf8")).toBe(`#!/bin/sh\nexec '/usr/bin/node' '/opt/elitea cli/dist/cli.js' "$@"\n`);
    expect((await stat(shim)).mode & 0o111).toBe(0o111);

    for (const path of Object.keys(pluginFiles())) {
      expect(await readFile(join(home, "claude-plugin", path), "utf8")).toBe(pluginFiles()[path]);
    }
    expect(JSON.parse(await readFile(join(home, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8")).name).toBe("elitea");
  });

  it("is idempotent and removes files an older version generated", async () => {
    await writeClaudeTools({ home, cliPath: "/x/cli.js" });
    const stale = join(home, "claude-plugin", "commands", "elitea-agents.md");
    await writeFile(stale, "old");
    await writeClaudeTools({ home, cliPath: "/x/cli.js" });
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(join(home, "claude-plugin", "commands", "agents.md"))).resolves.toBeDefined();
  });

  it("ships the skill and the three slash commands", () => {
    expect(Object.keys(pluginFiles()).sort()).toEqual([
      ".claude-plugin/plugin.json",
      "commands/agents.md",
      "commands/chat.md",
      "commands/projects.md",
      "skills/elitea/SKILL.md",
    ]);
    const skill = pluginFiles()["skills/elitea/SKILL.md"]!;
    expect(skill).toMatch(/^---\nname: elitea\n/);
    expect(skill).toContain("elitea-cli agents chat <agent id or name>");
    expect(skill).toContain("--conversation");
    expect(skill).toContain("elitea-cli pipelines run <pipeline id or name>");
    expect(skill).not.toContain("pipelines are not listed");
  });

  it("runs read-only commands without a prompt and asks before any run", () => {
    expect(ELITEA_PERMISSIONS.allow).toContain("Bash(elitea-cli pipelines:*)");
    expect(ELITEA_PERMISSIONS.ask).toEqual([
      "Bash(elitea-cli agents chat:*)",
      "Bash(elitea-cli agents run:*)",
      "Bash(elitea-cli pipelines run:*)",
    ]);
  });

  it("shim quotes paths with single quotes", () => {
    expect(shimScript("/n", "/it's/cli.js")).toContain(`'/it'\\''s/cli.js'`);
  });

  it("shim runs the CLI with the given arguments", async () => {
    const script = join(home, "echo.js");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))");
    const { shimDir } = await writeClaudeTools({ home, cliPath: script });
    const out = execFileSync(join(shimDir, "elitea-cli"), ["agents", "chat", "a b", "--json"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["agents", "chat", "a b", "--json"]);
  });
});

describe("sessionContext", () => {
  it("names the server, user and project", () => {
    expect(sessionContext({ url: "https://next.elitea.ai", projectId: 12321, projectName: "Personal", userName: "Jo Doe" })).toBe(
      [
        "You are running inside elitea-cli, connected to EliteA (https://next.elitea.ai).",
        "User: Jo Doe. Active EliteA project: Personal (id 12321).",
        "The user's EliteA agents and pipelines live in this project and run on the EliteA server.",
        "Use the `elitea` skill (the `elitea-cli` command) for anything about EliteA projects, agents or pipelines, or running them.",
      ].join("\n"),
    );
  });

  it("works without names", () => {
    expect(sessionContext({ url: "https://x", projectId: 7 }).split("\n")[1]).toBe("Active EliteA project: id 7.");
  });
});
