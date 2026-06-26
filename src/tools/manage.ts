/**
 * Entity-management tools: pause / enable / remove keywords, edit ad groups,
 * pause / enable / remove ads, and create + apply shared negative keyword lists.
 * These fill the "edit and clean up" gap left by the create-only tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";
import { KEYWORD_MATCH_TYPES } from "../constants.js";

function adGroupResourceName(customerId: string, adGroupId: string): string {
  return `customers/${customerId}/adGroups/${adGroupId}`;
}
function campaignResourceName(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${campaignId}`;
}
function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}
function gaqlString(value: string): string {
  return value.replace(/'/g, "\\'");
}

export function registerManageTools(server: McpServer): void {
  // ---- update_keywords (pause / enable / remove) -----------------------------
  const updKeywordsInput = z.object({
    ad_group_id: z.string().describe("Numeric ad group ID containing the keywords."),
    action: z.enum(["PAUSE", "ENABLE", "REMOVE"]).describe("PAUSE, ENABLE, or REMOVE the matching keywords."),
    keywords: z
      .array(
        z.object({
          text: z.string().min(1).max(80),
          match_type: z.enum(KEYWORD_MATCH_TYPES).optional().describe("Optional: narrow to a specific match type."),
        }),
      )
      .min(1)
      .max(500)
      .describe("Keywords to act on, matched by text (and match_type if given)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_update_keywords",
    {
      title: "Pause / Enable / Remove Keywords",
      description: `Pause, enable, or remove existing keywords in an ad group, matched by text (optionally narrowed by match type).

Args:
  - ad_group_id (string)
  - action ('PAUSE' | 'ENABLE' | 'REMOVE')
  - keywords (array): each { text, match_type? }
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "ad_group_id": string, "action": string, "matched": number, "not_found": string[], "customer_id": string }`,
      inputSchema: updKeywordsInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.ad_group_id.replace(/\D/g, "");

        const rows = await customer.query(
          `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ` +
            `ad_group_criterion.keyword.match_type FROM ad_group_criterion ` +
            `WHERE ad_group.id = ${cleanId} AND ad_group_criterion.type = 'KEYWORD' ` +
            `AND ad_group_criterion.status != 'REMOVED'`,
        );
        const existing = rows.map((r) => ({
          resource_name: r.ad_group_criterion?.resource_name as string,
          text: (r.ad_group_criterion?.keyword?.text ?? "").toLowerCase(),
          match_type: String(r.ad_group_criterion?.keyword?.match_type ?? ""),
        }));

        const matched: string[] = [];
        const notFound: string[] = [];
        for (const kw of args.keywords) {
          const hit = existing.find(
            (e) =>
              e.text === kw.text.toLowerCase() &&
              (!kw.match_type || e.match_type === kw.match_type || e.match_type === String(matchTypeEnum(kw.match_type))),
          );
          if (hit) matched.push(hit.resource_name);
          else notFound.push(kw.text);
        }

        if (matched.length === 0) {
          return fail(`No matching keywords found in ad group ${cleanId}. Not found: ${notFound.join(", ")}`);
        }

        if (args.action === "REMOVE") {
          await customer.adGroupCriteria.remove(matched);
        } else {
          await customer.adGroupCriteria.update(
            matched.map((rn) => ({ resource_name: rn, status: args.action === "PAUSE" ? "PAUSED" : "ENABLED" })),
          );
        }

        const output = { ad_group_id: cleanId, action: args.action, matched: matched.length, not_found: notFound, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ ${args.action} applied to ${matched.length} keyword(s) in ad group ${cleanId}.` +
              (notFound.length ? `\n⚠️ Not found: ${notFound.join(", ")}` : "");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_ad_group -------------------------------------------------------
  const updAdGroupInput = z.object({
    ad_group_id: z.string().describe("Numeric ad group ID."),
    name: z.string().min(1).max(255).optional().describe("New name."),
    status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).optional().describe("New status."),
    cpc_bid: z.number().positive().optional().describe("New default max CPC in account currency."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_update_ad_group",
    {
      title: "Update Ad Group",
      description: `Rename an ad group, change its status (enable/pause/remove), and/or change its default max CPC bid.

Provide at least one of name / status / cpc_bid.

Args:
  - ad_group_id (string)
  - name (string, optional) | status ('ENABLED'|'PAUSED'|'REMOVED', optional) | cpc_bid (number, optional)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: updAdGroupInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.name && !args.status && typeof args.cpc_bid !== "number") {
          return fail("Provide at least one of 'name', 'status', or 'cpc_bid'.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const cleanId = args.ad_group_id.replace(/\D/g, "");
        const update: resources.IAdGroup = { resource_name: adGroupResourceName(customerId, cleanId) };
        if (args.name) update.name = args.name;
        if (args.status) update.status = args.status;
        if (typeof args.cpc_bid === "number") update.cpc_bid_micros = toMicros(args.cpc_bid);
        await customer.adGroups.update([update]);
        const output = { ad_group_id: cleanId, name: args.name, status: args.status, cpc_bid: args.cpc_bid, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Updated ad group ${cleanId}` +
              [args.name ? ` name="${args.name}"` : "", args.status ? ` status=${args.status}` : "", typeof args.cpc_bid === "number" ? ` cpc=${args.cpc_bid}` : ""].join("");
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_ad_status ------------------------------------------------------
  const updAdInput = z.object({
    ad_group_ad_resource_name: z
      .string()
      .optional()
      .describe("Full ad_group_ad resource name (e.g. customers/X/adGroupAds/AG~AD). Provide this OR ad_group_id+ad_id."),
    ad_group_id: z.string().optional().describe("Numeric ad group ID (with ad_id)."),
    ad_id: z.string().optional().describe("Numeric ad ID (with ad_group_id)."),
    status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).describe("New ad status."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_update_ad_status",
    {
      title: "Pause / Enable / Remove Ad",
      description: `Pause, enable, or remove an ad. Identify it by its ad_group_ad resource name, or by ad_group_id + ad_id.

Args:
  - ad_group_ad_resource_name (string, optional) | (ad_group_id + ad_id) (strings, optional)
  - status ('ENABLED' | 'PAUSED' | 'REMOVED')
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: updAdInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        let rn = args.ad_group_ad_resource_name?.trim() ?? "";
        if (!rn) {
          if (!args.ad_group_id || !args.ad_id) {
            return fail("Provide 'ad_group_ad_resource_name', or both 'ad_group_id' and 'ad_id'.");
          }
          rn = `customers/${customerId}/adGroupAds/${args.ad_group_id.replace(/\D/g, "")}~${args.ad_id.replace(/\D/g, "")}`;
        }
        if (args.status === "REMOVED") {
          await customer.adGroupAds.remove([rn]);
        } else {
          await customer.adGroupAds.update([{ resource_name: rn, status: args.status }]);
        }
        const output = { ad_group_ad_resource_name: rn, status: args.status, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Ad ${idFromResourceName(rn)} is now **${args.status}**.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_shared_negative_list -------------------------------------------
  const sharedListInput = z.object({
    name: z.string().min(1).max(255).describe("Name for the shared negative keyword list."),
    keywords: z
      .array(
        z.object({
          text: z.string().min(1).max(80),
          match_type: z.enum(KEYWORD_MATCH_TYPES).default("BROAD"),
        }),
      )
      .min(1)
      .max(5000)
      .describe("Negative keywords to put in the list."),
    apply_to_campaign_ids: z
      .array(z.string())
      .optional()
      .describe("Optional campaign IDs to immediately attach this list to."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_shared_negative_list",
    {
      title: "Create & Apply Shared Negative Keyword List",
      description: `Create an account-level shared negative keyword list, fill it, and optionally attach it to one or more campaigns. Reuse the same list across many campaigns.

Args:
  - name (string)
  - keywords (array): each { text, match_type? }
  - apply_to_campaign_ids (string[], optional)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "shared_set_resource_name": string, "keyword_count": number, "applied_to": string[], "customer_id": string }`,
      inputSchema: sharedListInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        // 1) Create the shared set.
        const setResp = await customer.sharedSets.create([{ name: args.name, type: "NEGATIVE_KEYWORDS" }]);
        const sharedSet = setResp.results?.[0]?.resource_name ?? "";
        if (!sharedSet) return fail("Shared set creation returned no resource name.");

        // 2) Fill it with negative keyword criteria.
        const criteria: resources.ISharedCriterion[] = args.keywords.map((kw) => ({
          shared_set: sharedSet,
          keyword: { text: kw.text, match_type: kw.match_type },
        }));
        await customer.sharedCriteria.create(criteria);

        // 3) Optionally attach to campaigns.
        const appliedTo: string[] = [];
        if (args.apply_to_campaign_ids?.length) {
          const links: resources.ICampaignSharedSet[] = args.apply_to_campaign_ids.map((cid) => ({
            campaign: campaignResourceName(customerId, cid.replace(/\D/g, "")),
            shared_set: sharedSet,
          }));
          await customer.campaignSharedSets.create(links);
          appliedTo.push(...args.apply_to_campaign_ids.map((c) => c.replace(/\D/g, "")));
        }

        const output = {
          shared_set_resource_name: sharedSet,
          keyword_count: criteria.length,
          applied_to: appliedTo,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created shared negative list **${args.name}** with ${criteria.length} keyword(s).` +
              (appliedTo.length ? `\n- Applied to campaign(s): ${appliedTo.join(", ")}` : "\n- Not yet applied to any campaign.") +
              `\n- Resource: \`${sharedSet}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}

/** Maps a string match type to the numeric enum value the API reports back (for cross-checking). */
function matchTypeEnum(mt: string): number {
  switch (mt) {
    case "EXACT":
      return 2;
    case "PHRASE":
      return 3;
    case "BROAD":
      return 4;
    default:
      return -1;
  }
}
