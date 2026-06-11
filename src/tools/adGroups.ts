/**
 * Ad group, keyword, and responsive search ad (RSA) tools. Together with the
 * campaign tools these let an agent build a complete, serveable Search campaign:
 * campaign -> ad group -> keywords -> ad.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources, common } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";
import { KEYWORD_MATCH_TYPES } from "../constants.js";

/** Builds a campaign resource name from a customer ID and numeric campaign ID. */
function campaignResourceName(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${campaignId}`;
}

/** Builds an ad group resource name from a customer ID and numeric ad group ID. */
function adGroupResourceName(customerId: string, adGroupId: string): string {
  return `customers/${customerId}/adGroups/${adGroupId}`;
}

/** Extracts the trailing numeric ID from a resource name. */
function idFromResourceName(resourceName: string | null | undefined): string {
  return resourceName?.split("/").pop() ?? "";
}

/**
 * Resolves one of an explicit resource name or an ID-to-resource-name builder,
 * returning an error string if the caller supplied both or neither.
 */
function resolveParent(
  id: string | undefined,
  resourceName: string | undefined,
  build: (cleanId: string) => string,
  labels: { id: string; resourceName: string },
): { ok: true; value: string } | { ok: false; error: string } {
  const hasId = typeof id === "string" && id.length > 0;
  const hasRn = typeof resourceName === "string" && resourceName.length > 0;
  if (hasId === hasRn) {
    return { ok: false, error: `Provide exactly one of '${labels.id}' or '${labels.resourceName}'.` };
  }
  if (hasId) {
    const clean = (id as string).replace(/\D/g, "");
    if (!clean) {
      return { ok: false, error: `Invalid '${labels.id}' "${id}". Expected a numeric ID.` };
    }
    return { ok: true, value: build(clean) };
  }
  return { ok: true, value: resourceName as string };
}

export function registerAdGroupTools(server: McpServer): void {
  // ---- create_ad_group -------------------------------------------------------
  const createAdGroupInput = z.object({
    name: z.string().min(1).max(255).describe("Ad group name (unique within the campaign)"),
    campaign_id: z.string().optional().describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    type: z
      .enum(["SEARCH_STANDARD", "DISPLAY_STANDARD"])
      .default("SEARCH_STANDARD")
      .describe("Ad group type (default: SEARCH_STANDARD)."),
    status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED").describe("Initial status (default: ENABLED)."),
    cpc_bid: z
      .number()
      .positive()
      .optional()
      .describe("Default max CPC bid in account currency (e.g. 1.50). Optional."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createAdGroupOutput = z.object({
    resource_name: z.string(),
    ad_group_id: z.string(),
    name: z.string(),
    campaign_resource_name: z.string(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_ad_group",
    {
      title: "Create Ad Group",
      description: `Create an ad group inside a campaign. Ad groups hold keywords and ads.

Args:
  - name (string): Ad group name
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - type ('SEARCH_STANDARD' | 'DISPLAY_STANDARD'): default 'SEARCH_STANDARD'
  - status ('ENABLED' | 'PAUSED'): default 'ENABLED'
  - cpc_bid (number, optional): default max CPC in account currency
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "ad_group_id": string, "name": string, "campaign_resource_name": string, "customer_id": string }`,
      inputSchema: createAdGroupInput.shape,
      outputSchema: createAdGroupOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = resolveParent(
          args.campaign_id,
          args.campaign_resource_name,
          (id) => campaignResourceName(customerId, id),
          { id: "campaign_id", resourceName: "campaign_resource_name" },
        );
        if (!parent.ok) return fail(parent.error);

        const adGroup: resources.IAdGroup = {
          name: args.name,
          campaign: parent.value,
          type: args.type,
          status: args.status,
        };
        if (typeof args.cpc_bid === "number") adGroup.cpc_bid_micros = toMicros(args.cpc_bid);

        const response = await customer.adGroups.create([adGroup]);
        const resourceName = response.results?.[0]?.resource_name ?? "";
        if (!resourceName) {
          return fail("Ad group creation returned no resource name — it may not have been created.");
        }
        const output = {
          resource_name: resourceName,
          ad_group_id: idFromResourceName(resourceName),
          name: args.name,
          campaign_resource_name: parent.value,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created ad group **${args.name}** (${output.ad_group_id})\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- add_keywords ----------------------------------------------------------
  const addKeywordsInput = z.object({
    ad_group_id: z.string().optional().describe("Numeric ad group ID. Provide this OR ad_group_resource_name."),
    ad_group_resource_name: z
      .string()
      .optional()
      .describe("Full ad group resource name. Provide this OR ad_group_id."),
    keywords: z
      .array(
        z.object({
          text: z.string().min(1).max(80).describe("Keyword text"),
          match_type: z
            .enum(KEYWORD_MATCH_TYPES)
            .default("BROAD")
            .describe("Match type: BROAD (default), PHRASE, or EXACT"),
        }),
      )
      .min(1, "Provide at least one keyword")
      .max(500, "At most 500 keywords per call")
      .describe("Keywords to add, each with optional match_type (defaults to BROAD)."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const addKeywordsOutput = z.object({
    ad_group_resource_name: z.string(),
    count: z.number(),
    keywords: z.array(z.object({ text: z.string(), match_type: z.string(), resource_name: z.string() })),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_add_keywords",
    {
      title: "Add Keywords to Ad Group",
      description: `Add keywords (positive ad group criteria) to a Search ad group.

