// Add "hatıl kalıbı" keyword to the Perde Beton Kalıbı ad group and
// revise the RSA: +2 hatıl headlines, 1 description reworked to include hatıl.
import { customer, CUSTOMER_ID } from "./_client.mjs";

const AD_GROUP = `customers/${CUSTOMER_ID}/adGroups/201199904350`;
const AD = `customers/${CUSTOMER_ID}/ads/812405286414`;

// 1) Keyword
const kw = await customer.adGroupCriteria.create([
  { ad_group: AD_GROUP, status: "ENABLED", keyword: { text: "hatıl kalıbı", match_type: "PHRASE" } },
]);
console.log("keyword:", kw.results?.[0]?.resource_name);

// 2) RSA revision (update replaces the full asset lists)
const upd = await customer.ads.update([
  {
    resource_name: AD,
    responsive_search_ad: {
      headlines: [
        "Perde Beton Kalıbı", "Hatıl Kalıbı", "Kalıcı Hatıl Kalıp Sistemi",
        "Kalıcı Perde Kalıp Sistemi", "Vinç Gerektirmeyen Montaj", "Hafif Modüler Plastik Panel",
        "Sıva Gerektirmez", "Sökme İşçiliği Yok", "Hızlı Kurulum Düşük Maliyet",
        "GooPlast Üretici Firma", "Ücretsiz Teklif Alın", "İstinat ve Bodrum Perdeleri",
        "Elle Taşınır Hafif Paneller", "Hemen Fiyat Teklifi İsteyin",
      ].map((text) => ({ text })),
      descriptions: [
        "Mühendislik plastiğinden kalıcı perde kalıbı. Vinç gerektirmez, elle monte edilir.",
        "Beton döküldükten sonra yapıda kalır; sökme işçiliği yok, yüzey sıva gerektirmez.",
        "Hatıl, istinat ve temel perdeleri için hızlı, ekonomik kalıcı kalıp çözümü. Teklif alın.",
        "Ahşap ve çelik kalıba çevre dostu, ekonomik alternatif. Hemen iletişime geçin.",
      ].map((text) => ({ text })),
      path1: "perde-kalibi",
    },
  },
]);
console.log("ad updated:", upd.results?.[0]?.resource_name);
