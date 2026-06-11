# google-ads-mcp-server

An [MCP](https://modelcontextprotocol.io) server for **creating and managing Google Ads campaigns** via the Google Ads API. It gives an LLM agent the tools to discover accounts, build a complete Search campaign end-to-end (budget → campaign → ad group → keywords → ad), manage campaign status, and pull performance data.

Built with TypeScript, the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), and the [`google-ads-api`](https://github.com/Opteo/google-ads-api) library (Google Ads API **v23**). Runs locally over **stdio**.

---

## Tools

| Tool | What it does | Mutates? |
| --- | --- | --- |
| `google_ads_list_accessible_customers` | List account IDs the credentials can access | read |
| `google_ads_list_campaigns` | List campaigns (status, channel, budget) | read |
| `google_ads_run_gaql` | Run any GAQL query (flexible read escape hatch) | read |
| `google_ads_get_campaign_performance` | Per-campaign metrics over a date range | read |
| `google_ads_create_campaign_budget` | Create a (reusable) budget | create |
| `google_ads_create_campaign` | Create a campaign (+ inline budget, bidding strategy) | create |
| `google_ads_update_campaign_status` | Enable / pause / remove a campaign | update |
| `google_ads_create_ad_group` | Create an ad group inside a campaign | create |
| `google_ads_add_keywords` | Add keywords to an ad group | create |
| `google_ads_create_responsive_search_ad` | Create a responsive search ad (RSA) | create |

**Safety defaults:** campaigns and ads are created **PAUSED** so nothing spends until you explicitly enable them with `google_ads_update_campaign_status`.

---

## Prerequisites

1. **A Google Ads account** and a **Manager (MCC) account** (the developer token lives under the MCC).
2. **A Google Cloud project** with the **Google Ads API enabled**.
3. **Node.js 18+** (tested on Node 25).

You will need five values, supplied as environment variables:

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ✅ | Google Ads MCC → Tools & Settings → **API Center** |
| `GOOGLE_ADS_CLIENT_ID` | ✅ | Google Cloud Console → APIs & Services → **Credentials** (OAuth client) |
| `GOOGLE_ADS_CLIENT_SECRET` | ✅ | same OAuth client |
| `GOOGLE_ADS_REFRESH_TOKEN` | ✅ | OAuth2 consent flow (see below), scope `https://www.googleapis.com/auth/adwords` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | optional | Your MCC account ID (digits only). Set when operating on a sub-account. |
| `GOOGLE_ADS_CUSTOMER_ID` | optional | Default advertising account ID, so tools don't need it each call. |

### Getting the credentials

**Developer token** — In your Google Ads **manager** account: *Tools & Settings → Setup → API Center*. New tokens start in **test** mode (work only against test accounts); apply for **Basic** access to use them on production accounts.

**OAuth client** — In Google Cloud Console: *APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app*. Copy the **client ID** and **client secret**.

**Refresh token** — The fastest path is the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
1. Click the gear (⚙️) → check **"Use your own OAuth credentials"** → paste your client ID/secret.
2. In *Step 1*, enter the scope `https://www.googleapis.com/auth/adwords` and authorize.
3. In *Step 2*, click **Exchange authorization code for tokens** → copy the **refresh token**.

> Make sure the OAuth client used in the Playground is the **same** client ID/secret you put in the env vars, or you'll get `invalid_grant`.

---

## Install & build

```bash
cd /Users/harunketenci/Desktop/projects/MCP/google-ads
npm install
npm run build
```

Quick check (no credentials needed):

```bash
node dist/index.js --help
```

---

## Configure your MCP client

### Claude Code (CLI)

```bash
claude mcp add google-ads \
  --env GOOGLE_ADS_DEVELOPER_TOKEN=your_token \
  --env GOOGLE_ADS_CLIENT_ID=your_client_id \
  --env GOOGLE_ADS_CLIENT_SECRET=your_client_secret \
  --env GOOGLE_ADS_REFRESH_TOKEN=your_refresh_token \
  --env GOOGLE_ADS_LOGIN_CUSTOMER_ID=1234567890 \
  --env GOOGLE_ADS_CUSTOMER_ID=2345678901 \
  -- node /Users/harunketenci/Desktop/projects/MCP/google-ads/dist/index.js
```

### Claude Desktop / generic MCP config

Add to your client's MCP server config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "node",
      "args": ["/Users/harunketenci/Desktop/projects/MCP/google-ads/dist/index.js"],
      "env": {
        "GOOGLE_ADS_DEVELOPER_TOKEN": "your_token",
        "GOOGLE_ADS_CLIENT_ID": "your_client_id",
        "GOOGLE_ADS_CLIENT_SECRET": "your_client_secret",
        "GOOGLE_ADS_REFRESH_TOKEN": "your_refresh_token",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "1234567890",
        "GOOGLE_ADS_CUSTOMER_ID": "2345678901"
      }
    }
  }
}
```

---

## Typical workflow (launch a Search campaign)

A natural-language request like *"Create a paused search campaign 'Summer Sale' with a 50/day budget, an ad group for running shoes, a few keywords, and an ad"* maps to:

1. `google_ads_create_campaign` — `name: "Summer Sale"`, `channel_type: "SEARCH"`, `daily_budget: 50` (budget created inline, status `PAUSED`).
2. `google_ads_create_ad_group` — `campaign_id` from step 1, `name: "Running Shoes"`.
3. `google_ads_add_keywords` — `ad_group_id` from step 2, `keywords: [{text:"running shoes"}, {text:"buy running shoes", match_type:"PHRASE"}]`.
4. `google_ads_create_responsive_search_ad` — `ad_group_id`, `final_url`, 3+ headlines, 2+ descriptions.
5. `google_ads_update_campaign_status` — `status: "ENABLED"` once you're ready to go live.

Don't know the account ID? Start with `google_ads_list_accessible_customers`.

---

## Notes & limitations

- **Currency & micros:** budgets/bids are entered in your account's currency units (e.g. `50` = 50.00/day). The server converts to "micros" internally.
- **Channel coverage:** `SEARCH` and `DISPLAY` are supported end-to-end. `SHOPPING`, `VIDEO`, and `PERFORMANCE_MAX` campaigns can be *created*, but require extra setup (asset groups, listing groups, linked Merchant Center / YouTube assets) not covered by this server.
- **Bidding strategies:** `MANUAL_CPC`, `MAXIMIZE_CLICKS` (default — no conversion tracking required), `MAXIMIZE_CONVERSIONS`, `MAXIMIZE_CONVERSION_VALUE` (optional `target_roas`).
- **Atomicity:** when `create_campaign` makes a budget inline and the campaign step then fails, the budget may remain. Reuse it or remove it manually.
- **GAQL is read-only**, so `google_ads_run_gaql` can never modify the account. Field reference: <https://developers.google.com/google-ads/api/fields/v23/overview>.

---

## Development

```bash
npm run dev     # tsx watch mode
npm run build   # compile to dist/
npm start       # run the compiled server
```

### Manual testing with MCP Inspector

```bash
GOOGLE_ADS_DEVELOPER_TOKEN=... GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... \
GOOGLE_ADS_REFRESH_TOKEN=... GOOGLE_ADS_CUSTOMER_ID=... \
npx @modelcontextprotocol/inspector node dist/index.js
```

Then call `google_ads_list_accessible_customers` first to confirm authentication, then explore the other tools.

## Project structure

```
src/
├── index.ts            # entry point: env validation, tool registration, stdio transport
├── client.ts           # auth, client/Customer factories, micros + error formatting
├── constants.ts        # server metadata and string-enum option lists
├── format.ts           # response-format enum, result builders, char-limit guard
└── tools/
    ├── queries.ts      # list_accessible_customers, list_campaigns, run_gaql, get_campaign_performance
    ├── campaigns.ts    # create_campaign_budget, create_campaign, update_campaign_status
    └── adGroups.ts     # create_ad_group, add_keywords, create_responsive_search_ad
```

## License

MIT
