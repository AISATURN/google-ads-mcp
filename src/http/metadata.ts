/**
 * OAuth/MCP discovery metadata documents (RFC 8414 authorization server
 * metadata, RFC 9728 protected resource metadata), served at the real
 * /.well-known/... URLs via vercel.json rewrites.
 */

import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getPublicUrl, getResourceUrl } from "./env.js";

export function buildAuthorizationServerMetadata(): OAuthMetadata {
  const issuer = getPublicUrl();
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/authorize`,
    token_endpoint: `${issuer}/api/token`,
    registration_endpoint: `${issuer}/api/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function buildProtectedResourceMetadata(): OAuthProtectedResourceMetadata {
  const issuer = getPublicUrl();
  return {
    resource: getResourceUrl(),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  };
}
