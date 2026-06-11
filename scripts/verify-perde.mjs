// Verify targeting, negatives and asset links on campaign 23929756301.
import { customer } from "./_client.mjs";

try {
  const crit = await customer.query(`
    SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.keyword.text,
           campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant
    FROM campaign_criterion WHERE campaign.id = 23929756301`);
  const assets = await customer.query(`
    SELECT campaign.id, campaign_asset.field_type, campaign_asset.status FROM campaign_asset
    WHERE campaign.id = 23929756301 AND campaign_asset.status != 'REMOVED'`);
  const negs = crit.filter((r) => r.campaign_criterion.negative).map((r) => r.campaign_criterion.keyword?.text);
  const loc = crit.find((r) => r.campaign_criterion.location)?.campaign_criterion.location.geo_target_constant;
  const lang = crit.find((r) => r.campaign_criterion.language)?.campaign_criterion.language.language_constant;
  console.log(JSON.stringify({ location: loc, language: lang, negatives: negs, asset_links: assets.length }, null, 2));
} catch (err) {
  console.error("QUERY FAILED:", err.message ?? JSON.stringify(err, null, 2));
  process.exit(1);
}
