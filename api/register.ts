/**
 * Minimal RFC 7591 Dynamic Client Registration endpoint. Single-tenant server:
 * there's nothing to persist — every registration is a public client (PKCE,
 * no client secret), so we just echo back a fresh client_id.
 */

import { randomUUID } from "node:crypto";

export const config = { runtime: "nodejs" };

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Tolerate an empty/missing body — treat as no redirect_uris provided.
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return new Response(
      JSON.stringify({ error: "invalid_client_metadata", error_description: "redirect_uris is required" }),
      { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }

  const response = {
    client_id: randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
  };

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
