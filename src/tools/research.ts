/**
 * Keyword research and search-terms reporting. generate_keyword_ideas wraps the
 * KeywordPlanIdeaService to return real average monthly search volume and
 * competition — the data the campaign-building tools otherwise lack. The
 * search-terms report surfaces the actual queries that triggered ads, the raw
 * material for negative-keyword mining.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCustomer, fromMicros, formatGoogleAdsError } from "../client.js";
import { ResponseFormat, ok, fail, toJson } from "../format.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// MonthOfYear enum codes (0=UNSPECIFIED, 1=UNKNOWN, 2=JANUARY..13=DECEMBER).
const MONTH_NAMES_BY_CODE = [
  "", "", "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const MONTH_DISPLAY_NAMES: Record<string, string> = {
  "2": "Jan", "3": "Feb", "4": "Mar", "5": "Apr", "6": "May", "7": "Jun",
  "8": "Jul", "9": "Aug", "10": "Sep", "11": "Oct", "12": "Nov", "13": "Dec",
};

/**
 * MonthOfYear comes back either as its numeric enum code or as the string enum
 * name (e.g. "JANUARY") depending on nesting depth in the API client's response
 * serialization — normalize both to the numeric code for sorting/display.
 */
function monthEnumToNumber(month: unknown): number {
  if (typeof month === "string" && !/^\d+$/.test(month)) {
    return MONTH_NAMES_BY_CODE.indexOf(month.toUpperCase());
  }
  return Number(month ?? 0);
}

/** Parses a 'YYYY-MM' string into the {year, month} shape the API expects (month as an enum name). */
function toYearMonth(yearMonth: string): { year: number; month: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  return { year, month: MONTH_NAMES_BY_CODE[month + 1] };
}

