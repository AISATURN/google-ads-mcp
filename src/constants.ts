/**
 * Shared constants and string-enum option lists for the Google Ads MCP server.
 *
 * The string lists below are the values exposed to MCP clients. They are mapped
 * onto the numeric enums from the `google-ads-api` library inside the tool
 * implementations, keeping the wire-facing surface human-readable.
 */

export const SERVER_NAME = "google-ads-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum size (in characters) of a tool's text response before truncation. */
export const CHARACTER_LIMIT = 25000;

/**
 * Advertising channel types supported by `google_ads_create_campaign`.
 *
 * Note: SEARCH and DISPLAY work end-to-end with the ad group / keyword / RSA
 * tools in this server. SHOPPING, VIDEO and PERFORMANCE_MAX campaigns can be
 * created but require additional setup (asset groups, listing groups, linked
 * Merchant Center / YouTube assets) that is outside this server's scope.
 */
export const CHANNEL_TYPES = [
  "SEARCH",
  "DISPLAY",
  "SHOPPING",
  "VIDEO",
  "PERFORMANCE_MAX",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Bidding strategies supported by `google_ads_create_campaign`. */
export const BIDDING_STRATEGIES = [
  "MANUAL_CPC",
  "MAXIMIZE_CLICKS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
] as const;
export type BiddingStrategy = (typeof BIDDING_STRATEGIES)[number];

/** Keyword match types. */
export const KEYWORD_MATCH_TYPES = ["BROAD", "PHRASE", "EXACT"] as const;
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];

/** Mutable campaign statuses exposed to clients. */
export const CAMPAIGN_STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;
export type CampaignStatusName = (typeof CAMPAIGN_STATUSES)[number];

/** Budget delivery methods. */
export const BUDGET_DELIVERY_METHODS = ["STANDARD", "ACCELERATED"] as const;
export type BudgetDeliveryMethod = (typeof BUDGET_DELIVERY_METHODS)[number];

/**
 * Predefined GAQL date ranges (a subset of Google Ads `DURING` literals) used
 * by `google_ads_get_campaign_performance`.
 */
export const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
  "THIS_WEEK_MON_TODAY",
  "LAST_BUSINESS_WEEK",
] as const;
export type DateRange = (typeof DATE_RANGES)[number];
