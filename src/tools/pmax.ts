/**
 * Performance Max asset-group tools: create an asset group under a PMax campaign
 * and attach text assets (headlines, long headlines, descriptions, business
 * name) plus already-created image assets. Listing groups (retail) and Merchant
 * Center linking are out of scope.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerPmaxTools(server: McpServer): void {
  // ---- create_asset_group ----------------------------------------------------
  const createInput = z.object({
    campaign_id: z.string().describe("Numeric PERFORMANCE_MAX campaign ID."),
    name: z.string().min(1).max(255),
    final_url: z.string().url().describe("Landing page URL for the asset group."),
    status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED"),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_asset_group",
    {
      title: "Create Performance Max Asset Group",
      description: `Create an asset group under a Performance Max campaign. Add assets afterwards with google_ads_add_asset_group_assets and google_ads_add_image_asset.

Note: a PMax asset group needs minimum assets to be eligible (≥3 headlines, ≥1 long headline, ≥2 descriptions, business name, multiple images + logos). Listing groups and Merchant Center linking are not handled here.

Args:
  - campaign_id (string) / name (string) / final_url (string) / status ('ENABLED'|'PAUSED' default)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "resource_name": string, "asset_group_id": string, "customer_id": string }`,
      inputSchema: createInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const campaign = `customers/${customerId}/campaigns/${args.campaign_id.replace(/\D/g, "")}`;
        const assetGroup: resources.IAssetGroup = {
          campaign,
          name: args.name,
          final_urls: [args.final_url],
          status: args.status,
        };
        const resp = await customer.assetGroups.create([assetGroup]);
        const resourceName = resp.results?.[0]?.resource_name ?? "";
        if (!resourceName) return fail("Asset group creation returned no resource name.");
        const output = { resource_name: resourceName, asset_group_id: idFromResourceName(resourceName), customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created asset group **${args.name}** (${output.asset_group_id}) under campaign ${args.campaign_id.replace(/\D/g, "")}.\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- add_asset_group_assets ------------------------------------------------
  const addInput = z.object({
    asset_group_id: z.string().describe("Numeric asset group ID."),
    headlines: z.array(z.string().min(1).max(30)).max(15).optional().describe("Headlines (≤30 chars)."),
    long_headlines: z.array(z.string().min(1).max(90)).max(5).optional().describe("Long headlines (≤90 chars)."),
    descriptions: z.array(z.string().min(1).max(90)).max(5).optional().describe("Descriptions (≤90 chars)."),
    business_name: z.string().min(1).max(25).optional().describe("Business name (≤25 chars)."),
    image_asset_resource_names: z
      .array(z.object({
        asset_resource_name: z.string().min(1),
        field_type: z.enum(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"]),
      }))
      .max(20)
      .optional()
      .describe("Existing image assets (from add_image_asset) to link, each with its field type."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_add_asset_group_assets",
    {
      title: "Add Assets to Performance Max Asset Group",
      description: `Create text assets (headlines, long headlines, descriptions, business name) and link them — plus any existing image assets — to a Performance Max asset group.

Args:
  - asset_group_id (string)
  - headlines / long_headlines / descriptions (string[], optional) / business_name (string, optional)
  - image_asset_resource_names (array, optional): each { asset_resource_name, field_type }
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: addInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const assetGroup = `customers/${customerId}/assetGroups/${args.asset_group_id.replace(/\D/g, "")}`;

        // 1) Build text assets to create, tracking their PMax field type.
        const pending: Array<{ field: string; asset: resources.IAsset; label: string }> = [];
        for (const t of args.headlines ?? []) pending.push({ field: "HEADLINE", asset: { text_asset: { text: t } }, label: t });
        for (const t of args.long_headlines ?? []) pending.push({ field: "LONG_HEADLINE", asset: { text_asset: { text: t } }, label: t });
        for (const t of args.descriptions ?? []) pending.push({ field: "DESCRIPTION", asset: { text_asset: { text: t } }, label: t });
        if (args.business_name) pending.push({ field: "BUSINESS_NAME", asset: { text_asset: { text: args.business_name } }, label: args.business_name });

        const links: resources.IAssetGroupAsset[] = [];

        if (pending.length) {
          const resp = await customer.assets.create(pending.map((p) => p.asset));
          const created = (resp.results ?? []).map((r) => r.resource_name ?? "");
          if (created.length !== pending.length) return fail("Text asset creation count mismatch; aborting before linking.");
          pending.forEach((p, i) => links.push({ asset_group: assetGroup, asset: created[i], field_type: p.field as never }));
        }

        // 2) Link any pre-created image assets.
        for (const img of args.image_asset_resource_names ?? []) {
          links.push({ asset_group: assetGroup, asset: img.asset_resource_name, field_type: img.field_type });
        }

        if (links.length === 0) return fail("Provide at least one text asset or image to link.");
        await customer.assetGroupAssets.create(links);

        const output = { asset_group_id: args.asset_group_id.replace(/\D/g, ""), linked: links.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Linked ${links.length} asset(s) to asset group ${output.asset_group_id}.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
