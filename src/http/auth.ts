/**
 * Minimal, stateless OAuth 2.1 (authorization code + PKCE) token issuance and
 * verification for the single-user remote deployment of this server.
 *
 * There is no database: every "code" and "token" is a self-contained signed
 * JWT (HS256, secret = MCP_JWT_SECRET). A `type` claim on every token prevents
 * one kind (e.g. a refresh token) from being replayed as another (e.g. an
 * access token). Revocation = rotate MCP_JWT_SECRET, which invalidates every
 * outstanding code/token at once — the only revocation model that doesn't
 * require adding a datastore for a single-user deployment.
 *
 * Authorization codes are bounded-replay (not cryptographically single-use):
 * with no store to mark a code "consumed", the same code could in principle
 * be redeemed more than once within its 5-minute window. This is an accepted
 * tradeoff for a single personal user over HTTPS with PKCE — closing it fully
 * would require a datastore (e.g. Upstash/Vercel KV) to track consumed jti's.
 */

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getPublicUrl, getResourceUrl, requireEnv } from "./env.js";

const AUTH_CODE_TTL = "5m";
const ACCESS_TOKEN_TTL = "10d";
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL = "180d";

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv("MCP_JWT_SECRET"));
}

export interface AuthCodeClaims {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

/** Signs a short-lived authorization code embedding the PKCE challenge and redirect target. */
export async function signAuthCode(claims: AuthCodeClaims): Promise<string> {
  const issuer = getPublicUrl();
  return new SignJWT({ type: "auth_code", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(issuer)
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
    client_id: String(payload.client_id ?? ""),
    redirect_uri: String(payload.redirect_uri ?? ""),
    code_challenge: String(payload.code_challenge ?? ""),
  };
}

/** Signs an access token bound to a specific resource URL (default: this server's /mcp endpoint). */
export async function signAccessToken(resource?: string): Promise<{ token: string; expiresIn: number }> {
  const issuer = getPublicUrl();
  const token = await new SignJWT({ type: "access_token" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(resource ?? getResourceUrl())
    .setJti(randomUUID())
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getSecretKey());
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Verifies an access token against the expected resource audience. Throws on invalid/expired/wrong-type. */
export async function verifyAccessToken(token: string, resource?: string): Promise<void> {
  const issuer = getPublicUrl();
  const { payload } = await jwtVerify(token, getSecretKey(), {
    algorithms: ["HS256"],
    issuer,
    audience: resource ?? getResourceUrl(),
  });
  assertType(payload, "access_token");
}

/** Signs a long-lived refresh token, scoped to the issuer only (not a specific resource). */
export async function signRefreshToken(): Promise<string> {
  const issuer = getPublicUrl();
  return new SignJWT({ type: "refresh_token" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(issuer)
    .setJti(randomUUID())
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(getSecretKey());
}

/** Verifies a refresh token. Throws on invalid/expired/wrong-type. */
export async function verifyRefreshToken(token: string): Promise<void> {
  const issuer = getPublicUrl();
  await jwtVerify(token, getSecretKey(), {
    algorithms: ["HS256"],
    issuer,
    audience: issuer,
  }).then(({ payload }) => assertType(payload, "refresh_token"));
}

function assertType(payload: JWTPayload, expected: string): void {
  if (payload.type !== expected) {
    throw new Error(`Invalid token type: expected "${expected}", got "${String(payload.type)}"`);
  }
}

/** Constant-time comparison of a submitted password against MCP_OWNER_PASSWORD. */
export function checkOwnerPassword(submitted: string): boolean {
  const expected = requireEnv("MCP_OWNER_PASSWORD");
  const submittedHash = createHash("sha256").update(submitted, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(submittedHash, expectedHash);
}

/** Computes the S256 PKCE code_challenge for a given code_verifier, for comparison against the stored challenge. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