export function registerResearchTools(server: McpServer): void {
  // ---- generate_keyword_ideas ------------------------------------------------
  const ideasInput = z.object({
    keywords: z.array(z.string().min(1)).max(20).optional().describe("Seed keywords (up to 20). Provide keywords and/or page_url."),
    page_url: z.string().url().optional().describe("A landing page URL to derive ideas from."),
    language_id: z.string().default("1000").describe("Language constant ID (default 1000 = English; Turkish = 1037)."),
    location_ids: z.array(z.string()).optional().describe("Geo target constant IDs to scope volume (e.g. US=2840, Turkey=2792)."),
    limit: z.number().int().min(1).max(200).default(50).describe("Max ideas to return (default 50)."),
    start_month: z
      .string()
      .regex(MONTH_RE, "Use YYYY-MM format")
      .optional()
      .describe("Historical range start, e.g. '2024-06'. Requires end_month. Defaults to the trailing 12 months if omitted."),
    end_month: z
      .string()
      .regex(MONTH_RE, "Use YYYY-MM format")
      .optional()
      .describe("Historical range end, e.g. '2025-05'. Requires start_month. Google Ads allows up to ~4 years back."),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_generate_keyword_ideas",
    {
      title: "Generate Keyword Ideas (Volume & Competition)",
      description: `Get keyword ideas with real average monthly search volume, a month-by-month volume breakdown, and competition from the Keyword Planner (KeywordPlanIdeaService).

Provide seed 'keywords' and/or a 'page_url'. Scope volume by language (default English=1000) and optional locations. By default Google returns the trailing 12 months of history; pass 'start_month'/'end_month' to scope the average and the monthly breakdown to a specific historical window instead (e.g. to compare last year's season vs. this year's).

Args:
  - keywords (string[], optional) and/or page_url (string, optional): at least one required
  - language_id (string, default '1000')
  - location_ids (string[], optional): geo target constant IDs
  - limit (number, default 50)
  - start_month / end_month (string, optional, 'YYYY-MM'): custom historical range; provide both or neither
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')

Returns (json): { "count": number, "date_range": string, "ideas": [{ "text": string, "avg_monthly_searches": number, "competition": string, "low_top_of_page_bid": number, "high_top_of_page_bid": number, "monthly_search_volumes": [{ "year": number, "month": string, "monthly_searches": number }] }], "customer_id": string }`,
      inputSchema: ideasInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.keywords?.length && !args.page_url) {
          return fail("Provide at least one of 'keywords' or 'page_url'.");
        }
        if ((args.start_month && !args.end_month) || (!args.start_month && args.end_month)) {
          return fail("Provide both start_month and end_month for a custom historical range, or neither.");
        }
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;

        const request: Record<string, unknown> = {
          customer_id: customerId,
          language: `languageConstants/${args.language_id.replace(/\D/g, "")}`,
          geo_target_constants: (args.location_ids ?? []).map((id) => `geoTargetConstants/${id.replace(/\D/g, "")}`),
          keyword_plan_network: "GOOGLE_SEARCH",
          page_size: args.limit,
        };
        if (args.start_month && args.end_month) {
          request.historical_metrics_options = {
            year_month_range: { start: toYearMonth(args.start_month), end: toYearMonth(args.end_month) },
          };
        }
        const hasKw = !!args.keywords?.length;
        const hasUrl = !!args.page_url;
        if (hasKw && hasUrl) request.keyword_and_url_seed = { url: args.page_url, keywords: args.keywords };
        else if (hasKw) request.keyword_seed = { keywords: args.keywords };
        else request.url_seed = { url: args.page_url };

        // The library exposes generateKeywordIdeas on the keywordPlanIdeas service.
        const service = (customer as unknown as {
          keywordPlanIdeas: { generateKeywordIdeas: (req: unknown) => Promise<unknown> };
        }).keywordPlanIdeas;
        const raw = await service.generateKeywordIdeas(request);
        const results = (Array.isArray(raw) ? raw : (raw as { results?: unknown[] })?.results ?? []) as Array<{
          text?: string;
          keyword_idea_metrics?: {
            avg_monthly_searches?: number | string;
            competition?: number | string;
            low_top_of_page_bid_micros?: number | string;
            high_top_of_page_bid_micros?: number | string;
            monthly_search_volumes?: Array<{ year?: number | string; month?: number | string; monthly_searches?: number | string }>;
          };
        }>;

        const COMPETITION: Record<string, string> = { "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "LOW", "3": "MEDIUM", "4": "HIGH" };
        const ideas = results.slice(0, args.limit).map((r) => {
          const m = r.keyword_idea_metrics ?? {};
          const comp = String(m.competition ?? "");
          const monthly_search_volumes = (m.monthly_search_volumes ?? [])
            .map((v) => ({
              year: Number(v.year ?? 0),
              month_num: monthEnumToNumber(v.month),
              monthly_searches: Number(v.monthly_searches ?? 0),
            }))
            .sort((a, b) => a.year - b.year || a.month_num - b.month_num)
            .map(({ year, month_num, monthly_searches }) => ({
              year,
              month: MONTH_DISPLAY_NAMES[String(month_num)] ?? String(month_num),
              monthly_searches,
            }));
          return {
            text: r.text ?? "",
            avg_monthly_searches: Number(m.avg_monthly_searches ?? 0),
            competition: COMPETITION[comp] ?? comp,
            low_top_of_page_bid: fromMicros(m.low_top_of_page_bid_micros),
            high_top_of_page_bid: fromMicros(m.high_top_of_page_bid_micros),
            monthly_search_volumes,
          };
        });
        ideas.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);

        const dateRange = args.start_month && args.end_month ? `${args.start_month} to ${args.end_month}` : "trailing 12 months (default)";
        const output = { count: ideas.length, date_range: dateRange, ideas, customer_id: customerId };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        const lines = [
          `# Keyword ideas (${ideas.length}) — ${dateRange}`,
          ``,
          `| Keyword | Avg monthly searches | Competition | Top-of-page bid (low–high) | Monthly (oldest→newest) |`,
          `| --- | ---: | --- | --- | --- |`,
          ...ideas.map((i) => {
            const monthly = i.monthly_search_volumes.map((v) => `${v.month} '${String(v.year).slice(2)}: ${v.monthly_searches}`).join(", ");
            return `| ${i.text} | ${i.avg_monthly_searches} | ${i.competition} | ${i.low_top_of_page_bid.toFixed(2)}–${i.high_top_of_page_bid.toFixed(2)} | ${monthly} |`;
          }),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );

  // ---- get_search_terms_report -----------------------------------------------
  const stReportInput = z.object({
    campaign_id: z.string().optional().describe("Restrict to one campaign ID."),
    ad_group_id: z.string().optional().describe("Restrict to one ad group ID."),
    date_range: z
      .enum(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"])
      .default("LAST_30_DAYS"),
    limit: z.number().int().min(1).max(1000).default(100),
    customer_id: z.string().optional(),
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  });

  server.registerTool(
    "google_ads_get_search_terms_report",
    {
      title: "Get Search Terms Report",
      description: `List the actual search queries that triggered a campaign's ads, with impressions, clicks, cost, and conversions — the raw material for finding negative keywords.

Args:
  - campaign_id (string, optional) | ad_group_id (string, optional): optional filters
  - date_range (enum, default LAST_30_DAYS)
  - limit (number, default 100)
  - customer_id (string, optional)
  - response_format ('markdown' | 'json')`,
      inputSchema: stReportInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const customer = getCustomer(args.customer_id);
        const customerId = customer.credentials.customer_id;
        const filters: string[] = [`segments.date DURING ${args.date_range}`];
        if (args.campaign_id) filters.push(`campaign.id = ${args.campaign_id.replace(/\D/g, "")}`);
        if (args.ad_group_id) filters.push(`ad_group.id = ${args.ad_group_id.replace(/\D/g, "")}`);
        const gaql =
          `SELECT search_term_view.search_term, campaign.name, ad_group.name, ` +
          `metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ` +
          `FROM search_term_view WHERE ${filters.join(" AND ")} ` +
          `ORDER BY metrics.impressions DESC LIMIT ${args.limit}`;
        const rows = await customer.query(gaql);
        const terms = rows.map((r) => ({
          search_term: r.search_term_view?.search_term ?? "",
          campaign: r.campaign?.name ?? "",
          ad_group: r.ad_group?.name ?? "",
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          cost: fromMicros(r.metrics?.cost_micros),
          conversions: Number(r.metrics?.conversions ?? 0),
        }));
        const output = { customer_id: customerId, date_range: args.date_range, count: terms.length, search_terms: terms };
        if (args.response_format === ResponseFormat.JSON) return ok(toJson(output), output);
        if (terms.length === 0) return ok(`No search terms found for the given filters.`, output);
        const lines = [
          `# Search terms (${terms.length}) — ${args.date_range}`,
          ``,
          `| Search term | Impr. | Clicks | Cost | Conv. |`,
          `| --- | ---: | ---: | ---: | ---: |`,
          ...terms.map((t) => `| ${t.search_term} | ${t.impressions} | ${t.clicks} | ${t.cost.toFixed(2)} | ${t.conversions} |`),
        ];
        return ok(lines.join("\n"), output);
      } catch (error) {
        return fail(formatGoogleAdsError(error));
      }
    },
  );
}
