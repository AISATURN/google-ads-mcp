/**
 * Advanced responsive search ad tool: create an RSA with optional pinning of
 * specific headlines/descriptions to fixed positions, and optionally replace an
 * existing ad (RSAs are largely immutable, so "editing" means create-new +
 * remove-old).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources, common } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function adGroupResourceName(customerId: string, id: string): string {
  return `customers/${customerId}/adGroups/${id}`;
}
function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerAdTools(server: McpServer): void {
  const headlineSchema = z.object({
    text: z.string().min(1).max(30),
    pin: z.enum(["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"]).optional().describe("Optionally pin this headline to a fixed position."),
  });
  const descriptionSchema = z.object({
    text: z.string().min(1).max(90),
    pin: z.enum(["DESCRIPTION_1", "DESCRIPTION_2"]).optional().describe("Optionally pin this description to a fixed position."),
  });

  const input = z.object({
    ad_group_id: z.string().optional().describe("Numeric ad group ID. Provide this OR ad_group_resource_name."),
    ad_group_resource_name: z.string().optional(),
    final_url: z.string().url().describe("Landing page URL."),
    headlines: z.array(headlineSchema).min(3).max(15).describe("3-15 headlines, each { text (≤30), pin? }."),
    descriptions: z.array(descriptionSchema).min(2).max(4).describe("2-4 descriptions, each { text (≤90), pin? }."),
    path1: z.string().max(15).optional(),
    path2: z.string().max(15).optional(),
    status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED"),
    replace_ad_resource_name: z
      .string()
      .optional()
      .describe("Optional ad_group_ad resource name to REMOVE after the new ad is created (use to 'edit' an existing RSA)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_responsive_search_ad_advanced",
    {
      title: "Create RSA (with Pinning / Replace)",
      description: `Create a Responsive Search Ad with optional pinning of headlines/descriptions to fixed positions, and optionally replace (remove) an existing ad.

Because RSAs cannot be edited in place, to "edit" one: call this with the new content and set replace_ad_resource_name to the old ad's ad_group_ad resource name.

Args:
  - ad_group_id (string, optional) | ad_group_resource_name (string, optional): exactly one
  - final_url (string)
  - headlines (array): 3-15 of { text (≤30), pin? 'HEADLINE_1|2|3' }
  - descriptions (array): 2-4 of { text (≤90), pin? 'DESCRIPTION_1|2' }
  - path1 / path2 (string, optional)
  - status ('ENABLED' | 'PAUSED' default)
  - replace_ad_resource_name (string, optional): old ad to remove afterwards
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: input.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const hasId = typeof args.ad_group_id === "string" && args.ad_group_id.length > 0;
        const hasRn = typeof args.ad_group_resource_name === "string" && args.ad_group_resource_name.length > 0;
        if (hasId === hasRn) return fail("Provide exactly one of 'ad_group_id' or 'ad_group_resource_name'.");
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const parent = hasId ? adGroupResourceName(customerId, (args.ad_group_id as string).replace(/\D/g, "")) : (args.ad_group_resource_name as string);

        const headlines: common.IAdTextAsset[] = args.headlines.map((h) => (h.pin ? { text: h.text, pinned_field: h.pin } : { text: h.text }));
        const descriptions: common.IAdTextAsset[] = args.descriptions.map((d) => (d.pin ? { text: d.text, pinned_field: d.pin } : { text: d.text }));
        const rsa: common.IResponsiveSearchAdInfo = { headlines, descriptions };
        if (args.path1) rsa.path1 = args.path1;
        if (args.path2) rsa.path2 = args.path2;

        const adGroupAd: resources.IAdGroupAd = {
          ad_group: parent,
          status: args.status,
          ad: { final_urls: [args.final_url], responsive_search_ad: rsa },
        };
        const resp = await customer.adGroupAds.create([adGroupAd]);
        const resourceName = resp.results?.[0]?.resource_name ?? "";
        if (!resourceName) return fail("Ad creation returned no resource name.");

        let replaced = "";
        if (args.replace_ad_resource_name?.trim()) {
          await customer.adGroupAds.remove([args.replace_ad_resource_name.trim()]);
          replaced = args.replace_ad_resource_name.trim();
        }

        const pinnedCount = args.headlines.filter((h) => h.pin).length + args.descriptions.filter((d) => d.pin).length;
        const output = {
          resource_name: resourceName,
          ad_id: idFromResourceName(resourceName),
          ad_group_resource_name: parent,
          pinned_assets: pinnedCount,
          replaced_ad: replaced,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created RSA ${output.ad_id} in ad group ${idFromResourceName(parent)} (${pinnedCount} pinned).` +
              (replaced ? `\n- Removed old ad ${idFromResourceName(replaced)}.` : "");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
