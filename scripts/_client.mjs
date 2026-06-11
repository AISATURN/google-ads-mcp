// Shared Google Ads client for one-off scripts.
// Patches dns.lookup for googleads.googleapis.com because the local network's
// DNS filter (ad blocker) returns NXDOMAIN for it; IPs come from public DoH.
import dns from "node:dns";
import { readFileSync } from "node:fs";

const GOOGLEADS_IPS = ["216.239.32.223", "216.239.34.223", "216.239.36.223", "216.239.38.223"];
const OVERRIDE_HOST = "googleads.googleapis.com";

const realLookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (hostname === OVERRIDE_HOST) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options !== null ? options : {};
    const entries = GOOGLEADS_IPS.map((address) => ({ address, family: 4 }));
    if (opts.all) return process.nextTick(() => cb(null, entries));
    return process.nextTick(() => cb(null, GOOGLEADS_IPS[0], 4));
  }
  return realLookup(hostname, options, callback);
};

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

// Import AFTER the dns patch so grpc-js picks up the patched resolver.
const { GoogleAdsApi, ResourceNames } = await import("google-ads-api");

const api = new GoogleAdsApi({
  client_id: env.GOOGLE_ADS_CLIENT_ID,
  client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

export { ResourceNames };
export const CUSTOMER_ID = "5660353352";
export const customer = api.Customer({
  customer_id: CUSTOMER_ID,
  refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
  login_customer_id: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ""),
});
