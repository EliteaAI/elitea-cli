import { loadConfig, saveConfig } from "../config.js";
import { usageError } from "../errors.js";
import { OUTPUT_VALUES, parseFormat, printData } from "../output.js";

/** CLI settings: stored once for all environments in the config file's `settings` (AC-21). */
interface SettingSpec {
  allowed: string;
  /** Environment variable that wins over the stored value. */
  env: string;
  defaultValue: string;
  /** The stored value, or a usage error naming the allowed values. */
  parse: (raw: string) => string | number;
}

export const TIMEOUT_RANGE = { min: 1, max: 240, fallback: 30 } as const;

function oneOf(key: string, values: readonly string[]) {
  return (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (!values.includes(v)) throw usageError(`${key} must be one of ${values.join(", ")}, got "${raw}"`);
    return v;
  };
}

export const SETTINGS: Record<string, SettingSpec> = {
  output: { allowed: OUTPUT_VALUES.join("|"), env: "ELITEA_CLI_OUTPUT", defaultValue: "table", parse: oneOf("output", OUTPUT_VALUES) },
  color: { allowed: "auto|never", env: "NO_COLOR", defaultValue: "auto", parse: oneOf("color", ["auto", "never"]) },
  timeout: {
    allowed: `${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max} minutes`,
    env: "ELITEA_CLI_TIMEOUT",
    defaultValue: String(TIMEOUT_RANGE.fallback),
    parse: (raw) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < TIMEOUT_RANGE.min || n > TIMEOUT_RANGE.max) {
        throw usageError(`timeout must be a whole number of minutes from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}, got "${raw}"`);
      }
      return n;
    },
  },
};

function spec(key: string): SettingSpec {
  const s = SETTINGS[key];
  if (!s) throw usageError(`Unknown setting "${key}". Settings: ${Object.entries(SETTINGS).map(([k, v]) => `${k} (${v.allowed})`).join(", ")}`);
  return s;
}

export interface SettingRow {
  key: string;
  value: string;
  /** Where the effective value comes from. */
  source: "env" | "config" | "default";
  allowed: string;
}

function rowFor(key: string, stored: Record<string, unknown>): SettingRow {
  const s = spec(key);
  const env = process.env[s.env];
  if (env !== undefined && env !== "") {
    // NO_COLOR is set to anything at all; it means never.
    return { key, value: key === "color" ? "never" : env, source: "env", allowed: s.allowed };
  }
  const value = stored[key];
  if (value !== undefined && value !== null && value !== "") return { key, value: String(value), source: "config", allowed: s.allowed };
  return { key, value: s.defaultValue, source: "default", allowed: s.allowed };
}

const sourceText = (r: SettingRow) => (r.source === "env" ? `from ${SETTINGS[r.key]!.env}` : r.source === "config" ? "" : "default");

export async function configListCommand(opts: { output?: string; json?: boolean }): Promise<void> {
  const format = parseFormat(opts, true);
  const stored = (await loadConfig()).settings;
  const rows = Object.keys(SETTINGS).map((k) => rowFor(k, stored));
  if (format !== "text") {
    printData(format, rows);
    return;
  }
  const width = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    const note = sourceText(r);
    console.log(`${r.key.padEnd(width)}  ${r.value}${note ? `  (${note})` : ""}`);
  }
}

export async function configGetCommand(key: string): Promise<void> {
  console.log(rowFor(key, (await loadConfig()).settings).value);
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  const s = spec(key);
  const parsed = s.parse(value);
  const config = await loadConfig();
  config.settings[key] = parsed;
  await saveConfig(config);
  console.log(`${key} = ${parsed}`);
  const env = process.env[s.env];
  if (env !== undefined && env !== "") console.error(`Note: ${s.env} is set and wins over this setting`);
}

export async function configUnsetCommand(key: string): Promise<void> {
  spec(key);
  const config = await loadConfig();
  delete config.settings[key];
  await saveConfig(config);
  console.log(`${key} reset to ${SETTINGS[key]!.defaultValue}`);
}
