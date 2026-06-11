// One-off: full setup for "Up | Çit Altı Duvar Kalıbı" — campaign+budget,
// ad group, phrase keywords, RSA, TR/Turkish targeting, negatives, shared assets.
import { customer, CUSTOMER_ID, ResourceNames } from "./_client.mjs";

const asset = (id) => `customers/${CUSTOMER_ID}/assets/${id}`;
const FINAL_URL = "https://gooplast.com/cit-alti-duvar-kalibi/";

// 1) Budget + campaign (atomic)
const tempBudget = ResourceNames.campaignBudget(CUSTOMER_ID, "-1");
const step1 = await customer.mutateResources([
  {
    entity: "campaign_budget", operation: "create",
    resource: {
      resource_name: tempBudget,
      name: `Up | Çit Altı Duvar Kalıbı — budget ${Date.now().toString(36)}`,
      amount_micros: 1000 * 1_000_000,
      delivery_method: "STANDARD",
      explicitly_shared: false,
    },
  },
  {
    entity: "campaign", operation: "create",
    resource: {
      name: "Up | Çit Altı Duvar Kalıbı",
      advertising_channel_type: "SEARCH",
      status: "PAUSED",
      contains_eu_political_advertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      campaign_budget: tempBudget,
      target_spend: {},
      network_settings: {
        target_google_search: true,
        target_search_network: false,
        target_content_network: false,
        target_partner_search_network: false,
      },
    },
  },
]);
const campaign = step1.mutate_operation_responses?.[1]?.campaign_result?.resource_name;
if (!campaign) throw new Error("campaign create failed");
console.log("campaign:", campaign);

// 2) Ad group
const agRes = await customer.adGroups.create([
  { name: "Çit Altı Duvar Kalıbı", campaign, type: "SEARCH_STANDARD", status: "ENABLED" },
]);
const adGroup = agRes.results?.[0]?.resource_name;
if (!adGroup) throw new Error("ad group create failed");
console.log("ad_group:", adGroup);

// 3) Keywords (phrase)
const KEYWORDS = [
  "çit altı duvar kalıbı", // ürün adı (hacim 0 ama birebir alakalı)
  "bahçe duvarı kalıbı",   // 720/ay
  "hazır bahçe duvarı",    // 720/ay
  "duvar kalıbı",          // 590/ay
  "hazır beton duvar",     // 590/ay
  "beton duvar kalıbı",    // 480/ay
  "beton bahçe duvarı",    // 480/ay
  "beton çit",             // 390/ay
  "plastik duvar kalıbı",  // 140/ay
  "çevre duvarı kalıbı",   // 10/ay
];
const kwRes = await customer.adGroupCriteria.create(
  KEYWORDS.map((text) => ({ ad_group: adGroup, status: "ENABLED", keyword: { text, match_type: "PHRASE" } })),
);
console.log("keywords:", kwRes.results?.length);

// 4) Responsive Search Ad
const adRes = await customer.adGroupAds.create([
  {
    ad_group: adGroup,
    status: "ENABLED",
    ad: {
      final_urls: [FINAL_URL],
      responsive_search_ad: {
        headlines: [
          "Çit Altı Duvar Kalıbı", "Bahçe Duvarı Kalıbı", "Kalıcı Beton Duvar Kalıbı",
          "Vinç Gerektirmeyen Montaj", "Hafif Modüler Plastik Panel", "Sıva Gerektirmez",
          "UV ve Aleve Dayanıklı", "Hızlı Kurulum Düşük Maliyet", "GooPlast Üretici Firma",
          "Ücretsiz Teklif Alın", "Site ve Villa Çevre Duvarı", "Halı Saha ve Spor Tesisleri",
        ].map((text) => ({ text })),
        descriptions: [
          "Mühendislik plastiğinden kalıcı duvar kalıbı. Vinç gerektirmez, kolay ve hızlı montaj.",
          "Beton döküldükten sonra yapıda kalır; sökme işçiliği yok, yüzey sıva gerektirmez.",
          "Tel çit, halı saha, park ve site çevre duvarlarında hızlı, ekonomik kalıp çözümü.",
          "UV katkılı, aleve dayanıklı mühendislik plastiği. Ahşap ve çelik kalıba alternatif.",
        ].map((text) => ({ text })),
        path1: "cit-alti-duvar",
      },
    },
  },
]);
console.log("ad:", adRes.results?.[0]?.resource_name);

// 5) Targeting + negatives + assets
const NEGATIVES = [
  "tül", "fon perde", "stor", "zebra perde", "korniş", "perde modelleri", "dikiş",
  "nedir", "nasıl yapılır", "dwg", "detay çizimi", "ikinci el", "kiralık", "iş ilanları",
  "perde", "istinat", // Perde Beton Kalıbı kampanyasıyla çakışmayı önler
];
const step5 = await customer.mutateResources([
  { entity: "campaign_criterion", operation: "create",
    resource: { campaign, location: { geo_target_constant: "geoTargetConstants/2792" } } },
  { entity: "campaign_criterion", operation: "create",
    resource: { campaign, language: { language_constant: "languageConstants/1037" } } },
  ...NEGATIVES.map((text) => ({
    entity: "campaign_criterion", operation: "create",
    resource: { campaign, negative: true, keyword: { text, match_type: "PHRASE" } },
  })),
  ...["144923286614", "144923286617", "144923286620", "144923286623", "144923286626", "144923286629"].map((id) => ({
    entity: "campaign_asset", operation: "create",
    resource: { campaign, asset: asset(id), field_type: "CALLOUT" },
  })),
  { entity: "campaign_asset", operation: "create",
    resource: { campaign, asset: asset("144923286809"), field_type: "CALL" } },
  ...["144923284211", "144923284214", "144923284223", "144923284229"].map((id) => ({
    entity: "campaign_asset", operation: "create",
    resource: { campaign, asset: asset(id), field_type: "SITELINK" },
  })),
  { entity: "campaign_asset", operation: "create",
    resource: { campaign, asset: asset("280862924025"), field_type: "STRUCTURED_SNIPPET" } },
]);
console.log("criteria+assets:", step5.mutate_operation_responses?.length);
