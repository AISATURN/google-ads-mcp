/**
 * Audience tools: list user lists, create a customer-match (CRM) user list, and
 * attach an audience (user list) to a campaign or ad group as targeting,
 * observation, or exclusion.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerAudienceTools(server: McpServer): void {
  // ---- list_user_lists -------------------------------------------------------
  server.registerTool(
    "google_ads_list_user_lists",
    {
      title: "List Audiences (User Lists)",
      description: `List the account's user lists (audiences) with id, name, type, size, and membership status. Use the IDs with google_ads_attach_audience.

Args:
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: z.object({
        customer_id: z.string().optional(),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }).shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const rows = await customer.query(
          `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status, ` +
            `user_list.size_for_search, user_list.size_for_display FROM user_list ORDER BY user_list.id`,
        );
        const lists = rows.map((r) => ({
          id: String(r.user_list?.id ?? ""),
          name: r.user_list?.name ?? "",
          type: String(r.user_list?.type ?? ""),
          membership_status: String(r.user_list?.membership_status ?? ""),
          size_search: Number(r.user_list?.size_for_search ?? 0),
          size_display: Number(r.user_list?.size_for_display ?? 0),
        }));
        const output = { customer_id: customerId, count: lists.length, user_lists: lists };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        if (lists.length === 0) return ok(`No user lists in account ${customerId}.`, output);
        const lines = [`# Audiences (${lists.length})`, ``, ...lists.map((l) => `- **${l.name}** (${l.id}) — type ${l.type}, search size ~${l.size_search}`)];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_user_list (customer match / CRM) -------------------------------
  const createListInput = z.object({
    name: z.string().min(1).max(255).describe("Audience name."),
    description: z.string().max(1000).optional(),
    upload_key_type: z.enum(["CONTACT_INFO", "CRM_ID", "MOBILE_ADVERTISING_ID"]).default("CONTACT_INFO").describe("How members are keyed (default CONTACT_INFO = email/phone)."),
    membership_life_span_days: z.number().int().min(0).max(540).default(540).describe("Membership duration in days (default 540; 10000 = no expiry not supported here)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_user_list",
    {
      title: "Create Customer-Match Audience",
      description: `Create an empty customer-match (CRM) user list to later upload customer emails/phones into. Use this for first-party audience targeting.

Note: rule-based website remarketing lists require the Google Ads tag and are best built in the UI; this tool creates the CRM list type.

Args:
  - name (string) / description (string, optional)
  - upload_key_type ('CONTACT_INFO' default | 'CRM_ID' | 'MOBILE_ADVERTISING_ID')
  - membership_life_span_days (number, default 540)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "resource_name": string, "user_list_id": string, "name": string, "customer_id": string }`,
      inputSchema: createListInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const userList: resources.IUserList = {
          name: args.name,
          description: args.description,
          membership_life_span: args.membership_life_span_days,
          crm_based_user_list: { upload_key_type: args.upload_key_type },
        };
        const resp = await customer.userLists.create([userList]);
        const resourceName = resp.results?.[0]?.resource_name ?? "";
        if (!resourceName) return fail("User list creation returned no resource name.");
        const output = { resource_name: resourceName, user_list_id: idFromResourceName(resourceName), name: args.name, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created customer-match audience **${args.name}** (${output.user_list_id}).\n- Resource: \`${resourceName}\`\n- Upload members via the Audience Manager or the offline user-data API.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- attach_audience -------------------------------------------------------
  const attachInput = z.object({
    user_list_id: z.string().describe("Numeric user list (audience) ID to attach."),
    campaign_id: z.string().optional().describe("Attach at campaign level. Provide this OR ad_group_id."),
    ad_group_id: z.string().optional().describe("Attach at ad group level. Provide this OR campaign_id."),
    mode: z.enum(["OBSERVATION", "EXCLUDE"]).default("OBSERVATION").describe("OBSERVATION (bid/observe only) or EXCLUDE (negative)."),
    bid_modifier: z.number().min(0.1).max(10).optional().describe("Optional bid modifier for OBSERVATION mode."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_attach_audience",
    {
      title: "Attach Audience to Campaign / Ad Group",
      description: `Attach a user list (audience) to a campaign or ad group as an observation (optionally with a bid modifier) or as an exclusion.

For "targeting" (restrict serving to this audience) set the ad group/campaign targeting setting in the UI; this tool adds the audience criterion (observation/exclusion), which is the common, safe default.

Args:
  - user_list_id (string)
  - campaign_id (string, optional) | ad_group_id (string, optional): exactly one
  - mode ('OBSERVATION' default | 'EXCLUDE')
  - bid_modifier (number, optional): only for OBSERVATION
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: attachInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const hasCampaign = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasAdGroup = typeof args.ad_group_id === "string" && args.ad_group_id.length > 0;
        if (hasCampaign === hasAdGroup) return fail("Provide exactly one of 'campaign_id' or 'ad_group_id'.");
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const userList = `customers/${customerId}/userLists/${args.user_list_id.replace(/\D/g, "")}`;
        const negative = args.mode === "EXCLUDE";

        if (hasCampaign) {
          const parent = `customers/${customerId}/campaigns/${(args.campaign_id as string).replace(/\D/g, "")}`;
          const crit: resources.ICampaignCriterion = { campaign: parent, user_list: { user_list: userList }, negative };
          if (!negative && typeof args.bid_modifier === "number") crit.bid_modifier = args.bid_modifier;
          await customer.campaignCriteria.create([crit]);
          const output = { level: "campaign", parent, user_list_id: args.user_list_id, mode: args.mode, customer_id: customerId };
          return ok(args.response_format === ResponseFormat.JSON ? toJson(output) : `✅ Audience ${args.user_list_id} attached to campaign ${idFromResourceName(parent)} as ${args.mode}.`, output);
        }
        const parent = `customers/${customerId}/adGroups/${(args.ad_group_id as string).replace(/\D/g, "")}`;
        const crit: resources.IAdGroupCriterion = { ad_group: parent, user_list: { user_list: userList }, negative };
        if (!negative && typeof args.bid_modifier === "number") crit.bid_modifier = args.bid_modifier;
        await customer.adGroupCriteria.create([crit]);
        const output = { level: "ad_group", parent, user_list_id: args.user_list_id, mode: args.mode, customer_id: customerId };
        return ok(args.response_format === ResponseFormat.JSON ? toJson(output) : `✅ Audience ${args.user_list_id} attached to ad group ${idFromResourceName(parent)} as ${args.mode}.`, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
