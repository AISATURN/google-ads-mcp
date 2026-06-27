/**
 * Campaign mutation tools: create a campaign budget, create a campaign (with an
 * inline or pre-existing budget and a selectable bidding strategy), and change a
 * campaign's status (enable / pause / remove).
 *
 * Enum-valued fields are passed as their string names (e.g. "SEARCH", "PAUSED"),
 * which the Google Ads proto layer accepts and converts to the numeric enum.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceNames, type MutateOperation, type resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, fromMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";
import {
  CHANNEL_TYPES,
  BIDDING_STRATEGIES,
  BUDGET_DELIVERY_METHODS,
  type ChannelType,
} from "../constants.js";

// v23 renamed Campaign.start_date/end_date to start_date_time/end_date_time (datetime strings).
// Accept either a date or a full datetime from callers.
const DATE_OR_DATETIME_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

/** Normalizes a YYYY-MM-DD (or full datetime) value to the "YYYY-MM-DD HH:MM:SS" form the API expects. */
function toCampaignDateTime(value: string, kind: "start" | "end"): string {
  return /\d{2}:\d{2}:\d{2}$/.test(value)
    ? value
    : `${value} ${kind === "start" ? "00:00:00" : "23:59:59"}`;
}

/** Builds a campaign resource name from a customer ID and numeric campaign ID. */
function campaignResourceName(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${campaignId}`;
}

/** Extracts the trailing numeric ID from a resource name (e.g. ".../campaigns/123" -> "123"). */
function idFromResourceName(resourceName: string | null | undefined): string {
  return resourceName?.split("/").pop() ?? "";
}

/** Escapes single quotes for safe embedding inside GAQL string literals. */
function gaqlString(value: string): string {
  return value.replace(/'/g, "\\'");
}

/**
 * Returns default network settings for a channel type, applying any explicit
 * overrides. Only meaningful for SEARCH and DISPLAY; callers omit it otherwise.
 */
function buildNetworkSettings(
  channel: ChannelType,
  overrides: {
    target_google_search?: boolean;
    target_search_network?: boolean;
    target_content_network?: boolean;
    target_partner_search_network?: boolean;
  },
): resources.Campaign.INetworkSettings {
  const isSearch = channel === "SEARCH";
  const isDisplay = channel === "DISPLAY";
  return {
    target_google_search: overrides.target_google_search ?? isSearch,
    target_search_network: overrides.target_search_network ?? isSearch,
    target_content_network: overrides.target_content_network ?? isDisplay,
    target_partner_search_network: overrides.target_partner_search_network ?? false,
  };
}

export function registerCampaignTools(server: McpServer): void {
  // ---- create_campaign_budget ------------------------------------------------
  const createBudgetInput = z.object({
    name: z.string().min(1).max(255).describe("Budget name (must be unique within the account)"),
    daily_budget: z
      .number()
      .positive()
      .describe("Average daily budget in the account's currency units (e.g. 50 = 50.00/day)"),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    delivery_method: z
      .enum(BUDGET_DELIVERY_METHODS)
      .default("STANDARD")
      .describe("Spend pacing: STANDARD (even) or ACCELERATED (default: STANDARD)"),
    explicitly_shared: z
      .boolean()
      .default(false)
      .describe("Whether the budget can be shared across multiple campaigns (default: false)"),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createBudgetOutput = z.object({
    resource_name: z.string(),
    budget_id: z.string(),
    name: z.string(),
    daily_budget: z.number(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_campaign_budget",
    {
      title: "Create Campaign Budget",
      description: `Create a campaign budget, the spending container a campaign requires before it can run.

Most of the time you can skip this and let google_ads_create_campaign create a budget inline via its 'daily_budget' argument. Use this tool when you want a reusable/shared budget or to set one up ahead of time.

Args:
  - name (string): Unique budget name
  - daily_budget (number): Average daily amount in account currency (e.g. 50 = 50.00/day)
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - delivery_method ('STANDARD' | 'ACCELERATED'): default 'STANDARD'
  - explicitly_shared (boolean): default false
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "budget_id": string, "name": string, "daily_budget": number, "customer_id": string }`,
      inputSchema: createBudgetInput.shape,
      outputSchema: createBudgetOutput.shape,
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
        const response = await customer.campaignBudgets.create([
          {
            name: args.name,
            amount_micros: toMicros(args.daily_budget),
            delivery_method: args.delivery_method,
            explicitly_shared: args.explicitly_shared,
          },
        ]);
        const resourceName = response.results?.[0]?.resource_name ?? "";
        if (!resourceName) {
          return fail("Budget creation returned no resource name — it may not have been created.");
        }
        const output = {
          resource_name: resourceName,
          budget_id: idFromResourceName(resourceName),
          name: args.name,
          daily_budget: args.daily_budget,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created budget **${args.name}** (${args.daily_budget}/day)\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_campaign -------------------------------------------------------
  const createCampaignInput = z.object({
    name: z.string().min(1).max(255).describe("Campaign name (unique within the account)"),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    channel_type: z
      .enum(CHANNEL_TYPES)
      .default("SEARCH")
      .describe(
        "Advertising channel. SEARCH and DISPLAY are fully supported end-to-end. " +
          "SHOPPING/VIDEO/PERFORMANCE_MAX can be created but need extra setup not covered here.",
      ),
    daily_budget: z
      .number()
      .positive()
      .optional()
      .describe("Daily budget in account currency. Creates a budget inline. Provide this OR budget_resource_name."),
    budget_resource_name: z
      .string()
      .optional()
      .describe("Resource name of an existing budget to attach. Provide this OR daily_budget."),
    bidding_strategy: z
      .enum(BIDDING_STRATEGIES)
      .default("MAXIMIZE_CLICKS")
      .describe(
        "Bidding strategy: MANUAL_CPC, MAXIMIZE_CLICKS (default, no conversion tracking needed), " +
          "MAXIMIZE_CONVERSIONS, or MAXIMIZE_CONVERSION_VALUE.",
      ),
    status: z
      .enum(["ENABLED", "PAUSED"])
      .default("PAUSED")
      .describe("Initial status. Defaults to PAUSED so the campaign does not spend until you enable it."),
    target_roas: z
      .number()
      .positive()
      .optional()
      .describe("Target ROAS (e.g. 4.0 = 400%) — only used with MAXIMIZE_CONVERSION_VALUE."),
    enhanced_cpc: z
      .boolean()
      .default(false)
      .describe("Enable Enhanced CPC — only used with MANUAL_CPC (default: false)."),
    start_date: z
      .string()
      .regex(DATE_OR_DATETIME_RE, "Use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS")
      .optional()
      .describe("Campaign start (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS); maps to start_date_time."),
    end_date: z
      .string()
      .regex(DATE_OR_DATETIME_RE, "Use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS")
      .optional()
      .describe("Campaign end (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS); maps to end_date_time."),
    target_google_search: z.boolean().optional().describe("Network override (SEARCH/DISPLAY)."),
    target_search_network: z.boolean().optional().describe("Network override (SEARCH/DISPLAY)."),
    target_content_network: z.boolean().optional().describe("Network override (SEARCH/DISPLAY)."),
    target_partner_search_network: z.boolean().optional().describe("Network override (SEARCH/DISPLAY)."),
    contains_eu_political_advertising: z
      .boolean()
      .default(false)
      .describe(
        "Whether the campaign contains EU political advertising (required declaration as of API v23; default: false).",
      ),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const createCampaignOutput = z.object({
    resource_name: z.string(),
    campaign_id: z.string(),
    name: z.string(),
    status: z.string(),
    channel_type: z.string(),
    bidding_strategy: z.string(),
    budget_resource_name: z.string(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_create_campaign",
    {
      title: "Create Google Ads Campaign",
      description: `Create a Google Ads campaign. Optionally creates its budget inline in the same call.

