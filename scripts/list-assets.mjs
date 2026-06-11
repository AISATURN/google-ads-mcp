// Read existing ad assets (sitelinks, callouts, calls, structured snippets)
// linked at campaign and customer level, plus verify TR geo + Turkish language constants.
import { customer } from "./_client.mjs";

const campaignAssets = await customer.query(`
  SELECT campaign.id, campaign.name, campaign_asset.field_type, campaign_asset.status,
         asset.resource_name, asset.type,
         asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2,
         asset.final_urls,
         asset.callout_asset.callout_text,
         asset.call_asset.phone_number, asset.call_asset.country_code,
         asset.structured_snippet_asset.header, asset.structured_snippet_asset.values
  FROM campaign_asset
  WHERE campaign_asset.status != 'REMOVED'
`);

const customerAssets = await customer.query(`
  SELECT customer_asset.field_type, customer_asset.status,
         asset.resource_name, asset.type,
         asset.sitelink_asset.link_text, asset.final_urls,
         asset.callout_asset.callout_text,
         asset.call_asset.phone_number
  FROM customer_asset
  WHERE customer_asset.status != 'REMOVED'
`);

const geo = await customer.query(`
  SELECT geo_target_constant.resource_name, geo_target_constant.name
  FROM geo_target_constant
  WHERE geo_target_constant.country_code = 'TR' AND geo_target_constant.target_type = 'Country'
`);

const lang = await customer.query(`
  SELECT language_constant.resource_name, language_constant.name
  FROM language_constant
  WHERE language_constant.code = 'tr'
`);

console.log(JSON.stringify({ campaignAssets, customerAssets, geo, lang }, null, 2));
