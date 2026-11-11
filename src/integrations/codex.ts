import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eliteaCliHome } from "../config.js";
import type { EliteaModel } from "../elitea.js";
import { writeFileAtomic } from "../fsutil.js";
import type { Integration } from "./types.js";

const execFileAsync = promisify(execFile);

export const CODEX_PROVIDER_ID = "elitea-cli";
/** Env var Codex reads the bearer token from (via model_providers.<id>.env_key). */
export const CODEX_TOKEN_ENV = "ELITEA_CLI_CODEX_TOKEN";

type CatalogEntry = Record<string, unknown> & { slug: string };

/** Serialize a string as a TOML basic string, for `codex -c key=<value>`. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex validates model_catalog_json strictly and its schema changes between
 * releases, so entries are cloned from the installed Codex's own bundled catalog
 * and only the model-specific fields are replaced.
 */
export function buildCodexCatalog(template: CatalogEntry, models: EliteaModel[]): { models: CatalogEntry[] } {
  const reasoningLevels = Array.isArray(template.supported_reasoning_levels) ? template.supported_reasoning_levels : [];
  return {
    models: models.map((m, i) => ({
      ...structuredClone(template),
      slug: m.name,
      display_name: m.display_name || m.name,
      description: `EliteA model (${m.name})`,
      context_window: m.context_window || template.context_window,
      max_context_window: m.context_window || template.max_context_window,
      input_modalities: m.supports_vision ? ["text", "image"] : ["text"],
      supported_reasoning_levels: m.supports_reasoning ? reasoningLevels : [],
      default_reasoning_level: m.supports_reasoning ? template.default_reasoning_level : null,
      supports_reasoning_summaries: m.supports_reasoning,
      default_reasoning_summary: m.supports_reasoning ? "auto" : "none",
      priority: i,
      visibility: "list",
      supported_in_api: true,
      availability_nux: null,
      upgrade: null,
    })),
  };
}

/** Pick the template entry: a regular GPT model, never the internal auto-review one. */
export function pickTemplate(bundled: CatalogEntry[]): CatalogEntry {
  const usable = bundled.filter((m) => !/auto-review/.test(m.slug));
  const template = usable.find((m) => m.slug === "gpt-5.4") ?? usable[0];
  if (!template) throw new Error("Codex returned an empty bundled model catalog");
  return template;
}

/** Ask the installed Codex for its bundled catalog, isolated from the user's ~/.codex config. */
async function bundledCatalog(codexBin: string): Promise<CatalogEntry[]> {
  const home = await mkdtemp(join(tmpdir(), "elitea-cli-codex-"));
  try {
    const { stdout } = await execFileAsync(codexBin, ["debug", "models", "--bundled"], {
      env: { ...process.env, CODEX_HOME: home },
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { models?: CatalogEntry[] } | CatalogEntry[];
    return Array.isArray(parsed) ? parsed : (parsed.models ?? []);
  } catch (err) {
    throw new Error(
      `Could not read Codex's bundled model catalog (\`codex debug models --bundled\`): ${(err as Error).message}. ` +
        "Update Codex to a recent version.",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function codexCatalogPath(): string {
  return join(eliteaCliHome(), "codex-models.json");
}

/** `-c` overrides only: the user's ~/.codex/config.toml is never modified. */
export function codexArgs(opts: { url: string; projectId: number; model: string; catalogPath: string }): string[] {
  const p = `model_providers.${CODEX_PROVIDER_ID}`;
  const overrides = [
    `model_provider=${tomlString(CODEX_PROVIDER_ID)}`,
    `${p}.name=${tomlString("EliteA")}`,
    `${p}.base_url=${tomlString(`${opts.url}/llm/v1`)}`,
    `${p}.wire_api=${tomlString("responses")}`,
    `${p}.env_key=${tomlString(CODEX_TOKEN_ENV)}`,
    `${p}.http_headers={ "X-Project-Id" = ${tomlString(String(opts.projectId))} }`,
    // Our catalog replaces whatever the user's config points at (e.g. a stale one from another tool).
    `model_catalog_json=${tomlString(opts.catalogPath)}`,
    // EliteA's Azure deployments reject the built-in image_generation tool.
    "features.image_generation=false",
    // gpt-5.6-* on EliteA fails ("Unknown parameter: thinking") when reasoning is sent without a summary.
    `model_reasoning_summary=${tomlString("auto")}`,
  ];
  return [...overrides.flatMap((o) => ["-c", o]), "-m", opts.model];
}

export const codex: Integration = {
  name: "codex",
  aliases: ["codex-cli"],
  displayName: "Codex CLI",
  family: "openai",
  usesFastModel: false,
  binary: { name: "codex", fallbacks: [join(homedir(), ".local", "bin", "codex")] },
  installHint: "npm install -g @openai/codex",

  async prepare(ctx) {
    const catalog = buildCodexCatalog(pickTemplate(await bundledCatalog(ctx.bin)), ctx.catalog.items);
    const catalogPath = codexCatalogPath();
    await writeFileAtomic(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
    return {
      args: [...codexArgs({ url: ctx.url, projectId: ctx.projectId, model: ctx.model.name, catalogPath }), ...ctx.extraArgs],
      env: { [CODEX_TOKEN_ENV]: ctx.token },
    };
  },
};
