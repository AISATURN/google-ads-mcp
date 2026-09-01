/**
 * Minimal, stateless OAuth 2.1 (authorization code + PKCE) token issuance and
 * verification for the remote deployment of this server.
 *
 * There is no database: every "code" and "token" is a self-contained signed
 * JWT (HS256, secret = MCP_JWT_SECRET). A `type` claim on every token prevents
 * one kind (e.g. a refresh token) from being replayed as another (e.g. an
 * access token). Revocation = rotate MCP_JWT_SECRET, which invalidates every
 * outstanding code/token at once — the only revocation model that doesn't
 * require adding a datastore.
 *
 * Every code and token also carries the authenticated principal: who logged in
 * (`sub`) and which Google Ads accounts they may touch (`customers`, null =
 * unrestricted). That claim is what api/mcp.ts turns into a request scope, so
 * a scoped user's tokens can never widen their own access — the allowlist is
 * signed into the token itself.
 *
 * Authorization codes are bounded-replay (not cryptographically single-use):
 * with no store to mark a code "consumed", the same code could in principle
 * be redeemed more than once within its 5-minute window. This is an accepted
 * tradeoff over HTTPS with PKCE — closing it fully would require a datastore
 * (e.g. Upstash/Vercel KV) to track consumed jti's.
 */

import { randomUUID, createHash } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getPublicUrl, getResourceUrl, requireEnv } from "./env.js";

const AUTH_CODE_TTL = "5m";
const ACCESS_TOKEN_TTL = "10d";
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL = "180d";

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv("MCP_JWT_SECRET"));
}

/** The authenticated caller carried by every code/token this server issues. */
export interface Principal {
  /** User id from MCP_USERS, or "owner". */
  sub: string;
  /** Allowed 10-digit customer IDs, or null for unrestricted (owner) access. */
  customers: string[] | null;
}

export interface AuthCodeClaims extends Principal {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

/** Reads the principal claims off a verified payload, defaulting to unrestricted-but-anonymous. */
function principalFrom(payload: JWTPayload): Principal {
  const customers = payload.customers;
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "owner",
    customers: Array.isArray(customers) ? customers.map(String) : null,
  };
}

/** Signs a short-lived authorization code embedding the PKCE challenge, redirect target, and principal. */
export async function signAuthCode(claims: AuthCodeClaims): Promise<string> {
  const issuer = getPublicUrl();
  const { sub, customers, ...rest } = claims;
  return new SignJWT({ type: "auth_code", customers, ...rest })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(sub)
    .setJti(randomUUID())
    .setExpirationTime(AUTH_CODE_TTL)
    .sign(getSecretKey());
}

/** Verifies an authorization code, returning its embedded claims. Throws on invalid/expired/wrong-type. */
export async function verifyAuthCode(code: string): Promise<AuthCodeClaims> {
  const issuer = getPublicUrl();
  const { payload } = await jwtVerify(code, getSecretKey(), {
    algorithms: ["HS256"],
    issuer,
    audience: issuer,
  });
  assertType(payload, "auth_code");
  return {
    ...principalFrom(payload),
    client_id: String(payload.client_id ?? ""),
    redirect_uri: String(payload.redirect_uri ?? ""),
    code_challenge: String(payload.code_challenge ?? ""),
  };
}

/** Signs an access token for a principal, bound to a resource URL (default: this server's /mcp endpoint). */
export async function signAccessToken(
  principal: Principal,
  resource?: string,
): Promise<{ token: string; expiresIn: number }> {
  const issuer = getPublicUrl();
  const token = await new SignJWT({ type: "access_token", customers: principal.customers })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(resource ?? getResourceUrl())
    .setSubject(principal.sub)
    .setJti(randomUUID())
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getSecretKey());
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verifies an access token against the expected resource audience and returns
 * the principal it was issued for. Throws on invalid/expired/wrong-type.
 */
export async function verifyAccessToken(token: string, resource?: string): Promise<Principal> {
  const issuer = getPublicUrl();
  const { payload } = await jwtVerify(token, getSecretKey(), {
    algorithms: ["HS256"],
    issuer,
    audience: resource ?? getResourceUrl(),
  });
  assertType(payload, "access_token");
  return principalFrom(payload);
}

/** Signs a long-lived refresh token for a principal, scoped to the issuer only (not a specific resource). */
export async function signRefreshToken(principal: Principal): Promise<string> {
  const issuer = getPublicUrl();
  return new SignJWT({ type: "refresh_token", customers: principal.customers })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(principal.sub)
    .setJti(randomUUID())
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(getSecretKey());
}

/** Verifies a refresh token and returns its principal. Throws on invalid/expired/wrong-type. */
export async function verifyRefreshToken(token: string): Promise<Principal> {
  const issuer = getPublicUrl();
  const { payload } = await jwtVerify(token, getSecretKey(), {
    algorithms: ["HS256"],
    issuer,
    audience: issuer,
  });
  assertType(payload, "refresh_token");
  return principalFrom(payload);
}

function assertType(payload: JWTPayload, expected: string): void {
  if (payload.type !== expected) {
    throw new Error(`Invalid token type: expected "${expected}", got "${String(payload.type)}"`);
  }
}

/** Computes the S256 PKCE code_challenge for a given code_verifier, for comparison against the stored challenge. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
