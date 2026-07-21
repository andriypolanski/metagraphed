// SN99 (Leoma) end-to-end verification for the call_subnet_surface MCP tool
// (metagraphed#7111, MCP execute Phase 1 #7014/#7215). Unlike
// tests/call-subnet-surface-mcp.test.mjs -- which proves the tool wiring with
// synthetic surfaces -- this file pins SN99's *real* registry surface config
// (registry/subnets/leoma.json) to the tool's contract, so a future edit that
// regresses any of these surfaces' callability is caught here.
//
// All seven surfaces named in #7111 were live-verified 2026-07-21 against
// api.leoma.ai (a Cloudflare-fronted host, resolved 172.67.190.14) -- each a
// public no-auth GET returning HTTP 200 application/json whose shape matched
// its registry `notes`:
//   - sn-99-leoma-health           GET /health           {status,version,database,metagraph_synced,last_sync}
//   - sn-99-leoma-openapi          GET /openapi.json      OpenAPI 3.1.0 "Leoma API" v0.3.2, 28 paths
//   - sn-99-leoma-miners-list      GET /miners/list       {miners:[{uid,hotkey,model_name,model_revision,...}]}
//   - sn-99-leoma-samples-list     GET /samples/list      [{id,task_id,validator_hotkey,miner_hotkey,...}]
//   - sn-99-leoma-scores-validators GET /scores/validators [{validator_hotkey,total_samples,total_passed,avg_score,...}]
//   - sn-99-leoma-tasks-latest     GET /tasks/latest      {task_id}
//   - sn-99-leoma-weights          GET /weights           {winner_uid,miners:[{miner_hotkey,uid,pass_rate,weight}]}
// The registry already matched reality -- no probe/auth/URL/schema edit was
// needed. The `openapi` surface is a batch-build (non-operational) kind, so it
// is not reachable through the tool's operational-surfaces catalog; it was
// verified by requesting the URL directly (equally valid per #7111 for a
// no-auth GET) and is asserted here only at the registry-config level. The
// remaining six subnet-api surfaces are the operational, tool-callable set and
// are exercised through call_subnet_surface below with faithful subsets of
// their live bodies, keeping the test hermetic while still driving the real
// JSON parse-and-return path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { callSubnetSurface } from "../src/call-subnet-surface.mjs";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const NETUID = 99;

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../registry/subnets/leoma.json", import.meta.url)),
    "utf8",
  ),
);

function surfaceById(id) {
  return registry.surfaces.find((surface) => surface.id === id);
}

// Faithful subsets of each surface's live 2026-07-21 response body. Only real
// observed field names/values are used; the large list endpoints keep a single
// representative real entry (free-text sample prompt/reasoning omitted for
// brevity, not fabricated).
const TOOL_CALLABLE_SURFACES = [
  {
    id: "sn-99-leoma-health",
    surfaceKey: "srf-0d3e9b0db1918473",
    url: "https://api.leoma.ai/health",
    body: {
      status: "healthy",
      version: "0.3.2",
      database: true,
      metagraph_synced: true,
      last_sync: "2026-06-26T21:06:29.781333Z",
    },
    assertBody: (b) => {
      assert.equal(b.status, "healthy");
      assert.equal(b.version, "0.3.2");
      assert.equal(b.metagraph_synced, true);
    },
  },
  {
    id: "sn-99-leoma-miners-list",
    surfaceKey: "srf-f8069336daa1b6f4",
    url: "https://api.leoma.ai/miners/list",
    body: {
      miners: [
        {
          uid: 2,
          hotkey: "5CPxXZNBWbCvzmm9PPpGvJATBLVnFTgdWmaenGkWBijNDBGY",
          model_name: null,
          model_revision: null,
          model_hash: null,
          chute_id: null,
          chute_slug: null,
          is_valid: false,
          invalid_reason: "max_commits_exceeded_2",
          block: 8209807,
          last_validated_at: "2026-06-26T21:06:29.659405Z",
        },
      ],
    },
    assertBody: (b) => {
      assert.ok(Array.isArray(b.miners));
      assert.equal(typeof b.miners[0].uid, "number");
      assert.equal(typeof b.miners[0].hotkey, "string");
    },
  },
  {
    id: "sn-99-leoma-samples-list",
    surfaceKey: "srf-2cbcbf2a4d469c67",
    url: "https://api.leoma.ai/samples/list",
    body: [
      {
        id: 71250,
        task_id: 5954,
        validator_hotkey: "5CrGhhemVi8e77LRpogbQEvuqvBssaEYz2EzrUfNR5bJ1s99",
        miner_hotkey: "5GpoRvo4ANAg1QzRGyQu8nRndTERAWxQcjkpwc5iwCoTEZuV",
        s3_bucket: "leoma-samples",
        s3_prefix: "5954",
        passed: false,
        confidence: 95,
        evaluated_at: "2026-06-29T11:33:08.985485Z",
        latency_ms: 284806,
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].id, "number");
      assert.equal(typeof b[0].task_id, "number");
      assert.equal(typeof b[0].validator_hotkey, "string");
      assert.equal(typeof b[0].miner_hotkey, "string");
    },
  },
  {
    id: "sn-99-leoma-scores-validators",
    surfaceKey: "srf-2105648335486743",
    url: "https://api.leoma.ai/scores/validators",
    body: [
      {
        validator_hotkey: "5CrGhhemVi8e77LRpogbQEvuqvBssaEYz2EzrUfNR5bJ1s99",
        total_samples: 3472,
        total_passed: 2495,
        avg_score: 0.6995807933945115,
        pass_rate: 0.7186059907834101,
        last_updated: "2026-07-21T07:26:24.767522+00:00",
      },
    ],
    assertBody: (b) => {
      assert.ok(Array.isArray(b));
      assert.equal(typeof b[0].validator_hotkey, "string");
      assert.equal(typeof b[0].total_samples, "number");
      assert.equal(typeof b[0].avg_score, "number");
    },
  },
  {
    id: "sn-99-leoma-tasks-latest",
    surfaceKey: "srf-77b4603b849756fe",
    url: "https://api.leoma.ai/tasks/latest",
    body: { task_id: 5954 },
    assertBody: (b) => {
      assert.equal(typeof b.task_id, "number");
    },
  },
  {
    id: "sn-99-leoma-weights",
    surfaceKey: "srf-e861395493e32ffa",
    url: "https://api.leoma.ai/weights",
    body: {
      winner_uid: 164,
      miners: [
        {
          miner_hotkey: "5GpoRvo4ANAg1QzRGyQu8nRndTERAWxQcjkpwc5iwCoTEZuV",
          uid: 164,
          pass_rate: 0.74,
          weight: 1.0,
        },
      ],
    },
    assertBody: (b) => {
      assert.equal(typeof b.winner_uid, "number");
      assert.ok(Array.isArray(b.miners));
      assert.equal(typeof b.miners[0].miner_hotkey, "string");
      assert.equal(typeof b.miners[0].weight, "number");
    },
  },
];

function upstreamResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SN99 Leoma call_subnet_surface verification (#7111)", () => {
  test("the registry is SN99 Leoma and every #7111 surface is present", () => {
    assert.equal(registry.netuid, NETUID);
    assert.equal(registry.name, "Leoma");
    for (const { id } of TOOL_CALLABLE_SURFACES) {
      const surface = surfaceById(id);
      assert.ok(surface, `registry surface ${id} is present`);
      assert.equal(surface.kind, "subnet-api");
      assert.equal(surface.auth_required, false);
      assert.equal(surface.public_safe, true);
      assert.equal(surface.probe?.enabled, true);
      assert.equal(surface.probe?.method, "GET");
      assert.equal(surface.probe?.expect, "json");
    }
  });

  test("the openapi surface is catalogued as a machine-readable no-auth schema (verified via direct request)", () => {
    const openapi = surfaceById("sn-99-leoma-openapi");
    assert.ok(openapi, "registry surface sn-99-leoma-openapi is present");
    assert.equal(openapi.kind, "openapi");
    assert.equal(openapi.auth_required, false);
    assert.equal(openapi.schema_status, "machine-readable");
    assert.equal(openapi.schema_url, "https://api.leoma.ai/openapi.json");
    assert.equal(openapi.url, "https://api.leoma.ai/openapi.json");
  });

  for (const surfaceSpec of TOOL_CALLABLE_SURFACES) {
    test(`callSubnetSurface returns the live JSON body for ${surfaceSpec.id} using its own url + GET`, async () => {
      const surface = surfaceById(surfaceSpec.id);
      assert.equal(surface.url, surfaceSpec.url);
      let requestedUrl;
      let requestedMethod;
      const result = await callSubnetSurface(surface, {
        isUnsafeUrl: async () => false,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = init.method;
          return upstreamResponse(surfaceSpec.body);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(requestedUrl, surface.url);
      assert.equal(requestedMethod, "GET");
      assert.equal(result.status_code, 200);
      assert.equal(result.content_type, "application/json");
      assert.equal(result.truncated, false);
      assert.equal(result.parse_error, undefined);
      surfaceSpec.assertBody(result.body);
    });
  }

  test("end-to-end through the call_subnet_surface MCP tool, resolved by surface id and surface key", async () => {
    const catalog = {
      surfaces: TOOL_CALLABLE_SURFACES.map((spec) => {
        const surface = surfaceById(spec.id);
        return {
          ...surface,
          surface_id: surface.id,
          surface_key: spec.surfaceKey,
          netuid: NETUID,
        };
      }),
    };
    const deps = {
      readArtifact: async (_env, path) =>
        path === "/metagraph/operational-surfaces.json"
          ? { ok: true, data: catalog }
          : { ok: false, status: 404 },
    };
    const bodyByUrl = new Map(
      TOOL_CALLABLE_SURFACES.map((spec) => [spec.url, spec.body]),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        return new Response(JSON.stringify({ Status: 0 }), {
          headers: { "content-type": "application/dns-json" },
        });
      }
      return upstreamResponse(bodyByUrl.get(url) ?? {});
    };
    try {
      async function callTool(argument) {
        const response = await handleMcpRequest(
          new Request("https://metagraph.sh/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "call_subnet_surface", arguments: argument },
            }),
          }),
          {},
          deps,
        );
        return (await response.json()).result;
      }

      // Resolve by surface_id.
      const byId = await callTool({ surface_id: "sn-99-leoma-weights" });
      assert.equal(byId.isError, false);
      assert.equal(byId.structuredContent.surface_id, "sn-99-leoma-weights");
      assert.equal(byId.structuredContent.status_code, 200);
      assert.equal(byId.structuredContent.body.winner_uid, 164);

      // Resolve the same surface by its stable surface_key.
      const byKey = await callTool({ surface_id: "srf-e861395493e32ffa" });
      assert.equal(byKey.isError, false);
      assert.equal(byKey.structuredContent.surface_id, "sn-99-leoma-weights");
      assert.equal(byKey.structuredContent.body.winner_uid, 164);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
