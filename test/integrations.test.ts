import { afterEach, describe, expect, it } from "vitest";
import { claude } from "../src/integrations/claude.js";
import { buildCodexCatalog, codexArgs, pickTemplate } from "../src/integrations/codex.js";
import { findIntegration } from "../src/integrations/registry.js";
import type { LaunchContext } from "../src/integrations/types.js";
import { catalog, modelNamed } from "./fixtures.js";

function ctx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    bin: "/usr/local/bin/agent",
    url: "https://next.elitea.ai",
    token: "pat-secret-token",
    projectId: 4,
    catalog,
    model: modelNamed("eu.anthropic.claude-sonnet-5"),
    fastModel: modelNamed("eu.anthropic.claude-haiku-4-5-20251001-v1:0"),
    extraArgs: [],
    ...overrides,
  };
}

describe("registry", () => {
  it("finds integrations by name and alias", () => {
    expect(findIntegration("claude")?.name).toBe("claude");
    expect(findIntegration("Claude-Code")?.name).toBe("claude");
    expect(findIntegration("codex")?.name).toBe("codex");
    expect(findIntegration("vim")).toBeUndefined();
  });
});

describe("claude", () => {
  const saved = process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
    else process.env.CLAUDE_CODE_AUTO_MODE_SERVER = saved;
  });

  it("points Claude Code at the EliteA Anthropic endpoint with bearer auth and project header", async () => {
    delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
    const spec = await claude.prepare(ctx({ extraArgs: ["-p", "hi"] }));
    expect(spec.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://next.elitea.ai/llm",
      ANTHROPIC_AUTH_TOKEN: "pat-secret-token",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_CUSTOM_HEADERS: "X-Project-Id: 4",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "eu.anthropic.claude-sonnet-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "eu.anthropic.claude-sonnet-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      CLAUDE_CODE_SUBAGENT_MODEL: "eu.anthropic.claude-sonnet-5",
      CLAUDE_CODE_AUTO_MODE_SERVER: "0",
    });
    expect(spec.args).toEqual(["--model", "eu.anthropic.claude-sonnet-5", "--settings", expect.any(String), "-p", "hi"]);
  });

  it("replaces the /model picker with the EliteA catalog", async () => {
    const spec = await claude.prepare(ctx());
    const settings = JSON.parse(spec.args[spec.args.indexOf("--settings") + 1]!);
    expect(settings.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(settings.modelPicker.options).toHaveLength(catalog.items.length);
    expect(settings.modelPicker.options[2]).toEqual({
      model: "eu.anthropic.claude-sonnet-5",
      label: "Anthropic Claude 5 Sonnet",
      description: "EliteA · eu.anthropic.claude-sonnet-5 · 400k context",
    });
  });

  it("only overrides the compaction window for models smaller than Claude's default", async () => {
    expect((await claude.prepare(ctx())).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    const small = { ...modelNamed("eu.anthropic.claude-sonnet-5"), context_window: 128_000 };
    expect((await claude.prepare(ctx({ model: small }))).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("128000");
  });

  it("adds no EliteA context without generated tools", async () => {
    const spec = await claude.prepare(ctx());
    expect(spec.args).not.toContain("--plugin-dir");
    expect(spec.args).not.toContain("--append-system-prompt");
    expect(spec.env.PATH).toBeUndefined();
  });

  it("adds the session context, plugin, permissions and elitea-cli shim on PATH", async () => {
    const spec = await claude.prepare(
      ctx({ userName: "Jo", projectName: "Personal", tools: { shimDir: "/h/bin", pluginDir: "/h/claude-plugin" }, extraArgs: ["-p", "hi"] }),
    );
    const at = (flag: string) => spec.args[spec.args.indexOf(flag) + 1]!;
    expect(spec.args).toEqual([
      "--model",
      "eu.anthropic.claude-sonnet-5",
      "--append-system-prompt",
      expect.stringContaining("Active EliteA project: Personal (id 4)."),
      "--plugin-dir",
      "/h/claude-plugin",
      "--settings",
      expect.any(String),
      "-p",
      "hi",
    ]);
    expect(at("--append-system-prompt")).toContain("User: Jo.");
    const settings = JSON.parse(at("--settings"));
    expect(settings.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(settings.permissions.allow).toContain("Bash(elitea-cli agents:*)");
    expect(settings.permissions.ask).toEqual(["Bash(elitea-cli agents chat:*)"]);
    expect(spec.env.PATH!.split(":")[0]).toBe("/h/bin");
    expect(JSON.stringify(spec)).not.toContain("ELITEA_CLI_TOKEN");
  });

  it("respects a user-set auto mode server", async () => {
    process.env.CLAUDE_CODE_AUTO_MODE_SERVER = "1";
    expect((await claude.prepare(ctx())).env.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
  });
});

describe("codex", () => {
  const template = {
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    default_reasoning_level: "medium",
    context_window: 272_000,
    max_context_window: 272_000,
    base_instructions: "You are Codex",
    availability_nux: { message: "new!" },
    some_future_field: { keep: true },
  };

  it("uses a regular GPT template, never auto-review", () => {
    expect(pickTemplate([{ slug: "codex-auto-review" }, { slug: "gpt-5.5" }, { slug: "gpt-5.4" }]).slug).toBe("gpt-5.4");
    expect(pickTemplate([{ slug: "codex-auto-review" }, { slug: "gpt-5.5" }]).slug).toBe("gpt-5.5");
    expect(() => pickTemplate([{ slug: "codex-auto-review" }])).toThrow();
  });

  it("clones the template per EliteA model, keeping unknown fields", () => {
    const { models } = buildCodexCatalog(template, catalog.items);
    expect(models.map((m) => m.slug)).toEqual(catalog.items.map((m) => m.name));

    const terra = models.find((m) => m.slug === "global.openai.gpt-5.6-terra")!;
    expect(terra).toMatchObject({
      display_name: "GPT-5.6-Terra",
      context_window: 400_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: template.supported_reasoning_levels,
      default_reasoning_level: "medium",
      supports_reasoning_summaries: true,
      default_reasoning_summary: "auto",
      base_instructions: "You are Codex",
      availability_nux: null,
      some_future_field: { keep: true },
    });

    const haiku = models.find((m) => m.slug.includes("haiku"))!;
    expect(haiku).toMatchObject({
      input_modalities: ["text"],
      supported_reasoning_levels: [],
      default_reasoning_level: null,
      supports_reasoning_summaries: false,
    });
  });

  it("does not mutate the template", () => {
    buildCodexCatalog(template, catalog.items);
    expect(template.availability_nux).toEqual({ message: "new!" });
  });

  it("configures the provider and EliteA workarounds purely via -c overrides", () => {
    const args = codexArgs({ url: "https://next.elitea.ai", projectId: 4, model: "gpt-5.4", catalogPath: "/h/.elitea-cli/codex-models.json" });
    const overrides = args.filter((_, i) => args[i - 1] === "-c");
    expect(overrides).toEqual([
      'model_provider="elitea-cli"',
      'model_providers.elitea-cli.name="EliteA"',
      'model_providers.elitea-cli.base_url="https://next.elitea.ai/llm/v1"',
      'model_providers.elitea-cli.wire_api="responses"',
      'model_providers.elitea-cli.env_key="ELITEA_CLI_CODEX_TOKEN"',
      'model_providers.elitea-cli.http_headers={ "X-Project-Id" = "4" }',
      'model_catalog_json="/h/.elitea-cli/codex-models.json"',
      "features.image_generation=false",
      'model_reasoning_summary="auto"',
    ]);
    expect(args.slice(-2)).toEqual(["-m", "gpt-5.4"]);
  });
});
