import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function agentBotRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const parent = resolve(moduleDir, "..");
  if (parent.endsWith(`${sep}dist`) || parent.endsWith("/dist") || parent.endsWith("\\dist")) {
    return resolve(parent, "..");
  }
  return parent;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const eq = trimmed.indexOf("=");
  if (eq < 1) {
    return null;
  }
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** Load agent-bot/.env into process.env (does not override existing env vars). */
export function loadAgentBotEnv(): void {
  const envPath = resolve(agentBotRoot(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadAgentBotEnv();
