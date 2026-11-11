import { describe, expect, it } from "vitest";
import { defaultFastModel, defaultModelFor, findModel } from "../src/models.js";
import { catalog, modelNamed } from "./fixtures.js";

describe("findModel", () => {
  it("matches exact name, then case-insensitive name or display name", () => {
    expect(findModel(catalog, "eu.anthropic.claude-sonnet-5")?.display_name).toBe("Anthropic Claude 5 Sonnet");
    expect(findModel(catalog, "GPT-5.6-TERRA")?.name).toBe("global.openai.gpt-5.6-terra");
    expect(findModel(catalog, "gpt-5.6-terra")?.name).toBe("global.openai.gpt-5.6-terra");
    expect(findModel(catalog, "nope")).toBeUndefined();
  });
});

describe("defaultModelFor", () => {
  it("uses EliteA's high-tier default when it matches the agent's family", () => {
    expect(defaultModelFor(catalog, "openai")?.name).toBe("global.openai.gpt-5.6-terra");
  });

  it("falls back to EliteA's default model for the family", () => {
    const withInvokeDefault = { ...catalog, default_model_name: "eu.anthropic.claude-sonnet-4-6" };
    expect(defaultModelFor(withInvokeDefault, "anthropic")?.name).toBe("eu.anthropic.claude-sonnet-4-6");
  });

  it("never defaults Claude to Bedrock Converse models, even if EliteA's default is one", () => {
    expect(defaultModelFor(catalog, "anthropic")?.name).toBe("eu.anthropic.claude-sonnet-5");
  });

  it("picks the newest non-small native model when no default matches", () => {
    const bare = { items: catalog.items };
    expect(defaultModelFor(bare, "anthropic")?.name).toBe("eu.anthropic.claude-sonnet-5");
    expect(defaultModelFor(bare, "openai")?.name).toBe("global.openai.gpt-5.6-terra");
  });
});

describe("defaultFastModel", () => {
  it("prefers haiku for Anthropic main models", () => {
    expect(defaultFastModel(catalog, modelNamed("eu.anthropic.claude-sonnet-5")).name).toBe(
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("uses the low-tier default for other models", () => {
    expect(defaultFastModel(catalog, modelNamed("global.openai.gpt-5.6-terra")).name).toBe("global.openai.gpt-5.6-luna");
  });

  it("falls back to the main model", () => {
    const main = modelNamed("global.openai.gpt-5.6-terra");
    expect(defaultFastModel({ items: [main] }, main)).toBe(main);
  });
});
