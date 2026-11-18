import { claude } from "./claude.js";
import { codex } from "./codex.js";
import type { Integration } from "./types.js";

/**
 * Integrations offered by `launch`. Codex gets EliteA models only, without the EliteA agents
 * context (skill, commands, system prompt) Claude Code has (story #7561, open question 4: v3).
 */
export const integrations: Integration[] = [claude, codex];

export function findIntegration(name: string): Integration | undefined {
  const n = name.toLowerCase();
  return integrations.find((i) => i.name === n || i.aliases.includes(n));
}
