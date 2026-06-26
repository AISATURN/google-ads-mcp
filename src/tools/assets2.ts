/**
 * Image-asset and asset-cleanup tools: upload an image asset from a URL (and
 * optionally link it to a campaign as a marketing image or logo), and remove a
 * campaign asset link.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerAsset2Tools(server: McpServer): void {
  // ---- add_image_asset (from URL) --------------------------------------------
  const imgInput = z.object({
    image_url: z.string().url().describe("Public URL of the image to upload (PNG/JPG)."),
    name: z.string().min(1).max(255).describe("Asset name (must be unique in the account)."),
    campaign_id: z.string().optional().describe("Optional campaign ID to link the image to."),
    field_type: z
      .enum(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"])
      .default("MARKETING_IMAGE")
      .describe("How the image is used when linked to a campaign (default MARKETING_IMAGE)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_add_image_asset",
    {
      title: "Add Image Asset (from URL)",
      description: `Download an image from a public URL, create it as an image asset, and optionally link it to a campaign as a marketing image or logo.

Image specs matter: marketing images are typically 1.91:1 (≥600×314), square 1:1 (≥300×300), logos 1:1 and 4:1. Google rejects off-spec images.

Args:
  - image_url (string) / name (string)
  - campaign_id (string, optional) + field_type (enum, default MARKETING_IMAGE)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "asset_resource_name": string, "asset_id": string, "linked_to_campaign": string, "customer_id": string }`,
      inputSchema: imgInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        // Fetch image bytes.
        const res = await fetch(args.image_url);
        if (!res.ok) return fail(`Failed to download image (${res.status} ${res.statusText}) from ${args.image_url}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0) return fail("Downloaded image is empty.");

        const asset: resources.IAsset = {
          name: args.name,
          type: "IMAGE",
          image_asset: { data: bytes as unknown as Uint8Array },
        };
        const resp = await customer.assets.create([asset]);
        const assetRn = resp.results?.[0]?.resource_name ?? "";
        if (!assetRn) return fail("Image asset creation returned no resource name.");

        let linked = "";
        if (args.campaign_id) {
          const campaign = `customers/${customerId}/campaigns/${args.campaign_id.replace(/\D/g, "")}`;
          await customer.campaignAssets.create([{ campaign, asset: assetRn, field_type: args.field_type }]);
          linked = idFromResourceName(campaign);
        }
        const output = { asset_resource_name: assetRn, asset_id: idFromResourceName(assetRn), linked_to_campaign: linked, field_type: args.field_type, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created image asset **${args.name}** (${output.asset_id}).` + (linked ? `\n- Linked to campaign ${linked} as ${args.field_type}.` : "\n- Not linked to a campaign yet.");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- remove_campaign_asset -------------------------------------------------
  const removeInput = z.object({
    campaign_asset_resource_names: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("Full campaign_asset resource names to remove (from google_ads_run_gaql on campaign_asset)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_remove_campaign_asset",
    {
      title: "Remove Campaign Asset Link",
      description: `Unlink one or more assets from a campaign (removes the campaign_asset, not the underlying asset).

Find resource names with: SELECT campaign_asset.resource_name, campaign_asset.field_type FROM campaign_asset WHERE campaign.id = <ID>.

Args:
  - campaign_asset_resource_names (string[])
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: removeInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        await customer.campaignAssets.remove(args.campaign_asset_resource_names);
        const output = { removed: args.campaign_asset_resource_names.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Removed ${output.removed} campaign asset link(s).`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
