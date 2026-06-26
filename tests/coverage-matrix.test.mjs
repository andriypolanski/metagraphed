import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { composeCoverageMatrix, handleRequest } from "../workers/api.mjs";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";

// composeCoverageMatrix is the pure projection at the heart of
// /api/v1/registry/coverage-matrix; these craft the resolved source rows
// directly so every branch is exercised without depending on built artifacts.
describe("composeCoverageMatrix", () => {
  const profileRows = [
    {
      netuid: 1,
      name: "Apex",
      slug: "apex",
      completeness_score: 85,
      surface_count: 5,
      operational_interface_count: 2,
    },
    {
      netuid: 2,
      name: "Beta",
      slug: "beta",
      completeness_score: 60,
      surface_count: 2,
      operational_interface_count: 0,
    },
    {
      netuid: 3,
      name: "Gamma",
      slug: "gamma",
      completeness_score: null,
      surface_count: 0,
      operational_interface_count: 0,
    },
  ];

  test("builds matrix with health data, null-safe per source tier", () => {
    const allSurfaces = [
      { netuid: 1, kind: "openapi", id: "sn-1-openapi" },
      { netuid: 1, kind: "subnet-api", id: "sn-1-api" },
      { netuid: 2, kind: "openapi", id: "sn-2-openapi" },
    ];
    const healthRows = [
      {
        netuid: 1,
        kind: "openapi",
        surface_count: 1,
        ok_count: 1,
        avg_latency_ms: 120,
      },
      {
        netuid: 1,
        kind: "subnet-api",
        surface_count: 1,
        ok_count: 0,
        avg_latency_ms: null,
      },
      // No health row for netuid 2 / openapi → ok_count null, avg null.
    ];

    const data = composeCoverageMatrix({
      kinds: ["openapi", "subnet-api"],
      includeHealth: true,
      profileRows,
      allSurfaces,
      healthRows,
      observedAt: "2026-06-26T00:00:00.000Z",
    });

    assert.equal(data.schema_version, 1);
    assert.deepEqual(data.kinds, ["openapi", "subnet-api"]);
    assert.equal(data.source, "registry+live-cron-prober");
    assert.equal(data.observed_at, "2026-06-26T00:00:00.000Z");
    assert.equal(data.matrix.length, 3);

    const [s1, s2, s3] = data.matrix;

    // Subnet 1: has both kinds, health data present for both.
    assert.equal(s1.netuid, 1);
    assert.equal(s1.name, "Apex");
    assert.equal(s1.slug, "apex");
    assert.equal(s1.completeness_score, 85);
    assert.equal(s1.kinds.openapi.count, 1);
    assert.equal(s1.kinds.openapi.ok_count, 1);
    assert.equal(s1.kinds.openapi.avg_latency_ms, 120);
    assert.equal(s1.kinds["subnet-api"].count, 1);
    assert.equal(s1.kinds["subnet-api"].ok_count, 0);
    assert.equal(s1.kinds["subnet-api"].avg_latency_ms, null);

    // Subnet 2: has openapi, no health row → ok_count null; no subnet-api → null cell.
    assert.equal(s2.netuid, 2);
    assert.equal(s2.kinds.openapi.count, 1);
    assert.equal(s2.kinds.openapi.ok_count, null);
    assert.equal(s2.kinds.openapi.avg_latency_ms, null);
    assert.equal(s2.kinds["subnet-api"], null);

    // Subnet 3: no surfaces of any requested kind → all-null cells.
    assert.equal(s3.netuid, 3);
    assert.equal(s3.completeness_score, null);
    assert.equal(s3.kinds.openapi, null);
    assert.equal(s3.kinds["subnet-api"], null);
  });

  test("includeHealth=false sets ok_count and avg_latency_ms null in all cells", () => {
    const allSurfaces = [{ netuid: 1, kind: "openapi", id: "sn-1-openapi" }];

    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: false,
      profileRows: [profileRows[0]],
      allSurfaces,
      healthRows: null, // not fetched when health=false
      observedAt: null,
    });

    assert.equal(data.observed_at, null);
    assert.equal(data.matrix[0].kinds.openapi.count, 1);
    assert.equal(data.matrix[0].kinds.openapi.ok_count, null);
    assert.equal(data.matrix[0].kinds.openapi.avg_latency_ms, null);
    assert.equal(data.totals.openapi.surfaces_ok, null);
  });

  test("null/empty sources produce safe empty output", () => {
    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: true,
      profileRows: [],
      allSurfaces: null,
      healthRows: null,
      observedAt: null,
    });

    assert.equal(data.matrix.length, 0);
    assert.equal(data.totals.openapi.subnets_with_kind, 0);
    assert.equal(data.totals.openapi.surfaces_total, 0);
    assert.equal(data.totals.openapi.surfaces_ok, 0);
  });

  test("surfaces outside the requested kinds are ignored", () => {
    const allSurfaces = [{ netuid: 1, kind: "docs", id: "sn-1-docs" }];

    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: false,
      profileRows: [profileRows[0]],
      allSurfaces,
      healthRows: null,
      observedAt: null,
    });

    // "docs" is not in the requested kinds → treated as absent → null cell.
    assert.equal(data.matrix[0].kinds.openapi, null);
    assert.equal(data.totals.openapi.subnets_with_kind, 0);
  });

  test("surfaces with missing netuid or kind are skipped safely", () => {
    const allSurfaces = [
      { netuid: 1, kind: "openapi", id: "sn-1-ok" },
      { netuid: null, kind: "openapi", id: "sn-null-netuid" },
      { netuid: 1, id: "sn-1-no-kind" }, // kind missing
    ];

    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: false,
      profileRows: [profileRows[0]],
      allSurfaces,
      healthRows: null,
      observedAt: null,
    });

    // Only the valid surface (netuid=1, kind="openapi") was counted.
    assert.equal(data.matrix[0].kinds.openapi.count, 1);
  });

  test("multiple surfaces of the same kind on one subnet are counted correctly", () => {
    const allSurfaces = [
      { netuid: 1, kind: "openapi", id: "sn-1-openapi-1" },
      { netuid: 1, kind: "openapi", id: "sn-1-openapi-2" },
      { netuid: 2, kind: "openapi", id: "sn-2-openapi-1" },
    ];
    const healthRows = [
      { netuid: 1, kind: "openapi", ok_count: 2, avg_latency_ms: 100 },
      { netuid: 2, kind: "openapi", ok_count: 1, avg_latency_ms: 200 },
    ];

    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: true,
      profileRows: profileRows.slice(0, 3),
      allSurfaces,
      healthRows,
      observedAt: null,
    });

    assert.equal(data.matrix[0].kinds.openapi.count, 2);
    assert.equal(data.matrix[1].kinds.openapi.count, 1);
    assert.equal(data.totals.openapi.subnets_with_kind, 2); // sn1 + sn2, not sn3
    assert.equal(data.totals.openapi.surfaces_total, 3); // 2 + 1
    assert.equal(data.totals.openapi.surfaces_ok, 3); // 2 + 1
  });

  test("totals.surfaces_ok is null when includeHealth=false", () => {
    const allSurfaces = [{ netuid: 1, kind: "openapi", id: "sn-1-ok" }];

    const data = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: false,
      profileRows: [profileRows[0]],
      allSurfaces,
      healthRows: null,
      observedAt: null,
    });

    assert.equal(data.totals.openapi.surfaces_ok, null);
    assert.equal(data.totals.openapi.subnets_with_kind, 1);
    assert.equal(data.totals.openapi.surfaces_total, 1);
  });

  test("composeCoverageMatrix output validates against the CoverageMatrixArtifact contract", async () => {
    const generatedAt = "2026-06-26T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/coverage-matrix-artifact.json",
      components: openapi.components,
      $ref: "#/components/schemas/CoverageMatrixArtifact",
    });

    // Full output with health data.
    const fullData = composeCoverageMatrix({
      kinds: ["openapi", "subnet-api"],
      includeHealth: true,
      profileRows: [
        { netuid: 1, name: "Apex", slug: "apex", completeness_score: 85 },
        { netuid: 2, name: "Beta", slug: "beta", completeness_score: null },
      ],
      allSurfaces: [
        { netuid: 1, kind: "openapi", id: "sn-1-openapi" },
        { netuid: 1, kind: "subnet-api", id: "sn-1-api" },
      ],
      healthRows: [
        { netuid: 1, kind: "openapi", ok_count: 1, avg_latency_ms: 80 },
      ],
      observedAt: generatedAt,
    });
    assert.equal(validate(fullData), true, ajv.errorsText(validate.errors));

    // health=false output.
    const noHealthData = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: false,
      profileRows: [
        { netuid: 1, name: "Apex", slug: "apex", completeness_score: 85 },
      ],
      allSurfaces: [{ netuid: 1, kind: "openapi", id: "sn-1-openapi" }],
      healthRows: null,
      observedAt: null,
    });
    assert.equal(validate(noHealthData), true, ajv.errorsText(validate.errors));

    // Empty matrix.
    const emptyData = composeCoverageMatrix({
      kinds: ["openapi"],
      includeHealth: true,
      profileRows: [],
      allSurfaces: [],
      healthRows: [],
      observedAt: null,
    });
    assert.equal(validate(emptyData), true, ajv.errorsText(validate.errors));
  });
});

