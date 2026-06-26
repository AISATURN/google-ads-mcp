/**
 * Conversion-tracking tools: list existing conversion actions and create a new
 * one. Conversion actions are the prerequisite for value/conversion-based Smart
 * Bidding (MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE / tCPA / tROAS).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { resources } from "google-ads-api";
import { z } from "zod";
import { getCustomer, toMicros, fromMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerConversionTools(server: McpServer): void {
  // ---- list_conversion_actions -----------------------------------------------
  const listInput = z.object({
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_list_conversion_actions",
    {
      title: "List Conversion Actions",
      description: `List the account's conversion actions with their type, category, status, and counting settings. Use this to check whether conversion tracking exists before switching to conversion-based bidding.

Args:
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: listInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const rows = await customer.query(
          `SELECT conversion_action.id, conversion_action.name, conversion_action.type, ` +
            `conversion_action.category, conversion_action.status, conversion_action.primary_for_goal ` +
            `FROM conversion_action ORDER BY conversion_action.id`,
        );
        const actions = rows.map((r) => ({
          id: String(r.conversion_action?.id ?? ""),
          name: r.conversion_action?.name ?? "",
          type: String(r.conversion_action?.type ?? ""),
          category: String(r.conversion_action?.category ?? ""),
          status: String(r.conversion_action?.status ?? ""),
          primary_for_goal: Boolean(r.conversion_action?.primary_for_goal),
        }));
        const output = { customer_id: customerId, count: actions.length, conversion_actions: actions };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        if (actions.length === 0) return ok(`No conversion actions in account ${customerId}.`, output);
        const lines = [
          `# Conversion actions (${actions.length})`,
          ``,
          ...actions.map((a) => `- **${a.name}** (${a.id}) — type ${a.type}, category ${a.category}, status ${a.status}`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- create_conversion_action ----------------------------------------------
  const createInput = z.object({
    name: z.string().min(1).max(255).describe("Conversion action name."),
    category: z
      .enum(["DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART", "BEGIN_CHECKOUT", "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT", "REQUEST_QUOTE", "CONTACT", "PHONE_CALL_LEAD"])
      .default("SUBMIT_LEAD_FORM")
      .describe("Conversion category (default SUBMIT_LEAD_FORM). Use REQUEST_QUOTE / CONTACT / PHONE_CALL_LEAD / PURCHASE as fitting."),
    type: z
      .enum(["WEBPAGE", "UPLOAD_CLICKS", "WEBSITE_CALL"])
      .default("WEBPAGE")
      .describe("Conversion source type (default WEBPAGE for website tag)."),
    status: z.enum(["ENABLED", "REMOVED", "HIDDEN"]).default("ENABLED"),
    default_value: z.number().nonnegative().optional().describe("Optional default conversion value in account currency."),
    currency_code: z.string().length(3).optional().describe("Optional ISO currency code for the value (e.g. 'USD', 'TRY')."),
    counting_type: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).default("ONE_PER_CLICK").describe("Count one (leads) or many (sales) per click."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_conversion_action",
    {
      title: "Create Conversion Action",
      description: `Create a conversion action (e.g. a website lead/purchase) so the account can track conversions and use conversion-based Smart Bidding.

Note: for WEBPAGE conversions you still need the Google tag / Google Ads tag installed on the site, and (for click-based) to fire the event. This creates the action definition.

Args:
  - name (string)
  - category (enum, default LEAD)
  - type (enum, default WEBPAGE)
  - status (enum, default ENABLED)
  - default_value (number, optional) + currency_code (string, optional)
  - counting_type ('ONE_PER_CLICK' default | 'MANY_PER_CLICK')
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "resource_name": string, "conversion_action_id": string, "name": string, "customer_id": string }`,
      inputSchema: createInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const action: resources.IConversionAction = {
          name: args.name,
          category: args.category,
          type: args.type,
          status: args.status,
          counting_type: args.counting_type,
        };
        if (typeof args.default_value === "number") {
          action.value_settings = {
            default_value: args.default_value,
            default_currency_code: args.currency_code,
            always_use_default_value: false,
          };
        }
        const resp = await customer.conversionActions.create([action]);
        const resourceName = resp.results?.[0]?.resource_name ?? "";
        if (!resourceName) return fail("Conversion action creation returned no resource name.");
        const output = {
          resource_name: resourceName,
          conversion_action_id: idFromResourceName(resourceName),
          name: args.name,
          customer_id: customerId,
        };
        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : `✅ Created conversion action **${args.name}** (${output.conversion_action_id}, ${args.category}).\n` +
              `- Resource: \`${resourceName}\`\n` +
              `- Remember to install/verify the Google tag on the site so it can record conversions.`;
        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}

// Keep fromMicros referenced for potential value reporting extensions.
void fromMicros;
