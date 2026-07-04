/**
 * Builds the shared McpServer instance: registers all Google Ads tools. Used
 * by both the stdio entrypoint (src/index.ts) and the HTTP entrypoint
 * (api/mcp.ts) so tool registration lives in exactly one place.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerQueryTools } from "./tools/queries.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdGroupTools } from "./tools/adGroups.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerTargetingTools } from "./tools/targeting.js";
import { registerManageTools } from "./tools/manage.js";
import { registerResearchTools } from "./tools/research.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerOptimizeTools } from "./tools/optimize.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerAdTools } from "./tools/ads.js";
import { registerAsset2Tools } from "./tools/assets2.js";
import { registerExclusionTools } from "./tools/exclusions.js";
import { registerRecommendationTools } from "./tools/recommendations.js";
import { registerPmaxTools } from "./tools/pmax.js";
import { registerDsaTools } from "./tools/dsa.js";
import { registerBrandTools } from "./tools/brand.js";

export const TOOL_NAMES = [
  "google_ads_add_asset_group_assets",
  "google_ads_add_campaign_assets",
  "google_ads_add_dynamic_page_targets",
  "google_ads_add_image_asset",
  "google_ads_add_keywords",
  "google_ads_add_negative_keywords",
  "google_ads_add_pmax_brand_exclusion",
  "google_ads_apply_recommendation",
  "google_ads_attach_audience",
  "google_ads_create_ad_group",
  "google_ads_create_asset_group",
  "google_ads_create_campaign",
  "google_ads_create_campaign_budget",
  "google_ads_create_conversion_action",
  "google_ads_create_dsa_ad_group",
  "google_ads_create_dynamic_search_ad",
  "google_ads_create_responsive_search_ad",
  "google_ads_create_responsive_search_ad_advanced",
  "google_ads_create_shared_negative_list",
  "google_ads_create_user_list",
  "google_ads_exclude_placements",
  "google_ads_generate_keyword_ideas",
  "google_ads_get_campaign_performance",
  "google_ads_get_search_terms_report",
  "google_ads_list_accessible_customers",
  "google_ads_list_campaigns",
  "google_ads_list_conversion_actions",
  "google_ads_list_recommendations",
  "google_ads_list_user_lists",
  "google_ads_remove_campaign_asset",
  "google_ads_run_gaql",
  "google_ads_search_geo_targets",
  "google_ads_search_language_codes",
  "google_ads_set_ad_schedule",
  "google_ads_set_campaign_bidding_strategy",
  "google_ads_set_demographic_targeting",
  "google_ads_set_device_bid_adjustments",
  "google_ads_set_geo_targeting",
  "google_ads_set_language_targeting",
  "google_ads_set_location_bid_modifier",
  "google_ads_suggest_brands",
  "google_ads_update_ad_group",
  "google_ads_update_ad_status",
  "google_ads_update_campaign_bidding",
  "google_ads_update_campaign_budget",
  "google_ads_update_campaign_network_settings",
  "google_ads_update_campaign_status",
  "google_ads_update_keywords",
];

/** Constructs an McpServer with all Google Ads tools registered. */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerQueryTools(server);
  registerCampaignTools(server);
  registerAdGroupTools(server);
  registerAssetTools(server);
  registerTargetingTools(server);
  registerManageTools(server);
  registerResearchTools(server);
  registerConversionTools(server);
  registerOptimizeTools(server);
  registerAudienceTools(server);
  registerAdTools(server);
  registerAsset2Tools(server);
  registerExclusionTools(server);
  registerRecommendationTools(server);
  registerPmaxTools(server);
  registerDsaTools(server);
  registerBrandTools(server);

  return server;
}
