import type { EliteaModel, ModelCatalog } from "./elitea.js";

/** Match by exact name first, then case-insensitive name or display name. */
export function findModel(catalog: ModelCatalog, query: string): EliteaModel | undefined {
  const q = query.toLowerCase();
  return (
    catalog.items.find((m) => m.name === query) ??
    catalog.items.find((m) => m.name.toLowerCase() === q || m.display_name.toLowerCase() === q)
  );
}

export function isAnthropicModel(model: EliteaModel): boolean {
  return /anthropic|claude/i.test(model.name);
}

export function isOpenAIModel(model: EliteaModel): boolean {
  return /openai|gpt/i.test(model.name);
}

/**
 * LiteLLM's Bedrock Converse route rejects requests Claude Code sends
 * ("text content blocks must be non-empty"); the invoke-style eu.anthropic.* routes work.
 */
export function isBedrockConverse(model: EliteaModel): boolean {
  return model.name.startsWith("bedrock/converse/");
}

function byName(catalog: ModelCatalog, name: string | null | undefined): EliteaModel | undefined {
  return name ? catalog.items.find((m) => m.name === name) : undefined;
}

/**
 * Default main model for an agent: the first model of the agent's native family
 * (newest-looking first), falling back to EliteA's configured defaults.
 */
export function defaultModelFor(catalog: ModelCatalog, family: "anthropic" | "openai"): EliteaModel | undefined {
  const matches = (m: EliteaModel) =>
    family === "anthropic" ? isAnthropicModel(m) && !isBedrockConverse(m) : isOpenAIModel(m);
  const preferred = [catalog.high_tier_default_model_name, catalog.default_model_name]
    .map((n) => byName(catalog, n))
    .find((m) => m && matches(m));
  if (preferred) return preferred;
  const native = catalog.items.filter(matches).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return native.find((m) => !/haiku|mini|luna/i.test(m.name)) ?? native[0] ?? catalog.items[0];
}

/** Small/fast model for Claude Code's haiku slot and background tasks. */
export function defaultFastModel(catalog: ModelCatalog, main: EliteaModel): EliteaModel {
  if (isAnthropicModel(main)) {
    const haiku = catalog.items.find((m) => /haiku/i.test(m.name));
    if (haiku) return haiku;
  }
  return byName(catalog, catalog.low_tier_default_model_name) ?? main;
}
