/**
 * Minimal .env writer.
 *
 * Bootstrap provisions accounts, DIDs, and a topic. Printing those for a human
 * to paste back is the single most error-prone step in setting this up, so it
 * writes them directly instead.
 *
 * Existing lines are updated in place and unrelated content, comments, and
 * ordering are preserved, so nothing a user typed by hand gets clobbered.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const ENV_PATH = ".env";

/**
 * Reads a .env file into a map, ignoring comments and blank lines.
 *
 * @param path - Path to the env file
 * @returns Parsed key/value pairs, empty when the file does not exist
 */
export function readEnvFile(path = ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return result;
}

/**
 * Applies updates to a .env file, preserving everything else.
 *
 * @param updates - Keys to set
 * @param path - Path to the env file
 */
export function updateEnvFile(updates: Record<string, string>, path = ENV_PATH): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const index = trimmed.indexOf("=");
    if (index <= 0) return line;
    const key = trimmed.slice(0, index).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key) ?? "";
    remaining.delete(key);
    return `${key}=${value}`;
  });

  if (remaining.size > 0) {
    if (rewritten.length > 0 && rewritten[rewritten.length - 1] !== "") rewritten.push("");
    rewritten.push("# Written by `npm run bootstrap`.");
    for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);
  }

  writeFileSync(path, `${rewritten.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

/**
 * Whether bootstrap has already provisioned everything the demo needs.
 *
 * Used to make setup idempotent: running the one-command path twice should not
 * create a second set of accounts and identities.
 *
 * @param path - Path to the env file
 * @returns True when every provisioned value is present
 */
export function isProvisioned(path = ENV_PATH): boolean {
  const env = { ...readEnvFile(path), ...process.env };
  const required = [
    "ATTESTATION_TOPIC_ID",
    "BUYER_DID",
    "SELLER_DID",
    "MOCK_SELLER_DID",
    "VERIFIER_DID",
    "SELLER_ACCOUNT_ID",
    "SELLER_PRIVATE_KEY",
    "MOCK_SELLER_ACCOUNT_ID",
    "MOCK_SELLER_PRIVATE_KEY",
    "VERIFIER_ACCOUNT_ID",
    "VERIFIER_PRIVATE_KEY",
  ];
  return required.every((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim() !== "";
  });
}
