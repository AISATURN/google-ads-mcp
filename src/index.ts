#!/usr/bin/env node
/**
 * google-ads-mcp-server
 *
 * An MCP server for creating and managing Google Ads campaigns via the Google
 * Ads API. Exposes account discovery, GAQL reads, campaign/budget creation,
 * ad group / keyword / responsive-search-ad creation, status management, and
 * performance reporting.
 *
 * Transport: stdio (local). Logs go to stderr only — never stdout — so they do
 * not corrupt the JSON-RPC stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { getMissingEnvVars } from "./client.js";
import { buildMcpServer, TOOL_NAMES } from "./server.js";

function printHelp(): void {
  const help = `${SERVER_NAME} v${SERVER_VERSION}

An MCP server for creating and managing Google Ads campaigns.

USAGE
  google-ads-mcp-server            Start the server over stdio (for MCP clients)
  google-ads-mcp-server --help     Show this help
  google-ads-mcp-server --version  Print the version

REQUIRED ENVIRONMENT VARIABLES
  GOOGLE_ADS_DEVELOPER_TOKEN       Developer token from your Google Ads MCC API Center
  GOOGLE_ADS_CLIENT_ID             OAuth2 client ID (Google Cloud Console)
  GOOGLE_ADS_CLIENT_SECRET         OAuth2 client secret
  GOOGLE_ADS_REFRESH_TOKEN         OAuth2 refresh token (scope: adwords)

OPTIONAL ENVIRONMENT VARIABLES
  GOOGLE_ADS_LOGIN_CUSTOMER_ID     Manager (MCC) account ID — login-customer-id
  GOOGLE_ADS_CUSTOMER_ID           Default advertising account ID for tool calls

TOOLS (${TOOL_NAMES.length})
${TOOL_NAMES.map((t) => `  - ${t}`).join("\n")}

See README.md for setup, credentials, and MCP client configuration.`;
  process.stdout.write(help + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} v${SERVER_VERSION}\n`);
    return;
  }

  const missing = getMissingEnvVars();
  if (missing.length > 0) {
    console.error(
      `ERROR: missing required environment variable(s): ${missing.join(", ")}.\n` +
        `Set them before starting the server. Run with --help for details.`,
    );
    process.exit(1);
  }

  const server = buildMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (${TOOL_NAMES.length} tools)`);
}

main().catch((error) => {
  console.error("Fatal error starting server:", error);
  process.exit(1);
});