Args:
  - ad_group_id (string, optional) | ad_group_resource_name (string, optional): exactly one required
  - keywords (array): up to 500 items, each { text: string, match_type?: 'BROAD'|'PHRASE'|'EXACT' }
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "ad_group_resource_name": string, "count": number,
    "keywords": [{ "text": string, "match_type": string, "resource_name": string }],
    "customer_id": string }`,
      inputSchema: addKeywordsInput.shape,
      outputSchema: addKeywordsOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = resolveParent(
          args.ad_group_id,
          args.ad_group_resource_name,
          (id) => adGroupResourceName(customerId, id),
          { id: "ad_group_id", resourceName: "ad_group_resource_name" },
        );
        if (!parent.ok) return fail(parent.error);

        const criteria: resources.IAdGroupCriterion[] = args.keywords.map((kw) => ({
          ad_group: parent.value,
          status: "ENABLED",
          keyword: { text: kw.text, match_type: kw.match_type },
        }));

        const response = await customer.adGroupCriteria.create(criteria);
        const resourceNames = (response.results ?? []).map((r) => r.resource_name ?? "");
        if (resourceNames.length === 0) {
          return fail("Keyword creation returned no results — no keywords were added.");
        }
        const keywords = args.keywords.map((kw, i) => ({
          text: kw.text,
          match_type: kw.match_type,
          resource_name: resourceNames[i] ?? "",
        }));
        const output = {
          ad_group_resource_name: parent.value,
          count: keywords.length,
          keywords,
          customer_id: customerId,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = [
          `✅ Added ${keywords.length} keyword(s) to ad group ${idFromResourceName(parent.value)}:`,
          ``,
          ...keywords.map((k) => `- ${k.text} (${k.match_type})`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_responsive_search_ad ------------------------------------------
  const createRsaInput = z.object({
    ad_group_id: z.string().optional().describe("Numeric ad group ID. Provide this OR ad_group_resource_name."),
    ad_group_resource_name: z
      .string()
      .optional()
      .describe("Full ad group resource name. Provide this OR ad_group_id."),
    final_url: z.string().url("Must be a valid URL").describe("Landing page URL (e.g. https://example.com/shoes)."),
    headlines: z
      .array(z.string().min(1).max(30, "Headlines must be 30 characters or fewer"))
      .min(3, "Responsive search ads require at least 3 headlines")
      .max(15, "At most 15 headlines")
      .describe("3-15 headlines, each ≤30 characters."),
    descriptions: z
      .array(z.string().min(1).max(90, "Descriptions must be 90 characters or fewer"))
      .min(2, "Responsive search ads require at least 2 descriptions")
      .max(4, "At most 4 descriptions")
      .describe("2-4 descriptions, each ≤90 characters."),
    path1: z.string().max(15).optional().describe("First display URL path segment (≤15 chars)."),
    path2: z.string().max(15).optional().describe("Second display URL path segment (≤15 chars)."),
    status: z
      .enum(["ENABLED", "PAUSED"])
      .default("PAUSED")
      .describe("Initial ad status (default: PAUSED)."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createRsaOutput = z.object({
    resource_name: z.string(),
    ad_id: z.string(),
    ad_group_resource_name: z.string(),
    final_url: z.string(),
    headline_count: z.number(),
    description_count: z.number(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_responsive_search_ad",
    {
      title: "Create Responsive Search Ad",
      description: `Create a Responsive Search Ad (RSA) in a Search ad group.

Google Ads requires 3-15 headlines (≤30 chars each) and 2-4 descriptions (≤90 chars each). The ad is created PAUSED by default.

Args:
  - ad_group_id (string, optional) | ad_group_resource_name (string, optional): exactly one required
  - final_url (string): landing page URL
  - headlines (string[]): 3-15 items, ≤30 chars each
  - descriptions (string[]): 2-4 items, ≤90 chars each
  - path1 / path2 (string, optional): display URL path segments (≤15 chars)
  - status ('ENABLED' | 'PAUSED'): default 'PAUSED'
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "ad_id": string, "ad_group_resource_name": string,
    "final_url": string, "headline_count": number, "description_count": number, "customer_id": string }`,
      inputSchema: createRsaInput.shape,
      outputSchema: createRsaOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = resolveParent(
          args.ad_group_id,
          args.ad_group_resource_name,
          (id) => adGroupResourceName(customerId, id),
          { id: "ad_group_id", resourceName: "ad_group_resource_name" },
        );
        if (!parent.ok) return fail(parent.error);

        const headlines: common.IAdTextAsset[] = args.headlines.map((text) => ({ text }));
        const descriptions: common.IAdTextAsset[] = args.descriptions.map((text) => ({ text }));
        const rsa: common.IResponsiveSearchAdInfo = { headlines, descriptions };
        if (args.path1) rsa.path1 = args.path1;
        if (args.path2) rsa.path2 = args.path2;

        const adGroupAd: resources.IAdGroupAd = {
          ad_group: parent.value,
          status: args.status,
          ad: {
            final_urls: [args.final_url],
            responsive_search_ad: rsa,
          },
        };

        const response = await customer.adGroupAds.create([adGroupAd]);
        const resourceName = response.results?.[0]?.resource_name ?? "";
        if (!resourceName) {
          return fail("Ad creation returned no resource name — it may not have been created.");
        }
        const output = {
          resource_name: resourceName,
          ad_id: idFromResourceName(resourceName),
          ad_group_resource_name: parent.value,
          final_url: args.final_url,
          headline_count: headlines.length,
          description_count: descriptions.length,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created responsive search ad (${output.ad_id}) in ad group ${idFromResourceName(parent.value)}\n` +
              `- **Final URL**: ${args.final_url}\n` +
              `- **Headlines**: ${headlines.length}, **Descriptions**: ${descriptions.length}\n` +
              `- **Status**: ${args.status}\n- **Resource**: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
