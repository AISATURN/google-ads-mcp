/**
 * Campaign-targeting and criterion tools: negative keywords (campaign- and
 * ad-group-level), location targeting, language targeting, ad schedules, and
 * device bid adjustments. These shape WHERE and TO WHOM a campaign serves —
 * the layer that was previously only editable in the Google Ads UI.
 *
 * Enum-valued fields are passed as their string names (e.g. "MOBILE"), which the
 * Google Ads proto layer accepts and converts to the numeric enum.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";
import { KEYWORD_MATCH_TYPES } from "../constants.js";

function campaignResourceName(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${campaignId}`;
}
function adGroupResourceName(customerId: string, adGroupId: string): string {
  return `customers/${customerId}/adGroups/${adGroupId}`;
}
function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

/** Maps a numeric minute (0/15/30/45) to the Google Ads MinuteOfHour enum name. */
const MINUTE_ENUM: Record<number, string> = { 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" };

export function registerTargetingTools(server: McpServer): void {
  // ---- add_negative_keywords -------------------------------------------------
  const negKeywordsInput = z.object({
    campaign_id: z.string().optional().describe("Numeric campaign ID for campaign-level negatives. Provide this OR ad_group_id."),
    ad_group_id: z.string().optional().describe("Numeric ad group ID for ad-group-level negatives. Provide this OR campaign_id."),
    keywords: z
      .array(
        z.object({
          text: z.string().min(1).max(80).describe("Negative keyword text"),
          match_type: z.enum(KEYWORD_MATCH_TYPES).default("BROAD").describe("BROAD (default), PHRASE, or EXACT"),
        }),
      )
      .min(1)
      .max(5000)
      .describe("Negative keywords to add."),
    customer_id: z.string().optional().describe("10-digit account ID. Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_add_negative_keywords",
    {
      title: "Add Negative Keywords",
      description: `Add negative keywords at the campaign level or the ad group level to block irrelevant searches and protect budget.

Provide exactly one of campaign_id (campaign-level) or ad_group_id (ad-group-level).

Args:
  - campaign_id (string, optional) | ad_group_id (string, optional): exactly one required
  - keywords (array): each { text: string, match_type?: 'BROAD'|'PHRASE'|'EXACT' }
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "level": "campaign"|"ad_group", "parent_resource_name": string, "count": number, "customer_id": string }`,
      inputSchema: negKeywordsInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const hasCampaign = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasAdGroup = typeof args.ad_group_id === "string" && args.ad_group_id.length > 0;
        if (hasCampaign === hasAdGroup) {
          return fail("Provide exactly one of 'campaign_id' or 'ad_group_id'.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        if (hasCampaign) {
          const parent = campaignResourceName(customerId, (args.campaign_id as string).replace(/\D/g, ""));
          const criteria: resources.ICampaignCriterion[] = args.keywords.map((kw) => ({
            campaign: parent,
            negative: true,
            keyword: { text: kw.text, match_type: kw.match_type },
          }));
          await customer.campaignCriteria.create(criteria);
          const output = { level: "campaign", parent_resource_name: parent, count: criteria.length, customer_id: customerId };
          const text =
            args.response_format === ResponseFormat.JSON
              ? toJson(output)
              : `✅ Added ${criteria.length} campaign-level negative(s) to campaign ${idFromResourceName(parent)}:\n` +
                args.keywords.map((k) => `- ${k.text} (${k.match_type})`).join("\n");
          return ok(text, output);
        }
        const parent = adGroupResourceName(customerId, (args.ad_group_id as string).replace(/\D/g, ""));
        const criteria: resources.IAdGroupCriterion[] = args.keywords.map((kw) => ({
          ad_group: parent,
          negative: true,
          keyword: { text: kw.text, match_type: kw.match_type },
        }));
        await customer.adGroupCriteria.create(criteria);
        const output = { level: "ad_group", parent_resource_name: parent, count: criteria.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Added ${criteria.length} ad-group-level negative(s) to ad group ${idFromResourceName(parent)}:\n` +
              args.keywords.map((k) => `- ${k.text} (${k.match_type})`).join("\n");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- set_geo_targeting -----------------------------------------------------
  const geoInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    location_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Geo target constant IDs to TARGET. Common: US=2840, UK=2826, Germany=2276, France=2250, " +
          "Netherlands=2528, Canada=2124, Australia=2036, UAE=2784, Saudi Arabia=2682, Turkey=2792.",
      ),
    excluded_location_ids: z.array(z.string()).optional().describe("Geo target constant IDs to EXCLUDE."),
    replace_existing: z
      .boolean()
      .default(false)
      .describe("If true, remove all existing location criteria first (clean slate). Default false (append)."),
    customer_id: z.string().optional().describe("10-digit account ID. Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_geo_targeting",
    {
      title: "Set Campaign Location Targeting",
      description: `Add (or replace) the locations a campaign targets and/or excludes, using geo target constant IDs.

Common country IDs: US=2840, UK=2826, Germany=2276, France=2250, Netherlands=2528, Canada=2124, Australia=2036, UAE=2784, Saudi Arabia=2682, Turkey=2792. Find others via GAQL on geo_target_constant.

Args:
  - campaign_id (string)
  - location_ids (string[], optional): targeted locations
  - excluded_location_ids (string[], optional): excluded locations
  - replace_existing (boolean, default false): clear existing location criteria first
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: geoInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.location_ids?.length && !args.excluded_location_ids?.length) {
          return fail("Provide at least one of 'location_ids' or 'excluded_location_ids'.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.campaign_id.replace(/\D/g, "");
        const parent = campaignResourceName(customerId, cleanId);

        if (args.replace_existing) {
          const rows = await customer.query(
            `SELECT campaign_criterion.resource_name FROM campaign_criterion ` +
              `WHERE campaign.id = ${cleanId} AND campaign_criterion.type = 'LOCATION'`,
          );
          const toRemove = rows.map((r) => r.campaign_criterion?.resource_name).filter(Boolean) as string[];
          if (toRemove.length) await customer.campaignCriteria.remove(toRemove);
        }

        const criteria: resources.ICampaignCriterion[] = [];
        for (const id of args.location_ids ?? []) {
          criteria.push({ campaign: parent, location: { geo_target_constant: `geoTargetConstants/${id.replace(/\D/g, "")}` } });
        }
        for (const id of args.excluded_location_ids ?? []) {
          criteria.push({ campaign: parent, negative: true, location: { geo_target_constant: `geoTargetConstants/${id.replace(/\D/g, "")}` } });
        }
        await customer.campaignCriteria.create(criteria);

        const output = {
          campaign_resource_name: parent,
          targeted: args.location_ids ?? [],
          excluded: args.excluded_location_ids ?? [],
          replaced_existing: args.replace_existing,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Location targeting updated on campaign ${cleanId}` +
              `${args.replace_existing ? " (existing cleared)" : ""}:\n` +
              `- Targeted: ${output.targeted.join(", ") || "—"}\n- Excluded: ${output.excluded.join(", ") || "—"}`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- set_language_targeting ------------------------------------------------
  const langInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    language_ids: z
      .array(z.string())
      .min(1)
      .describe("Language constant IDs. Common: English=1000, Turkish=1037, German=1001, French=1002, Spanish=1003, Arabic=1019, Italian=1004, Dutch=1010."),
    customer_id: z.string().optional().describe("10-digit account ID. Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_language_targeting",
    {
      title: "Set Campaign Language Targeting",
      description: `Add language targeting to a campaign using language constant IDs.

Common: English=1000, Turkish=1037, German=1001, French=1002, Spanish=1003, Arabic=1019, Italian=1004, Dutch=1010.

Args:
  - campaign_id (string)
  - language_ids (string[]): one or more language constant IDs
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: langInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.campaign_id.replace(/\D/g, "");
        const parent = campaignResourceName(customerId, cleanId);
        const criteria: resources.ICampaignCriterion[] = args.language_ids.map((id) => ({
          campaign: parent,
          language: { language_constant: `languageConstants/${id.replace(/\D/g, "")}` },
        }));
        await customer.campaignCriteria.create(criteria);
        const output = { campaign_resource_name: parent, language_ids: args.language_ids, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Added language targeting to campaign ${cleanId}: ${args.language_ids.join(", ")}`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- set_ad_schedule -------------------------------------------------------
  const scheduleInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    schedules: z
      .array(
        z.object({
          day_of_week: z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]),
          start_hour: z.number().int().min(0).max(23).describe("0-23"),
          end_hour: z.number().int().min(0).max(24).describe("0-24 (24 = end of day; use with end_minute 0)"),
          start_minute: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]).default(0),
          end_minute: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]).default(0),
          bid_modifier: z.number().positive().optional().describe("Optional bid multiplier, e.g. 1.2 = +20%."),
        }),
      )
      .min(1)
      .max(84)
      .describe("Day-parting entries."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_ad_schedule",
    {
      title: "Set Campaign Ad Schedule",
      description: `Add ad schedule (day-parting) entries to a campaign, optionally with per-slot bid modifiers.

Args:
  - campaign_id (string)
  - schedules (array): each { day_of_week, start_hour (0-23), end_hour (0-24), start_minute?, end_minute?, bid_modifier? }
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: scheduleInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.campaign_id.replace(/\D/g, "");
        const parent = campaignResourceName(customerId, cleanId);
        const criteria: resources.ICampaignCriterion[] = args.schedules.map((s) => {
          const c: resources.ICampaignCriterion = {
            campaign: parent,
            ad_schedule: {
              day_of_week: s.day_of_week,
              start_hour: s.start_hour,
              end_hour: s.end_hour,
              start_minute: MINUTE_ENUM[s.start_minute] as never,
              end_minute: MINUTE_ENUM[s.end_minute] as never,
            },
          };
          if (typeof s.bid_modifier === "number") c.bid_modifier = s.bid_modifier;
          return c;
        });
        await customer.campaignCriteria.create(criteria);
        const output = { campaign_resource_name: parent, count: criteria.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Added ${criteria.length} ad schedule slot(s) to campaign ${cleanId}.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- set_device_bid_adjustments -------------------------------------------
  const deviceInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    adjustments: z
      .array(
        z.object({
          device: z.enum(["MOBILE", "DESKTOP", "TABLET"]),
          bid_modifier: z.number().min(0).max(10).describe("Multiplier: 1.0 = no change, 1.2 = +20%, 0 = exclude (mobile/tablet)."),
        }),
      )
      .min(1)
      .max(3),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_device_bid_adjustments",
    {
      title: "Set Campaign Device Bid Adjustments",
      description: `Set per-device bid modifiers on a campaign (mobile / desktop / tablet).

bid_modifier is a multiplier: 1.0 = no change, 1.2 = +20%, 0.8 = -20%, 0 = exclude (mobile/tablet only).

Args:
  - campaign_id (string)
  - adjustments (array): each { device: 'MOBILE'|'DESKTOP'|'TABLET', bid_modifier: number }
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: deviceInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.campaign_id.replace(/\D/g, "");
        const parent = campaignResourceName(customerId, cleanId);
        const criteria: resources.ICampaignCriterion[] = args.adjustments.map((a) => ({
          campaign: parent,
          device: { type: a.device },
          bid_modifier: a.bid_modifier,
        }));
        await customer.campaignCriteria.create(criteria);
        const output = { campaign_resource_name: parent, adjustments: args.adjustments, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Set device bid adjustments on campaign ${cleanId}:\n` +
              args.adjustments.map((a) => `- ${a.device}: ×${a.bid_modifier}`).join("\n");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
