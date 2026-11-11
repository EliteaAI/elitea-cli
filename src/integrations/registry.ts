import { claude } from "./claude.js";
import { codex } from "./codex.js";
import type { Integration } from "./types.js";

export const integrations: Integration[] = [claude, codex];

export function findIntegration(name: string): Integration | undefined {
  const n = name.toLowerCase();
  return integrations.find((i) => i.name === n || i.aliases.includes(n));
}
