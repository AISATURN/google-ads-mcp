/**
 * Read-only tools: account discovery, listing campaigns, running raw GAQL
 * queries, and campaign performance reporting. GAQL is inherently read-only
 * (SELECT-style), so these tools never mutate the account.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient, getCredentials, getCustomer, fromMicros, formatGoogleAdsError } from "../client.js";
import { getAllowedCustomerIds } from "../scope.js";
import { ResponseFormat, ok, fail, toJson, clampRowsToLimit } from "../format.js";
import { DATE_RANGES, CHARACTER_LIMIT } from "../constants.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Escapes single quotes for safe embedding inside GAQL string literals. */
function gaqlString(value: string): string {
  return value.replace(/'/g, "\\'");
}

// Output schemas (stable shapes) — give MCP clients typed, structured results.
const listAccessibleOutput = z.object({
  count: z.number(),
  customer_ids: z.array(z.string()),
  resource_names: z.array(z.string()),
});

const campaignSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  channel_type: z.string(),
  bidding_strategy_type: z.string(),
  daily_budget: z.number(),
  start_date: z.string(),
  end_date: z.string(),
  resource_name: z.string(),
});
const listCampaignsOutput = z.object({
  customer_id: z.string(),
  count: z.number(),
  campaigns: z.array(campaignSummarySchema),
});

const runGaqlOutput = z.object({
  customer_id: z.string(),
  row_count: z.number(),
  truncated: z.boolean(),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const performanceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),
  cost: z.number(),
  conversions: z.number(),
  conversions_value: z.number(),
});
const performanceOutput = z.object({
  customer_id: z.string(),
  date_range: z.string(),
  count: z.number(),
  campaigns: z.array(performanceRowSchema),
});

