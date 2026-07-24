import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as healthServing from "../src/health-serving.ts";
import * as listQuery from "../workers/list-query.ts";
import {
  ENDPOINTS_ARTIFACT,
  LIST_ENDPOINTS_INSTRUCTIONS,
  LIST_ENDPOINTS_MCP_TOOL,
  LIST_ENDPOINTS_OUTPUT_SCHEMA,
  endpointsMcpError,
  endpointsQueryUrl,
  loadEndpointsList,
} from "../src/endpoints-mcp.ts";
import type { Row } from "./row-type.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

type LoadCtx = Parameters<typeof loadEndpointsList>[0];
type LoadDeps = Parameters<typeof loadEndpointsList>[2];

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["endpoint catalog"],
  endpoints: [
    {
      id: "datura-subnet-api",
      kind: "subnet-api",
      layer: "subnet-app",
      provider: "datura",
      netuid: 1,
      status: "ok",
      latency_ms: 120,
      score: 90,
      pool_eligible: true,
      publication_state: "monitored",
    },
    {
      id: "chutes-openapi",
      kind: "openapi",
      layer: "subnet-app",
      provider: "chutes",
      netuid: 12,
      status: "degraded",
      latency_ms: 400,
      score: 40,
      pool_eligible: false,
      publication_state: "monitored",
    },
    {
      id: "allnodes-rpc",
      kind: "subtensor-rpc",
      layer: "bittensor-base",
      provider: "allnodes",
      netuid: 0,
      status: "ok",
      latency_ms: 80,
      score: 95,
      pool_eligible: true,
      publication_state: "monitored",
    },
  ],
};

