/** RFC 9728 protected resource metadata. Exposed at /.well-known/oauth-protected-resource via vercel.json rewrite. */

import { buildProtectedResourceMetadata } from "../../src/http/metadata.js";

export const config = { runtime: "nodejs" };

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(buildProtectedResourceMetadata()), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}
