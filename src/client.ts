/**
 * Shared Google Ads API client infrastructure: credential handling, client and
 * Customer factories, customer-ID normalization, micros conversion, and
 * actionable error formatting. All tools route through these helpers so that
 * authentication and error handling live in exactly one place.
 */

import { GoogleAdsApi, type Customer } from "google-ads-api";

export interface GoogleAdsCredentials {
  developer_token: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  login_customer_id?: string;
  default_customer_id?: string;
}

const REQUIRED_ENV_VARS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

/**
 * Returns the list of required environment variables that are missing or empty.
 * Used for fail-fast validation at server startup.
 */
export function getMissingEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

let cachedCredentials: GoogleAdsCredentials | null = null;

/** Reads and caches credentials from the environment, throwing if any required value is absent. */
export function getCredentials(): GoogleAdsCredentials {
  if (cachedCredentials) return cachedCredentials;

  const missing = getMissingEnvVars();
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before starting the server (see .env.example / README.md).`,
    );
  }

  cachedCredentials = {
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!.trim(),
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim()
      ? normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
      : undefined,
    default_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID?.trim()
      ? normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID)
      : undefined,
  };
  return cachedCredentials;
}

let cachedClient: GoogleAdsApi | null = null;

/** Returns a shared GoogleAdsApi client instance. */
export function getClient(): GoogleAdsApi {
  if (cachedClient) return cachedClient;
  const creds = getCredentials();
  cachedClient = new GoogleAdsApi({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    developer_token: creds.developer_token,
  });
  return cachedClient;
}

/** Strips dashes, spaces, and any non-digit characters from a customer ID. */
export function normalizeCustomerId(id: string): string {
  return id.replace(/\D/g, "");
}

/**
 * Resolves a customer ID from an explicit argument or the GOOGLE_ADS_CUSTOMER_ID
 * default, validating that it is a 10-digit Google Ads account ID.
 */
export function resolveCustomerId(provided?: string): string {
  const creds = getCredentials();
  const raw = provided?.trim() || creds.default_customer_id;
  if (!raw) {
    throw new Error(
      "No customer_id provided and GOOGLE_ADS_CUSTOMER_ID is not set. " +
        "Pass a customer_id (the 10-digit account ID, dashes optional) or set the env default. " +
        "Use google_ads_list_accessible_customers to discover available account IDs.",
    );
  }
  const normalized = normalizeCustomerId(raw);
  if (normalized.length !== 10) {
    throw new Error(
      `Invalid customer_id "${raw}". Expected a 10-digit Google Ads account ID ` +
        `(e.g. 1234567890 or 123-456-7890).`,
    );
  }
  return normalized;
}

/**
 * Builds a Customer instance scoped to a specific advertising account. The
 * login-customer-id (manager/MCC account) is applied automatically when set.
 */
export function getCustomer(customerId?: string): Customer {
  const creds = getCredentials();
  const client = getClient();
  return client.Customer({
    customer_id: resolveCustomerId(customerId),
    refresh_token: creds.refresh_token,
    login_customer_id: creds.login_customer_id,
  });
}

/** Converts an amount in account-currency units to Google Ads "micros" (1 unit = 1,000,000 micros). */
export function toMicros(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/** Converts Google Ads "micros" back to account-currency units. */
export function fromMicros(micros: number | string | null | undefined): number {
  const value = typeof micros === "string" ? Number(micros) : micros;
  if (!value || Number.isNaN(value)) return 0;
  return value / 1_000_000;
}

interface GoogleAdsErrorItem {
  message?: string;
  error_code?: Record<string, unknown>;
  location?: { field_path_elements?: Array<{ field_name?: string }> };
}

/**
 * Inspects an error's full text for well-known credential/authorization failure
 * signatures and returns an actionable hint, or an empty string if none match.
 * Credential setup is the most common failure mode for this server.
 */
function authHint(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("invalid_client")) {
    return "\nHint: invalid_client usually means GOOGLE_ADS_CLIENT_ID or GOOGLE_ADS_CLIENT_SECRET is wrong.";
  }
  if (t.includes("invalid_grant")) {
    return "\nHint: invalid_grant usually means GOOGLE_ADS_REFRESH_TOKEN is expired, revoked, or was issued for different OAuth credentials. Generate a new refresh token.";
  }
  if (t.includes("developer") && t.includes("token")) {
    return "\nHint: check GOOGLE_ADS_DEVELOPER_TOKEN and that it is approved for the target account (test tokens only work on test accounts).";
  }
  if (t.includes("user_permission_denied") || t.includes("permission_denied")) {
    return "\nHint: the authenticated user lacks access to this account. Verify the customer_id and set GOOGLE_ADS_LOGIN_CUSTOMER_ID to your manager (MCC) account if operating on a sub-account.";
  }
  if (t.includes("customer_not_found") || t.includes("not found")) {
    return "\nHint: verify the customer_id. Use google_ads_list_accessible_customers to find valid account IDs.";
  }
  return "";
}

/**
 * Formats any error thrown by the Google Ads API (or library) into a clear,
 * actionable message. Google Ads failures carry a list of granular errors, each
 * with a message, a typed error code, and an optional field path.
 */
export function formatGoogleAdsError(error: unknown): string {
  const anyErr = error as { errors?: GoogleAdsErrorItem[]; message?: string } | undefined;

  if (anyErr && Array.isArray(anyErr.errors) && anyErr.errors.length > 0) {
    const lines = anyErr.errors.map((item) => {
      const codeEntries = Object.entries(item.error_code ?? {}).filter(
        ([, v]) => v !== null && v !== undefined,
      );
      const code =
        codeEntries.length > 0
          ? ` [${codeEntries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}]`
          : "";
      const field = item.location?.field_path_elements
        ?.map((e) => e.field_name)
        .filter(Boolean)
        .join(".");
      const fieldNote = field ? ` (field: ${field})` : "";
      return `  • ${item.message ?? "Unknown error"}${code}${fieldNote}`;
    });
    const body = `Google Ads API request failed:\n${lines.join("\n")}`;
    return body + authHint(body);
  }

  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}${authHint(message)}`;
}
