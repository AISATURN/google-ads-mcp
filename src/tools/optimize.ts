/**
 * Optimization helpers: switch a campaign's bidding strategy type, look up geo
 * target constant IDs by name, look up language constant IDs, and set a bid
 * modifier on an already-targeted location.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function campaignResourceName(customerId: string, id: string): string {
  return `customers/${customerId}/campaigns/${id}`;
}

export function registerOptimizeTools(server: McpServer): void {
  // ---- set_campaign_bidding_strategy (switch type) ---------------------------
  const switchInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    strategy: z
      .enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS"])
      .describe("New bidding strategy type to switch the campaign to."),
    target_cpa: z.number().positive().optional().describe("Target CPA in account currency (TARGET_CPA, or optional for MAXIMIZE_CONVERSIONS)."),
    target_roas: z.number().positive().optional().describe("Target ROAS ratio, e.g. 4 = 400% (TARGET_ROAS, or optional for MAXIMIZE_CONVERSION_VALUE)."),
    enhanced_cpc: z.boolean().default(false).describe("Enhanced CPC for MANUAL_CPC."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_campaign_bidding_strategy",
    {
      title: "Switch Campaign Bidding Strategy",
      description: `Change a campaign's bidding strategy TYPE (not just its target). Switches between Manual CPC, Maximize Clicks, Maximize Conversions (optional tCPA), Maximize Conversion Value (optional tROAS), Target CPA, and Target ROAS.

Conversion-based strategies require working conversion tracking (see google_ads_list_conversion_actions).

Args:
  - campaign_id (string)
  - strategy (enum)
  - target_cpa (number, optional) / target_roas (number, optional) / enhanced_cpc (bool)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: switchInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.campaign_id.replace(/\D/g, "");
        const update: resources.ICampaign = { resource_name: campaignResourceName(customerId, cleanId) };
        // Clear competing fields by setting only the chosen one.
        switch (args.strategy) {
          case "MANUAL_CPC":
            update.manual_cpc = { enhanced_cpc_enabled: args.enhanced_cpc };
            break;
          case "MAXIMIZE_CLICKS":
            update.target_spend = {};
            break;
          case "MAXIMIZE_CONVERSIONS":
            update.maximize_conversions = typeof args.target_cpa === "number" ? { target_cpa_micros: toMicros(args.target_cpa) } : {};
            break;
          case "MAXIMIZE_CONVERSION_VALUE":
            update.maximize_conversion_value = typeof args.target_roas === "number" ? { target_roas: args.target_roas } : {};
            break;
          case "TARGET_CPA":
            if (typeof args.target_cpa !== "number") return fail("TARGET_CPA requires 'target_cpa'.");
            update.target_cpa = { target_cpa_micros: toMicros(args.target_cpa) };
            break;
          case "TARGET_ROAS":
            if (typeof args.target_roas !== "number") return fail("TARGET_ROAS requires 'target_roas'.");
            update.target_roas = { target_roas: args.target_roas };
            break;
        }
        await customer.campaigns.update([update]);
        const output = { campaign_id: cleanId, strategy: args.strategy, target_cpa: args.target_cpa, target_roas: args.target_roas, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Campaign ${cleanId} bidding strategy switched to **${args.strategy}**.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- search_geo_targets ----------------------------------------------------
  const geoSearchInput = z.object({
    location_names: z.array(z.string().min(1)).min(1).max(25).describe("Location names to look up, e.g. ['United States','Germany','Dubai']."),
    locale: z.string().default("en").describe("Locale for returned names (default 'en')."),
    country_code: z.string().length(2).optional().describe("Optional ISO country code to scope the search."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_search_geo_targets",
    {
      title: "Search Geo Target IDs by Name",
      description: `Look up geo target constant IDs (used by google_ads_set_geo_targeting) from human location names via Google's suggestion service.

Args:
  - location_names (string[]): names to resolve
  - locale (string, default 'en') / country_code (string, optional)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: geoSearchInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const svc = (customer as unknown as {
          geoTargetConstants: { suggest: (req: unknown) => Promise<unknown> };
        }).geoTargetConstants;
        const raw = await svc.suggest({
          locale: args.locale,
          country_code: args.country_code,
          location_names: { names: args.location_names },
        });
        const suggestions = (Array.isArray(raw) ? raw : (raw as { geo_target_constant_suggestions?: unknown[] })?.geo_target_constant_suggestions ?? []) as Array<{
          geo_target_constant?: { id?: number | string; name?: string; country_code?: string; target_type?: string };
          reach?: number | string;
        }>;
        const results = suggestions.map((s) => ({
          id: String(s.geo_target_constant?.id ?? ""),
          name: s.geo_target_constant?.name ?? "",
          country_code: s.geo_target_constant?.country_code ?? "",
          target_type: String(s.geo_target_constant?.target_type ?? ""),
          reach: Number(s.reach ?? 0),
        }));
        const output = { count: results.length, geo_targets: results, customer_id: customerId };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        const lines = [
          `# Geo target matches (${results.length})`,
          ``,
          `| ID | Name | Country | Type |`,
          `| --- | --- | --- | --- |`,
          ...results.map((r) => `| ${r.id} | ${r.name} | ${r.country_code} | ${r.target_type} |`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- search_language_codes -------------------------------------------------
  const langSearchInput = z.object({
    query: z.string().min(1).describe("Substring to match against language names/codes, e.g. 'eng', 'turk', 'arab'."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_search_language_codes",
    {
      title: "Search Language Constant IDs",
      description: `Find language constant IDs (used by google_ads_set_language_targeting / keyword ideas) by matching a substring of the language name or code.

Args:
  - query (string): substring to match (case-insensitive)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: langSearchInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const rows = await customer.query(
          `SELECT language_constant.id, language_constant.name, language_constant.code, language_constant.targetable FROM language_constant`,
        );
        const q = args.query.toLowerCase();
        const matches = rows
          .map((r) => ({
            id: String(r.language_constant?.id ?? ""),
            name: r.language_constant?.name ?? "",
            code: r.language_constant?.code ?? "",
            targetable: Boolean(r.language_constant?.targetable),
          }))
          .filter((l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q));
        const output = { count: matches.length, languages: matches, customer_id: customerId };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        const lines = [`# Language matches (${matches.length})`, ``, ...matches.map((m) => `- **${m.id}** — ${m.name} (${m.code})`)];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- set_location_bid_modifier ---------------------------------------------
  const locBidInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    location_id: z.string().describe("Geo target constant ID of an already-targeted location."),
    bid_modifier: z.number().min(0.1).max(10).describe("Multiplier: 1.2 = +20%, 0.8 = -20%."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_location_bid_modifier",
    {
      title: "Set Location Bid Modifier",
      description: `Set a bid modifier on a location the campaign already targets (the location must already be added via google_ads_set_geo_targeting).

Args:
  - campaign_id (string) / location_id (string) / bid_modifier (number)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: locBidInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanCampaign = args.campaign_id.replace(/\D/g, "");
        const cleanLoc = args.location_id.replace(/\D/g, "");
        const rows = await customer.query(
          `SELECT campaign_criterion.resource_name FROM campaign_criterion ` +
            `WHERE campaign.id = ${cleanCampaign} AND campaign_criterion.type = 'LOCATION' ` +
            `AND campaign_criterion.location.geo_target_constant = 'geoTargetConstants/${cleanLoc}'`,
        );
        const rn = rows[0]?.campaign_criterion?.resource_name as string | undefined;
        if (!rn) return fail(`Location ${cleanLoc} is not targeted on campaign ${cleanCampaign}. Add it first with set_geo_targeting.`);
        await customer.campaignCriteria.update([{ resource_name: rn, bid_modifier: args.bid_modifier }]);
        const output = { campaign_id: cleanCampaign, location_id: cleanLoc, bid_modifier: args.bid_modifier, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Location ${cleanLoc} bid modifier set to ×${args.bid_modifier} on campaign ${cleanCampaign}.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
