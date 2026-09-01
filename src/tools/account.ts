/**
 * Account-management tools: create a new client (sub-)account under a Google
 * Ads manager (MCC) account. Complements google_ads_list_accessible_customers,
 * which only discovers accounts that already exist.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { services } from "google-ads-api";
import { z } from "zod";
import { getClient, getCredentials, normalizeCustomerId, formatGoogleAdsError } from "../client.js";
import { assertUnrestricted } from "../scope.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

function idFromResourceName(rn: string | null | undefined): string {
  return rn?.split("/").pop() ?? "";
}

export function registerAccountTools(server: McpServer): void {
  const createInput = z.object({
    descriptive_name: z.string().min(1).max(255).describe("Name for the new account, e.g. 'Vinci Leather - US'."),
    currency_code: z.string().length(3).describe("ISO currency code for the new account, e.g. 'USD', 'TRY'."),
    time_zone: z.string().min(1).describe("IANA time zone for the new account, e.g. 'Europe/Istanbul', 'America/New_York'."),
    manager_customer_id: z
      .string()
      .optional()
      .describe("Manager (MCC) account ID to create the client under. Defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID."),
    email_address: z.string().email().optional().describe("Optional: invite this email as a user on the new account."),
    access_role: z
      .enum(["ADMIN", "STANDARD", "READ_ONLY", "EMAIL_ONLY"])
      .default("ADMIN")
      .describe("Access role granted to email_address (only meaningful if email_address is set)."),
    validate_only: z.boolean().default(false).describe("If true, validates the request without creating the account."),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_create_customer_client",
    {
      title: "Create Customer Account (Sub-Account)",
      description: `Create a new client (sub-)account under a Google Ads manager (MCC) account — the API equivalent of "+ New account" in the Google Ads UI under a manager.

Note: the authenticated user needs access to the manager account, and the manager's developer-token access level may cap daily account creation (Basic access is limited; test accounts have no cap but only work under test MCCs). This creates the account shell only — campaigns, billing, and conversion tracking still need to be set up afterward with the other tools.

Args:
  - descriptive_name (string): account name
  - currency_code (string): ISO currency code, e.g. 'USD', 'TRY'
  - time_zone (string): IANA time zone, e.g. 'Europe/Istanbul'
  - manager_customer_id (string, optional): MCC account ID to create under; defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID
  - email_address (string, optional): invite this email as a user on the new account
  - access_role ('ADMIN' default | 'STANDARD' | 'READ_ONLY' | 'EMAIL_ONLY')
  - validate_only (boolean, default false): validate without creating
  - response_format ('markdown' | 'json')

Returns (json): { "resource_name": string, "customer_id": string, "descriptive_name": string, "manager_customer_id": string, "invitation_link": string | null, "validate_only": boolean }`,
      inputSchema: createInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        // Creating an account under the manager isn't scoped to one advertising
        // account, so there is no allowlist to check it against — owner only.
        assertUnrestricted("creating a Google Ads sub-account");
        const creds = getCredentials();
        const managerId = args.manager_customer_id
          ? normalizeCustomerId(args.manager_customer_id)
          : creds.login_customer_id;
        if (!managerId) {
          return fail(
            "No manager_customer_id provided and GOOGLE_ADS_LOGIN_CUSTOMER_ID is not set. " +
              "Pass manager_customer_id explicitly (the MCC account ID under which to create the new account).",
          );
        }

        const client = getClient();
        const manager = client.Customer({
          customer_id: managerId,
          refresh_token: creds.refresh_token,
          login_customer_id: managerId,
        });

        const request: services.ICreateCustomerClientRequest = {
          customer_id: managerId,
          customer_client: {
            descriptive_name: args.descriptive_name,
            currency_code: args.currency_code,
            time_zone: args.time_zone,
          },
          email_address: args.email_address,
          access_role: args.access_role,
          validate_only: args.validate_only,
        };
        // The wrapper library's type declares its concrete request class here, but the
        // underlying gRPC client (and this call) accepts the plain-object request shape.
        const resp = await manager.customers.createCustomerClient(
          request as unknown as services.CreateCustomerClientRequest,
        );

        const resourceName = resp.resource_name ?? "";
        if (!resourceName && !args.validate_only) {
          return fail("Customer creation returned no resource name.");
        }

        const output = {
          resource_name: resourceName,
          customer_id: idFromResourceName(resourceName),
          descriptive_name: args.descriptive_name,
          manager_customer_id: managerId,
          invitation_link: resp.invitation_link ?? null,
          validate_only: args.validate_only,
        };

        const text =
          args.response_format === ResponseFormat.JSON
            ? toJson(output)
            : args.validate_only
              ? `✅ Validated: a new account **${args.descriptive_name}** could be created under manager ${managerId} (nothing was actually created).`
              : `✅ Created customer account **${args.descriptive_name}** (${output.customer_id}) under manager ${managerId}.\n` +
                `- Resource: \`${resourceName}\`\n` +
                (output.invitation_link ? `- Invitation link for ${args.email_address}: ${output.invitation_link}\n` : "") +
                `- Next: set up a campaign budget/campaign, conversion tracking, and billing on this new account.`;

        return ok(text, output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
