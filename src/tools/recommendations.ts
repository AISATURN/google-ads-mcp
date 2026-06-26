/**
 * Google Ads Recommendations: list the optimization recommendations Google
 * surfaces for the account, and apply one by resource name.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCustomer, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

export function registerRecommendationTools(server: McpServer): void {
  // ---- list_recommendations --------------------------------------------------
  const listInput = z.object({
    type_filter: z.string().optional().describe("Optional recommendation.type to filter (e.g. 'KEYWORD', 'CAMPAIGN_BUDGET', 'RESPONSIVE_SEARCH_AD')."),
    limit: z.number().int().min(1).max(500).default(100),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_list_recommendations",
    {
      title: "List Optimization Recommendations",
      description: `List the optimization recommendations Google surfaces for the account (budget, keywords, ads, bidding, etc.) with their resource names for applying.

Args:
  - type_filter (string, optional): recommendation.type
  - limit (number, default 100)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: listInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const where = args.type_filter ? `WHERE recommendation.type = '${args.type_filter.replace(/'/g, "")}' ` : "";
        const rows = await customer.query(
          `SELECT recommendation.resource_name, recommendation.type, recommendation.campaign ` +
            `FROM recommendation ${where}LIMIT ${args.limit}`,
        );
        const recs = rows.map((r) => ({
          resource_name: r.recommendation?.resource_name ?? "",
          type: String(r.recommendation?.type ?? ""),
          campaign: r.recommendation?.campaign ?? "",
        }));
        const output = { customer_id: customerId, count: recs.length, recommendations: recs };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        if (recs.length === 0) return ok(`No recommendations available for account ${customerId}.`, output);
        const lines = [`# Recommendations (${recs.length})`, ``, ...recs.map((r) => `- **${r.type}** — \`${r.resource_name}\``)];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- apply_recommendation --------------------------------------------------
  const applyInput = z.object({
    recommendation_resource_names: z.array(z.string().min(1)).min(1).max(100).describe("Recommendation resource names to apply (from list_recommendations)."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_apply_recommendation",
    {
      title: "Apply Optimization Recommendation",
      description: `Apply one or more recommendations by resource name. Applying changes the account immediately (e.g. raises a budget, adds keywords/ads).

Args:
  - recommendation_resource_names (string[])
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: applyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const svc = (customer as unknown as {
          recommendations: { apply: (ops: unknown) => Promise<unknown> };
        }).recommendations;
        await svc.apply(args.recommendation_resource_names.map((rn) => ({ resource_name: rn })));
        const output = { applied: args.recommendation_resource_names.length, customer_id: customerId };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Applied ${output.applied} recommendation(s).`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
