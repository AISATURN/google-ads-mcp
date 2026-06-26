#!/usr/bin/env node
/**
 * google-ads-mcp-server
 *
 * An MCP server for creating and managing Google Ads campaigns via the Google
 * Ads API. Exposes account discovery, GAQL reads, campaign/budget creation,
 * ad group / keyword / responsive-search-ad creation, status management, and
 * performance reporting.
 *
 * Transport: stdio (local). Logs go to stderr only — never stdout — so they do
 * not corrupt the JSON-RPC stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { getMissingEnvVars } from "./client.js";
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

const TOOL_NAMES = [
  "google_ads_list_accessible_customers",
  "google_ads_list_campaigns",
  "google_ads_run_gaql",
  "google_ads_get_campaign_performance",
  "google_ads_create_campaign_budget",
  "google_ads_create_campaign",
  "google_ads_update_campaign_status",
  "google_ads_update_campaign_budget",
  "google_ads_update_campaign_bidding",
  "google_ads_create_ad_group",
  "google_ads_add_keywords",
  "google_ads_create_responsive_search_ad",
  "google_ads_add_campaign_assets",
  "google_ads_add_negative_keywords",
  "google_ads_set_geo_targeting",
  "google_ads_set_language_targeting",
  "google_ads_set_ad_schedule",
  "google_ads_set_device_bid_adjustments",
  "google_ads_update_keywords",
  "google_ads_update_ad_group",
  "google_ads_update_ad_status",
  "google_ads_create_shared_negative_list",
  "google_ads_generate_keyword_ideas",
  "google_ads_get_search_terms_report",
  "google_ads_list_conversion_actions",
  "google_ads_create_conversion_action",
  "google_ads_set_campaign_bidding_strategy",
  "google_ads_search_geo_targets",
  "google_ads_search_language_codes",
  "google_ads_set_location_bid_modifier",
  "google_ads_list_user_lists",
  "google_ads_create_user_list",
  "google_ads_attach_audience",
  "google_ads_create_responsive_search_ad_advanced",
  "google_ads_add_image_asset",
  "google_ads_remove_campaign_asset",
  "google_ads_set_demographic_targeting",
  "google_ads_exclude_placements",
  "google_ads_list_recommendations",
  "google_ads_apply_recommendation",
  "google_ads_create_asset_group",
  "google_ads_add_asset_group_assets",
];

function printHelp(): void {
  const help = `${SERVER_NAME} v${SERVER_VERSION}

An MCP server for creating and managing Google Ads campaigns.

USAGE
  google-ads-mcp-server            Start the server over stdio (for MCP clients)
  google-ads-mcp-server --help     Show this help
  google-ads-mcp-server --version  Print the version

REQUIRED ENVIRONMENT VARIABLES
  GOOGLE_ADS_DEVELOPER_TOKEN       Developer token from your Google Ads MCC API Center
  GOOGLE_ADS_CLIENT_ID             OAuth2 client ID (Google Cloud Console)
  GOOGLE_ADS_CLIENT_SECRET         OAuth2 client secret
  GOOGLE_ADS_REFRESH_TOKEN         OAuth2 refresh token (scope: adwords)

OPTIONAL ENVIRONMENT VARIABLES
  GOOGLE_ADS_LOGIN_CUSTOMER_ID     Manager (MCC) account ID — login-customer-id
  GOOGLE_ADS_CUSTOMER_ID           Default advertising account ID for tool calls

TOOLS (${TOOL_NAMES.length})
${TOOL_NAMES.map((t) => `  - ${t}`).join("\n")}

See README.md for setup, credentials, and MCP client configuration.`;
  process.stdout.write(help + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} v${SERVER_VERSION}\n`);
    return;
  }

  const missing = getMissingEnvVars();
  if (missing.length > 0) {
    console.error(
      `ERROR: missing required environment variable(s): ${missing.join(", ")}.\n` +
        `Set them before starting the server. Run with --help for details.`,
    );
    process.exit(1);
  }

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (${TOOL_NAMES.length} tools)`);
}

main().catch((error) => {
  console.error("Fatal error starting server:", error);
  process.exit(1);
});
