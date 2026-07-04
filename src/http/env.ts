/** Shared environment-variable helpers for the HTTP/OAuth layer (api/*.ts + src/http/*.ts). */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/** The public base URL of this deployment (no trailing slash), used as OAuth issuer/audience. */
export function getPublicUrl(): string {
  return requireEnv("MCP_PUBLIC_URL").replace(/\/+$/, "");
}

/** The URL of the MCP resource endpoint itself — the default OAuth audience for access tokens. */
export function getResourceUrl(): string {
  return `${getPublicUrl()}/api/mcp`;
}
