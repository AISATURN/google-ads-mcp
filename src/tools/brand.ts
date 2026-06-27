/**
 * Brand tools: look up Google brand entities, and apply a PMax/Search brand
 * EXCLUSION. A brand exclusion is built from a shared set of type BRANDS holding
 * one brand criterion per brand, then attached to a campaign as a NEGATIVE
 * brand_list campaign criterion. This is the supported path for keeping a
 * campaign (e.g. Performance Max) from serving on specific brands' queries.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

/** Extracts the trailing numeric ID from a resource name. */
function idFromResourceName(resourceName: string | null | undefined): string {
  return resourceName?.split("/").pop() ?? "";
}

export function registerBrandTools(server: McpServer): void {
  // ---- suggest_brands --------------------------------------------------------
  const suggestInput = z.object({
    brand_prefix: z
      .string()
      .min(1)
      .describe("Brand name prefix to search Google's brand database, e.g. 'deercase'."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const suggestOutput = z.object({
    count: z.number(),
    brands: z.array(z.object({ entity_id: z.string(), name: z.string(), urls: z.array(z.string()) })),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_suggest_brands",
    {
      title: "Suggest Brand Entities",
      description: `Look up Google brand entities by name prefix (BrandSuggestionService). Use this to find the brand entity_id needed for google_ads_add_pmax_brand_exclusion.

Args:
  - brand_prefix (string): brand name prefix, e.g. 'deercase'
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "count": number, "brands": [{ "entity_id": string, "name": string, "urls": string[] }], "customer_id": string }`,
      inputSchema: suggestInput.shape,
      outputSchema: suggestOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const res = await customer.brandSuggestions.suggestBrands({
          customer_id: customerId,
          brand_prefix: args.brand_prefix,
          selected_brands: [],
        } as never);
        const brands = (res?.brands ?? []).map((b) => ({
          entity_id: b.id ?? "",
          name: b.name ?? "",
          urls: b.urls ?? [],
        }));
        const output = { count: brands.length, brands, customer_id: customerId };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = [
          `Found ${brands.length} brand(s) for "${args.brand_prefix}":`,
          ``,
          ...brands.slice(0, 25).map((b) => `- **${b.name}** — \`${b.entity_id}\`${b.urls[0] ? ` (${b.urls[0]})` : ""}`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- add_pmax_brand_exclusion ---------------------------------------------
  const exclInput = z.object({
    brand_entity_ids: z
      .array(z.string().min(1))
      .min(1, "Provide at least one brand entity_id")
      .max(100)
      .describe("Brand entity IDs to exclude (from google_ads_suggest_brands), e.g. ['/g/11k9crmrst']."),
    campaign_ids: z
      .array(z.string().min(1))
      .min(1, "Provide at least one campaign ID")
      .describe("Campaign IDs to attach the brand exclusion to (PMax or Search)."),
    name: z
      .string()
      .min(1)
      .max(255)
      .default("Brand Exclusion")
      .describe("Name for the brand list shared set."),
    shared_set_resource_name: z
      .string()
      .optional()
      .describe("Reuse an existing BRANDS shared set instead of creating a new one. Optional."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const exclOutput = z.object({
    shared_set_resource_name: z.string(),
    brand_criteria_added: z.number(),
    linked_campaign_ids: z.array(z.string()),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_add_pmax_brand_exclusion",
    {
      title: "Add PMax/Search Brand Exclusion",
      description: `Exclude one or more brands from a campaign (so it stops serving on those brands' queries — e.g. keep Performance Max off your own brand so brand traffic flows to a dedicated Brand Search campaign).

Builds a BRANDS shared set with one criterion per brand entity, then attaches it to each campaign as a NEGATIVE brand_list criterion. Get brand entity IDs from google_ads_suggest_brands.

Args:
  - brand_entity_ids (string[]): brand entity IDs to exclude, e.g. ['/g/11k9crmrst']
  - campaign_ids (string[]): campaigns to attach the exclusion to
  - name (string, optional): shared set name (default 'Brand Exclusion')
  - shared_set_resource_name (string, optional): reuse an existing BRANDS shared set
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "shared_set_resource_name": string, "brand_criteria_added": number, "linked_campaign_ids": string[], "customer_id": string }`,
      inputSchema: exclInput.shape,
      outputSchema: exclOutput.shape,
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

        // 1) Resolve or create the BRANDS shared set.
        let sharedSet = args.shared_set_resource_name ?? "";
        if (!sharedSet) {
          const ssRes = await customer.sharedSets.create([{ name: args.name, type: "BRANDS" }]);
          sharedSet = ssRes.results?.[0]?.resource_name ?? "";
          if (!sharedSet) return fail("Shared set creation returned no resource name.");
        }

        // 2) Add one brand criterion per entity. Brand criteria use entity_id.
        const brandCriteria: resources.ISharedCriterion[] = args.brand_entity_ids.map((entity_id) => ({
          shared_set: sharedSet,
          brand: { entity_id },
        }));
        const scRes = await customer.sharedCriteria.create(brandCriteria);
        const brandCriteriaAdded = (scRes.results ?? []).length;

        // 3) Attach to each campaign as a NEGATIVE brand_list campaign criterion.
        const linked: string[] = [];
        for (const id of args.campaign_ids) {
          const cleanId = id.replace(/\D/g, "");
          if (!cleanId) continue;
          await customer.campaignCriteria.create([
            {
              campaign: `customers/${customerId}/campaigns/${cleanId}`,
              negative: true,
              brand_list: { shared_set: sharedSet },
            },
          ]);
          linked.push(cleanId);
        }

        const output = {
          shared_set_resource_name: sharedSet,
          brand_criteria_added: brandCriteriaAdded,
          linked_campaign_ids: linked,
          customer_id: customerId,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const text =
          `✅ Brand exclusion applied.\n` +
          `- Shared set: \`${sharedSet}\` (${idFromResourceName(sharedSet)})\n` +
          `- Brands excluded: ${brandCriteriaAdded}\n` +
          `- Linked campaigns: ${linked.join(", ")}`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
