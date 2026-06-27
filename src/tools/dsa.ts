/**
 * Dynamic Search Ads (DSA) building blocks: create a DSA-type ad group, add
 * dynamic page targets (webpage URL rules — positive or negative), and create a
 * dynamic search ad. These complement the standard Search tools so an agent can
 * build a model-by-model DSA structure (one ad group per brand, URL-contains
 * targets per model) inside an existing DSA campaign.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources, common } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

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

export function registerDsaTools(server: McpServer): void {
  // ---- create_dsa_ad_group ---------------------------------------------------
  const createDsaAdGroupInput = z.object({
    name: z.string().min(1).max(255).describe("Ad group name (unique within the campaign)."),
    campaign_id: z.string().optional().describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED").describe("Initial status (default: PAUSED)."),
    cpc_bid: z
      .number()
      .positive()
      .optional()
      .describe("Default max CPC bid in account currency. Ignored under portfolio/Smart Bidding. Optional."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createDsaAdGroupOutput = z.object({
    resource_name: z.string(),
    ad_group_id: z.string(),
    name: z.string(),
    campaign_resource_name: z.string(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_dsa_ad_group",
    {
      title: "Create Dynamic Search Ads Ad Group",
      description: `Create a Dynamic Search Ads (DSA) ad group (ad_group.type = SEARCH_DYNAMIC_ADS) inside an existing DSA campaign.

The parent campaign must be a Search campaign with dynamic_search_ads_setting configured (a domain + language). After creating the ad group, add dynamic page targets with google_ads_add_dynamic_page_targets and a dynamic search ad with google_ads_create_dynamic_search_ad. Created PAUSED by default.

Args:
  - name (string)
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - status ('ENABLED' | 'PAUSED'): default 'PAUSED'
  - cpc_bid (number, optional)
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "ad_group_id": string, "name": string, "campaign_resource_name": string, "customer_id": string }`,
      inputSchema: createDsaAdGroupInput.shape,
      outputSchema: createDsaAdGroupOutput.shape,
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
          type: "SEARCH_DYNAMIC_ADS",
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
            : `✅ Created DSA ad group **${args.name}** (${output.ad_group_id}) — status ${args.status}\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- add_dynamic_page_targets ---------------------------------------------
  const addTargetsInput = z.object({
    ad_group_id: z.string().optional().describe("Numeric ad group ID. Provide this OR ad_group_resource_name."),
    ad_group_resource_name: z
      .string()
      .optional()
      .describe("Full ad group resource name. Provide this OR ad_group_id."),
    targets: z
      .array(
        z.object({
          match: z
            .enum(["CONTAINS", "EQUALS"])
            .default("CONTAINS")
            .describe("URL match: CONTAINS (substring, e.g. 'iphone-15') or EQUALS (exact URL). Default CONTAINS."),
          value: z
            .string()
            .min(1)
            .max(2048)
            .describe("The URL substring (for CONTAINS) or full URL (for EQUALS) to match."),
          negative: z
            .boolean()
            .default(false)
            .describe("true = EXCLUDE pages matching this rule (negative dynamic target). Default false."),
          name: z.string().max(255).optional().describe("Optional label for the target. Defaults to the rule text."),
        }),
      )
      .min(1, "Provide at least one target")
      .max(1000, "At most 1000 targets per call")
      .describe(
        "Dynamic page targets. Each is one webpage URL rule. Use separate CONTAINS targets for OR logic (e.g. one per phone model).",
      ),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const addTargetsOutput = z.object({
    ad_group_resource_name: z.string(),
    count: z.number(),
    positive_count: z.number(),
    negative_count: z.number(),
    targets: z.array(
      z.object({ match: z.string(), value: z.string(), negative: z.boolean(), resource_name: z.string() }),
    ),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_add_dynamic_page_targets",
    {
      title: "Add Dynamic Page Targets",
      description: `Add dynamic page targets (webpage URL rules) to a DSA ad group — positive (serve on matching pages) or negative (exclude matching pages).

Each target is one webpage criterion with a single URL condition. For OR logic across many pages (e.g. one rule per phone model), pass multiple CONTAINS targets. To restrict a brand ad group to model pages only, add negative targets for theme/accessory substrings (e.g. 'mermer', 'airpods').

Args:
  - ad_group_id (string, optional) | ad_group_resource_name (string, optional): exactly one required
  - targets (array, 1-1000): each { match: 'CONTAINS'|'EQUALS' (default CONTAINS), value: string, negative?: boolean, name?: string }
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "ad_group_resource_name": string, "count": number, "positive_count": number, "negative_count": number,
    "targets": [{ "match": string, "value": string, "negative": boolean, "resource_name": string }], "customer_id": string }`,
      inputSchema: addTargetsInput.shape,
      outputSchema: addTargetsOutput.shape,
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

        const criteria: resources.IAdGroupCriterion[] = args.targets.map((t) => {
          const criterion: resources.IAdGroupCriterion = {
            ad_group: parent.value,
            negative: t.negative,
            webpage: {
              criterion_name: t.name ?? `URL ${t.match} ${t.value}`,
              conditions: [{ operand: "URL", operator: t.match, argument: t.value }],
            } as common.IWebpageInfo,
          };
          // Positive criteria carry a status; negative criteria do not take one.
          if (!t.negative) criterion.status = "ENABLED";
          return criterion;
        });

        const response = await customer.adGroupCriteria.create(criteria);
        const resourceNames = (response.results ?? []).map((r) => r.resource_name ?? "");
        if (resourceNames.length === 0) {
          return fail("Target creation returned no results — no dynamic page targets were added.");
        }
        const targets = args.targets.map((t, i) => ({
          match: t.match,
          value: t.value,
          negative: t.negative,
          resource_name: resourceNames[i] ?? "",
        }));
        const positiveCount = targets.filter((t) => !t.negative).length;
        const negativeCount = targets.length - positiveCount;
        const output = {
          ad_group_resource_name: parent.value,
          count: targets.length,
          positive_count: positiveCount,
          negative_count: negativeCount,
          targets,
          customer_id: customerId,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = [
          `✅ Added ${targets.length} dynamic page target(s) to ad group ${idFromResourceName(parent.value)} (${positiveCount} positive, ${negativeCount} negative):`,
          ``,
          ...targets.map((t) => `- ${t.negative ? "🚫 exclude" : "✅ target"} URL ${t.match} \`${t.value}\``),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_dynamic_search_ad ---------------------------------------------
  const createDsaAdInput = z.object({
    ad_group_id: z.string().optional().describe("Numeric ad group ID. Provide this OR ad_group_resource_name."),
    ad_group_resource_name: z
      .string()
      .optional()
      .describe("Full ad group resource name. Provide this OR ad_group_id."),
    description: z
      .string()
      .min(1)
      .max(90, "Descriptions must be 90 characters or fewer")
      .describe("Ad description line 1 (≤90 chars). Headline and final URL are auto-generated by DSA."),
    description2: z
      .string()
      .max(90, "Descriptions must be 90 characters or fewer")
      .optional()
      .describe("Optional ad description line 2 (≤90 chars)."),
    status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED").describe("Initial ad status (default: PAUSED)."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createDsaAdOutput = z.object({
    resource_name: z.string(),
    ad_id: z.string(),
    ad_group_resource_name: z.string(),
    description_count: z.number(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_dynamic_search_ad",
    {
      title: "Create Dynamic Search Ad",
      description: `Create a Dynamic Search Ad (expanded dynamic search ad) in a DSA ad group. The headline and final URL are generated dynamically by Google from the matched landing page; you supply only the description(s). Created PAUSED by default.

Args:
  - ad_group_id (string, optional) | ad_group_resource_name (string, optional): exactly one required
  - description (string): description line 1 (≤90 chars)
  - description2 (string, optional): description line 2 (≤90 chars)
  - status ('ENABLED' | 'PAUSED'): default 'PAUSED'
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "ad_id": string, "ad_group_resource_name": string, "description_count": number, "customer_id": string }`,
      inputSchema: createDsaAdInput.shape,
      outputSchema: createDsaAdOutput.shape,
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

        const edsa: common.IExpandedDynamicSearchAdInfo = { description: args.description };
        if (args.description2) edsa.description2 = args.description2;

        const adGroupAd: resources.IAdGroupAd = {
          ad_group: parent.value,
          status: args.status,
          ad: { expanded_dynamic_search_ad: edsa },
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
          description_count: args.description2 ? 2 : 1,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created dynamic search ad (${output.ad_id}) in ad group ${idFromResourceName(parent.value)} — status ${args.status}\n- Descriptions: ${output.description_count}\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
