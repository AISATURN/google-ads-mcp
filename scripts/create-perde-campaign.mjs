// One-off: create the "Up | Perde Beton Kalıbı" Search campaign (paused) with inline budget.
// Needed because the running MCP server predates the contains_eu_political_advertising fix.
import { readFileSync } from "node:fs";
import { GoogleAdsApi, ResourceNames } from "google-ads-api";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const api = new GoogleAdsApi({
  client_id: env.GOOGLE_ADS_CLIENT_ID,
  client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

const CUSTOMER_ID = "5660353352";
const customer = api.Customer({
  customer_id: CUSTOMER_ID,
  refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
  login_customer_id: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ""),
});

const tempBudget = ResourceNames.campaignBudget(CUSTOMER_ID, "-1");

const operations = [
  {
    entity: "campaign_budget",
    operation: "create",
    resource: {
      resource_name: tempBudget,
      name: `Up | Perde Beton Kalıbı — budget ${Date.now().toString(36)}`,
      amount_micros: 1000 * 1_000_000,
      delivery_method: "STANDARD",
      explicitly_shared: false,
    },
  },
  {
    entity: "campaign",
    operation: "create",
    resource: {
      name: "Up | Perde Beton Kalıbı",
      advertising_channel_type: "SEARCH",
      status: "PAUSED",
      contains_eu_political_advertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      campaign_budget: tempBudget,
      target_spend: {},
      network_settings: {
        target_google_search: true,
        target_search_network: false,
        target_content_network: false,
        target_partner_search_network: false,
      },
    },
  },
];

const response = await customer.mutateResources(operations);
const ops = response.mutate_operation_responses ?? [];
console.log(
  JSON.stringify(
    {
      budget: ops[0]?.campaign_budget_result?.resource_name,
      campaign: ops[1]?.campaign_result?.resource_name,
    },
    null,
    2,
  ),
);
