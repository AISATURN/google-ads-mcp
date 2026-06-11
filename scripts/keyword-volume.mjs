// Fetch Keyword Planner historical metrics for keywords passed as CLI args.
// Usage: node scripts/keyword-volume.mjs "box culvert" [more keywords...]
import { customer, CUSTOMER_ID } from "./_client.mjs";

const keywords = process.argv.slice(2);
if (keywords.length === 0) {
  console.error("Usage: node scripts/keyword-volume.mjs <keyword> [keyword...]");
  process.exit(1);
}

// KEYWORD_LANG=tr için Türkçe + yalnızca Türkiye kapsamı; varsayılan İngilizce + global/ABD/TR.
const TURKISH = process.env.KEYWORD_LANG === "tr";
const LANGUAGE = TURKISH ? "languageConstants/1037" : "languageConstants/1000";
const SCOPES = TURKISH
  ? [{ label: "Türkiye", geo: ["geoTargetConstants/2792"] }]
  : [
      { label: "Global (tüm ülkeler)", geo: [] },
      { label: "ABD", geo: ["geoTargetConstants/2840"] },
      { label: "Türkiye", geo: ["geoTargetConstants/2792"] },
    ];

const fmt = (m) => ({
  avg_monthly_searches: m.avg_monthly_searches,
  competition: m.competition,
  low_top_of_page_bid_micros: m.low_top_of_page_bid_micros,
  high_top_of_page_bid_micros: m.high_top_of_page_bid_micros,
  monthly_volumes: (m.monthly_search_volumes ?? []).map((v) => `${v.year}-${String(v.month).padStart(2, "0")}: ${v.monthly_searches}`),
});

try {
  for (const scope of SCOPES) {
    const response = await customer.keywordPlanIdeas.generateKeywordHistoricalMetrics({
      customer_id: CUSTOMER_ID,
      keywords,
      language: LANGUAGE,
      keyword_plan_network: "GOOGLE_SEARCH",
      geo_target_constants: scope.geo,
      historical_metrics_options: { include_average_cpc: true },
    });
    console.log(`\n=== ${scope.label} ===`);
    for (const r of response.results ?? []) {
      console.log(r.text, JSON.stringify(fmt(r.keyword_metrics ?? {}), null, 2));
    }
  }
} catch (err) {
  console.error("FAILED:", err.message ?? JSON.stringify(err, null, 2));
  process.exit(1);
}