This is the primary tool for launching a campaign. By default the campaign is created PAUSED with a MAXIMIZE_CLICKS bidding strategy so nothing spends until you explicitly enable it (google_ads_update_campaign_status) and add ad groups, keywords, and ads.

You must provide exactly one of:
  - daily_budget (number): a budget is created automatically and attached, OR
  - budget_resource_name (string): attach an existing budget (see google_ads_create_campaign_budget)

Args:
  - name (string): Campaign name
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - channel_type (enum): SEARCH (default) | DISPLAY | SHOPPING | VIDEO | PERFORMANCE_MAX
  - daily_budget (number, optional) | budget_resource_name (string, optional): exactly one required
  - bidding_strategy (enum): MANUAL_CPC | MAXIMIZE_CLICKS (default) | MAXIMIZE_CONVERSIONS | MAXIMIZE_CONVERSION_VALUE
  - status ('ENABLED' | 'PAUSED'): default 'PAUSED'
  - target_roas (number, optional): for MAXIMIZE_CONVERSION_VALUE
  - enhanced_cpc (boolean): for MANUAL_CPC
  - start_date / end_date (YYYY-MM-DD, optional)
  - target_google_search / target_search_network / target_content_network / target_partner_search_network (boolean, optional)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "campaign_id": string, "name": string, "status": string,
    "channel_type": string, "bidding_strategy": string, "budget_resource_name": string, "customer_id": string }