describe("GET /api/v1/registry/coverage-matrix", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("returns matrix with default kinds and correct envelope shape", async () => {
    const { status, body } = await get("/api/v1/registry/coverage-matrix");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // Default kinds = the five high-value callable contributor kinds in canonical order.
    assert.deepEqual(body.data.kinds, [
      "openapi",
      "subnet-api",
      "sse",
      "data-artifact",
      "sdk",
    ]);
    assert.ok(Array.isArray(body.data.matrix));
    assert.ok(typeof body.data.totals === "object");
    for (const kind of body.data.kinds) {
      assert.ok(kind in body.data.totals, `totals missing key "${kind}"`);
    }
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/registry/coverage-matrix.json",
    );
    assert.equal(body.meta.source, "registry+live-cron-prober");
  });

  test("kinds subset selects columns in canonical SurfaceKind enum order", async () => {
    // Request in reversed order — response must canonicalise.
    const { body } = await get(
      "/api/v1/registry/coverage-matrix?kinds=sdk,openapi",
    );
    assert.equal(body.ok, true);
    // "openapi" precedes "sdk" in the enum; the response must reflect that.
    assert.deepEqual(body.data.kinds, ["openapi", "sdk"]);
  });

  test("duplicate kinds are deduplicated in canonical order", async () => {
    const { body } = await get(
      "/api/v1/registry/coverage-matrix?kinds=openapi,openapi,sdk",
    );
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.kinds, ["openapi", "sdk"]);
  });

  test("health=false omits health data from all cells and totals", async () => {
    const { status, body } = await get(
      "/api/v1/registry/coverage-matrix?health=false",
    );
    assert.equal(status, 200);
    for (const row of body.data.matrix) {
      for (const cell of Object.values(row.kinds)) {
        if (cell !== null) {
          assert.equal(
            cell.ok_count,
            null,
            `row ${row.netuid} cell.ok_count should be null`,
          );
          assert.equal(
            cell.avg_latency_ms,
            null,
            `row ${row.netuid} cell.avg_latency_ms should be null`,
          );
        }
      }
    }
    for (const [kind, total] of Object.entries(body.data.totals)) {
      assert.equal(
        total.surfaces_ok,
        null,
        `totals.${kind}.surfaces_ok should be null`,
      );
    }
  });

  test("rejects unknown kind", async () => {
    const { status, body } = await get(
      "/api/v1/registry/coverage-matrix?kinds=bogus",
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "kinds");
    assert.ok(body.error.message.includes("bogus"));
  });

  test("rejects empty kinds value", async () => {
    const { status, body } = await get(
      "/api/v1/registry/coverage-matrix?kinds=",
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "kinds");
  });

  test("rejects invalid health value", async () => {
    const { status, body } = await get(
      "/api/v1/registry/coverage-matrix?health=maybe",
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "health");
    assert.ok(body.error.message.includes("maybe"));
  });

  test("rejects unknown and duplicate query params", async () => {
    const cases = [
      ["/api/v1/registry/coverage-matrix?foo=1", "foo"],
      ["/api/v1/registry/coverage-matrix?kinds=openapi&kinds=sdk", "kinds"],
    ];
    for (const [path, parameter] of cases) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.error.code, "invalid_query", path);
      assert.equal(body.meta.parameter, parameter, path);
    }
  });

  test("D1 is queried for health=true and skipped for health=false", async () => {
    const queries = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return { all: () => Promise.resolve({ results: [] }) };
            },
          };
        },
      },
    };

    // health=true (default): D1 must be queried.
    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/registry/coverage-matrix?kinds=openapi",
      ),
      healthEnv,
      {},
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /FROM surface_status/);
    assert.match(queries[0].sql, /WHERE kind IN \(\?\)/);
    assert.deepEqual(queries[0].params, ["openapi"]);

    queries.length = 0;

    // health=false: D1 must NOT be queried.
    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/registry/coverage-matrix?health=false",
      ),
      healthEnv,
      {},
    );
    assert.equal(queries.length, 0);
  });

  test("D1 query is bounded to the requested kinds only", async () => {
    const queries = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return { all: () => Promise.resolve({ results: [] }) };
            },
          };
        },
      },
    };

    // Two kinds → two bind params, IN clause has two placeholders.
    await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/registry/coverage-matrix?kinds=openapi,sdk",
      ),
      healthEnv,
      {},
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /WHERE kind IN \(\?, \?\)/);
    // Params are in canonical enum order (openapi precedes sdk).
    assert.deepEqual(queries[0].params, ["openapi", "sdk"]);
  });

  test("stamps observed_at from the live cron snapshot", async () => {
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(_sql) {
          return {
            bind(..._params) {
              return { all: () => Promise.resolve({ results: [] }) };
            },
          };
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-26T01:02:03.000Z" }
            : null;
        },
      },
    };
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/registry/coverage-matrix?kinds=openapi",
      ),
      healthEnv,
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.observed_at, "2026-06-26T01:02:03.000Z");
  });
});
