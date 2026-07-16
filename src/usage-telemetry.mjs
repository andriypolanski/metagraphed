// Typed PostHog usage-event wrapper for the Worker backend (#6030 / #366).
//
// Single chokepoint for product-usage capture: callers pass an allowlisted
// UsageEvent; this module owns the PostHog event name/properties and the
// Workers-safe client lifecycle (flushAt:1, captureImmediate, shutdown).
// Nothing outside this file should construct a raw PostHog event.
//
// Safe no-op when POSTHOG_PROJECT_TOKEN is unset — self-hosters / local / CI
// see zero behavior change. Never throws. Not wired into request or MCP
// dispatch yet (#6031 / #6032 are the callers).

import { PostHog } from "posthog-node";

/** Env var holding the PostHog project API token (wrangler secret). */
export const POSTHOG_PROJECT_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN";

/** Optional PostHog host override (defaults to PostHog US cloud). */
export const POSTHOG_HOST_ENV = "POSTHOG_HOST";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Stable distinct_id for anonymous Worker-side product events. */
export const USAGE_EVENT_DISTINCT_ID = "metagraphed-worker";

/** PostHog event name owned by this wrapper — do not emit it elsewhere. */
export const USAGE_EVENT_NAME = "usage_event";

// Cap free-form string fields so a buggy caller can't ship unbounded payloads.
const MAX_LABEL_CHARS = 256;

/**
 * @typedef {object} UsageEvent
 * @property {string} [route] REST/GraphQL route path (no query string / bodies).
 * @property {string} [mcpTool] MCP tool name (no arguments / response content).
 * @property {boolean} ok Whether the request/tool call succeeded.
 * @property {number} durationMs Wall-clock duration in milliseconds (>= 0).
 */

/**
 * @typedef {object} RecordUsageEventDeps
 * @property {typeof PostHog} [PostHog] Injectable client class (tests).
 * @property {string} [distinctId] Override distinct_id (tests).
 */

/**
 * True when this deployment has a non-empty PostHog project token configured.
 * @param {object | null | undefined} env
 * @returns {boolean}
 */
export function isUsageTelemetryConfigured(env) {
  const token = env?.[POSTHOG_PROJECT_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * Build the allowlisted PostHog properties object, or null when the event is
 * too malformed to record (missing ok / non-finite duration).
 * @param {UsageEvent | null | undefined} event
 * @returns {Record<string, string | number | boolean> | null}
 */
export function usageEventProperties(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.ok !== "boolean") return null;
  if (
    typeof event.durationMs !== "number" ||
    !Number.isFinite(event.durationMs) ||
    event.durationMs < 0
  ) {
    return null;
  }

  /** @type {Record<string, string | number | boolean>} */
  const properties = {
    ok: event.ok,
    // Coarse integer ms — drop sub-ms noise; clamp absurd values at 24h.
    duration_ms: Math.min(Math.round(event.durationMs), 86_400_000),
  };

  const route = sanitizeLabel(event.route);
  if (route !== undefined) properties.route = route;

  const mcpTool = sanitizeLabel(event.mcpTool);
  if (mcpTool !== undefined) properties.mcp_tool = mcpTool;

  return properties;
}

/**
 * Record one product-usage event. Resolves without throwing; returns whether
 * an event was handed to PostHog. Callers that need Workers flush semantics
 * should schedule the returned promise via `ctx.waitUntil(...)`.
 *
 * @param {object | null | undefined} env Worker env (reads POSTHOG_* vars).
 * @param {UsageEvent} event Allowlisted usage fields only.
 * @param {RecordUsageEventDeps} [deps]
 * @returns {Promise<boolean>}
 */
export async function recordUsageEvent(env, event, deps = {}) {
  try {
    if (!isUsageTelemetryConfigured(env)) return false;

    const properties = usageEventProperties(event);
    if (!properties) return false;

    const Client = postHogClientClass(deps);
    const token = String(env[POSTHOG_PROJECT_TOKEN_ENV]).trim();
    const host = resolvePostHogHost(env);

    const client = new Client(token, {
      host,
      // Workers isolates can freeze the moment the response returns — never
      // batch; flush each capture immediately (PostHog Workers docs).
      flushAt: 1,
      flushInterval: 0,
    });

    try {
      await client.captureImmediate({
        distinctId: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID,
        event: USAGE_EVENT_NAME,
        properties,
      });
    } finally {
      // Always drain pending work so a capture isn't stranded on isolate exit.
      await client.shutdown().catch(() => {});
    }
    return true;
  } catch {
    // Telemetry must never surface into the request/tool path.
    return false;
  }
}

/**
 * PostHog client class — injectable for tests, defaults to posthog-node.
 * @param {RecordUsageEventDeps} [deps]
 * @returns {typeof PostHog}
 */
export function postHogClientClass(deps = {}) {
  return deps.PostHog ?? PostHog;
}

/**
 * @param {object | null | undefined} env
 * @returns {string}
 */
export function resolvePostHogHost(env) {
  return typeof env?.[POSTHOG_HOST_ENV] === "string" &&
    env[POSTHOG_HOST_ENV].trim()
    ? env[POSTHOG_HOST_ENV].trim()
    : DEFAULT_POSTHOG_HOST;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeLabel(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS
    ? trimmed.slice(0, MAX_LABEL_CHARS)
    : trimmed;
}