Next steps after creating a SEARCH campaign: google_ads_create_ad_group → google_ads_add_keywords → google_ads_create_responsive_search_ad, then google_ads_update_campaign_status to ENABLED.`,
      inputSchema: createCampaignInput.shape,
      outputSchema: createCampaignOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // Cross-field validation (refinements are not preserved when only .shape is passed to the SDK).
        const hasBudget = typeof args.daily_budget === "number";
        const hasBudgetRn = typeof args.budget_resource_name === "string" && args.budget_resource_name.length > 0;
        if (hasBudget === hasBudgetRn) {
          return fail(
            "Provide exactly one of 'daily_budget' (to create a budget inline) or " +
              "'budget_resource_name' (to attach an existing budget).",
          );
        }

        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        // Assemble the campaign resource (budget is attached below).
        const campaign: resources.ICampaign = {
          name: args.name,
          advertising_channel_type: args.channel_type,
          status: args.status,
          // Required declaration as of Google Ads API v23.
          contains_eu_political_advertising: args.contains_eu_political_advertising
            ? "CONTAINS_EU_POLITICAL_ADVERTISING"
            : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        };
        if (args.start_date) campaign.start_date_time = toCampaignDateTime(args.start_date, "start");
        if (args.end_date) campaign.end_date_time = toCampaignDateTime(args.end_date, "end");
        if (args.channel_type === "SEARCH" || args.channel_type === "DISPLAY") {
          campaign.network_settings = buildNetworkSettings(args.channel_type, args);
        }

        // Apply the bidding strategy one-of.
        switch (args.bidding_strategy) {
          case "MANUAL_CPC":
            campaign.manual_cpc = { enhanced_cpc_enabled: args.enhanced_cpc };
            break;
          case "MAXIMIZE_CLICKS":
            campaign.target_spend = {};
            break;
          case "MAXIMIZE_CONVERSIONS":
            campaign.maximize_conversions = {};
            break;
          case "MAXIMIZE_CONVERSION_VALUE":
            campaign.maximize_conversion_value =
              typeof args.target_roas === "number" ? { target_roas: args.target_roas } : {};
            break;
        }

        // When creating the budget inline, do it atomically with the campaign in a single
        // mutate transaction (linked by a temporary budget resource name). If anything fails,
        // nothing is created — no orphaned budget, and a retry won't collide on the budget name.
        let resourceName = "";
        let budgetResourceName = args.budget_resource_name ?? "";
        if (hasBudget) {
          const tempBudget = ResourceNames.campaignBudget(customerId, "-1");
          campaign.campaign_budget = tempBudget;
          const operations: MutateOperation<resources.ICampaignBudget | resources.ICampaign>[] = [
            {
              entity: "campaign_budget",
              operation: "create",
              resource: {
                resource_name: tempBudget,
                name: `${args.name} — budget ${Date.now().toString(36)}`,
                amount_micros: toMicros(args.daily_budget as number),
                delivery_method: "STANDARD",
                explicitly_shared: false,
              },
            },
            { entity: "campaign", operation: "create", resource: campaign },
          ];
          const response = await customer.mutateResources(operations);
          const opResponses = response.mutate_operation_responses ?? [];
          budgetResourceName = opResponses[0]?.campaign_budget_result?.resource_name ?? "";
          resourceName = opResponses[1]?.campaign_result?.resource_name ?? "";
        } else {
          campaign.campaign_budget = budgetResourceName;
          const response = await customer.campaigns.create([campaign]);
          resourceName = response.results?.[0]?.resource_name ?? "";
        }

        if (!resourceName) {
          return fail(
            "Campaign creation returned no resource name — the operation may not have completed. " +
              "Verify with google_ads_list_campaigns.",
          );
        }
        const output = {
          resource_name: resourceName,
          campaign_id: idFromResourceName(resourceName),
          name: args.name,
          status: args.status,
          channel_type: args.channel_type,
          bidding_strategy: args.bidding_strategy,
          budget_resource_name: budgetResourceName,
          customer_id: customerId,
        };

        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = [
          `✅ Created campaign **${args.name}** (${output.campaign_id})`,
          `- **Status**: ${args.status}${args.status === "PAUSED" ? " — enable it with google_ads_update_campaign_status when ready" : ""}`,
          `- **Channel**: ${args.channel_type}`,
          `- **Bidding**: ${args.bidding_strategy}`,
          `- **Budget**: \`${budgetResourceName}\`${hasBudget ? ` (${args.daily_budget}/day)` : ""}`,
          `- **Resource**: \`${resourceName}\``,
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_campaign_status ------------------------------------------------
  const updateStatusInput = z.object({
    campaign_id: z
      .string()
      .optional()
      .describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    status: z
      .enum(["ENABLED", "PAUSED", "REMOVED"])
      .describe("New status: ENABLED (serve), PAUSED (stop serving), or REMOVED (permanent)."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const updateStatusOutput = z.object({
    resource_name: z.string(),
    campaign_id: z.string(),
    status: z.string(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_update_campaign_status",
    {
      title: "Update Campaign Status",
      description: `Enable, pause, or remove a campaign.

Use ENABLED to start serving a PAUSED campaign, PAUSED to stop serving, or REMOVED to permanently delete it (REMOVED cannot be undone).

Args:
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - status ('ENABLED' | 'PAUSED' | 'REMOVED'): required
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "campaign_id": string, "status": string, "customer_id": string }`,
      inputSchema: updateStatusInput.shape,
      outputSchema: updateStatusOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const hasId = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasRn = typeof args.campaign_resource_name === "string" && args.campaign_resource_name.length > 0;
        if (hasId === hasRn) {
          return fail("Provide exactly one of 'campaign_id' or 'campaign_resource_name'.");
        }
        let cleanCampaignId = "";
        if (hasId) {
          cleanCampaignId = (args.campaign_id as string).replace(/\D/g, "");
          if (!cleanCampaignId) {
            return fail(`Invalid campaign_id "${args.campaign_id}". Expected a numeric campaign ID.`);
          }
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const resourceName = hasRn
          ? (args.campaign_resource_name as string)
          : campaignResourceName(customerId, cleanCampaignId);

        // REMOVED must be issued as a delete operation; the API rejects an update that sets
        // status = REMOVED (request_error 18). ENABLED / PAUSED are normal field updates.
        if (args.status === "REMOVED") {
          await customer.campaigns.remove([resourceName]);
        } else {
          await customer.campaigns.update([{ resource_name: resourceName, status: args.status }]);
        }
        const output = {
          resource_name: resourceName,
          campaign_id: idFromResourceName(resourceName),
          status: args.status,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Campaign ${output.campaign_id} is now **${args.status}**.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_campaign_budget ------------------------------------------------
  const updateBudgetInput = z.object({
    campaign_id: z
      .string()
      .optional()
      .describe("Numeric campaign ID whose budget to update. Provide this OR budget_resource_name."),
    budget_resource_name: z
      .string()
      .optional()
      .describe("Full campaign budget resource name to update directly. Provide this OR campaign_id."),
    daily_budget: z
      .number()
      .positive()
      .describe("New average daily budget in account currency (e.g. 340 = 340.00/day)."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const updateBudgetOutput = z.object({
    resource_name: z.string(),
    budget_id: z.string(),
    previous_daily_budget: z.number(),
    daily_budget: z.number(),
    explicitly_shared: z.boolean(),
    reference_count: z.number(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_update_campaign_budget",
    {
      title: "Update Campaign Budget",
      description: `Change the daily amount of an existing campaign budget — the tool to use when scaling a campaign's spend up or down.

Identify the budget either by the campaign that uses it (campaign_id; the budget is resolved automatically) or by a budget_resource_name directly. The amount is set on the budget itself, so if the budget is shared across multiple campaigns the change affects all of them (the response flags this).

Args:
  - campaign_id (string, optional) | budget_resource_name (string, optional): exactly one required
  - daily_budget (number): new average daily amount in account currency (e.g. 340 = 340.00/day)
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "budget_id": string, "previous_daily_budget": number, "daily_budget": number, "explicitly_shared": boolean, "reference_count": number, "customer_id": string }

Tip: scale Smart Bidding budgets gradually (about 20-30% per step) so the bidding algorithm re-stabilizes between changes.`,
      inputSchema: updateBudgetInput.shape,
      outputSchema: updateBudgetOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const hasId = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasRn =
          typeof args.budget_resource_name === "string" && args.budget_resource_name.length > 0;
        if (hasId === hasRn) {
          return fail("Provide exactly one of 'campaign_id' or 'budget_resource_name'.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        let budgetResourceName: string;
        let previousMicros = 0;
        let explicitlyShared = false;
        let referenceCount = 0;

        if (hasId) {
          const cleanId = (args.campaign_id as string).replace(/\D/g, "");
          if (!cleanId) {
            return fail(`Invalid campaign_id "${args.campaign_id}". Expected a numeric campaign ID.`);
          }
          const rows = await customer.query(
            `SELECT campaign_budget.resource_name, campaign_budget.amount_micros, ` +
              `campaign_budget.explicitly_shared, campaign_budget.reference_count ` +
              `FROM campaign WHERE campaign.id = ${cleanId} LIMIT 1`,
          );
          const budget = rows[0]?.campaign_budget;
          if (!budget?.resource_name) {
            return fail(
              `No campaign (or attached budget) found for campaign_id ${cleanId} in account ${customerId}.`,
            );
          }
          budgetResourceName = budget.resource_name;
          previousMicros = Number(budget.amount_micros ?? 0);
          explicitlyShared = Boolean(budget.explicitly_shared);
          referenceCount = Number(budget.reference_count ?? 0);
        } else {
          budgetResourceName = args.budget_resource_name as string;
          const rows = await customer.query(
            `SELECT campaign_budget.amount_micros, campaign_budget.explicitly_shared, ` +
              `campaign_budget.reference_count FROM campaign_budget ` +
              `WHERE campaign_budget.resource_name = '${gaqlString(budgetResourceName)}' LIMIT 1`,
          );
          const budget = rows[0]?.campaign_budget;
          previousMicros = Number(budget?.amount_micros ?? 0);
          explicitlyShared = Boolean(budget?.explicitly_shared);
          referenceCount = Number(budget?.reference_count ?? 0);
        }

        await customer.campaignBudgets.update([
          { resource_name: budgetResourceName, amount_micros: toMicros(args.daily_budget) },
        ]);

        const output = {
          resource_name: budgetResourceName,
          budget_id: idFromResourceName(budgetResourceName),
          previous_daily_budget: fromMicros(previousMicros),
          daily_budget: args.daily_budget,
          explicitly_shared: explicitlyShared,
          reference_count: referenceCount,
          customer_id: customerId,
        };

        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const sharedNote =
          referenceCount > 1 || explicitlyShared
            ? `\n- ⚠️ Shared budget used by ${referenceCount} campaign(s) — this change affects all of them.`
            : "";
        const text =
          `✅ Budget ${output.budget_id} updated: ${output.previous_daily_budget} → **${args.daily_budget}**/day.` +
          sharedNote +
          `\n- Resource: \`${budgetResourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_campaign_bidding -----------------------------------------------
  const updateBiddingInput = z.object({
    campaign_id: z
      .string()
      .optional()
      .describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    target_roas: z
      .number()
      .positive()
      .optional()
      .describe(
        "New target ROAS as a ratio (e.g. 7 = 700%). Only for campaigns using MAXIMIZE_CONVERSION_VALUE. Provide this OR target_cpa.",
      ),
    target_cpa: z
      .number()
      .positive()
      .optional()
      .describe(
        "New target CPA in account currency (e.g. 50 = 50.00). Only for campaigns using MAXIMIZE_CONVERSIONS. Provide this OR target_roas.",
      ),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const updateBiddingOutput = z.object({
    resource_name: z.string(),
    campaign_id: z.string(),
    field: z.string(),
    previous_value: z.number(),
    new_value: z.number(),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_update_campaign_bidding",
    {
      title: "Update Campaign Bidding Target",
      description: `Update the optimization target of an existing campaign's Smart Bidding strategy: the target ROAS (for MAXIMIZE_CONVERSION_VALUE) or the target CPA (for MAXIMIZE_CONVERSIONS).

This sets a target on the campaign's existing standard bidding strategy; it does not switch strategy types. If the target you pass does not match the campaign's current strategy, the Google Ads API rejects the change. Raising a target ROAS protects efficiency when scaling budget; lowering it favors volume.

Args:
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - target_roas (number, optional): new tROAS as a ratio (7 = 700%); for MAXIMIZE_CONVERSION_VALUE
  - target_cpa (number, optional): new target CPA in account currency; for MAXIMIZE_CONVERSIONS
  - exactly one of target_roas / target_cpa is required
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "campaign_id": string, "field": string, "previous_value": number, "new_value": number, "customer_id": string }`,
      inputSchema: updateBiddingInput.shape,
      outputSchema: updateBiddingOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const hasId = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasRn =
          typeof args.campaign_resource_name === "string" && args.campaign_resource_name.length > 0;
        if (hasId === hasRn) {
          return fail("Provide exactly one of 'campaign_id' or 'campaign_resource_name'.");
        }
        const hasRoas = typeof args.target_roas === "number";
        const hasCpa = typeof args.target_cpa === "number";
        if (hasRoas === hasCpa) {
          return fail("Provide exactly one of 'target_roas' or 'target_cpa'.");
        }

        let cleanCampaignId = "";
        if (hasId) {
          cleanCampaignId = (args.campaign_id as string).replace(/\D/g, "");
          if (!cleanCampaignId) {
            return fail(`Invalid campaign_id "${args.campaign_id}". Expected a numeric campaign ID.`);
          }
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const resourceName = hasRn
          ? (args.campaign_resource_name as string)
          : campaignResourceName(customerId, cleanCampaignId);

        // Read the current target so we can report the before/after change.
        const rows = await customer.query(
          `SELECT campaign.maximize_conversion_value.target_roas, ` +
            `campaign.maximize_conversions.target_cpa_micros ` +
            `FROM campaign WHERE campaign.resource_name = '${gaqlString(resourceName)}' LIMIT 1`,
        );
        const current = rows[0]?.campaign;

        const update: resources.ICampaign = { resource_name: resourceName };
        let field: string;
        let previousValue: number;
        let newValue: number;
        if (hasRoas) {
          update.maximize_conversion_value = { target_roas: args.target_roas as number };
          field = "target_roas";
          previousValue = Number(current?.maximize_conversion_value?.target_roas ?? 0);
          newValue = args.target_roas as number;
        } else {
          update.maximize_conversions = { target_cpa_micros: toMicros(args.target_cpa as number) };
          field = "target_cpa";
          previousValue = fromMicros(current?.maximize_conversions?.target_cpa_micros);
          newValue = args.target_cpa as number;
        }

        await customer.campaigns.update([update]);

        const output = {
          resource_name: resourceName,
          campaign_id: idFromResourceName(resourceName),
          field,
          previous_value: previousValue,
          new_value: newValue,
          customer_id: customerId,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const pretty =
          field === "target_roas"
            ? `${(previousValue * 100).toFixed(0)}% → **${(newValue * 100).toFixed(0)}%**`
            : `${previousValue} → **${newValue}**`;
        const text =
          `✅ Campaign ${output.campaign_id} ${field} updated: ${pretty}.\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- update_campaign_network_settings --------------------------------------
  const updateNetworkInput = z.object({
    campaign_id: z
      .string()
      .optional()
      .describe("Numeric campaign ID. Provide this OR campaign_resource_name."),
    campaign_resource_name: z
      .string()
      .optional()
      .describe("Full campaign resource name. Provide this OR campaign_id."),
    target_google_search: z
      .boolean()
      .optional()
      .describe("Serve on Google search results. Omit to leave unchanged."),
    target_search_network: z
      .boolean()
      .optional()
      .describe("Serve on Google Search Partner sites. Omit to leave unchanged."),
    target_content_network: z
      .boolean()
      .optional()
      .describe("Serve on the Display Network. Omit to leave unchanged."),
    target_partner_search_network: z
      .boolean()
      .optional()
      .describe("Serve on the Google Partner search network. Omit to leave unchanged."),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  const updateNetworkOutput = z.object({
    resource_name: z.string(),
    campaign_id: z.string(),
    previous: z.object({
      target_google_search: z.boolean(),
      target_search_network: z.boolean(),
      target_content_network: z.boolean(),
      target_partner_search_network: z.boolean(),
    }),
    updated: z.object({
      target_google_search: z.boolean(),
      target_search_network: z.boolean(),
      target_content_network: z.boolean(),
      target_partner_search_network: z.boolean(),
    }),
    changed_fields: z.array(z.string()),
    customer_id: z.string(),
  });

  server.registerTool(
    "google_ads_update_campaign_network_settings",
    {
      title: "Update Campaign Network Settings",
      description: `Toggle which networks an existing campaign serves on: Google Search, Search Partners, the Display Network, and the Google Partner search network.

Only the fields you pass are changed; omitted fields keep their current values. Common use: turn OFF Search Partners (target_search_network=false) on a Search/DSA campaign to cut low-quality partner-site traffic.

Args:
  - campaign_id (string, optional) | campaign_resource_name (string, optional): exactly one required
  - target_google_search (boolean, optional)
  - target_search_network (boolean, optional): Search Partners
  - target_content_network (boolean, optional): Display Network
  - target_partner_search_network (boolean, optional)
  - at least one of the four network flags is required
  - customer_id (string, optional): defaults to GOOGLE_ADS_CUSTOMER_ID
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  { "resource_name": string, "campaign_id": string, "previous": {...}, "updated": {...}, "changed_fields": string[], "customer_id": string }`,
      inputSchema: updateNetworkInput.shape,
      outputSchema: updateNetworkOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const hasId = typeof args.campaign_id === "string" && args.campaign_id.length > 0;
        const hasRn =
          typeof args.campaign_resource_name === "string" && args.campaign_resource_name.length > 0;
        if (hasId === hasRn) {
          return fail("Provide exactly one of 'campaign_id' or 'campaign_resource_name'.");
        }

        const flagKeys = [
          "target_google_search",
          "target_search_network",
          "target_content_network",
          "target_partner_search_network",
        ] as const;
        const providedFlags = flagKeys.filter((k) => typeof args[k] === "boolean");
        if (providedFlags.length === 0) {
          return fail(
            "Provide at least one network flag to change (target_google_search, target_search_network, target_content_network, or target_partner_search_network).",
          );
        }

        let cleanCampaignId = "";
        if (hasId) {
          cleanCampaignId = (args.campaign_id as string).replace(/\D/g, "");
          if (!cleanCampaignId) {
            return fail(`Invalid campaign_id "${args.campaign_id}". Expected a numeric campaign ID.`);
          }
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const resourceName = hasRn
          ? (args.campaign_resource_name as string)
          : campaignResourceName(customerId, cleanCampaignId);

        // Read the current network settings so we can report and preserve unchanged flags.
        const rows = await customer.query(
          `SELECT campaign.network_settings.target_google_search, ` +
            `campaign.network_settings.target_search_network, ` +
            `campaign.network_settings.target_content_network, ` +
            `campaign.network_settings.target_partner_search_network ` +
            `FROM campaign WHERE campaign.resource_name = '${gaqlString(resourceName)}' LIMIT 1`,
        );
        const current = rows[0]?.campaign?.network_settings;
        if (!current) {
          return fail(`Campaign ${idFromResourceName(resourceName)} not found, or it has no network settings.`);
        }

        const previous = {
          target_google_search: Boolean(current.target_google_search),
          target_search_network: Boolean(current.target_search_network),
          target_content_network: Boolean(current.target_content_network),
          target_partner_search_network: Boolean(current.target_partner_search_network),
        };

        // Apply requested flags over the current values; send the full object so the
        // generated field mask covers every network flag.
        const updated = { ...previous };
        const changedFields: string[] = [];
        for (const k of providedFlags) {
          const next = args[k] as boolean;
          if (updated[k] !== next) changedFields.push(k);
          updated[k] = next;
        }

        if (changedFields.length === 0) {
          const noop = {
            resource_name: resourceName,
            campaign_id: idFromResourceName(resourceName),
            previous,
            updated,
            changed_fields: changedFields,
            customer_id: customerId,
          };
          if (args.response_format === ResponseFormat.JSON) {
            return ok(toJson(noop), noop);
          }
          return ok(
            `ℹ️ Campaign ${noop.campaign_id} network settings already match the requested values — no change made.`,
            noop,
          );
        }

        const update: resources.ICampaign = {
          resource_name: resourceName,
          network_settings: updated as resources.Campaign.INetworkSettings,
        };
        await customer.campaigns.update([update]);

        const output = {
          resource_name: resourceName,
          campaign_id: idFromResourceName(resourceName),
          previous,
          updated,
          changed_fields: changedFields,
          customer_id: customerId,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = changedFields.map(
          (k) => `- ${k}: ${previous[k as keyof typeof previous]} → **${updated[k as keyof typeof updated]}**`,
        );
        const text =
          `✅ Campaign ${output.campaign_id} network settings updated:\n${lines.join("\n")}\n- Resource: \`${resourceName}\``;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
