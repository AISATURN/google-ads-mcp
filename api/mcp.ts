/**
 * MCP Streamable HTTP endpoint (Vercel Node.js serverless function).
 *
 * Stateless: a fresh McpServer + transport is built per request (Vercel
 * invocations are ephemeral/independent, so there's no session to keep alive
 * across requests — see src/server.ts for the shared tool-registration logic
 * also used by the local stdio entrypoint). Requires a valid Bearer access
 * token (see src/http/auth.ts) issued via the /authorize + /token flow.
 *
 * The token's principal becomes the request's access scope (src/scope.ts):
 * everything the request goes on to do — every tool call — runs inside it, so
 * an account-scoped user is confined to their allowlist no matter which tool
 * they reach for.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "../src/server.js";
import { verifyAccessToken, type Principal } from "../src/http/auth.js";
import { getPublicUrl } from "../src/http/env.js";
import { runWithAccessScope } from "../src/scope.js";

export const config = { runtime: "nodejs" };

function unauthorized(): Response {
  const resourceMetadataUrl = `${getPublicUrl()}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );
}

/** Resolves the Bearer token to its principal, or null when absent/invalid. */
async function authenticate(request: Request): Promise<Principal | null> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  try {
    return await verifyAccessToken(match[1]);
  } catch {
    return null;
  }
}

async function serve(request: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

async function handle(request: Request): Promise<Response> {
  const principal = await authenticate(request);
  if (!principal) return unauthorized();

  return runWithAccessScope(
    { subject: principal.sub, allowedCustomerIds: principal.customers },
    () => serve(request),
  );
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