const BLOB_WITH_SURFACE_IDS = {
  endpoints: [
    {
      id: "datura-subnet-api",
      surface_id: "datura-subnet-api",
      status: "degraded",
      latency_ms: 500,
    },
    {
      id: "chutes-openapi",
      surface_id: "chutes-openapi",
      status: "degraded",
      latency_ms: 500,
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === ENDPOINTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("endpoints-mcp (#7892)", () => {
  test("endpointsMcpError is shaped for MCP toolError handling", () => {
    const err = endpointsMcpError("invalid_params", "bad status");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("endpointsQueryUrl sets all filter, range, sort, and pagination params", () => {
    const url = endpointsQueryUrl({
      kind: "subnet-api",
      layer: "subnet-app",
      netuid: 1,
      pool_eligible: true,
      provider: "datura",
      publication_state: "monitored",
      status: "ok",
      min_latency_ms: 50,
      max_latency_ms: 300,
      min_score: 80,
      max_score: 100,
      sort: "latency_ms",
      order: "asc",
      fields: "id,status",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("layer"), "subnet-app");
    assert.equal(url.searchParams.get("netuid"), "1");
    assert.equal(url.searchParams.get("pool_eligible"), "true");
    assert.equal(url.searchParams.get("provider"), "datura");
    assert.equal(url.searchParams.get("publication_state"), "monitored");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("min_latency_ms"), "50");
    assert.equal(url.searchParams.get("max_latency_ms"), "300");
    assert.equal(url.searchParams.get("min_score"), "80");
    assert.equal(url.searchParams.get("max_score"), "100");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("order"), "asc");
    assert.equal(url.searchParams.get("fields"), "id,status");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("endpointsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => endpointsQueryUrl({ kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects invalid status", () => {
    assert.throws(
      () => endpointsQueryUrl({ status: "healthy" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects negative netuid and fractional cursor", () => {
    assert.throws(
      () => endpointsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects non-finite range bound", () => {
    assert.throws(
      () => endpointsQueryUrl({ min_latency_ms: Infinity }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl rejects blank string filters", () => {
    assert.throws(
      () => endpointsQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => endpointsQueryUrl({ provider: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("endpointsQueryUrl clamps invalid limit values to the REST default", () => {
    assert.equal(endpointsQueryUrl({ limit: -1 }).searchParams.get("limit"), "50");
    assert.equal(endpointsQueryUrl({ limit: 0 }).searchParams.get("limit"), "50");
    assert.equal(
      endpointsQueryUrl({ limit: Number.NaN }).searchParams.get("limit"),
      "50",
    );
    assert.equal(
      endpointsQueryUrl({ limit: "bad" as unknown as number }).searchParams.get(
        "limit",
      ),
      "50",
    );
  });

  test("endpointsQueryUrl rejects a non-boolean pool_eligible", () => {
    assert.throws(
      () => endpointsQueryUrl({ pool_eligible: "yes" as unknown as boolean }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadEndpointsList returns all endpoints when unfiltered", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.returned, 3);
    assert.deepEqual(out.notes, ["endpoint catalog"]);
  });

  test("loadEndpointsList filters by kind and status", async () => {
    const byKind = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { kind: "openapi" },
    );
    assert.equal(byKind.returned, 1);
    assert.equal(byKind.endpoints[0].provider, "chutes");

    const byStatus = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { status: "ok" },
    );
    assert.equal(byStatus.returned, 2);
  });

  test("loadEndpointsList filters by score range", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { min_score: 85 },
    );
    assert.equal(out.returned, 2);
    assert.ok(out.endpoints.every((e) => (e as Row).score >= 85));
  });

  test("loadEndpointsList sorts and pages the collection", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "latency_ms", order: "asc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.endpoints[0].id, "allnodes-rpc");
    assert.equal(out.next_cursor, 1);
  });

  test("loadEndpointsList skips overlay when no surface_id in endpoints", async () => {
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact,
        readHealthKv: async () => ({ surfaces: [] }),
      } as unknown as LoadCtx,
      { status: "ok" },
    );
    assert.equal(out.returned, 2);
  });

  test("loadEndpointsList applies live overlay before filtering", async () => {
    const live = {
      surfaces: [
        { surface_id: "chutes-openapi", status: "ok", latency_ms: 50 },
      ],
    };
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact: async (_env: unknown, path: string) => {
          if (path === ENDPOINTS_ARTIFACT)
            return { ok: true, data: BLOB_WITH_SURFACE_IDS };
          return { ok: false, code: "artifact_not_found" };
        },
        readHealthKv: async () => live,
      } as unknown as LoadCtx,
      { status: "ok" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.endpoints[0].id, "chutes-openapi");
  });

  test("loadEndpointsList keeps the artifact when overlay returns null", async () => {
    const spy = vi
      .spyOn(healthServing, "overlayArtifactEndpoints")
      .mockReturnValue(null);
    try {
      const out = await loadEndpointsList(
        {
          env: {},
          readArtifact: async (_env: unknown, path: string) => {
            if (path === ENDPOINTS_ARTIFACT)
              return { ok: true, data: BLOB_WITH_SURFACE_IDS };
            return { ok: false, code: "artifact_not_found" };
          },
          readHealthKv: async () => ({ surfaces: [] }),
        } as unknown as LoadCtx,
        { status: "degraded" },
      );
      assert.equal(out.returned, 2);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadEndpointsList uses an injected readArtifact dep", async () => {
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: [{ id: "solo" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.endpoints[0].id, "solo");
  });

  test("loadEndpointsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadEndpointsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" && /endpoints\.json/.test(err.message),
    );
  });

  test("loadEndpointsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadEndpointsList projects row fields when requested", async () => {
    const out = await loadEndpointsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { kind: "openapi", fields: "id,status" },
    );
    assert.deepEqual(out.endpoints[0], {
      id: "chutes-openapi",
      status: "degraded",
    });
  });

  test("loadEndpointsList treats a non-array endpoints key as empty", async () => {
    const out = await loadEndpointsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { endpoints: null },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.total, 0);
  });

  test("loadEndpointsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { endpoints: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadEndpointsList(
        { env: {}, readArtifact } as unknown as LoadCtx,
        {},
      );
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadEndpointsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadEndpointsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEndpointsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_ENDPOINTS_MCP_TOOL.name, "list_endpoints");
    assert.match(LIST_ENDPOINTS_INSTRUCTIONS, /list_endpoints/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_ENDPOINTS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_endpoints with sort, order, and fields", () => {
    assert.match(MCP_INSTRUCTIONS, /list_endpoints/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_endpoints");
    assert.ok(tool);
    assert.equal(tool.title, "List monitored endpoint resources");
    const props = tool.inputSchema.properties as Row;
    assert.ok(props.sort);
    assert.ok(props.order);
    assert.ok(props.fields);
    assert.ok(props.kind);
    assert.ok(props.status);
    assert.ok(props.min_latency_ms);
  });
});
