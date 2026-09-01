/**
 * OAuth 2.1 token endpoint: exchanges an authorization code (+ PKCE verifier)
 * or a refresh token for a fresh access token. See src/http/auth.ts for the
 * underlying stateless JWT sign/verify logic.
 *
 * The principal (user id + account allowlist) is carried over from the
 * presented code/refresh token onto every token issued here — a caller can
 * never refresh their way into wider access than they were granted.
 */

import {
  verifyAuthCode,
  pkceChallengeFromVerifier,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../src/http/auth.js";

export const config = { runtime: "nodejs" };

function errorResponse(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("invalid_request", "Expected an application/x-www-form-urlencoded body");
  }

  const grantType = String(form.get("grant_type") ?? "");
  const resource = form.get("resource") ? String(form.get("resource")) : undefined;

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const codeVerifier = String(form.get("code_verifier") ?? "");
    if (!code || !redirectUri || !codeVerifier) {
      return errorResponse("invalid_request", "Missing code, redirect_uri, or code_verifier");
    }

    let claims;
    try {
      claims = await verifyAuthCode(code);
    } catch {
      return errorResponse("invalid_grant", "Authorization code is invalid or expired");
    }
    if (claims.redirect_uri !== redirectUri) {
      return errorResponse("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (pkceChallengeFromVerifier(codeVerifier) !== claims.code_challenge) {
      return errorResponse("invalid_grant", "code_verifier does not match code_challenge");
    }

    const principal = { sub: claims.sub, customers: claims.customers };
    const { token, expiresIn } = await signAccessToken(principal, resource);
    const refreshToken = await signRefreshToken(principal);
    return new Response(
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshToken,
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") ?? "");
    if (!refreshToken) return errorResponse("invalid_request", "Missing refresh_token");
    let principal;
    try {
      principal = await verifyRefreshToken(refreshToken);
    } catch {
      return errorResponse("invalid_grant", "Refresh token is invalid or expired");
    }
    const { token, expiresIn } = await signAccessToken(principal, resource);
    return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  return errorResponse("unsupported_grant_type", `Unsupported grant_type: "${grantType}"`);
}
