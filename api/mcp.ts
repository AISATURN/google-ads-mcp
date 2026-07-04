/**
 * MCP Streamable HTTP endpoint (Vercel Node.js serverless function).
 *
 * Stateless: a fresh McpServer + transport is built per request (Vercel
 * invocations are ephemeral/independent, so there's no session to keep alive
 * across requests — see src/server.ts for the shared tool-registration logic
 * also used by the local stdio entrypoint). Requires a valid Bearer access
 * token (see src/http/auth.ts) issued via the /authorize + /token flow.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "../src/server.js";
import { verifyAccessToken } from "../src/http/auth.js";
import { getPublicUrl } from "../src/http/env.js";

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

async function requireAuth(request: Request): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  try {
    await verifyAccessToken(match[1]);
    return true;
  } catch {
    return false;
  }
}

async function handle(request: Request): Promise<Response> {
  if (!(await requireAuth(request))) return unauthorized();

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

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
