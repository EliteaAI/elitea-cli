import type { EliteaModel, ModelCatalog } from "../src/elitea.js";

function model(name: string, display: string, extra: Partial<EliteaModel> = {}): EliteaModel {
  return {
    name,
    display_name: display,
    project_id: 1,
    shared: true,
    context_window: 400_000,
    max_output_tokens: 128_000,
    supports_reasoning: true,
    supports_vision: true,
    ...extra,
  };
}

/** Mirrors the real catalog of next.elitea.ai project 4 (2026-09-29). */
export const catalog: ModelCatalog = {
  items: [
    model("bedrock/converse/eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "Anthropic Claude 4.5 Sonnet", { context_window: 200_000, max_output_tokens: 64_000 }),
    model("eu.anthropic.claude-sonnet-4-6", "Anthropic Claude 4.6 Sonnet", { supports_reasoning: false }),
    model("eu.anthropic.claude-sonnet-5", "Anthropic Claude 5 Sonnet"),
    model("eu.anthropic.claude-haiku-4-5-20251001-v1:0", "Anthropic Claude Haiku 4.5", {
      context_window: 200_000,
      max_output_tokens: 64_000,
      supports_reasoning: false,
      supports_vision: false,
    }),
    model("global.openai.gpt-5.6-luna", "GPT-5.6-Luna", { max_output_tokens: 16_000 }),
    model("global.openai.gpt-5.6-terra", "GPT-5.6-Terra", { max_output_tokens: 16_000 }),
  ],
  default_model_name: "bedrock/converse/eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  low_tier_default_model_name: "global.openai.gpt-5.6-luna",
  high_tier_default_model_name: "global.openai.gpt-5.6-terra",
};

export function modelNamed(name: string): EliteaModel {
  const m = catalog.items.find((i) => i.name === name);
  if (!m) throw new Error(`fixture model ${name} missing`);
  return m;
}
