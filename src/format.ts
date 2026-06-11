/**
 * Shared response-formatting helpers: a response-format enum, character-limit
 * enforcement, and small builders for success/error tool results so every tool
 * returns a consistent shape (human-readable text + structured content).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "./constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Truncates text that exceeds CHARACTER_LIMIT, appending a clear notice. */
export function enforceCharacterLimit(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const removed = text.length - CHARACTER_LIMIT;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[...truncated ${removed} characters. Narrow your request with a smaller 'limit', ` +
    `more selective filters, or a LIMIT clause in your GAQL query.]`
  );
}

/** Builds a successful tool result with both text content and structured content. */
export function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: enforceCharacterLimit(text) }],
    structuredContent,
  };
}

/** Builds an error tool result (isError flag set; no structured content required). */
export function fail(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/** Renders a value as pretty JSON, safely handling BigInt and circular structures. */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2,
  );
}

/**
 * Returns the largest prefix of `rows` whose JSON serialization stays within
 * `limitChars`, plus how many rows were dropped. Keeps both the text response and
 * the structured content bounded (so neither floods the client's context, and the
 * JSON stays valid rather than being hard-sliced mid-string).
 */
export function clampRowsToLimit<T>(
  rows: T[],
  limitChars: number = CHARACTER_LIMIT,
): { rows: T[]; dropped: number } {
  if (rows.length === 0 || toJson(rows).length <= limitChars) {
    return { rows, dropped: 0 };
  }
  // Binary search for the largest fitting prefix.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (toJson(rows.slice(0, mid)).length <= limitChars) lo = mid;
    else hi = mid - 1;
  }
  return { rows: rows.slice(0, lo), dropped: rows.length - lo };
}
