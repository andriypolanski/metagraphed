import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { PostHog } from "posthog-node";
import {
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  USAGE_EVENT_NAME,
  isUsageTelemetryConfigured,
  postHogClientClass,
  recordUsageEvent,
  resolvePostHogHost,
  usageEventProperties,
} from "../src/usage-telemetry.mjs";

function fakePostHog({
  onConstruct,
  onCapture,
  onShutdown,
  captureThrows = false,
  shutdownThrows = false,
} = {}) {
  return class FakePostHog {
    constructor(token, options) {
      onConstruct?.(token, options);
      this.token = token;
      this.options = options;
    }
    async captureImmediate(payload) {
      if (captureThrows) throw new Error("capture failed");
      onCapture?.(payload);
    }
    async shutdown() {
      if (shutdownThrows) throw new Error("shutdown failed");
      onShutdown?.();
    }
  };
}

describe("isUsageTelemetryConfigured", () => {
  test("false when env is missing / token empty / whitespace", () => {
    assert.equal(isUsageTelemetryConfigured(undefined), false);
    assert.equal(isUsageTelemetryConfigured({}), false);
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "" }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "   " }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: 123 }),
      false,
    );
  });

  test("true when a non-empty token string is set", () => {
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
      }),
      true,
    );
  });
});

describe("usageEventProperties", () => {
  test("returns null for missing ok or non-finite / negative duration", () => {
    assert.equal(usageEventProperties(null), null);
    assert.equal(usageEventProperties({ durationMs: 10 }), null);
    assert.equal(usageEventProperties({ ok: true }), null);
    assert.equal(
      usageEventProperties({ ok: true, durationMs: Number.NaN }),
      null,
    );
    assert.equal(usageEventProperties({ ok: true, durationMs: -1 }), null);
    assert.equal(usageEventProperties({ ok: "yes", durationMs: 10 }), null);
  });

  test("allowlists only route / mcp_tool / ok / duration_ms", () => {
    assert.deepEqual(
      usageEventProperties({
        route: " /api/v1/subnets ",
        mcpTool: " get_subnet ",
        ok: true,
        durationMs: 12.6,
        args: { secret: "nope" },
        wallet: "5Fake",
      }),
      {
        route: "/api/v1/subnets",
        mcp_tool: "get_subnet",
        ok: true,
        duration_ms: 13,
      },
    );
  });

  test("omits blank optional labels and truncates overlong ones", () => {
    const long = "x".repeat(300);
    assert.deepEqual(
      usageEventProperties({
        route: "   ",
        mcpTool: long,
        ok: false,
        durationMs: 0,
      }),
      {
        mcp_tool: "x".repeat(256),
        ok: false,
        duration_ms: 0,
      },
    );
  });

  test("clamps absurd durations at 24h", () => {
    assert.equal(
      usageEventProperties({ ok: true, durationMs: 999_999_999 }).duration_ms,
      86_400_000,
    );
  });
});

describe("postHogClientClass / resolvePostHogHost", () => {
  test("defaults to posthog-node's PostHog export", () => {
    assert.equal(postHogClientClass(), PostHog);
    assert.equal(postHogClientClass({}), PostHog);
  });

  test("honors an injected PostHog class", () => {
    class Injected {}
    assert.equal(postHogClientClass({ PostHog: Injected }), Injected);
  });

  test("resolvePostHogHost trims a custom host or falls back to US cloud", () => {
    assert.equal(resolvePostHogHost(undefined), "https://us.i.posthog.com");
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "  https://eu.i.posthog.com " }),
      "https://eu.i.posthog.com",
    );
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "   " }),
      "https://us.i.posthog.com",
    );
  });
});

describe("recordUsageEvent — unconfigured (safe no-op)", () => {
  test("returns false and never constructs a PostHog client", async () => {
    let constructed = 0;
    const recorded = await recordUsageEvent(
      {},
      { route: "/api/v1/health", ok: true, durationMs: 5 },
      {
        PostHog: fakePostHog({
          onConstruct: () => {
            constructed += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(constructed, 0);
  });

  test("never throws when env is null", async () => {
    await assert.doesNotReject(() =>
      recordUsageEvent(null, { ok: true, durationMs: 1 }),
    );
  });
});

describe("recordUsageEvent — configured", () => {
  test("captures an allowlisted usage_event via captureImmediate + shutdown", async () => {
    const constructs = [];
    const captures = [];
    let shutdowns = 0;
    const env = {
      [POSTHOG_PROJECT_TOKEN_ENV]: " phc_token ",
      [POSTHOG_HOST_ENV]: "https://eu.i.posthog.com",
    };

    const recorded = await recordUsageEvent(
      env,
      {
        route: "/api/v1/subnets/1",
        mcpTool: "get_subnet",
        ok: true,
        durationMs: 42,
      },
      {
        PostHog: fakePostHog({
          onConstruct: (token, options) => constructs.push({ token, options }),
          onCapture: (payload) => captures.push(payload),
          onShutdown: () => {
            shutdowns += 1;
          },
        }),
      },
    );

    assert.equal(recorded, true);
    assert.equal(constructs.length, 1);
    assert.equal(constructs[0].token, "phc_token");
    assert.equal(constructs[0].options.host, "https://eu.i.posthog.com");
    assert.equal(constructs[0].options.flushAt, 1);
    assert.equal(constructs[0].options.flushInterval, 0);
    assert.deepEqual(captures, [
      {
        distinctId: USAGE_EVENT_DISTINCT_ID,
        event: USAGE_EVENT_NAME,
        properties: {
          route: "/api/v1/subnets/1",
          mcp_tool: "get_subnet",
          ok: true,
          duration_ms: 42,
        },
      },
    ]);
    assert.equal(shutdowns, 1);
  });

  test("defaults host to PostHog US cloud when POSTHOG_HOST is unset", async () => {
    const constructs = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: false, durationMs: 1 },
      {
        PostHog: fakePostHog({
          onConstruct: (_token, options) => constructs.push(options),
        }),
      },
    );
    assert.equal(constructs[0].host, "https://us.i.posthog.com");
  });

  test("returns false for an invalid event without capturing", async () => {
    let captures = 0;
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: -5 },
      {
        PostHog: fakePostHog({
          onCapture: () => {
            captures += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(captures, 0);
  });

  test("swallows capture errors and still attempts shutdown", async () => {
    let shutdowns = 0;
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 3 },
      {
        PostHog: fakePostHog({
          captureThrows: true,
          onShutdown: () => {
            shutdowns += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(shutdowns, 1);
  });

  test("swallows shutdown errors after a successful capture", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { mcpTool: "list_tools", ok: true, durationMs: 9 },
      {
        PostHog: fakePostHog({ shutdownThrows: true }),
      },
    );
    assert.equal(recorded, true);
  });

  test("never throws when the PostHog constructor itself throws", async () => {
    class Boom {
      constructor() {
        throw new Error("construct failed");
      }
    }
    await assert.doesNotReject(async () => {
      const recorded = await recordUsageEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
        { ok: true, durationMs: 1 },
        { PostHog: Boom },
      );
      assert.equal(recorded, false);
    });
  });

  test("honors an injected distinctId override", async () => {
    const captures = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 2 },
      {
        distinctId: "test-distinct",
        PostHog: fakePostHog({
          onCapture: (payload) => captures.push(payload),
        }),
      },
    );
    assert.equal(captures[0].distinctId, "test-distinct");
  });
});
