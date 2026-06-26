/**
 * Ad asset (extension) tools. Creates Search ad assets — sitelinks, callouts,
 * structured snippets, and a call asset — and links them to a campaign so they
 * can show alongside its ads.
 *
 * Flow: create the Asset resources in one batch, then link each to the campaign
 * via CampaignAsset with the matching field type. Enum-valued fields are passed
 * as their string names (e.g. "SITELINK"), which the Google Ads proto layer
 * accepts and converts to the numeric enum.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

/** Builds a campaign resource name from a customer ID and numeric campaign ID. */
function campaignResourceName(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${campaignId}`;
}

/** Extracts the trailing numeric ID from a resource name. */
function idFromResourceName(resourceName: string | null | undefined): string {
  return resourceName?.split("/").pop() ?? "";
}

/** A pending asset to create plus the campaign field type it will be linked under. */
interface PendingAsset {
  fieldType: "SITELINK" | "CALLOUT" | "STRUCTURED_SNIPPET" | "CALL";
  asset: resources.IAsset;
  label: string;
}

export function registerAssetTools(server: McpServer): void {
  const sitelinkSchema = z.object({
    link_text: z.string().min(1).max(25).describe("Sitelink text shown as the clickable link (≤25 chars)."),
    description1: z
      .string()
      .max(35)
      .optional()
      .describe("First description line (≤35 chars). Provide both descriptions or neither."),
    description2: z
      .string()
      .max(35)
      .optional()
      .describe("Second description line (≤35 chars). Provide both descriptions or neither."),
    final_url: z.string().url("Must be a valid URL").describe("Landing page URL for this sitelink."),
  });

  const addAssetsInput = z.object({
    campaign_id: z.string().optional().describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    callouts: z
      .array(z.string().min(1).max(25))
      .max(20)
      .optional()
      .describe("Callout texts, each ≤25 chars (e.g. 'Crane-Free Assembly')."),
    sitelinks: z
      .array(sitelinkSchema)
      .max(20)
      .optional()
      .describe("Sitelinks, each with link_text, optional description1/description2, and final_url."),
    structured_snippet: z
      .object({
        header: z
          .string()
          .min(1)
          .describe(
            "A predefined Google snippet header, e.g. 'Types', 'Brands', 'Services', 'Models', 'Featured'.",
          ),
        values: z
          .array(z.string().min(1).max(25))
          .min(3, "Structured snippets require at least 3 values")
          .max(10)
          .describe("3-10 snippet values, each ≤25 chars."),
      })
      .optional()
      .describe("A single structured snippet (one header + its values)."),
    call: z
      .object({
        phone_number: z.string().min(1).describe("Phone number, e.g. '+90 216 222 00 44' or '2162220044'."),
        country_code: z
          .string()
          .length(2)
          .describe("Two-letter ISO country code for the phone number, e.g. 'TR', 'US', 'GB'."),
      })
      .optional()
      .describe("A single call asset (click-to-call phone number)."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const addAssetsOutput = z.object({
    campaign_resource_name: z.string(),
    count: z.number(),
    assets: z.array(
      z.object({ field_type: z.string(), label: z.string(), asset_resource_name: z.string() }),
    ),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_add_campaign_assets",
    {
      title: "Add Campaign Assets (Extensions)",
      description: `Create Search ad assets (extensions) and link them to a campaign: sitelinks, callouts, a structured snippet, and a call asset.

Provide at least one asset type. Each asset is created at the account level and linked to the campaign with the matching field type. Assets are reusable; this tool always creates new ones.

Args:
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - callouts (string[], optional): each ≤25 chars
  - sitelinks (array, optional): each { link_text (≤25), description1? (≤35), description2? (≤35), final_url }
  - structured_snippet (object, optional): { header, values[] } — 3-10 values, each ≤25 chars
  - call (object, optional): { phone_number, country_code (2-letter ISO) }
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "campaign_resource_name": string, "count": number,
    "assets": [{ "field_type": string, "label": string, "asset_resource_name": string }],
    "customer_id": string }`,
      inputSchema: addAssetsInput.shape,
      outputSchema: addAssetsOutput.shape,
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

        // Resolve the parent campaign (exactly one of id / resource name).
        const hasId = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasRn =
          typeof args.campaign_resource_name === "string" && args.campaign_resource_name.length > 0;
        if (hasId === hasRn) {
          return fail("Provide exactly one of 'campaign_id' or 'campaign_resource_name'.");
        }
        const campaign = hasId
          ? campaignResourceName(customerId, (args.campaign_id as string).replace(/\D/g, ""))
          : (args.campaign_resource_name as string);

        // Build the list of assets to create, preserving field-type + label for linking and reporting.
        const pending: PendingAsset[] = [];

        for (const text of args.callouts ?? []) {
          pending.push({ fieldType: "CALLOUT", asset: { callout_asset: { callout_text: text } }, label: text });
        }

        for (const sl of args.sitelinks ?? []) {
          if ((sl.description1 == null) !== (sl.description2 == null)) {
            return fail(
              `Sitelink "${sl.link_text}": provide both description1 and description2, or neither.`,
            );
          }
          pending.push({
            fieldType: "SITELINK",
            asset: {
              final_urls: [sl.final_url],
              sitelink_asset: {
                link_text: sl.link_text,
                description1: sl.description1,
                description2: sl.description2,
              },
            },
            label: sl.link_text,
          });
        }

        if (args.structured_snippet) {
          pending.push({
            fieldType: "STRUCTURED_SNIPPET",
            asset: {
              structured_snippet_asset: {
                header: args.structured_snippet.header,
                values: args.structured_snippet.values,
              },
            },
            label: `${args.structured_snippet.header}: ${args.structured_snippet.values.join(", ")}`,
          });
        }

        if (args.call) {
          pending.push({
            fieldType: "CALL",
            asset: {
              call_asset: {
                phone_number: args.call.phone_number,
                country_code: args.call.country_code.toUpperCase(),
              },
            },
            label: args.call.phone_number,
          });
        }

        if (pending.length === 0) {
          return fail(
            "No assets provided. Supply at least one of: callouts, sitelinks, structured_snippet, call.",
          );
        }

        // 1) Create the assets.
        const assetResponse = await customer.assets.create(pending.map((p) => p.asset));
        const assetResourceNames = (assetResponse.results ?? []).map((r) => r.resource_name ?? "");
        if (assetResourceNames.length !== pending.length) {
          return fail(
            `Asset creation returned ${assetResourceNames.length} result(s) for ${pending.length} asset(s); aborting before linking.`,
          );
        }

        // 2) Link each asset to the campaign under its field type.
        const campaignAssets: resources.ICampaignAsset[] = pending.map((p, i) => ({
          campaign,
          asset: assetResourceNames[i],
          field_type: p.fieldType,
        }));
        await customer.campaignAssets.create(campaignAssets);

        const assets = pending.map((p, i) => ({
          field_type: p.fieldType,
          label: p.label,
          asset_resource_name: assetResourceNames[i] ?? "",
        }));
        const output = {
          campaign_resource_name: campaign,
          count: assets.length,
          assets,
          customer_id: customerId,
        };

        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const byType = (t: string) => assets.filter((a) => a.field_type === t);
        const lines: string[] = [
          `✅ Added ${assets.length} asset(s) to campaign ${idFromResourceName(campaign)}:`,
          ``,
        ];
        const sitelinks = byType("SITELINK");
        const callouts = byType("CALLOUT");
        const snippets = byType("STRUCTURED_SNIPPET");
        const calls = byType("CALL");
        if (sitelinks.length) lines.push(`- **Sitelinks** (${sitelinks.length}): ${sitelinks.map((a) => a.label).join(", ")}`);
        if (callouts.length) lines.push(`- **Callouts** (${callouts.length}): ${callouts.map((a) => a.label).join(", ")}`);
        if (snippets.length) lines.push(`- **Structured snippet**: ${snippets.map((a) => a.label).join(" | ")}`);
        if (calls.length) lines.push(`- **Call**: ${calls.map((a) => a.label).join(", ")}`);
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
