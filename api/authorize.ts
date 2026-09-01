/**
 * OAuth 2.1 authorization endpoint: validates the incoming request, shows a
 * password gate, and on success redirects back to the client with a signed
 * authorization code (see src/http/auth.ts).
 *
 * The password identifies *which* user is logging in (see src/http/users.ts):
 * the owner, or one of the account-scoped users declared in MCP_USERS. The
 * resulting account allowlist is signed into the authorization code, so it
 * travels with every token minted from it.
 */

import { signAuthCode } from "../src/http/auth.js";
import { authenticateUser } from "../src/http/users.js";

export const config = { runtime: "nodejs" };

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function isAllowedRedirect(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function parseParams(url: URL): AuthorizeParams | { error: string } {
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!redirectUri) return { error: "Missing redirect_uri" };
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    return { error: "Invalid redirect_uri" };
  }
  if (!isAllowedRedirect(parsedRedirect)) return { error: "redirect_uri must be HTTPS" };

  if (url.searchParams.get("response_type") !== "code") {
    return { error: "Unsupported response_type (only 'code' is supported)" };
  }
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return { error: "Missing client_id" };
  const codeChallenge = url.searchParams.get("code_challenge");
  if (!codeChallenge) return { error: "Missing code_challenge (PKCE is required)" };
  if (url.searchParams.get("code_challenge_method") !== "S256") {
    return { error: "code_challenge_method must be S256" };
  }

  return { clientId, redirectUri, codeChallenge, state: url.searchParams.get("state") };
}

function renderForm(url: URL, error?: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize — Google Ads MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  p { color: #555; font-size: 0.9rem; }
  input[type=password] { width: 100%; padding: 10px; font-size: 1rem; box-sizing: border-box; margin: 12px 0; border: 1px solid #ccc; border-radius: 6px; }
  button { width: 100%; padding: 10px; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  .error { color: #b00020; font-size: 0.9rem; }
</style></head>
<body>
  <h1>Authorize access</h1>
  <p>Sign in to grant this app access to your Google Ads MCP server.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(url.pathname + url.search)}">
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function badRequest(error: string): Response {
  return new Response(`Invalid authorization request: ${error}`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = parseParams(url);
  if ("error" in params) return badRequest(params.error);
  return renderForm(url);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = parseParams(url);
  if ("error" in params) return badRequest(params.error);

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const user = authenticateUser(password);
  if (!user) {
    return renderForm(url, "Incorrect password. Try again.");
  }

  const code = await signAuthCode({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    sub: user.id,
    customers: user.customerIds,
  });

  const redirectTarget = new URL(params.redirectUri);
  redirectTarget.searchParams.set("code", code);
  if (params.state) redirectTarget.searchParams.set("state", params.state);

  return new Response(null, {
    status: 302,
    headers: { location: redirectTarget.toString(), "cache-control": "no-store" },
  });
}
