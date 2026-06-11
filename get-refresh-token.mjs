#!/usr/bin/env node
/**
 * Obtains a Google Ads refresh token for YOUR OAuth client via a local loopback
 * redirect (the reliable, Playground-free path). Opens the browser, captures the
 * consent callback on http://localhost:8080, exchanges the code, and writes the
 * refresh token to /tmp/ga-refresh-token.txt (and prints it).
 *
 * Run with: GA_CLIENT_ID=... GA_CLIENT_SECRET=... node get-refresh-token.mjs
 *
 * For a "Desktop app" OAuth client no redirect-URI registration is needed —
 * Google auto-allows the loopback flow. Uses http://127.0.0.1:8080 (per RFC 8252;
 * "localhost" can trigger redirect_uri_mismatch on Desktop clients).
 */
import http from "node:http";
import { writeFileSync } from "node:fs";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GA_CLIENT_ID;
const CLIENT_SECRET = process.env.GA_CLIENT_SECRET;
const PORT = 8080;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";
const OUT_FILE = "/tmp/ga-refresh-token.txt";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GA_CLIENT_ID / GA_CLIENT_SECRET env vars.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.end(`OAuth error: ${error}. You can close this tab.`);
    console.error("RESULT: FAIL — OAuth error:", error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const j = await r.json();
    if (j.refresh_token) {
      writeFileSync(OUT_FILE, j.refresh_token);
      res.end("✅ Success! Refresh token captured. You can close this tab and return to Claude.");
      console.log("RESULT: OK");
      console.log("refresh_token:", j.refresh_token);
      console.log("written to:", OUT_FILE);
    } else {
      res.end("No refresh_token returned. You can close this tab.");
      console.error("RESULT: FAIL — no refresh_token. Response:", JSON.stringify(j));
    }
  } catch (e) {
    res.end("Token exchange failed. You can close this tab.");
    console.error("RESULT: FAIL —", e?.message ?? String(e));
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Listening on ${REDIRECT_URI} — opening browser for consent...`);
  console.log("If the browser doesn't open, visit this URL manually:\n" + authUrl);
  exec(`open "${authUrl}"`);
});

// Safety timeout
setTimeout(() => {
  console.error("RESULT: TIMEOUT — no callback within 180s.");
  server.close();
  process.exit(1);
}, 180000);
