/** RFC 8414 authorization server metadata. Exposed at /.well-known/oauth-authorization-server via vercel.json rewrite. */

import { buildAuthorizationServerMetadata } from "../../src/http/metadata.js";

export const config = { runtime: "nodejs" };

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(buildAuthorizationServerMetadata()), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}
