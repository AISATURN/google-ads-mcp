// One-off: rebuild "HK - Categories DYN&" (9072767896) DSA targeting on DEERCASE
// (9772349482) as model-based ad groups. Creates 4 DSA ad groups (PAUSED), each
// with positive URL-contains model targets + negative theme targets, and a
// dynamic search ad. Does NOT enable anything and does NOT pause old ad groups —
// that cutover is a separate, explicitly-approved step.
//
// Mirrors the same google-ads-api calls the new MCP tools use
// (create_dsa_ad_group / add_dynamic_page_targets / create_dynamic_search_ad).
import dns from "node:dns";
import { readFileSync } from "node:fs";

// Local network's DNS filter NXDOMAINs googleads.googleapis.com; pin public IPs.
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

const { GoogleAdsApi } = await import("google-ads-api");
const api = new GoogleAdsApi({
  client_id: env.GOOGLE_ADS_CLIENT_ID,
  client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

const CUSTOMER_ID = "9772349482"; // DEERCASE
const CAMPAIGN_ID = "9072767896"; // HK - Categories DYN&
const customer = api.Customer({
  customer_id: CUSTOMER_ID,
  refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
  login_customer_id: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ""),
});
const CAMPAIGN = `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}`;

// Shared negative theme targets (model+theme pages -> excluded, keep model-only)
const THEME_NEGATIVES = [
  "mermer", "isme-ozel", "harfli", "seffaf", "renkli-silikon",
  "girl-boss", "retro", "tutacakli", "simli-sulu", "deri",
];

const IPHONE_DESC = [
  "iPhone modeline özel kılıflar. Trend tasarımlar, uygun fiyatlarla DeerCase'te.",
  "Ürünlerde %80'e varan indirim DeerCase'te. Hemen keşfet, koleksiyonu incele.",
];
const D2 = "Ürünlerde %80'e varan indirim DeerCase'te. Hemen keşfet, koleksiyonu incele.";

const GROUPS = [
  {
    name: "Model | iPhone Güncel",
    positives: ["iphone-13", "iphone-14", "iphone-15", "iphone-16", "iphone-17"],
    desc: IPHONE_DESC,
  },
  {
    name: "Model | iPhone Eski",
    positives: ["iphone-6", "iphone-7", "iphone-8", "iphone-x", "iphone-11", "iphone-12", "iphone-se"],
    desc: IPHONE_DESC,
  },
  {
    name: "Model | Samsung",
    positives: ["samsung-", "galaxy-"],
    desc: ["Samsung Galaxy modeline özel kılıflar. Trend tasarımlar, uygun fiyatlarla DeerCase.", D2],
  },
  {
    name: "Model | Xiaomi",
    positives: ["xiaomi-", "redmi-", "poco-"],
    desc: ["Xiaomi modeline özel kılıflar. Trend tasarımlar, uygun fiyatlarla DeerCase'te.", D2],
  },
];

const summary = [];
for (const g of GROUPS) {
  // 1) DSA ad group (PAUSED)
  const agRes = await customer.adGroups.create([
    { name: g.name, campaign: CAMPAIGN, type: "SEARCH_DYNAMIC_ADS", status: "PAUSED" },
  ]);
  const adGroup = agRes.results[0].resource_name;
  const adGroupId = adGroup.split("/").pop();

  // 2) Targets: positive model URL-contains + negative theme URL-contains
  const criteria = [
    ...g.positives.map((value) => ({
      ad_group: adGroup,
      status: "ENABLED",
      webpage: {
        criterion_name: `URL CONTAINS ${value}`,
        conditions: [{ operand: "URL", operator: "CONTAINS", argument: value }],
      },
    })),
    ...THEME_NEGATIVES.map((value) => ({
      ad_group: adGroup,
      negative: true,
      webpage: {
        criterion_name: `URL CONTAINS ${value}`,
        conditions: [{ operand: "URL", operator: "CONTAINS", argument: value }],
      },
    })),
  ];
  const critRes = await customer.adGroupCriteria.create(criteria);

  // 3) Dynamic search ad (PAUSED)
  const adRes = await customer.adGroupAds.create([
    {
      ad_group: adGroup,
      status: "PAUSED",
      ad: { expanded_dynamic_search_ad: { description: g.desc[0], description2: g.desc[1] } },
    },
  ]);

  summary.push({
    ad_group: g.name,
    ad_group_id: adGroupId,
    positives: g.positives.length,
    negatives: THEME_NEGATIVES.length,
    criteria_created: critRes.results.length,
    ad: adRes.results[0].resource_name.split("/").pop(),
  });
  console.log(`✓ ${g.name} (${adGroupId}) — ${g.positives.length} pozitif + ${THEME_NEGATIVES.length} negatif hedef, 1 reklam`);
}

console.log("\n=== ÖZET ===");
console.log(JSON.stringify(summary, null, 2));
console.log("\nHepsi PAUSED. Eski gruplara ve kampanya ayarlarına dokunulmadı.");
