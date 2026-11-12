import { claude } from "./claude.js";
import type { Integration } from "./types.js";

/**
 * Integrations offered by `launch`. The Codex adapter (codex.ts) is kept and tested but not listed:
 * it gets EliteA models only, without the EliteA agents context Claude Code has.
 */
export const integrations: Integration[] = [claude];

export function findIntegration(name: string): Integration | undefined {
  const n = name.toLowerCase();
  return integrations.find((i) => i.name === n || i.aliases.includes(n));
}
