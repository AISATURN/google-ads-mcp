/**
 * The user directory for the remote (HTTP) deployment.
 *
 * There is no database — users are declared in environment variables, which is
 * enough for a handful of named people and keeps the deployment stateless:
 *
 *   MCP_OWNER_PASSWORD  the owner (you): unrestricted access to every account
 *                       the Google Ads credentials can reach.
 *   MCP_USERS           optional JSON array of additional, account-scoped users:
 *                       [{"id":"xenon","password":"...","customer_ids":["8392105733"]}]
 *   MCP_USER_<ID>       the same thing, one variable per person:
 *                       MCP_USER_XENON={"password":"...","customer_ids":["8392105733"]}
 *                       Preferred for adding someone, because these values are
 *                       write-only on the host: a new person can be declared
 *                       without having to read back — and rewrite — everyone
 *                       else's entry. Both forms are read and merged.
 *
 * A scoped user can only operate on the accounts listed in customer_ids —
 * enforced centrally in client.ts via the request scope (see src/scope.ts).
 * Passwords are compared in constant time, and every candidate is checked so
 * the comparison count doesn't leak which user matched.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env.js";

export interface McpUser {
  id: string;
  /** Accounts this user may touch; `null` = unrestricted (the owner). */
  customerIds: string[] | null;
}

interface UserRecord extends McpUser {
  password: string;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function normalizeCustomerId(id: string): string {
  return id.replace(/\D/g, "");
}

/** Shared validation for one user entry, wherever it was declared. */
function parseUserEntry(entry: unknown, label: string, fallbackId = ""): UserRecord {
  const user = (entry ?? {}) as Record<string, unknown>;
  const id = (typeof user.id === "string" ? user.id.trim() : "") || fallbackId;
  const password = typeof user.password === "string" ? user.password : "";
  const ids = Array.isArray(user.customer_ids) ? user.customer_ids : [];

  if (!id) throw new Error(`${label}: "id" is required.`);
  if (!password) throw new Error(`${label} (${id}): "password" is required.`);
  if (ids.length === 0) {
    throw new Error(
      `${label} (${id}): "customer_ids" must list at least one 10-digit account ID. ` +
        `Scoped users cannot be granted unrestricted access — use MCP_OWNER_PASSWORD for that.`,
    );
  }

  const customerIds = ids.map((value, i) => {
    const normalized = normalizeCustomerId(String(value));
    if (normalized.length !== 10) {
      throw new Error(
        `${label} (${id}): customer_ids[${i}] = "${String(value)}" is not a 10-digit account ID.`,
      );
    }
    return normalized;
  });

  return { id, password, customerIds };
}

/** Parses MCP_USERS, throwing a descriptive error if the value is malformed. */
function parseUsersVariable(): UserRecord[] {
  const raw = process.env.MCP_USERS?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'MCP_USERS is not valid JSON. Expected: [{"id":"name","password":"...","customer_ids":["1234567890"]}]',
    );
  }
  if (!Array.isArray(parsed)) throw new Error("MCP_USERS must be a JSON array of user objects.");

  return parsed.map((entry, index) => parseUserEntry(entry, `MCP_USERS[${index}]`));
}

/**
 * Parses the one-variable-per-person form: MCP_USER_<ID>, each holding a single
 * JSON object. The id defaults to the lowercased name suffix, so
 * MCP_USER_GOOPLAST is the user "gooplast"; an explicit "id" in the JSON wins.
 */
function parsePerUserVariables(): UserRecord[] {
  const prefix = "MCP_USER_";
  return Object.keys(process.env)
    .filter((name) => name.startsWith(prefix) && process.env[name]?.trim())
    .sort()
    .map((name) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(process.env[name]!.trim());
      } catch {
        throw new Error(
          `${name} is not valid JSON. Expected: {"password":"...","customer_ids":["1234567890"]}`,
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${name} must be a single JSON object, not an array or scalar.`);
      }
      return parseUserEntry(parsed, name, name.slice(prefix.length).toLowerCase());
    });
}

/** Every scoped user, from both declaration forms. */
function parseScopedUsers(): UserRecord[] {
  return [...parseUsersVariable(), ...parsePerUserVariables()];
}

/**
 * Resolves a submitted password to a user, or null if it matches nobody.
 * The owner password wins if it collides with a scoped user's password.
 */
export function authenticateUser(submitted: string): McpUser | null {
  const candidates: UserRecord[] = [
    { id: "owner", password: requireEnv("MCP_OWNER_PASSWORD"), customerIds: null },
    ...parseScopedUsers(),
  ];

  let matched: McpUser | null = null;
  for (const candidate of candidates) {
    // No early exit: every candidate is compared so timing doesn't reveal which one hit.
    if (constantTimeEquals(submitted, candidate.password) && !matched) {
      matched = { id: candidate.id, customerIds: candidate.customerIds };
    }
  }
  return matched;
}