export function registerQueryTools(server: McpServer): void {
  // ---- list_accessible_customers ---------------------------------------------
  const listAccessibleInput = z.object({
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' (default) or 'json'"),
  });

  server.registerTool(
    "google_ads_list_accessible_customers",
    {
      title: "List Accessible Google Ads Customers",
      description: `List the Google Ads customer (account) IDs that the configured credentials can access.

This is the first tool to call when you don't yet know which account ID to operate on. It returns the resource names and the bare 10-digit customer IDs reachable by the authenticated user. Note: under a manager (MCC) account this returns directly-accessible accounts; sub-accounts may require setting GOOGLE_ADS_LOGIN_CUSTOMER_ID and querying customer_client.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (json):
  { "count": number, "customer_ids": string[], "resource_names": string[] }`,
      inputSchema: listAccessibleInput.shape,
      outputSchema: listAccessibleOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // An account-scoped caller gets their allowlist verbatim: the underlying
        // API call answers "what can the owner's token reach", which is both
        // wider than their access and, for accounts reached through the manager,
        // not even a superset of it.
        const allowed = getAllowedCustomerIds();
        let resourceNames: string[];
        let customerIds: string[];
        if (allowed) {
          customerIds = allowed;
          resourceNames = allowed.map((id) => `customers/${id}`);
        } else {
          const client = getClient();
          const { refresh_token } = getCredentials();
          const res = await client.listAccessibleCustomers(refresh_token);
          resourceNames = res.resource_names ?? [];
          customerIds = resourceNames.map((rn) => rn.split("/")[1] ?? rn);
        }
        const output = {
          count: customerIds.length,
          customer_ids: customerIds,
          resource_names: resourceNames,
        };
        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        const lines = [
          `# Accessible Google Ads Accounts`,
          ``,
          `Found ${customerIds.length} account(s):`,
          ``,
          ...customerIds.map((id) => `- ${id}`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- list_campaigns --------------------------------------------------------
  const listCampaignsInput = z.object({
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    status_filter: z
      .enum(["ALL", "ENABLED", "PAUSED", "REMOVED"])
      .default("ALL")
      .describe("Filter campaigns by status (default: ALL)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe("Maximum campaigns to return (default: 50, max: 1000)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' (default) or 'json'"),
  });

  server.registerTool(
    "google_ads_list_campaigns",
    {
      title: "List Google Ads Campaigns",
      description: `List campaigns in a Google Ads account, including status, channel type, bidding strategy, and daily budget.

Use this to inspect existing campaigns, find a campaign's resource name or ID for later operations, or verify a campaign was created.

Args:
  - customer_id (string, optional): Account ID; defaults to GOOGLE_ADS_CUSTOMER_ID
  - status_filter ('ALL' | 'ENABLED' | 'PAUSED' | 'REMOVED'): default 'ALL'
  - limit (number): 1-1000, default 50
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  {
    "customer_id": string,
    "count": number,
    "campaigns": [{
      "id": string, "name": string, "status": string,
      "channel_type": string, "bidding_strategy_type": string,
      "daily_budget": number, "start_date": string, "end_date": string,
      "resource_name": string
    }]
  }`,
      inputSchema: listCampaignsInput.shape,
      outputSchema: listCampaignsOutput.shape,
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
        const where = args.status_filter === "ALL" ? "" : `WHERE campaign.status = '${args.status_filter}' `;
        const gaql =
          `SELECT campaign.id, campaign.name, campaign.status, ` +
          `campaign.advertising_channel_type, campaign.bidding_strategy_type, ` +
          `campaign.start_date_time, campaign.end_date_time, campaign_budget.amount_micros, ` +
          `campaign.resource_name ` +
          `FROM campaign ${where}ORDER BY campaign.id LIMIT ${args.limit}`;
        const rows = await customer.query(gaql);

        const campaigns = rows.map((row) => ({
          id: String(row.campaign?.id ?? ""),
          name: row.campaign?.name ?? "",
          status: String(row.campaign?.status ?? ""),
          channel_type: String(row.campaign?.advertising_channel_type ?? ""),
          bidding_strategy_type: String(row.campaign?.bidding_strategy_type ?? ""),
          daily_budget: fromMicros(row.campaign_budget?.amount_micros),
          start_date: row.campaign?.start_date_time ?? "",
          end_date: row.campaign?.end_date_time ?? "",
          resource_name: row.campaign?.resource_name ?? "",
        }));

        const output = { customer_id: customerId, count: campaigns.length, campaigns };

        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        if (campaigns.length === 0) {
          return ok(`No campaigns found in account ${customerId}.`, output);
        }
        const lines = [`# Campaigns in account ${customerId} (${campaigns.length})`, ``];
        for (const c of campaigns) {
          lines.push(`## ${c.name} (${c.id})`);
          lines.push(`- **Status**: ${c.status}`);
          lines.push(`- **Channel**: ${c.channel_type}`);
          lines.push(`- **Bidding**: ${c.bidding_strategy_type}`);
          lines.push(`- **Daily budget**: ${c.daily_budget}`);
          if (c.start_date) lines.push(`- **Start**: ${c.start_date}`);
          if (c.end_date) lines.push(`- **End**: ${c.end_date}`);
          lines.push("");
        }
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- run_gaql --------------------------------------------------------------
  const runGaqlInput = z.object({
    query: z
      .string()
      .min(10, "Query is too short to be valid GAQL")
      .describe(
        "A full Google Ads Query Language (GAQL) SELECT statement, e.g. " +
          "\"SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = 'ENABLED'\". " +
          "GAQL is read-only.",
      ),
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(200)
      .describe("Maximum rows to return from the result set (default: 200, max: 10000)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.JSON)
      .describe("Output format: 'json' (default) or 'markdown'"),
  });

  server.registerTool(
    "google_ads_run_gaql",
    {
      title: "Run a GAQL Query",
      description: `Run an arbitrary Google Ads Query Language (GAQL) query against an account and return the rows.

This is the flexible escape hatch for any read that the dedicated tools don't cover (segments, ad groups, keywords, metrics, change history, etc.). GAQL only supports reads, so this tool cannot modify the account.

Args:
  - query (string): A full GAQL SELECT statement
  - customer_id (string, optional): Account ID; defaults to GOOGLE_ADS_CUSTOMER_ID
  - limit (number): max rows returned, 1-10000, default 200
  - response_format ('json' | 'markdown'): default 'json'

Returns (json):
  { "customer_id": string, "row_count": number, "rows": object[] }

Tips:
  - Resources & fields: https://developers.google.com/google-ads/api/fields/v23/overview
  - Add your own LIMIT clause for large tables; the 'limit' arg additionally caps returned rows.`,
      inputSchema: runGaqlInput.shape,
      outputSchema: runGaqlOutput.shape,
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
        const allRows = await customer.query(args.query);
        const limited = allRows.slice(0, args.limit);
        // Bound both the text and structured payload by serialized size (headroom for the wrapper).
        const { rows, dropped } = clampRowsToLimit(limited, CHARACTER_LIMIT - 1000);
        const truncated = allRows.length > rows.length;
        const output = {
          customer_id: customerId,
          row_count: rows.length,
          truncated,
          rows: rows as unknown[],
        };
        const notice = truncated
          ? `\n\n> Showing ${rows.length} of ${allRows.length} row(s)` +
            (dropped > 0 ? ` (${dropped} dropped to fit the size limit)` : "") +
            `. Add a tighter WHERE/LIMIT or select fewer fields to see more.`
          : "";
        if (args.response_format === ResponseFormat.MARKDOWN) {
          const header = `# GAQL result (${rows.length} row(s)) for account ${customerId}`;
          return ok(`${header}\n\n\`\`\`json\n${toJson(rows)}\n\`\`\`${notice}`, output);
        }
        return ok(toJson(output) + notice, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- get_campaign_performance ---------------------------------------------
  const performanceInput = z.object({
    customer_id: z
      .string()
      .optional()
      .describe("10-digit account ID (dashes optional). Defaults to GOOGLE_ADS_CUSTOMER_ID."),
    date_range: z
      .enum(DATE_RANGES)
      .default("LAST_30_DAYS")
      .describe("Predefined GAQL date range (default: LAST_30_DAYS). Ignored if start_date/end_date are set."),
    start_date: z
      .string()
      .regex(DATE_RE, "Use YYYY-MM-DD format")
      .optional()
      .describe("Custom range start (YYYY-MM-DD). Requires end_date."),
    end_date: z
      .string()
      .regex(DATE_RE, "Use YYYY-MM-DD format")
      .optional()
      .describe("Custom range end (YYYY-MM-DD). Requires start_date."),
    campaign_id: z
      .string()
      .optional()
      .describe("Restrict the report to a single campaign ID."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe("Maximum campaigns to include (default: 50)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' (default) or 'json'"),
  });

  server.registerTool(
    "google_ads_get_campaign_performance",
    {
      title: "Get Campaign Performance",
      description: `Report key performance metrics per campaign over a date range: impressions, clicks, CTR, cost, conversions, and conversion value.

Args:
  - customer_id (string, optional): Account ID; defaults to GOOGLE_ADS_CUSTOMER_ID
  - date_range (enum): one of TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH, THIS_WEEK_MON_TODAY, LAST_BUSINESS_WEEK (default LAST_30_DAYS)
  - start_date / end_date (YYYY-MM-DD, optional): custom range; overrides date_range when both set
  - campaign_id (string, optional): restrict to one campaign
  - limit (number): default 50
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json):
  {
    "customer_id": string, "date_range": string, "count": number,
    "campaigns": [{ "id": string, "name": string, "impressions": number,
      "clicks": number, "ctr": number, "cost": number,
      "conversions": number, "conversions_value": number }]
  }`,
      inputSchema: performanceInput.shape,
      outputSchema: performanceOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if ((args.start_date && !args.end_date) || (!args.start_date && args.end_date)) {
          return fail("Provide both start_date and end_date for a custom range, or neither.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        const dateClause =
          args.start_date && args.end_date
            ? `segments.date BETWEEN '${args.start_date}' AND '${args.end_date}'`
            : `segments.date DURING ${args.date_range}`;
        const rangeLabel =
          args.start_date && args.end_date ? `${args.start_date}..${args.end_date}` : args.date_range;
        const campaignClause = args.campaign_id
          ? ` AND campaign.id = ${Number(gaqlString(args.campaign_id).replace(/\D/g, "")) || 0}`
          : "";

        const gaql =
          `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, ` +
          `metrics.ctr, metrics.cost_micros, metrics.conversions, metrics.conversions_value ` +
          `FROM campaign WHERE ${dateClause}${campaignClause} ` +
          `ORDER BY metrics.cost_micros DESC LIMIT ${args.limit}`;
        const rows = await customer.query(gaql);

        const campaigns = rows.map((row) => ({
          id: String(row.campaign?.id ?? ""),
          name: row.campaign?.name ?? "",
          impressions: Number(row.metrics?.impressions ?? 0),
          clicks: Number(row.metrics?.clicks ?? 0),
          ctr: Number(row.metrics?.ctr ?? 0),
          cost: fromMicros(row.metrics?.cost_micros),
          conversions: Number(row.metrics?.conversions ?? 0),
          conversions_value: Number(row.metrics?.conversions_value ?? 0),
        }));

        const output = {
          customer_id: customerId,
          date_range: rangeLabel,
          count: campaigns.length,
          campaigns,
        };

        if (args.response_format === ResponseFormat.JSON) {
          return ok(toJson(output), output);
        }
        if (campaigns.length === 0) {
          return ok(`No performance data for account ${customerId} over ${rangeLabel}.`, output);
        }
        const lines = [
          `# Campaign performance — account ${customerId} (${rangeLabel})`,
          ``,
          `| Campaign | Impr. | Clicks | CTR | Cost | Conv. | Conv. value |`,
          `| --- | ---: | ---: | ---: | ---: | ---: | ---: |`,
        ];
        for (const c of campaigns) {
          lines.push(
            `| ${c.name} (${c.id}) | ${c.impressions} | ${c.clicks} | ` +
              `${(c.ctr * 100).toFixed(2)}% | ${c.cost.toFixed(2)} | ${c.conversions} | ${c.conversions_value.toFixed(2)} |`,
          );
        }
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
