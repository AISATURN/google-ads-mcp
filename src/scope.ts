/**
 * Request-scoped access control.
 *
 * The stdio entrypoint runs as the server owner: there is no scope, so every
 * account the credentials can reach is fair game. The HTTP entrypoint
 * (api/mcp.ts) authenticates a caller first and then runs the whole request
 * inside a scope that pins which Google Ads accounts that caller may touch —
 * enforced centrally in client.ts (resolveCustomerId), so no individual tool
 * has to remember to check.
 *
 * AsyncLocalStorage is what makes this safe under concurrency: each request
 * gets its own store, so two callers handled by the same process can never see
 * each other's scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AccessScope {
  /** Who is calling — the user id from MCP_USERS, or "owner". Used in error messages/logs. */
  subject: string;
  /**
   * Customer IDs (10-digit, normalized) this caller may operate on.
   * `null` means unrestricted: every account the credentials can reach.
   */
  allowedCustomerIds: string[] | null;
}

const storage = new AsyncLocalStorage<AccessScope>();

/** Runs `fn` with the given access scope bound to the current async context. */
export function runWithAccessScope<T>(scope: AccessScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The scope of the in-flight request, or undefined on the unrestricted stdio path. */
export function getAccessScope(): AccessScope | undefined {
  return storage.getStore();
}

/** Allowed customer IDs for the current request, or `null` when unrestricted. */
export function getAllowedCustomerIds(): string[] | null {
  return storage.getStore()?.allowedCustomerIds ?? null;
}

/**
 * Throws unless the caller is unrestricted. For account-level operations that
 * are not scoped to a single advertising account (e.g. creating a new
 * sub-account under the manager), where an allowlist has nothing to check.
 */
export function assertUnrestricted(action: string): void {
  const scope = storage.getStore();
  if (scope?.allowedCustomerIds) {
    throw new Error(
      `Access denied: ${action} is restricted to the server owner. ` +
        `Your access is limited to account(s): ${scope.allowedCustomerIds.join(", ")}.`,
    );
  }
}
