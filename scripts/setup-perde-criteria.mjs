// One-off: configure "Up | Perde Beton Kalıbı" (23929756301) —
// location=Turkey, language=Turkish, campaign-level negative keywords,
// and link existing brand assets (callouts, call, sitelinks, snippet).
import { customer, CUSTOMER_ID } from "./_client.mjs";

const CAMPAIGN = `customers/${CUSTOMER_ID}/campaigns/23929756301`;
const asset = (id) => `customers/${CUSTOMER_ID}/assets/${id}`;

const NEGATIVES = [
  "tül", "fon perde", "stor", "zebra perde", "korniş", "perde modelleri", "dikiş",
  "nedir", "nasıl yapılır", "dwg", "detay çizimi", "ikinci el", "kiralık", "iş ilanları",
];

const operations = [
  // Targeting
  { entity: "campaign_criterion", operation: "create",
    resource: { campaign: CAMPAIGN, location: { geo_target_constant: "geoTargetConstants/2792" } } },
  { entity: "campaign_criterion", operation: "create",
    resource: { campaign: CAMPAIGN, language: { language_constant: "languageConstants/1037" } } },
  // Negative keywords (phrase)
  ...NEGATIVES.map((text) => ({
    entity: "campaign_criterion", operation: "create",
    resource: { campaign: CAMPAIGN, negative: true, keyword: { text, match_type: "PHRASE" } },
  })),
  // Callouts (shared Turkish brand callouts)
  ...["144923286614", "144923286617", "144923286620", "144923286623", "144923286626", "144923286629"].map((id) => ({
    entity: "campaign_asset", operation: "create",
    resource: { campaign: CAMPAIGN, asset: asset(id), field_type: "CALLOUT" },
  })),
  // Call asset (0216 222 00 44)
  { entity: "campaign_asset", operation: "create",
    resource: { campaign: CAMPAIGN, asset: asset("144923286809"), field_type: "CALL" } },
  // Sitelinks (Turkish, cross-product)
  ...["144923284211", "144923284214", "144923284223", "144923284229"].map((id) => ({
    entity: "campaign_asset", operation: "create",
    resource: { campaign: CAMPAIGN, asset: asset(id), field_type: "SITELINK" },
  })),
  // Structured snippet (Hizmetler: Maliyet Avantajı / Kolay Montaj / Doğa Dostu / Uzun Ömürlü)
  { entity: "campaign_asset", operation: "create",
    resource: { campaign: CAMPAIGN, asset: asset("280862924025"), field_type: "STRUCTURED_SNIPPET" } },
];

const response = await customer.mutateResources(operations);
const results = (response.mutate_operation_responses ?? []).map(
  (r) => r.campaign_criterion_result?.resource_name ?? r.campaign_asset_result?.resource_name,
);
console.log(JSON.stringify({ created: results.length, results }, null, 2));
