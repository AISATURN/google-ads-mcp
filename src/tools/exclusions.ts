/**
 * Demographic targeting/exclusion and placement exclusion tools. Age/gender
 * criteria attach to an ad group; placement exclusions attach to a campaign
 * (useful for Display/Performance Max brand-safety).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

const AGE_RANGES = [
  "AGE_RANGE_18_24",
  "AGE_RANGE_25_34",
  "AGE_RANGE_35_44",
  "AGE_RANGE_45_54",
  "AGE_RANGE_55_64",
  "AGE_RANGE_65_UP",
  "AGE_RANGE_UNDETERMINED",
] as const;
const GENDERS = ["MALE", "FEMALE", "UNDETERMINED"] as const;

export function registerExclusionTools(server: McpServer): void {
  // ---- set_demographic_targeting ---------------------------------------------
  const demoInput = z.object({
    ad_group_id: z.string().describe("Numeric ad group ID."),
    action: z.enum(["EXCLUDE", "INCLUDE"]).default("EXCLUDE").describe("EXCLUDE adds negative criteria; INCLUDE adds positive criteria."),
    age_ranges: z.array(z.enum(AGE_RANGES)).optional().describe("Age ranges to act on."),
    genders: z.array(z.enum(GENDERS)).optional().describe("Genders to act on."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_set_demographic_targeting",
    {
      title: "Set Demographic Targeting / Exclusions",
      description: `Add age-range and/or gender criteria to an ad group, either as exclusions (negative) or inclusions (positive).

Provide at least one of age_ranges / genders.

Args:
  - ad_group_id (string)
  - action ('EXCLUDE' default | 'INCLUDE')
  - age_ranges (enum[], optional) / genders (enum[], optional)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: demoInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.age_ranges?.length && !args.genders?.length) {
          return fail("Provide at least one of 'age_ranges' or 'genders'.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = `customers/${customerId}/adGroups/${args.ad_group_id.replace(/\D/g, "")}`;
        const negative = args.action === "EXCLUDE";
        const criteria: resources.IAdGroupCriterion[] = [];
        for (const a of args.age_ranges ?? []) criteria.push({ ad_group: parent, negative, age_range: { type: a } });
        for (const g of args.genders ?? []) criteria.push({ ad_group: parent, negative, gender: { type: g } });
        await customer.adGroupCriteria.create(criteria);
        const output = { ad_group_id: args.ad_group_id.replace(/\D/g, ""), action: args.action, count: criteria.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ ${args.action}: added ${criteria.length} demographic criterion/criteria to ad group ${output.ad_group_id}.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- exclude_placements ----------------------------------------------------
  const placementInput = z.object({
    campaign_id: z.string().describe("Numeric campaign ID."),
    placements: z
      .array(z.string().min(1))
      .min(1)
      .max(500)
      .describe("Placements to exclude: website domains (e.g. 'example.com') or YouTube URLs."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_exclude_placements",
    {
      title: "Exclude Placements (Brand Safety)",
      description: `Add negative placement criteria to a campaign (website domains or YouTube URLs) for brand safety on Display / Performance Max.

Args:
  - campaign_id (string)
  - placements (string[]): domains or URLs to exclude
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: placementInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = `customers/${customerId}/campaigns/${args.campaign_id.replace(/\D/g, "")}`;
        const criteria: resources.ICampaignCriterion[] = args.placements.map((p) => ({
          campaign: parent,
          negative: true,
          placement: { url: p.startsWith("http") ? p : `http://${p}` },
        }));
        await customer.campaignCriteria.create(criteria);
        const output = { campaign_id: args.campaign_id.replace(/\D/g, ""), excluded: args.placements.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Excluded ${output.excluded} placement(s) from campaign ${output.campaign_id}.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
