import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import {
  buildSchema,
  getIntrospectionQuery,
  parse,
  subscribe,
  validate,
} from "graphql";
import { describe, test } from "vitest";
import {
  FIELD_COMPLEXITY,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_QUERY_BYTES,
  GRAPHQL_SUBSCRIPTION_CONTEXT_KEY,
  SDL,
  handleGraphQLRequest,
  maxComplexityRule,
  maxDepthRule,
  schema as chainEventsSchema,
} from "../src/graphql.mjs";
import { LEADERBOARD_BOARDS } from "../src/health-serving.mjs";
import { CHAIN_PROMETHEUS_WINDOWS } from "../src/chain-prometheus.mjs";
import { CHAIN_SIGNERS_SORTS } from "../src/chain-query-loaders.mjs";
import { CHAIN_DEREGISTRATIONS_WINDOWS } from "../src/chain-deregistrations.mjs";
import { CHAIN_REGISTRATIONS_WINDOWS } from "../src/chain-registrations.mjs";
import { CHAIN_AXON_REMOVALS_WINDOWS } from "../src/chain-axon-removals.mjs";
import { handleRequest } from "../workers/api.mjs";
import { resolveClientIp, DAY_MS } from "../workers/config.mjs";
import {
  KV_ECONOMICS_CURRENT,
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
} from "../src/kv-keys.mjs";

// Minimal fake env — no R2 or ASSETS, so readArtifact always returns ok:false.
const emptyEnv = {};

async function gql(query, env = emptyEnv, extras = {}) {
  const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, ...extras }),
  });
  const res = await handleGraphQLRequest(req, env);
  return { status: res.status, body: await res.json() };
}

// Inject synthetic artifacts (R2) and optional live KV tiers (health:current,
// economics:current — the fresh sources REST prefers) into a fake env. `reads`/
// `kvReads` record per-key access counts so tests can prove per-request read
// memoization. GraphQL source paths are R2-only; fixtures are keyed by full
// artifact path, e.g. "/metagraph/subnets.json". `kv` maps KV keys to values.
function fixtureEnv(fixtures = {}, { reads, kv, kvReads } = {}) {
  const env = {
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_ARCHIVE: {
      async get(key) {
        if (reads) reads.set(key, (reads.get(key) || 0) + 1);
        const path = "/metagraph/" + key.replace(/^latest\//, "");
        const data = fixtures[path];
        return data === undefined
          ? null
          : {
              async json() {
                return data;
              },
            };
      },
    },
  };
  if (kv) {
    env.METAGRAPH_CONTROL = {
      async get(key) {
        if (kvReads) kvReads.set(key, (kvReads.get(key) || 0) + 1);
        return Object.hasOwn(kv, key) ? kv[key] : null;
      },
    };
  }
  return env;
}

describe("handleGraphQLRequest — method guard", () => {
  test("GET publishes the SDL document (discoverability)", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql");
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/graphql/);
    assert.equal(res.headers.get("allow"), "GET, POST");
    const sdl = await res.text();
    // The published shape advertises the broadened graph + its relationships.
    assert.ok(sdl.includes("type Query"));
    assert.ok(sdl.includes("opportunity_boards"));
    assert.ok(sdl.includes("type Subnet"));
    assert.ok(sdl.includes("health: SubnetHealth"));
  });

  test("an unsupported method (PUT) returns 405 advertising GET, POST", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "PUT",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("POST"));
    assert.equal(res.headers.get("allow"), "GET, POST");
  });
});

describe("handleRequest — GraphQL routing", () => {
  test("POST /api/v1/graphql reaches the GraphQL handler", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleRequest(req, emptyEnv, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("allow"), null);
    assert.deepEqual(await res.json(), { data: { __typename: "Query" } });
  });

  test("OPTIONS /api/v1/graphql advertises GET + POST for CORS preflight", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "OPTIONS",
      }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, POST, OPTIONS",
    );
  });

  test("GET /api/v1/graphql through the router returns the SDL", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql"),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/graphql/);
    assert.ok((await res.text()).includes("type Query"));
  });
});

describe("handleGraphQLRequest — request validation", () => {
  test("non-JSON body returns 400", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("JSON"));
  });

  test("oversized Content-Length is rejected before reading the body", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(GRAPHQL_MAX_BODY_BYTES + 1),
      },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("body"));
  });

  test("oversized streaming body without Content-Length is rejected", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([" ".repeat(GRAPHQL_MAX_BODY_BYTES + 1)]).stream(),
      duplex: "half",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("body"));
  });

  test("oversized GraphQL query is rejected before parsing", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `# ${"x".repeat(GRAPHQL_MAX_QUERY_BYTES)}\n{ __typename }`,
      }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("missing query field returns 400", async () => {
    const { status, body } = await gql(undefined);
    assert.equal(status, 400);
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("empty query string returns 400", async () => {
    const { status, body } = await gql("   ");
    assert.equal(status, 400);
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("syntax error in query returns 400", async () => {
    const { status, body } = await gql("{ subnets { ");
    assert.equal(status, 400);
    assert.ok(body.errors.length > 0);
  });
});

describe("handleGraphQLRequest — validation rules", () => {
  test("unknown field name returns 400", async () => {
    const { status, body } = await gql("{ nonExistentField }");
    assert.equal(status, 400);
    assert.ok(body.errors.length > 0);
  });

  test("depth exceeded returns DEPTH_LIMIT_EXCEEDED extension", async () => {
    // Build a query that nests past the limit. With max depth 7, we need 8 levels.
    // subnets.items counts as depth 1, then we'd need 7 more nesting levels.
    // Since we only have depth-2 types, force it via aliases repeating subnets.
    // Actually build an artificially deep introspection-style query.
    const deep =
      "{ " +
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1) +
      " }";
    const { status, body } = await gql(deep);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("standard introspection query is accepted over POST", async () => {
    // The full getIntrospectionQuery() is intrinsically deeper/wider than the
    // data limits; exempting the schema-only __schema/__type roots keeps it
    // working for tooling (GraphiQL/Apollo/codegen) as the contract promises.
    const { status, body } = await gql(getIntrospectionQuery());
    assert.equal(
      status,
      200,
      `introspection must not be rejected, got: ${JSON.stringify(body.errors)}`,
    );
    assert.ok(body.data?.__schema?.types?.length > 0);
  });

  test("introspection exemption does not let sibling data fields bypass depth", async () => {
    // A query that pairs __schema with an over-deep real data selection must
    // still be rejected on the data portion — the exemption is scoped to the
    // schema-only meta-field subtree, not the whole operation.
    const deepData =
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1);
    const { status, body } = await gql(
      `{ __schema { queryType { name } } ${deepData} }`,
    );
    assert.equal(status, 400);
    assert.ok(
      body.errors.find((e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED"),
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("complexity counts fields inside named fragments (no spread bypass)", async () => {
    // Moving the whole selection into a fragment must NOT bypass the limit: the
    // spread is transparent, so its fields are counted at the operation level.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY + 1 },
      (_, i) => `t${i}: __typename`,
    ).join(" ");
    const q = `query { ...Big } fragment Big on Query { ${fields} }`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("depth counts nesting inside named fragments (no spread bypass)", async () => {
    // Deep nesting hidden inside a fragment must still be counted. Without
    // following the spread, the operation's selection set is just `...Big` and
    // counts as depth 0, bypassing the limit.
    const nested =
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1);
    const q = `query { ...Big } fragment Big on Query { ${nested} }`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("validation memoizes repeated named fragment spreads", async () => {
    const fragments = ["fragment F0 on Query { __typename }"];
    for (let i = 1; i <= 20; i += 1) {
      fragments.push(`fragment F${i} on Query { ...F${i - 1} ...F${i - 1} }`);
    }
    const q = `query { ...F20 } ${fragments.join(" ")}`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("inline fragments are transparent for complexity (no over-count)", async () => {
    // Exactly at the limit, wrapped in a type-conditional inline fragment. The
    // inline fragment is not a field, so this must pass — counting it would
    // over-measure (51) and wrongly reject a query identical to its inlined form.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY },
      (_, i) => `t${i}: __typename`,
    ).join(" ");
    const inlineFrag = await gql(`query { ... on Query { ${fields} } }`);
    assert.equal(
      inlineFrag.status,
      200,
      `inline-fragment query should match its inlined form: ${JSON.stringify(inlineFrag.body.errors)}`,
    );
    // Same fields without the inline fragment also pass — equal measurement.
    const plain = await gql(`query { ${fields} }`);
    assert.equal(plain.status, 200);
    // One field over the limit is still rejected through the inline fragment.
    const over = await gql(
      `query { ... on Query { ${fields} t_extra: __typename } }`,
    );
    assert.equal(over.status, 400);
    assert.ok(
      over.body.errors.find(
        (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
      ),
    );
  });

  test("maxDepthRule treats inline fragments transparently", () => {
    // `{ a { b { c } } }` is depth 2 (a->1, b->2; c is a scalar leaf). Wrapping
    // the selection in an inline fragment must NOT add a level — otherwise the
    // inline form measures depth 3 and is wrongly rejected at limit 2.
    const depthSchema = buildSchema(
      `type Query { a: A } type A { b: B } type B { c: Int }`,
    );
    const plain = parse("{ a { b { c } } }");
    const inline = parse("{ ... on Query { a { b { c } } } }");
    assert.equal(validate(depthSchema, plain, [maxDepthRule(2)]).length, 0);
    assert.equal(
      validate(depthSchema, inline, [maxDepthRule(2)]).length,
      0,
      "inline-wrapped query must measure the same depth as its inlined form",
    );
    // Transparency is not a free pass: limit 1 still rejects both equally.
    assert.equal(validate(depthSchema, plain, [maxDepthRule(1)]).length, 1);
    assert.equal(validate(depthSchema, inline, [maxDepthRule(1)]).length, 1);
  });

  test("complexity exceeded returns COMPLEXITY_LIMIT_EXCEEDED extension", async () => {
    // GRAPHQL_MAX_COMPLEXITY is 50. Build a query with many fields by using
    // inline fragments or repeating aliases to exceed the limit.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY + 1 },
      (_, i) => `f${i}: subnets { items { netuid } }`,
    ).join(" ");
    const { status, body } = await gql(`{ ${fields} }`);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });
});

describe("handleGraphQLRequest — introspection", () => {
  test("introspection query succeeds and includes Query type", async () => {
    const { status, body } = await gql("{ __schema { queryType { name } } }");
    assert.equal(status, 200);
    assert.equal(body.data.__schema.queryType.name, "Query");
  });

  test("__type on Subnet returns defined fields", async () => {
    const { status, body } = await gql(
      '{ __type(name: "Subnet") { fields { name } } }',
    );
    assert.equal(status, 200);
    const names = body.data.__type.fields.map((f) => f.name);
    assert.ok(names.includes("netuid"), `expected netuid, got: ${names}`);
    assert.ok(names.includes("name"), `expected name, got: ${names}`);
  });
});

describe("handleGraphQLRequest — resolvers (cold store)", () => {
  test("subnets returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ subnets { items { netuid } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnets, { items: [], total: 0 });
  });

  test("subnet returns null when artifact not found", async () => {
    const { status, body } = await gql("{ subnet(netuid: 1) { netuid name } }");
    assert.equal(status, 200);
    assert.equal(body.data.subnet, null);
  });

  test("providers returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ providers { items { id name } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.providers, { items: [], total: 0 });
  });

  test("provider returns null when artifact not found", async () => {
    const { status, body } = await gql('{ provider(id: "acme") { id name } }');
    assert.equal(status, 200);
    assert.equal(body.data.provider, null);
  });

  test("economics returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ economics { subnets { netuid } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.economics, { subnets: [], total: 0 });
  });
});

describe("handleGraphQLRequest — resolvers (injected data)", () => {
  test("subnets resolves items and total from fixture data", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "Alpha", slug: "alpha" },
          { netuid: 2, name: "Beta", slug: "beta" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets { items { netuid name slug } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.equal(body.data.subnets.items[0].netuid, 1);
    assert.equal(body.data.subnets.items[1].name, "Beta");
  });

  test("subnets pagination: limit and next_cursor", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets(limit: 2) { items { netuid } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.items.length, 2);
    assert.equal(body.data.subnets.next_cursor, "2");
    assert.equal(body.data.subnets.total, 3);
  });

  test("subnets limit:0 falls back to the default page (not clamped up to 1)", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    for (const limit of [0, -5]) {
      const { status, body } = await gql(
        `{ subnets(limit: ${limit}) { items { netuid } total } }`,
        env,
      );
      assert.equal(status, 200);
      assert.equal(body.data.subnets.items.length, 3, `limit:${limit}`);
      assert.equal(body.data.subnets.total, 3);
    }
  });

  test("subnets filters by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets(netuid: 2) { items { netuid name } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 2, name: "B" }]);
  });

  test("subnets filters by status (case-insensitive)", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a", status: "active" },
          { netuid: 2, name: "B", slug: "b", status: "inactive" },
          { netuid: 3, name: "C", slug: "c", status: "active" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(status: "Active") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.deepEqual(
      body.data.subnets.items.map((row) => row.netuid),
      [1, 3],
    );
  });

  test("subnets filters exclude rows missing the filtered field", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a", status: "active" },
          { netuid: 2, name: "B", slug: "b" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(status: "active") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 1 }]);
  });

  test("subnets filters by domain via derived_categories", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 1,
            name: "A",
            slug: "a",
            categories: ["inference"],
          },
          {
            netuid: 2,
            name: "B",
            slug: "b",
            derived_categories: ["training"],
          },
          {
            netuid: 3,
            name: "C",
            slug: "c",
            categories: ["other"],
          },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(domain: "training") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 2 }]);
  });

  test("subnet resolves a single subnet by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/7.json": {
        netuid: 7,
        name: "Tao Subnet",
        slug: "tao",
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 7) { netuid name slug } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.netuid, 7);
    assert.equal(body.data.subnet.name, "Tao Subnet");
  });

  test("subnet backfills the list-only computed metrics the detail artifact omits", async () => {
    // The detail artifact omits integration_readiness/official_surface_count/
    // gap_count/first_party, which only the list artifact computes. Without the
    // backfill the single-subnet path returns them null while `subnets` does not.
    const env = fixtureEnv({
      "/metagraph/subnets/7.json": {
        netuid: 7,
        name: "Detail Name",
        slug: "x",
      },
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 7,
            name: "List Name",
            integration_readiness: 86,
            official_surface_count: 0,
            gap_count: 0,
            first_party: false,
          },
        ],
      },
    });
    const { status, body } = await gql(
      `{ subnet(netuid: 7) {
        name
        integration_readiness
        official_surface_count
        gap_count
        first_party
      } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.subnet;
    assert.equal(s.integration_readiness, 86);
    assert.equal(s.official_surface_count, 0);
    assert.equal(s.gap_count, 0);
    assert.equal(s.first_party, false);
    // The detail artifact stays authoritative for identity on shared keys.
    assert.equal(s.name, "Detail Name");
  });

  test("providers normalises missing netuids to empty array", async () => {
    const env = fixtureEnv({
      "/metagraph/providers.json": {
        providers: [{ id: "acme", name: "Acme" }],
      },
    });
    const { status, body } = await gql(
      "{ providers { items { id netuids } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.providers.items[0].netuids, []);
  });

  test("provider resolves a valid slug id from the store", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme-1.0.json": { id: "acme-1.0", name: "Acme" },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme-1.0") { id name } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.provider.name, "Acme");
  });

  test("provider rejects a traversal/invalid id without reading any artifact", async () => {
    // The id is interpolated into the artifact path and the static-asset tier
    // collapses "../", so an unvalidated id could escape the providers/
    // namespace. The resolver must reject a non-slug id BEFORE touching storage.
    let reads = 0;
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          reads += 1;
          return null;
        },
      },
    };
    for (const id of ["../subnets", "../../economics", "a/b", "foo bar", ""]) {
      const { status, body } = await gql(
        `{ provider(id: ${JSON.stringify(id)}) { id name } }`,
        env,
      );
      assert.equal(status, 200, id);
      assert.equal(body.data.provider, null, id);
    }
    assert.equal(reads, 0, "no artifact read should happen for an invalid id");
  });

  test("economics returns subnet economics list", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [
          { netuid: 1, name: "Root", emission_share: 0.05, miner_count: 10 },
        ],
      },
    });
    const { status, body } = await gql(
      "{ economics { total subnets { netuid name emission_share miner_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.total, 1);
    assert.equal(body.data.economics.subnets[0].netuid, 1);
    assert.equal(body.data.economics.subnets[0].emission_share, 0.05);
  });

  test("economics exposes the network-value summary rollup (#6641)", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, name: "Alpha", emission_share: 1 }],
        summary: {
          subnet_count: 1,
          with_economics_count: 1,
          total_stake_tao: "1000.000000000",
          total_validators: 9,
          total_miners: 200,
          registration_open_count: 1,
          total_root_value_tao: "500.000000000",
          total_alpha_value_tao: "40.000000000",
          total_network_value_tao: "540.000000000",
        },
      },
    });
    const { status, body } = await gql(
      `{ economics { summary {
          total_root_value_tao total_alpha_value_tao total_network_value_tao
          subnet_count
        } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.economics.summary, {
      total_root_value_tao: "500.000000000",
      total_alpha_value_tao: "40.000000000",
      total_network_value_tao: "540.000000000",
      subnet_count: 1,
    });
  });

  test("economics.summary is null when the source artifact has none", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, name: "Alpha" }],
      },
    });
    const { status, body } = await gql(
      "{ economics { summary { subnet_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.summary, null);
  });
});

describe("handleGraphQLRequest — error envelope is never cacheable", () => {
  const post = (env) =>
    handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ subnets { items { netuid } total } }",
        }),
      }),
      env,
    );

  test("a clean POST keeps the success cache directive", async () => {
    const res = await post(emptyEnv);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  // A thrown artifact read surfaces in result.errors while execute() stays 200:
  // readR2 parses the body outside its try/catch, so the rejection propagates.
  test("a populated result.errors switches to no-store", async () => {
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              throw new Error("corrupt artifact body");
            },
          };
        },
      },
    };
    const res = await post(env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.errors?.length > 0);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("maxDepthRule / maxComplexityRule exports", () => {
  test("GRAPHQL_MAX_DEPTH is a positive integer", () => {
    assert.ok(Number.isInteger(GRAPHQL_MAX_DEPTH) && GRAPHQL_MAX_DEPTH > 0);
  });

  test("GRAPHQL_MAX_COMPLEXITY is a positive integer", () => {
    assert.ok(
      Number.isInteger(GRAPHQL_MAX_COMPLEXITY) && GRAPHQL_MAX_COMPLEXITY > 0,
    );
  });

  test("maxDepthRule returns a function", () => {
    assert.equal(typeof maxDepthRule(5), "function");
  });

  test("maxComplexityRule returns a function", () => {
    assert.equal(typeof maxComplexityRule(10), "function");
  });
});

describe("handleGraphQLRequest — coverage edge cases", () => {
  // Fragment definitions are non-operation nodes that depth/complexity rules
  // must skip over (def.kind !== "OperationDefinition").
  test("query with named operation and fragment definition succeeds", async () => {
    const q = `
      fragment SubnetFields on Subnet { netuid name }
      query GetSubnet { subnet(netuid: 1) { ...SubnetFields } }
    `;
    const { status, body } = await gql(q);
    assert.equal(status, 200);
    assert.ok("subnet" in body.data);
  });

  // Cursor not found in items → start stays 0 (no crash).
  test("subnets with an unresolvable cursor returns first page", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A" },
          { netuid: 2, name: "B" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(cursor: "999") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.items.length, 2);
  });

  // Data keys missing from artifact (subnets array absent → empty list).
  test("subnets artifact without subnets key returns empty list", async () => {
    const env = fixtureEnv({ "/metagraph/subnets.json": {} });
    const { status, body } = await gql("{ subnets { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 0);
  });

  // Providers artifact without providers key → empty list.
  test("providers artifact without providers key returns empty list", async () => {
    const env = fixtureEnv({ "/metagraph/providers.json": {} });
    const { status, body } = await gql("{ providers { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.providers.total, 0);
  });

  // Provider artifact with netuids present → returned as-is.
  test("provider artifact with netuids returns them", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        id: "acme",
        name: "Acme Corp",
        netuids: [1, 7],
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { netuids } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.netuids, [1, 7]);
  });
});

// Security hardening (#1: GraphQL must run through the rate limiter). GraphQL is
// POST-only and fans out into artifact reads, so it shares the strict RPC
// limiter binding. A counting limiter that allows the first N keyed hits and
// denies the rest models the Cloudflare binding closely enough to prove the
// gate fires on /api/v1/graphql.
function countingRateLimiterEnv(limit, extra = {}) {
  const counts = new Map();
  return {
    ...extra,
    RPC_RATE_LIMITER: {
      limit({ key }) {
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        return Promise.resolve({ success: next <= limit });
      },
    },
  };
}

const gqlPost = (env, headers = {}) =>
  handleRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: "{ __typename }" }),
    }),
    env,
    {},
  );

describe("handleRequest — GraphQL rate limiting (#security)", () => {
  test("N requests within the window pass, the N+1 returns 429", async () => {
    const N = 3;
    const env = countingRateLimiterEnv(N);
    // The first N requests are under the limit and reach the handler (200).
    for (let i = 0; i < N; i += 1) {
      const res = await gqlPost(env);
      assert.equal(res.status, 200, `request ${i + 1} should pass`);
    }
    // The N+1th request is over the limit -> 429 from the GraphQL gate.
    const limited = await gqlPost(env);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.error.code, "graphql_rate_limited");
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  });

  test("no limiter binding (local/CI) lets GraphQL through", async () => {
    // emptyEnv has no RPC_RATE_LIMITER; the gate must no-op, not 429.
    const res = await gqlPost(emptyEnv);
    assert.equal(res.status, 200);
  });

  test("a WebSocket upgrade bypasses the rate limiter entirely, even with an already-exhausted budget", async () => {
    const env = countingRateLimiterEnv(0); // every check() would fail
    let forwarded = false;
    env.CHAIN_FIREHOSE_HUB = {
      idFromName: () => "global",
      get: () => ({
        fetch: () => {
          forwarded = true;
          return new Response(null, { status: 200 });
        },
      }),
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        headers: { upgrade: "websocket" },
      }),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(forwarded, true);
  });
});

describe("client IP resolution — x-forwarded-for is not trusted (#security)", () => {
  test("resolveClientIp ignores x-forwarded-for, uses cf-connecting-ip only", () => {
    const sameCf = (xff) =>
      resolveClientIp(
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": xff,
          },
        }),
      );
    // Two forged XFF values, same trusted cf-connecting-ip -> identical key.
    assert.equal(sameCf("1.1.1.1"), sameCf("9.9.9.9"));
    assert.equal(sameCf("1.1.1.1"), "203.0.113.7");
  });

  test("absent cf-connecting-ip falls back to a fixed bucket, not the XFF header", () => {
    const key = resolveClientIp(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "x-forwarded-for": "attacker-controlled" },
      }),
    );
    assert.equal(key, "anonymous");
    assert.notEqual(key, "attacker-controlled");
  });

  test("two forged x-forwarded-for share ONE rate-limit bucket (2nd is limited)", async () => {
    // limit=1: the first request from cf-connecting-ip 203.0.113.7 passes; a
    // second request with the SAME cf-connecting-ip but a DIFFERENT forged
    // x-forwarded-for must be counted in the same bucket -> 429. If the forged
    // header were honored it would mint a fresh bucket and wrongly pass.
    const env = countingRateLimiterEnv(1);
    const first = await gqlPost(env, {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "10.0.0.1",
    });
    assert.equal(first.status, 200);
    const second = await gqlPost(env, {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "10.0.0.2",
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, "graphql_rate_limited");
  });
});

// --- Broadened registry coverage --------------------------------------------

describe("graphql — broadened Subnet + nested relationships", () => {
  test("subnet detail serves bundled surfaces/endpoints from one read; economics loads lazily", async () => {
    const reads = new Map();
    const env = fixtureEnv(
      {
        // The real detail artifact has no economics key (REST overlays it live),
        // but it does bundle surfaces/endpoints.
        "/metagraph/subnets/7.json": {
          subnet: {
            netuid: 7,
            name: "Allways",
            slug: "allways",
            categories: ["inference"],
            status: "active",
            integration_readiness: 80,
          },
          surfaces: [{ id: "s1", netuid: 7, kind: "subnet-api", status: "ok" }],
          endpoints: [{ id: "e1", netuid: 7, status: "ok", kind: "rpc" }],
        },
        "/metagraph/economics.json": {
          subnets: [{ netuid: 7, emission_share: 0.12, open_slots: 4 }],
        },
      },
      { reads },
    );
    const { status, body } = await gql(
      `{ subnet(netuid: 7) {
          netuid name slug categories status integration_readiness
          economics { netuid emission_share open_slots }
          surfaces { id kind status }
          endpoints { id kind status }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.subnet;
    assert.equal(s.netuid, 7);
    assert.equal(s.name, "Allways");
    assert.deepEqual(s.categories, ["inference"]);
    assert.equal(s.integration_readiness, 80);
    assert.equal(s.economics.emission_share, 0.12);
    assert.equal(s.surfaces[0].kind, "subnet-api");
    assert.equal(s.endpoints[0].id, "e1");
    // surfaces/endpoints came from the detail artifact (never read separately);
    // economics is not in it, so it loads lazily — once.
    assert.equal(reads.get("latest/subnets/7.json"), 1);
    assert.equal(reads.get("latest/economics.json"), 1);
    assert.equal(reads.has("latest/surfaces.json"), false);
    assert.equal(reads.has("latest/endpoints.json"), false);
  });

  test("subnet.health resolves from the live health snapshot by netuid", async () => {
    const env = fixtureEnv(
      {
        "/metagraph/subnets/7.json": { subnet: { netuid: 7, name: "Allways" } },
      },
      {
        kv: {
          [KV_HEALTH_CURRENT]: {
            subnets: [
              { netuid: 7, status: "ok", ok_count: 3, surface_count: 3 },
              { netuid: 8, status: "failed", ok_count: 0 },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ subnet(netuid: 7) { netuid health { status ok_count surface_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.health.status, "ok");
    assert.equal(body.data.subnet.health.ok_count, 3);
  });

  test("list items resolve economics/health by netuid, reading each source once (memoized)", async () => {
    const reads = new Map();
    const kvReads = new Map();
    const env = fixtureEnv(
      {
        "/metagraph/subnets.json": {
          subnets: [
            { netuid: 1, name: "A" },
            { netuid: 2, name: "B" },
          ],
        },
        "/metagraph/economics.json": {
          subnets: [
            { netuid: 1, emission_share: 0.1 },
            { netuid: 2, emission_share: 0.2 },
          ],
        },
      },
      {
        reads,
        kvReads,
        kv: {
          [KV_HEALTH_CURRENT]: {
            subnets: [
              { netuid: 1, status: "ok" },
              { netuid: 2, status: "degraded" },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ subnets { items { netuid economics { emission_share } health { status } } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.equal(body.data.subnets.items[0].economics.emission_share, 0.1);
    assert.equal(body.data.subnets.items[1].health.status, "degraded");
    // Two items, but the economics source and the live health snapshot are each
    // resolved exactly once.
    assert.equal(reads.get("latest/economics.json"), 1);
    assert.equal(kvReads.get(KV_HEALTH_CURRENT), 1);
  });

  test("provider.subnets resolves the provider's netuids to full subnet nodes", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        provider: { id: "acme", name: "Acme", netuids: [2, 1] },
      },
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { id netuids subnets { netuid name } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.netuids, [2, 1]);
    // Order follows the provider's netuids list.
    assert.equal(body.data.provider.subnets[0].netuid, 2);
    assert.equal(body.data.provider.subnets[1].name, "A");
  });
});

describe("graphql — surfaces / endpoints / health roots", () => {
  test("surfaces filters by netuid and paginates", async () => {
    const env = fixtureEnv({
      "/metagraph/surfaces.json": {
        surfaces: [
          { id: "s1", netuid: 1, kind: "subnet-api" },
          { id: "s2", netuid: 2, kind: "rpc" },
          { id: "s3", netuid: 1, kind: "sse" },
        ],
      },
    });
    const filtered = await gql(
      "{ surfaces(netuid: 1) { items { id netuid } total } }",
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.surfaces.total, 2);
    assert.ok(filtered.body.data.surfaces.items.every((s) => s.netuid === 1));

    const paged = await gql(
      "{ surfaces(limit: 1) { items { id } total next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.surfaces.items.length, 1);
    assert.equal(paged.body.data.surfaces.total, 3);
    assert.equal(paged.body.data.surfaces.next_cursor, "s1");
  });

  test("endpoints filters by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoints.json": {
        endpoints: [
          { id: "e1", netuid: 5, status: "ok" },
          { id: "e2", netuid: 6, status: "failed" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ endpoints(netuid: 6) { items { id status netuid } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.endpoints.total, 1);
    assert.equal(body.data.endpoints.items[0].id, "e2");
  });

  test("endpoints paginate, falling back to surface_id for the cursor when id is absent", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoints.json": {
        endpoints: [
          { surface_id: "x1", netuid: 1, status: "ok" }, // no id → cursor uses surface_id
          { id: "e2", netuid: 2, status: "failed" },
        ],
      },
    });
    const first = await gql(
      "{ endpoints(limit: 1) { items { status } total next_cursor } }",
      env,
    );
    assert.equal(first.body.data.endpoints.total, 2);
    assert.equal(first.body.data.endpoints.next_cursor, "x1");
    const second = await gql(
      '{ endpoints(limit: 1, cursor: "x1") { items { id } } }',
      env,
    );
    assert.equal(second.body.data.endpoints.items[0].id, "e2");
  });

  test("health lifts the live rollup and exposes per-subnet summaries", async () => {
    const env = fixtureEnv(
      {},
      {
        kv: {
          [KV_HEALTH_CURRENT]: {
            summary: { status: "degraded", ok_count: 40, surface_count: 50 },
            subnets: [
              { netuid: 1, status: "ok" },
              { netuid: 2, status: "failed" },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ health { status ok_count surface_count health_source subnets { netuid status } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.health.status, "degraded");
    assert.equal(body.data.health.ok_count, 40);
    assert.equal(body.data.health.health_source, "live-cron-prober");
    assert.equal(body.data.health.subnets.length, 2);
    assert.equal(body.data.health.subnets[1].status, "failed");
  });

  test("health returns null when the live store is cold", async () => {
    const { status, body } = await gql("{ health { status } }", emptyEnv);
    assert.equal(status, 200);
    assert.equal(body.data.health, null);
  });
});

// #6985: GraphQL parity for endpoint-pools/rpc-pools/endpoint-incidents, reusing
// list_endpoint_pools'/list_rpc_pools'/list_endpoint_incidents' own loaders
// unchanged (same filter/sort/page + error behavior as REST and MCP) rather than
// a GraphQL-only reimplementation.
describe("graphql — endpoint_pools / rpc_pools / endpoint_incidents", () => {
  const POOLS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    notes: "test",
    pools: [
      {
        id: "finney-rpc",
        kind: "subtensor-rpc",
        eligible_count: 2,
        endpoint_count: 5,
      },
      {
        id: "finney-wss",
        kind: "subtensor-wss",
        eligible_count: 8,
        endpoint_count: 10,
      },
      {
        id: "finney-archive",
        kind: "archive",
        eligible_count: 0,
        endpoint_count: 3,
      },
    ],
  };

  const INCIDENTS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    notes: ["probe-derived only"],
    summary: { incident_count: 2, active_count: 2 },
    incidents: [
      {
        id: "incident-a",
        endpoint_id: "a",
        netuid: 7,
        kind: "subnet-api",
        provider: "allways",
        status: "failed",
        severity: "critical",
        state: "active",
      },
      {
        id: "incident-b",
        endpoint_id: "b",
        netuid: 31,
        kind: "openapi",
        provider: "candles",
        status: "degraded",
        severity: "warning",
        state: "active",
      },
    ],
  };

  test("endpoint_pools filters by kind and paginates", async () => {
    const env = fixtureEnv({ "/metagraph/endpoint-pools.json": POOLS_BLOB });
    const filtered = await gql(
      '{ endpoint_pools(kind: "archive") { pools total } }',
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.endpoint_pools.total, 1);
    assert.equal(
      filtered.body.data.endpoint_pools.pools[0].id,
      "finney-archive",
    );

    const paged = await gql(
      "{ endpoint_pools(limit: 1) { pools total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.endpoint_pools.pools.length, 1);
    assert.equal(paged.body.data.endpoint_pools.total, 3);
    assert.equal(paged.body.data.endpoint_pools.returned, 1);
    assert.ok(paged.body.data.endpoint_pools.next_cursor != null);
  });

  test("endpoint_pools surfaces an invalid kind as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({ "/metagraph/endpoint-pools.json": POOLS_BLOB });
    const { body } = await gql(
      '{ endpoint_pools(kind: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("endpoint_pools surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ endpoint_pools { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("rpc_pools returns the same pools[] row shape via its own artifact", async () => {
    const env = fixtureEnv({ "/metagraph/rpc/pools.json": POOLS_BLOB });
    const { status, body } = await gql(
      '{ rpc_pools(sort: "eligible_count", order: "desc") { pools total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.rpc_pools.total, 3);
    assert.equal(body.data.rpc_pools.pools[0].id, "finney-wss");
  });

  test("rpc_pools applies the live 15-minute cron eligibility overlay before filtering", async () => {
    const env = fixtureEnv(
      { "/metagraph/rpc/pools.json": POOLS_BLOB },
      {
        kv: {
          [KV_HEALTH_RPC_POOL]: {
            endpoints: [],
            last_run_at: "2026-07-20T12:00:00.000Z",
          },
        },
      },
    );
    const { body } = await gql(
      "{ rpc_pools { source operational_observed_at } }",
      env,
    );
    assert.equal(body.data.rpc_pools.source, "live-cron-prober");
    assert.equal(
      body.data.rpc_pools.operational_observed_at,
      "2026-07-20T12:00:00.000Z",
    );
  });

  test("rpc_pools leaves source/operational_observed_at null with no live overlay", async () => {
    const env = fixtureEnv({ "/metagraph/rpc/pools.json": POOLS_BLOB });
    const { body } = await gql(
      "{ rpc_pools { source operational_observed_at } }",
      env,
    );
    assert.equal(body.data.rpc_pools.source, null);
    assert.equal(body.data.rpc_pools.operational_observed_at, null);
  });

  test("endpoint_incidents filters by severity and netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoint-incidents.json": INCIDENTS_BLOB,
    });
    const { status, body } = await gql(
      '{ endpoint_incidents(severity: "critical") { incidents total summary } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.endpoint_incidents.total, 1);
    assert.equal(body.data.endpoint_incidents.incidents[0].id, "incident-a");
    assert.equal(body.data.endpoint_incidents.summary.incident_count, 2);

    const byNetuid = await gql(
      "{ endpoint_incidents(netuid: 31) { incidents total } }",
      env,
    );
    assert.equal(byNetuid.body.data.endpoint_incidents.total, 1);
    assert.equal(
      byNetuid.body.data.endpoint_incidents.incidents[0].id,
      "incident-b",
    );
  });

  test("endpoint_incidents surfaces an invalid severity as a GraphQL error", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoint-incidents.json": INCIDENTS_BLOB,
    });
    const { body } = await gql(
      '{ endpoint_incidents(severity: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("FIELD_COMPLEXITY weights all three new fields like their sibling relationship fields", () => {
    for (const field of ["endpoint_pools", "rpc_pools", "endpoint_incidents"]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });
});

// #6986: GraphQL parity for source-snapshots, reusing list_source_snapshots'
// own loader unchanged (same filter/sort/page + error behavior as REST and
// MCP) rather than a GraphQL-only reimplementation.
describe("graphql — source_snapshots", () => {
  const SNAPSHOTS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    schema_version: 1,
    summary: { source_count: 2 },
    sources: [
      {
        id: "chain-events",
        kind: "db",
        path: "chain_events",
        record_count: 100,
        input_hash: "abc",
      },
      {
        id: "economics",
        kind: "kv",
        path: "economics.json",
        record_count: 50,
        input_hash: "def",
      },
    ],
  };

  test("filters by keyword across id/kind/path and paginates", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const filtered = await gql(
      '{ source_snapshots(q: "chain") { sources total generated_at } }',
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.source_snapshots.total, 1);
    assert.equal(
      filtered.body.data.source_snapshots.sources[0].id,
      "chain-events",
    );
    assert.equal(
      filtered.body.data.source_snapshots.generated_at,
      "2026-07-01T00:00:00.000Z",
    );

    const paged = await gql(
      "{ source_snapshots(limit: 1) { sources total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.source_snapshots.sources.length, 1);
    assert.equal(paged.body.data.source_snapshots.total, 2);
    assert.equal(paged.body.data.source_snapshots.returned, 1);
    assert.ok(paged.body.data.source_snapshots.next_cursor != null);
  });

  test("sorts by record_count and exposes summary/schema_version", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const { status, body } = await gql(
      '{ source_snapshots(sort: "record_count", order: "desc") { sources summary schema_version } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.source_snapshots.sources[0].id, "chain-events");
    assert.equal(body.data.source_snapshots.summary.source_count, 2);
    assert.equal(body.data.source_snapshots.schema_version, "1");
  });

  test("surfaces an invalid sort as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const { body } = await gql(
      '{ source_snapshots(sort: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ source_snapshots { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.source_snapshots, 5);
  });
});

describe("graphql — economics pagination", () => {
  const env = () =>
    fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [
          { netuid: 1, emission_share: 0.1 },
          { netuid: 2, emission_share: 0.2 },
          { netuid: 3, emission_share: 0.3 },
        ],
      },
    });

  test("limit + next_cursor page through the economics rows", async () => {
    const first = await gql(
      "{ economics(limit: 2) { subnets { netuid } total next_cursor } }",
      env(),
    );
    assert.equal(first.body.data.economics.subnets.length, 2);
    assert.equal(first.body.data.economics.total, 3);
    assert.equal(first.body.data.economics.next_cursor, "2");

    const second = await gql(
      '{ economics(limit: 2, cursor: "2") { subnets { netuid } next_cursor } }',
      env(),
    );
    assert.equal(second.body.data.economics.subnets.length, 1);
    assert.equal(second.body.data.economics.subnets[0].netuid, 3);
    assert.equal(second.body.data.economics.next_cursor, null);
  });

  test("prefers the fresh KV economics tier over the committed artifact", async () => {
    const env = fixtureEnv(
      // Stale committed copy — must NOT be served while the KV tier is fresh.
      {
        "/metagraph/economics.json": {
          subnets: [{ netuid: 9, emission_share: 1 }],
        },
      },
      {
        kv: {
          [KV_ECONOMICS_CURRENT]: {
            captured_at: new Date().toISOString(),
            subnets: [
              { netuid: 1, emission_share: 0.6 },
              { netuid: 2, emission_share: 0.4, alpha_market_cap_tao: 80 },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ economics { subnets { netuid alpha_market_cap_tao } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.total, 2);
    assert.deepEqual(
      body.data.economics.subnets.map((s) => s.netuid),
      [1, 2],
    );
    assert.equal(body.data.economics.subnets[0].alpha_market_cap_tao, null);
    assert.equal(body.data.economics.subnets[1].alpha_market_cap_tao, 80);
  });
});

describe("graphql — opportunity boards (reuse the leaderboard ranking)", () => {
  const env = () =>
    fixtureEnv({
      "/metagraph/economics.json": {
        captured_at: "2026-06-23T00:00:00.000Z",
        subnets: [
          {
            netuid: 1,
            slug: "a",
            name: "A",
            open_slots: 5,
            max_uids: 256,
            registration_cost_tao: 0.5,
            registration_allowed: true,
            emission_share: 0.1,
            total_stake_tao: 1000,
            validator_count: 10,
            max_validators: 64,
            miner_count: 50,
          },
          {
            netuid: 2,
            slug: "b",
            name: "B",
            open_slots: 0,
            registration_cost_tao: 0.2,
            registration_allowed: false,
            emission_share: 0.3,
            total_stake_tao: 2000,
            validator_count: 64,
            max_validators: 64,
            miner_count: 100,
          },
          {
            netuid: 3,
            slug: "c",
            name: "C",
            open_slots: 20,
            registration_cost_tao: 0.1,
            registration_allowed: true,
            emission_share: 0.05,
            total_stake_tao: 500,
            validator_count: 5,
            max_validators: 64,
            miner_count: 10,
          },
        ],
      },
    });

  test("boards rank by their economic metric", async () => {
    const { status, body } = await gql(
      `{ opportunity_boards {
          observed_at with_economics_count
          open_slots { netuid open_slots }
          highest_emission { netuid emission_share }
          cheapest_registration { netuid registration_cost_tao }
          validator_headroom { netuid validator_headroom }
        } }`,
      env(),
    );
    assert.equal(status, 200);
    const b = body.data.opportunity_boards;
    assert.equal(b.with_economics_count, 3);
    assert.equal(b.observed_at, "2026-06-23T00:00:00.000Z");
    // Most open slots first; the full subnet (open_slots 0) is dropped.
    assert.equal(b.open_slots[0].netuid, 3);
    assert.equal(b.open_slots[0].open_slots, 20);
    assert.equal(b.open_slots.length, 2);
    // Highest emission first.
    assert.equal(b.highest_emission[0].netuid, 2);
    // Cheapest open registration first (the closed subnet is excluded).
    assert.equal(b.cheapest_registration[0].netuid, 3);
    assert.ok(b.cheapest_registration.every((e) => e.netuid !== 2));
    // Most validator headroom first.
    assert.equal(b.validator_headroom[0].netuid, 3);
  });

  test("opportunity_boards degrades to empty boards on a cold store", async () => {
    const { status, body } = await gql(
      "{ opportunity_boards { with_economics_count open_slots { netuid } } }",
      emptyEnv,
    );
    assert.equal(status, 200);
    assert.equal(body.data.opportunity_boards.with_economics_count, 0);
    assert.deepEqual(body.data.opportunity_boards.open_slots, []);
  });
});

describe("graphql — complexity weights keep the guard meaningful", () => {
  test("FIELD_COMPLEXITY weights the read/fan-out fields above scalars", () => {
    for (const field of [
      "subnets",
      "subnet",
      "providers",
      "provider",
      "economics",
      "surfaces",
      "endpoints",
      "health",
      "opportunity_boards",
    ]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });

  test("a single weighted field trips a tight complexity budget", () => {
    const s = buildSchema(SDL);
    const doc = parse("{ health { status } }"); // 5 (health) + 1 (status) = 6
    assert.equal(validate(s, doc, [maxComplexityRule(6)]).length, 0);
    const errs = validate(s, doc, [maxComplexityRule(5)]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].extensions?.code, "COMPLEXITY_LIMIT_EXCEEDED");
  });

  test("the headline composition — one subnet with all its relationships — stays within budget", async () => {
    // The whole point of GraphQL here: a subnet + health + surfaces + endpoints
    // + economics in one shaped request must NOT trip the guard.
    const { status, body } = await gql(
      `{ subnet(netuid: 1) {
          netuid name slug
          health { status ok_count }
          surfaces { id kind status }
          endpoints { id kind status }
          economics { emission_share open_slots }
      } }`,
      emptyEnv,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet, null); // cold store, but the query was accepted
  });

  test("greedily pulling many fields of several relationships across the list exceeds the budget", async () => {
    // subnets(5) items(1) + four relationship containers (5 each = 20) + 28 leaf
    // fields = 55 > 50.
    const { status, body } = await gql(
      `{ subnets { items {
          economics { netuid emission_share alpha_market_cap_tao open_slots max_uids miner_count validator_count total_stake_tao }
          endpoints { id status kind url latency_ms last_ok score }
          health { status ok_count failed_count degraded_count unknown_count surface_count avg_latency_ms }
          surfaces { id key kind status url provider name }
      } } }`,
      emptyEnv,
    );
    assert.equal(status, 400);
    assert.ok(
      body.errors.find(
        (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
      ),
    );
  });
});

// --- Branch coverage for the changed resolvers/handler ----------------------

describe("graphql — resolver branch coverage", () => {
  test("a spread to an undefined fragment is handled by the depth/complexity guards", async () => {
    // frag is undefined, so the rules skip the spread instead of throwing.
    const { status } = await gql("{ ...Ghost }");
    assert.equal(status, 400); // unknown-fragment validation error, no crash
  });

  test("list-item surfaces/endpoints resolve lazily by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": { subnets: [{ netuid: 1, name: "A" }] },
      "/metagraph/surfaces.json": {
        surfaces: [
          { id: "s1", netuid: 1, kind: "subnet-api" },
          { id: "s2", netuid: 2, kind: "rpc" },
        ],
      },
      "/metagraph/endpoints.json": {
        endpoints: [{ id: "e1", netuid: 1, status: "ok" }],
      },
    });
    const { status, body } = await gql(
      "{ subnets { items { netuid surfaces { id } endpoints { id } } } }",
      env,
    );
    assert.equal(status, 200);
    const item = body.data.subnets.items[0];
    assert.deepEqual(
      item.surfaces.map((s) => s.id),
      ["s1"],
    );
    assert.deepEqual(
      item.endpoints.map((e) => e.id),
      ["e1"],
    );
  });

  test("a null bundled surfaces/endpoints list resolves to an empty list", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/3.json": {
        subnet: { netuid: 3, name: "C" },
        surfaces: null,
        endpoints: null,
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 3) { surfaces { id } endpoints { id } } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet.surfaces, []);
    assert.deepEqual(body.data.subnet.endpoints, []);
  });

  test("subnet.economics is null when the netuid has no economics row", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/5.json": { subnet: { netuid: 5, name: "E" } },
      "/metagraph/economics.json": {
        subnets: [{ netuid: 9, emission_share: 1 }],
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 5) { economics { emission_share } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.economics, null);
  });

  test("provider.subnets is empty when the provider lists no netuids", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/solo.json": {
        provider: { id: "solo", name: "Solo", netuids: [] },
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "solo") { subnets { netuid } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.subnets, []);
  });

  test("providers paginate with an id cursor", async () => {
    const env = fixtureEnv({
      "/metagraph/providers.json": {
        providers: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ providers(limit: 1) { items { id } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.providers.total, 2);
    assert.equal(body.data.providers.next_cursor, "a");
  });

  test("surfaces paginate, falling back to key for the cursor when id is absent", async () => {
    const env = fixtureEnv({
      "/metagraph/surfaces.json": {
        surfaces: [
          { key: "k1", netuid: 1, kind: "sse" }, // no id → cursor uses key
          { id: "s2", netuid: 1, kind: "rpc" },
        ],
      },
    });
    const first = await gql(
      "{ surfaces(limit: 1) { items { kind } total next_cursor } }",
      env,
    );
    assert.equal(first.body.data.surfaces.total, 2);
    assert.equal(first.body.data.surfaces.next_cursor, "k1");
  });

  test("invalid Content-Length is rejected before the body is read", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "-1" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors[0].message.includes("Content-Length"));
  });

  test("a POST with no body returns a missing-query error", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors[0].message.includes("query"));
  });

  test("OPTIONS /mcp advertises GET, POST, DELETE, OPTIONS (the sibling CORS branch, #4983 MCP half)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "OPTIONS" }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, POST, DELETE, OPTIONS",
    );
  });

  test("OPTIONS /api/v1/ask advertises POST, OPTIONS (the other CORS operand)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/ask", { method: "OPTIONS" }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
  });

  test("OPTIONS on a default route keeps the read-only CORS methods", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets", {
        method: "OPTIONS",
      }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
  });

  test("an in-bounds Content-Length is accepted and the body is read", async () => {
    const payload = JSON.stringify({ query: "{ __typename }" });
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(payload).byteLength),
      },
      body: payload,
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { __typename: "Query" } });
  });
});

describe("graphql — compare (reuse the shared compare loader)", () => {
  const profilesEnv = (extra = {}, opts = {}) =>
    fixtureEnv(
      {
        "/metagraph/profiles.json": {
          profiles: [
            {
              netuid: 1,
              slug: "a",
              name: "A",
              completeness_score: 90,
              surface_count: 4,
              operational_interface_count: 2,
            },
            {
              netuid: 2,
              slug: "b",
              name: "B",
              completeness_score: 50,
              surface_count: 1,
              operational_interface_count: 0,
            },
          ],
        },
        ...extra,
      },
      opts,
    );

  test("default dimensions: structure + economics + health side by side", async () => {
    const env = profilesEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, emission_share: 0.1, open_slots: 5 }],
      },
    });
    const { status, body } = await gql(
      `{ compare(netuids: [1, 99]) {
          schema_version dimensions requested_netuids
          subnets { netuid found
            structure { completeness_score surface_count }
            economics { emission_share open_slots }
            health { ok_count }
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const c = body.data.compare;
    assert.equal(c.schema_version, 1);
    assert.deepEqual(c.dimensions, ["structure", "economics", "health"]);
    assert.deepEqual(c.requested_netuids, [1, 99]);
    // Requested order is preserved.
    assert.equal(c.subnets[0].netuid, 1);
    assert.equal(c.subnets[0].found, true);
    assert.equal(c.subnets[0].structure.completeness_score, 90);
    assert.equal(c.subnets[0].economics.emission_share, 0.1);
    // No D1 binding → health is null, not an error.
    assert.equal(c.subnets[0].health, null);
    // Unknown netuid → found:false, all dimension blocks null.
    assert.equal(c.subnets[1].netuid, 99);
    assert.equal(c.subnets[1].found, false);
    assert.equal(c.subnets[1].structure, null);
    assert.equal(c.subnets[1].economics, null);
  });

  test("explicit dimensions subset skips the economics read", async () => {
    const reads = new Map();
    const env = profilesEnv({}, { reads });
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["structure"]) {
          dimensions subnets { structure { surface_count } economics { emission_share } }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.compare.dimensions, ["structure"]);
    assert.equal(body.data.compare.subnets[0].structure.surface_count, 4);
    assert.equal(body.data.compare.subnets[0].economics, null);
    // economics dimension excluded → no economics artifact read.
    assert.equal(reads.has("latest/economics.json"), false);
  });

  test("observed_at is stamped from the health:meta KV freshness", async () => {
    const env = profilesEnv(
      {},
      { kv: { [KV_HEALTH_META]: { last_run_at: "2026-06-23T00:00:00.000Z" } } },
    );
    const { body } = await gql(
      `{ compare(netuids: [1], dimensions: ["structure"]) { observed_at } }`,
      env,
    );
    assert.equal(body.data.compare.observed_at, "2026-06-23T00:00:00.000Z");
  });

  // D1 fully eliminated (2026-07-17): surface_status is Postgres-only now, so
  // the health dimension is always empty -- even a "warm" D1 mock (real rows)
  // must not change the response.
  test("never queries D1 even when mocked with real rows: health dimension is always null", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        throw new Error("D1 must not be queried -- surface_status is retired");
      },
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) {
          subnets { netuid health { surface_count ok_count avg_latency_ms } }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("a D1 result with no rows yields null health (results || [] fallback)", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) { subnets { health { ok_count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("a D1 error degrades the health dimension to null (no throw)", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        throw new Error("db unavailable");
      },
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) { subnets { health { ok_count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("invalid netuids (empty / negative) returns BAD_USER_INPUT", async () => {
    const empty = await gql("{ compare(netuids: []) { schema_version } }");
    assert.equal(empty.status, 200);
    assert.ok(
      empty.body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
    );
    const neg = await gql("{ compare(netuids: [-1]) { schema_version } }");
    assert.ok(
      neg.body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
    );
  });

  test("an unknown dimension returns BAD_USER_INPUT", async () => {
    const { body } = await gql(
      '{ compare(netuids: [1], dimensions: ["bogus"]) { schema_version } }',
    );
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("cold store: no profiles/economics artifacts → found:false, empty rows", async () => {
    // emptyEnv: readArtifact always ok:false, so profiles and economics both
    // resolve to [] (the fallback arms), observed_at is null, and every
    // requested netuid is reported found:false with null dimension blocks.
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["economics"]) {
          observed_at subnets { netuid found economics { emission_share } }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.observed_at, null);
    assert.equal(body.data.compare.subnets[0].found, false);
    assert.equal(body.data.compare.subnets[0].economics, null);
  });

  test("compare is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.compare, 5);
  });
});

describe("graphql — sudo (#5895, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("sudo: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ sudo { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.sudo, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("sudo: resolves Postgres-tier rows from the Sudo feed, JSON-encoding call_args", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 9,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"b".repeat(64)}`,
              signer: "5Sudo",
              call_module: "Sudo",
              call_function: "sudo",
              call_args: [{ name: "call", value: "setWeights" }],
              success: true,
              fee_tao: 0,
              tip_tao: 0,
              observed_at: "2026-07-15T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ sudo { items { block_number call_module call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.sudo.total, 1);
    assert.equal(body.data.sudo.next_cursor, "cursor-1");
    const item = body.data.sudo.items[0];
    assert.equal(item.call_module, "Sudo");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "call", value: "setWeights" }]),
    );
  });

  test("sudo: hits /api/v1/sudo and forwards filters, never signer/call_module", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ sudo(limit: 5, offset: 2, block: 42, call_function: "sudo", success: true) { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/sudo");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "2");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(capturedUrl.searchParams.get("call_function"), "sudo");
    assert.equal(capturedUrl.searchParams.get("success"), "true");
    // The route fixes call_module=Sudo, so the field exposes neither arg.
    assert.equal(capturedUrl.searchParams.get("call_module"), null);
    assert.equal(capturedUrl.searchParams.get("signer"), null);
  });

  test("sudo: a cursor arg is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ sudo(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("sudo: a negative block filter is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql("{ sudo(block: -1) { total } }", env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("sudo: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ sudo { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.sudo, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });
});

describe("graphql — extrinsics / extrinsic (#5580, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("extrinsics: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ extrinsics { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.extrinsics, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("extrinsics: resolves Postgres-tier rows, JSON-encoding call_args", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 5,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"a".repeat(64)}`,
              signer: "5Signer",
              call_module: "SubtensorModule",
              call_function: "register",
              call_args: [{ name: "netuid", value: 1 }],
              success: true,
              fee_tao: 0.001,
              tip_tao: 0,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ extrinsics { items { block_number call_module call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsics.total, 1);
    assert.equal(body.data.extrinsics.next_cursor, "cursor-1");
    const item = body.data.extrinsics.items[0];
    assert.equal(item.call_module, "SubtensorModule");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("extrinsics: filter args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ extrinsics(limit: 5, block: 42, signer: "5Signer", call_module: "SubtensorModule", call_function: "register", success: true) { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/extrinsics");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(capturedUrl.searchParams.get("signer"), "5Signer");
    assert.equal(
      capturedUrl.searchParams.get("call_module"),
      "SubtensorModule",
    );
    assert.equal(capturedUrl.searchParams.get("call_function"), "register");
    assert.equal(capturedUrl.searchParams.get("success"), "true");
  });

  test("extrinsics: a cursor arg is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ extrinsics(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("extrinsics: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ extrinsics { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.extrinsics, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("extrinsic: a malformed Postgres-tier body falls back to the requested ref", async () => {
    const ref = "5-2";
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic, null);
  });

  test("extrinsics: a negative block filter is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      "{ extrinsics(block: -1) { total } }",
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("extrinsic: unresolved ref returns extrinsic:null, never a GraphQL error", async () => {
    const ref = `0x${"a".repeat(64)}`;
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic, null);
  });

  test("extrinsic: resolves a Postgres-tier row by composite ref", async () => {
    const ref = "5-2";
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ref,
          extrinsic: {
            block_number: 5,
            extrinsic_index: 2,
            extrinsic_hash: null,
            signer: "5Signer",
            call_module: "SubtensorModule",
            call_function: "set_weights",
            call_args: null,
            success: true,
            fee_tao: 0,
            tip_tao: 0,
            observed_at: "2026-07-14T00:00:00.000Z",
          },
          events: [],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module call_function } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic.call_module, "SubtensorModule");
    assert.equal(body.data.extrinsic.extrinsic.call_function, "set_weights");
  });

  test("extrinsics / extrinsic are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.extrinsics, 5);
    assert.equal(FIELD_COMPLEXITY.extrinsic, 5);
  });
});

describe("graphql — governance_config_changes (#5897, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("governance_config_changes: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ governance_config_changes { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.governance_config_changes, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("governance_config_changes: resolves Postgres-tier AdminUtils rows", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 5,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"a".repeat(64)}`,
              signer: null,
              call_module: "AdminUtils",
              call_function: "sudo_set_weights_set_rate_limit",
              call_args: [{ name: "netuid", value: 1 }],
              success: true,
              fee_tao: 0,
              tip_tao: 0,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ governance_config_changes { items { block_number call_module call_function call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.governance_config_changes.total, 1);
    assert.equal(body.data.governance_config_changes.next_cursor, "cursor-1");
    const item = body.data.governance_config_changes.items[0];
    assert.equal(item.call_module, "AdminUtils");
    assert.equal(item.call_function, "sudo_set_weights_set_rate_limit");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("governance_config_changes: a partial Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      // Body omits extrinsics / extrinsic_count / next_cursor entirely -- the
      // resolver must fall back to [] / 0 / null rather than surface undefined.
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ governance_config_changes { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.governance_config_changes, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("governance_config_changes: filter args are forwarded to the /governance/config-changes path (loader reuse, no signer/call_module)", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ governance_config_changes(limit: 5, block: 42, call_function: "sudo_set_tempo", success: true) { total } }`,
      env,
    );
    // The worker fixes call_module=AdminUtils by path, so the resolver hits the
    // governance route (not /extrinsics) and never forwards signer/call_module.
    assert.equal(capturedUrl.pathname, "/api/v1/governance/config-changes");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(
      capturedUrl.searchParams.get("call_function"),
      "sudo_set_tempo",
    );
    assert.equal(capturedUrl.searchParams.get("success"), "true");
    assert.equal(capturedUrl.searchParams.get("signer"), null);
    assert.equal(capturedUrl.searchParams.get("call_module"), null);
  });

  test("governance_config_changes: a cursor arg is forwarded as a query param", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ governance_config_changes(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("governance_config_changes: rejects a negative block with BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      "{ governance_config_changes(block: -1) { total } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("governance_config_changes is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.governance_config_changes, 5);
  });
});

describe("graphql — blocks / block (#5575, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("blocks: cold/no-tier store returns a schema-stable empty page (fallback builder, production steady state)", async () => {
    const { status, body } = await gql(
      "{ blocks { items { block_number } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("blocks: resolves Postgres-tier rows into the block feed", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          block_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          blocks: [
            {
              block_number: 123,
              block_hash: `0x${"b".repeat(64)}`,
              parent_hash: `0x${"a".repeat(64)}`,
              author: "5Author",
              extrinsic_count: 3,
              event_count: 7,
              spec_version: 200,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ blocks { items { block_number block_hash extrinsic_count event_count } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.blocks.total, 1);
    assert.equal(body.data.blocks.next_cursor, "cursor-1");
    const item = body.data.blocks.items[0];
    assert.equal(item.block_number, 123);
    assert.equal(item.extrinsic_count, 3);
    assert.equal(item.event_count, 7);
  });

  test("blocks: limit/offset/cursor are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            block_count: 0,
            limit: 5,
            offset: 10,
            next_cursor: null,
            blocks: [],
          });
        },
      },
    };
    await gql(
      `{ blocks(limit: 5, offset: 10, cursor: "abc123") { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/blocks");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("blocks: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ blocks { items { block_number } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("block: resolves a Postgres-tier row by numeric height, with chain-walk nav", async () => {
    const ref = "123";
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ref,
          block: {
            block_number: 123,
            block_hash: `0x${"b".repeat(64)}`,
            parent_hash: `0x${"a".repeat(64)}`,
            author: "5Author",
            extrinsic_count: 3,
            event_count: 7,
            spec_version: 200,
            observed_at: "2026-07-14T00:00:00.000Z",
          },
          prev_block_number: 122,
          next_block_number: 124,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number spec_version } prev_block_number next_block_number } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block.block_number, 123);
    assert.equal(body.data.block.block.spec_version, 200);
    assert.equal(body.data.block.prev_block_number, 122);
    assert.equal(body.data.block.next_block_number, 124);
  });

  test("block: resolves a Postgres-tier row by 0x block hash", async () => {
    const ref = `0x${"b".repeat(64)}`;
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ref,
            block: {
              block_number: 123,
              block_hash: ref,
              parent_hash: null,
              author: null,
              extrinsic_count: 0,
              event_count: 0,
              spec_version: 200,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
            prev_block_number: null,
            next_block_number: null,
          });
        },
      },
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number block_hash } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, `/api/v1/blocks/${ref}`);
    assert.equal(body.data.block.block.block_number, 123);
    assert.equal(body.data.block.block.block_hash, ref);
  });

  test("block: unresolved ref returns block:null, never a GraphQL error", async () => {
    const ref = `0x${"c".repeat(64)}`;
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number } prev_block_number next_block_number } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block, null);
    assert.equal(body.data.block.prev_block_number, null);
    assert.equal(body.data.block.next_block_number, null);
  });

  test("block: a malformed Postgres-tier body falls back to the requested ref", async () => {
    const ref = "123";
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block, null);
  });

  test("blocks / block are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.blocks, 5);
    assert.equal(FIELD_COMPLEXITY.block, 5);
  });
});

describe("graphql — validators / validator (#5573, Postgres-tier leaderboard)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("validators: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ validators { items { hotkey } total sort captured_at block_number } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validators, {
      items: [],
      total: 0,
      sort: "subnet_count",
      captured_at: null,
      block_number: null,
    });
  });

  test("validators: resolves Postgres-tier rows, normalizing latest_* into captured_at/block_number", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          sort: "total_stake",
          limit: 20,
          captured_at: "2026-07-14T00:00:00.000Z",
          block_number: 100,
          validator_count: 1,
          validators: [
            {
              hotkey: "5Validator",
              featured: true,
              coldkey: "5Coldkey",
              coldkey_identity: { has_identity: false },
              coldkey_count: 1,
              subnet_count: 1,
              uid_count: 1,
              take: 0.1,
              total_stake_tao: 1000,
              root_stake_tao: 0,
              alpha_stake_tao: 1000,
              total_emission_tao: 5,
              nominator_count: 3,
              apy_estimate: 0.12,
              apy_estimate_eligible_subnet_count: 1,
              avg_validator_trust: 0.9,
              max_validator_trust: 0.9,
              latest_captured_at: "2026-07-14T00:00:00.000Z",
              latest_block_number: 100,
              subnets: [
                {
                  netuid: 1,
                  uid: 5,
                  stake_tao: 1000,
                  emission_tao: 5,
                  validator_trust: 0.9,
                },
              ],
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ validators(sort: "total_stake", limit: 5) { items { hotkey featured coldkey nominator_count captured_at block_number subnets { netuid uid stake_tao } } total sort captured_at block_number } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.validators.total, 1);
    assert.equal(body.data.validators.sort, "total_stake");
    assert.equal(body.data.validators.captured_at, "2026-07-14T00:00:00.000Z");
    assert.equal(body.data.validators.block_number, 100);
    const item = body.data.validators.items[0];
    assert.equal(item.hotkey, "5Validator");
    assert.equal(item.featured, true);
    assert.equal(item.nominator_count, 3);
    assert.equal(item.captured_at, "2026-07-14T00:00:00.000Z");
    assert.equal(item.block_number, 100);
    assert.deepEqual(item.subnets, [{ netuid: 1, uid: 5, stake_tao: 1000 }]);
  });

  test("validators: sort and limit args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "uid_count",
            limit: 5,
            captured_at: null,
            block_number: null,
            validator_count: 0,
            validators: [],
          });
        },
      },
    };
    await gql('{ validators(sort: "uid_count", limit: 5) { total } }', env);
    assert.equal(capturedUrl.pathname, "/api/v1/validators");
    assert.equal(capturedUrl.searchParams.get("sort"), "uid_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
  });

  test("validators: an omitted limit forwards the default limit to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "subnet_count",
            limit: 20,
            captured_at: null,
            block_number: null,
            validator_count: 0,
            validators: [],
          });
        },
      },
    };
    await gql("{ validators { total } }", env);
    assert.equal(capturedUrl.searchParams.get("sort"), "subnet_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "20");
  });

  test("validators: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ validators { items { hotkey } total sort captured_at block_number } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validators, {
      items: [],
      total: 0,
      sort: "subnet_count",
      captured_at: null,
      block_number: null,
    });
  });

  test("validators: an unsupported sort value is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ validators(sort: "not_a_real_sort") { total } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("validator: a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null", async () => {
    const { status, body } = await gql(
      '{ validator(hotkey: "5NoRows") { hotkey featured subnet_count total_stake_tao captured_at block_number subnets { netuid } } }',
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.validator, {
      hotkey: "5NoRows",
      featured: false,
      subnet_count: 0,
      total_stake_tao: 0,
      captured_at: null,
      block_number: null,
      subnets: [],
    });
  });

  test("validator: resolves Postgres-tier detail data, normalizing captured_at/block_number", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          hotkey: "5Validator",
          coldkey: "5Coldkey",
          coldkey_identity: { has_identity: false },
          coldkey_count: 1,
          subnet_count: 2,
          take: 0.1,
          total_stake_tao: 2000,
          root_stake_tao: 500,
          alpha_stake_tao: 1500,
          total_emission_tao: 8,
          nominator_count: null,
          apy_estimate: null,
          apy_estimate_eligible_subnet_count: 0,
          avg_validator_trust: 0.8,
          max_validator_trust: 0.85,
          captured_at: "2026-07-14T01:00:00.000Z",
          block_number: 200,
          subnets: [
            { netuid: 1, uid: 5, stake_tao: 500, emission_tao: 2 },
            { netuid: 3, uid: 9, stake_tao: 1500, emission_tao: 6 },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ validator(hotkey: "5Validator") { hotkey subnet_count captured_at block_number subnets { netuid stake_tao } } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.validator.hotkey, "5Validator");
    assert.equal(body.data.validator.subnet_count, 2);
    assert.equal(body.data.validator.captured_at, "2026-07-14T01:00:00.000Z");
    assert.equal(body.data.validator.block_number, 200);
    assert.deepEqual(body.data.validator.subnets, [
      { netuid: 1, stake_tao: 500 },
      { netuid: 3, stake_tao: 1500 },
    ]);
  });

  test("validators / validator are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.validators, 5);
    assert.equal(FIELD_COMPLEXITY.validator, 5);
  });
});

describe("graphql — account_position_history (#5889, Postgres-tier + empty-points fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty-points card, never null", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 1) {
          schema_version ss58 netuid window point_count points { snapshot_date }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_position_history, {
      schema_version: 1,
      ss58: SS58,
      netuid: 1,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier points for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          netuid: 5,
          window: "90d",
          point_count: 1,
          points: [
            {
              snapshot_date: "2026-07-01",
              captured_at: "2026-07-01T00:00:00.000Z",
              uid: 3,
              coldkey: "5Cold",
              role: "validator",
              active: true,
              stake_tao: 1000,
              emission_tao: 4,
              rank: 0.1,
              trust: 0.2,
              incentive: 0.3,
              dividends: 0.4,
              yield: 0.004,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 5, window: "90d") {
          ss58 netuid window point_count
          points { snapshot_date captured_at uid coldkey role active stake_tao emission_tao rank trust incentive dividends yield }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.account_position_history;
    assert.equal(r.netuid, 5);
    assert.equal(r.window, "90d");
    assert.equal(r.point_count, 1);
    assert.equal(r.points[0].role, "validator");
    assert.equal(r.points[0].stake_tao, 1000);
    assert.equal(r.points[0].yield, 0.004);
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the tier", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "not-an-ss58", netuid: 1) { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("an out-of-range netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 99999) { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 5, window: "7d") { window } }`,
      env,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(
      capturedUrl.pathname.endsWith(`/accounts/${SS58}/subnets/5/history`),
    );
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 3, window: "30d") {
          schema_version ss58 netuid window point_count points { snapshot_date }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_position_history, {
      schema_version: 1,
      ss58: SS58,
      netuid: 3,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 1, window: "99d") { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });
});

describe("graphql — subnet_turnover (#5886, Postgres-tier + empty-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }
  const EMPTY = {
    schema_version: 1,
    netuid: 1,
    window: "30d",
    start_date: null,
    end_date: null,
    comparable: false,
    validators_start: 0,
    validators_end: 0,
    validators_entered: 0,
    validators_exited: 0,
    validator_retention: null,
    neurons_start: 0,
    neurons_end: 0,
    uids_deregistered: 0,
    neuron_retention: null,
    stability_score: null,
  };
  const ALL_FIELDS =
    "schema_version netuid window start_date end_date comparable validators_start validators_end validators_entered validators_exited validator_retention neurons_start neurons_end uids_deregistered neuron_retention stability_score";

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1) { ${ALL_FIELDS} } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_turnover, EMPTY);
  });

  test("resolves the Postgres-tier scorecard for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "90d",
          start_date: "2026-04-01",
          end_date: "2026-06-30",
          comparable: true,
          validators_start: 10,
          validators_end: 12,
          validators_entered: 3,
          validators_exited: 1,
          validator_retention: 0.9,
          neurons_start: 100,
          neurons_end: 110,
          uids_deregistered: 4,
          neuron_retention: 0.85,
          stability_score: 88,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 5, window: "90d") { ${ALL_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_turnover;
    assert.equal(r.netuid, 5);
    assert.equal(r.window, "90d");
    assert.equal(r.comparable, true);
    assert.equal(r.validators_entered, 3);
    assert.equal(r.validator_retention, 0.9);
    assert.equal(r.stability_score, 88);
  });

  test("window + netuid are forwarded to the Postgres tier route", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(`{ subnet_turnover(netuid: 7, window: "7d") { window } }`, env);
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(capturedUrl.pathname.endsWith("/subnets/7/turnover"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1, window: "30d") { ${ALL_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_turnover, EMPTY);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1, window: "99d") { comparable } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("an out-of-range netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 99999) { comparable } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });
});

describe("graphql — validator_history (#5710, Postgres-tier + empty-points fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no neuron_daily rows returns a schema-stable empty-points card, never null", async () => {
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5NoRows") {
          schema_version hotkey window point_count points { snapshot_date }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.validator_history, {
      schema_version: 1,
      hotkey: "5NoRows",
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier points for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          hotkey: "5Validator",
          window: "90d",
          point_count: 1,
          points: [
            {
              snapshot_date: "2026-07-01",
              subnet_count: 2,
              total_stake_tao: 1000,
              total_emission_tao: 4,
              rewards_per_1000_tao: 4,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5Validator", window: "90d") {
          hotkey window point_count
          points { snapshot_date subnet_count total_stake_tao total_emission_tao rewards_per_1000_tao }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.validator_history;
    assert.equal(r.hotkey, "5Validator");
    assert.equal(r.window, "90d");
    assert.equal(r.point_count, 1);
    assert.deepEqual(r.points, [
      {
        snapshot_date: "2026-07-01",
        subnet_count: 2,
        total_stake_tao: 1000,
        total_emission_tao: 4,
        rewards_per_1000_tao: 4,
      },
    ]);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ validator_history(hotkey: "5Validator", window: "7d") { window } }',
      env,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(capturedUrl.pathname.endsWith("/validators/5Validator/history"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5Validator", window: "30d") {
          schema_version hotkey window point_count points { snapshot_date }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validator_history, {
      schema_version: 1,
      hotkey: "5Validator",
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ validator_history(hotkey: "5Validator", window: "99d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.validator_history ?? null, null);
  });

  test("validator_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.validator_history, 5);
  });
});

describe("graphql — subnet_trajectory (#5887, Postgres-tier + D1-live fallback)", () => {
  const trajectoryQuery = `{ subnet_trajectory(netuid: 3) {
    schema_version netuid point_count
    points { date completeness_score surface_count total_stake_tao }
    deltas { window from_date to_date completeness_score tao_in_pool_tao }
  } }`;

  const P1 = {
    date: "2026-07-01",
    completeness_score: 50,
    surface_count: 4,
    endpoint_count: 2,
    validator_count: null,
    miner_count: null,
    total_stake_tao: 100,
    alpha_price_tao: null,
    emission_share: null,
    tao_in_pool_tao: 10,
    alpha_in_pool: null,
    alpha_out_pool: null,
    subnet_volume_tao: null,
  };
  const P2 = {
    ...P1,
    date: "2026-07-08",
    completeness_score: 60,
    tao_in_pool_tao: 15,
  };

  test("cold store: schema-stable empty trajectory", async () => {
    const { status, body } = await gql(trajectoryQuery);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_trajectory, {
      schema_version: 1,
      netuid: 3,
      point_count: 0,
      points: [],
      deltas: [],
    });
  });

  test("resolves Postgres-tier data and flattens the window-keyed deltas map to a labelled list", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            netuid: 3,
            point_count: 2,
            points: [P1, P2],
            deltas: {
              "7d": {
                from_date: "2026-07-01",
                to_date: "2026-07-08",
                completeness_score: 10,
                surface_count: 0,
                endpoint_count: 0,
                tao_in_pool_tao: 5,
                alpha_in_pool: null,
                alpha_out_pool: null,
              },
              "30d": null,
            },
          });
        },
      },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/subnets/3/trajectory");
    assert.equal(body.data.subnet_trajectory.point_count, 2);
    assert.equal(body.data.subnet_trajectory.points[0].date, "2026-07-01");
    assert.equal(body.data.subnet_trajectory.points[1].completeness_score, 60);
    // The window-keyed map becomes a list; the null 30d entry is dropped and
    // the 7d entry carries its label.
    assert.equal(body.data.subnet_trajectory.deltas.length, 1);
    assert.equal(body.data.subnet_trajectory.deltas[0].window, "7d");
    assert.equal(body.data.subnet_trajectory.deltas[0].completeness_score, 10);
    assert.equal(body.data.subnet_trajectory.deltas[0].tao_in_pool_tao, 5);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty trajectory", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.equal(body.data.subnet_trajectory.point_count, 0);
    assert.deepEqual(body.data.subnet_trajectory.points, []);
    assert.deepEqual(body.data.subnet_trajectory.deltas, []);
  });

  // D1 fully eliminated (2026-07-17): subnet_snapshots is Postgres-only now,
  // so a tier miss always yields an empty trajectory -- even a "warm" D1 mock
  // (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty trajectory", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- subnet_snapshots is retired",
          );
        },
      },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_trajectory, {
      schema_version: 1,
      netuid: 3,
      point_count: 0,
      points: [],
      deltas: [],
    });
  });

  test("subnet_trajectory is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_trajectory, 5);
  });
});

describe("graphql — subnet_identity_history (#5721, Postgres-tier + empty timeline fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no D1 rows returns a schema-stable empty timeline, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 1) {
          schema_version netuid entry_count limit offset next_cursor
          entries { subnet_name identity_hash }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_identity_history, {
      schema_version: 1,
      netuid: 1,
      entry_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
  });

  test("resolves the Postgres-tier timeline entries", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          entry_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: null,
          entries: [
            {
              block_number: 4200,
              observed_at: "2026-07-01T00:00:00.000Z",
              subnet_name: "Example",
              symbol: "EX",
              description: "desc",
              github_repo: "https://github.com/example/repo",
              subnet_url: "https://example.com",
              discord: "https://discord.gg/example",
              logo_url: "https://example.com/logo.png",
              identity_hash: "abc123",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 7, limit: 50) {
          netuid entry_count limit
          entries {
            block_number observed_at subnet_name symbol description
            github_repo subnet_url discord logo_url identity_hash
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_identity_history;
    assert.equal(r.netuid, 7);
    assert.equal(r.entry_count, 1);
    assert.equal(r.limit, 50);
    assert.deepEqual(r.entries, [
      {
        block_number: 4200,
        observed_at: "2026-07-01T00:00:00.000Z",
        subnet_name: "Example",
        symbol: "EX",
        description: "desc",
        github_repo: "https://github.com/example/repo",
        subnet_url: "https://example.com",
        discord: "https://discord.gg/example",
        logo_url: "https://example.com/logo.png",
        identity_hash: "abc123",
      },
    ]);
  });

  // D1 fully eliminated (2026-07-17): subnet_identity_history is built
  // directly from an empty row set on a tier miss now (buildSubnetIdentityHistory([], ...)),
  // so a tier miss always yields the schema-stable empty timeline -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty timeline", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- subnet_identity_history is retired",
          );
        },
      },
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 86, limit: 10) {
          netuid entry_count limit
          entries { block_number observed_at subnet_name symbol identity_hash }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_identity_history;
    assert.equal(r.netuid, 86);
    assert.equal(r.entry_count, 0);
    assert.equal(r.limit, 10);
    assert.deepEqual(r.entries, []);
  });

  test("pagination args are forwarded to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_identity_history(netuid: 3, limit: 25, offset: 10, cursor: "abc") { entry_count } }',
      env,
    );
    assert.equal(capturedUrl.searchParams.get("limit"), "25");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc");
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/identity-history"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 9) {
          schema_version netuid entry_count limit offset next_cursor entries { subnet_name }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_identity_history, {
      schema_version: 1,
      netuid: 9,
      entry_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_identity_history(netuid: -1) { entry_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_identity_history ?? null, null);
  });

  test("subnet_identity_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_identity_history, 5);
  });
});

describe("graphql — chain_identity_history (#5878, Postgres-tier + empty-feed fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no D1 rows returns a schema-stable empty feed, never null", async () => {
    const { status, body } = await gql(
      `{ chain_identity_history {
          schema_version count subnet_count changes { netuid subnet_name identity_hash }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_identity_history, {
      schema_version: 1,
      count: 0,
      subnet_count: 0,
      changes: [],
    });
  });

  test("resolves the Postgres-tier network feed, mapping each cross-subnet change", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          count: 2,
          subnet_count: 2,
          changes: [
            {
              netuid: 7,
              block_number: 4200,
              observed_at: "2026-07-01T00:00:00.000Z",
              subnet_name: "Example",
              symbol: "EX",
              description: "desc",
              github_repo: "https://github.com/example/repo",
              subnet_url: "https://example.com",
              discord: "https://discord.gg/example",
              logo_url: "https://example.com/logo.png",
              identity_hash: "abc123",
            },
            {
              netuid: 12,
              block_number: 4180,
              observed_at: "2026-06-30T00:00:00.000Z",
              subnet_name: "Other",
              symbol: "OT",
              description: null,
              github_repo: null,
              subnet_url: null,
              discord: null,
              logo_url: null,
              identity_hash: "def456",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_identity_history(limit: 50) {
          schema_version count subnet_count
          changes { netuid block_number observed_at subnet_name symbol identity_hash }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.chain_identity_history;
    assert.equal(r.count, 2);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.changes.length, 2);
    assert.equal(r.changes[0].netuid, 7);
    assert.equal(r.changes[0].subnet_name, "Example");
    assert.equal(r.changes[1].netuid, 12);
    assert.equal(r.changes[1].identity_hash, "def456");
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ chain_identity_history {
          schema_version count subnet_count changes { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_identity_history, {
      schema_version: 1,
      count: 0,
      subnet_count: 0,
      changes: [],
    });
  });
});

describe("graphql — accounts / account (#5574, Postgres-tier accounts leaderboard)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  test("accounts: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ accounts { items { hotkey } total sort captured_at block_number } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.accounts, {
      items: [],
      total: 0,
      sort: "total_stake",
      captured_at: null,
      block_number: null,
    });
  });

  test("accounts: resolves Postgres-tier rows", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 5,
            captured_at: "2026-07-15T00:00:00.000Z",
            block_number: 300,
            account_count: 1,
            accounts: [
              {
                hotkey: "5Account",
                coldkey: "5Coldkey",
                coldkey_count: 1,
                subnet_count: 2,
                uid_count: 2,
                validator_count: 1,
                miner_count: 1,
                total_stake_tao: 1500,
                total_emission_tao: 7,
                stake_dominance: 0.42,
                latest_captured_at: "2026-07-15T00:00:00.000Z",
                latest_block_number: 300,
                subnets: [
                  { netuid: 1, uid: 5, stake_tao: 1000, emission_tao: 5 },
                  { netuid: 3, uid: 9, stake_tao: 500, emission_tao: 2 },
                ],
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(
      '{ accounts(sort: "total_stake", limit: 5) { items { hotkey coldkey subnet_count total_stake_tao stake_dominance latest_captured_at latest_block_number subnets { netuid uid stake_tao emission_tao } } total sort captured_at block_number } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.accounts.total, 1);
    assert.equal(body.data.accounts.sort, "total_stake");
    assert.equal(body.data.accounts.captured_at, "2026-07-15T00:00:00.000Z");
    assert.equal(body.data.accounts.block_number, 300);
    const item = body.data.accounts.items[0];
    assert.equal(item.hotkey, "5Account");
    assert.equal(item.coldkey, "5Coldkey");
    assert.equal(item.subnet_count, 2);
    assert.equal(item.total_stake_tao, 1500);
    assert.equal(item.stake_dominance, 0.42);
    assert.deepEqual(item.subnets, [
      { netuid: 1, uid: 5, stake_tao: 1000, emission_tao: 5 },
      { netuid: 3, uid: 9, stake_tao: 500, emission_tao: 2 },
    ]);
  });

  test("accounts: sort and limit args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "uid_count",
            limit: 5,
            captured_at: null,
            block_number: null,
            account_count: 0,
            accounts: [],
          });
        },
      },
    };
    await gql('{ accounts(sort: "uid_count", limit: 5) { total } }', env);
    assert.equal(capturedUrl.pathname, "/api/v1/accounts");
    assert.equal(capturedUrl.searchParams.get("sort"), "uid_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
  });

  test("accounts: an omitted sort/limit forwards the defaults to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 20,
            captured_at: null,
            block_number: null,
            account_count: 0,
            accounts: [],
          });
        },
      },
    };
    await gql("{ accounts { total } }", env);
    assert.equal(capturedUrl.searchParams.get("sort"), "total_stake");
    assert.equal(capturedUrl.searchParams.get("limit"), "20");
  });

  test("accounts: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ accounts { items { hotkey } total sort captured_at block_number } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.accounts, {
      items: [],
      total: 0,
      sort: "total_stake",
      captured_at: null,
      block_number: null,
    });
  });

  test("accounts: an unsupported sort value is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ accounts(sort: "not_a_real_sort") { total } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account: an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ account(ss58: "not-a-valid-address") { ss58 } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    // `account` is a nullable field (unlike `validators`/`accounts`), so the
    // thrown error nulls out just this field, not the whole `data` object.
    assert.equal(body.data.account, null);
    assert.equal(called, false);
  });

  test("account: a never-seen address (cold store) resolves to a schema-stable zero summary, never null", async () => {
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count event_scan_capped first_block last_block event_kinds { kind } registrations { netuid } recent_events { block_number } activity { tx_count modules_called { call_module } } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account, {
      ss58: SS58,
      event_count: 0,
      subnet_count: 0,
      event_scan_capped: false,
      first_block: null,
      last_block: null,
      event_kinds: [],
      registrations: [],
      recent_events: [],
      activity: { tx_count: 0, modules_called: [] },
    });
  });

  test("account: resolves Postgres-tier detail data", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            event_count: 12,
            subnet_count: 2,
            event_scan_capped: false,
            first_block: 100,
            last_block: 500,
            first_seen_at: "2026-06-01T00:00:00.000Z",
            last_seen_at: "2026-07-14T00:00:00.000Z",
            event_kinds: [{ kind: "Transfer", count: 5 }],
            registrations: [
              {
                netuid: 1,
                uid: 5,
                stake_tao: 10,
                validator_permit: true,
                active: true,
              },
            ],
            recent_events: [
              { block_number: 500, event_index: 0, event_kind: "Transfer" },
            ],
            activity: {
              tx_count: 3,
              last_tx_block: 490,
              last_tx_at: "2026-07-13T00:00:00.000Z",
              total_fee_tao: 0.01,
              modules_called: [{ call_module: "SubtensorModule", count: 3 }],
            },
          }),
      },
    };
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count first_block last_block event_kinds { kind count } registrations { netuid stake_tao validator_permit active } recent_events { block_number event_kind } activity { tx_count last_tx_block total_fee_tao modules_called { call_module count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.ss58, SS58);
    assert.equal(body.data.account.event_count, 12);
    assert.equal(body.data.account.subnet_count, 2);
    assert.equal(body.data.account.first_block, 100);
    assert.equal(body.data.account.last_block, 500);
    assert.deepEqual(body.data.account.event_kinds, [
      { kind: "Transfer", count: 5 },
    ]);
    assert.deepEqual(body.data.account.registrations, [
      { netuid: 1, stake_tao: 10, validator_permit: true, active: true },
    ]);
    assert.deepEqual(body.data.account.recent_events, [
      { block_number: 500, event_kind: "Transfer" },
    ]);
    assert.deepEqual(body.data.account.activity, {
      tx_count: 3,
      last_tx_block: 490,
      total_fee_tao: 0.01,
      modules_called: [{ call_module: "SubtensorModule", count: 3 }],
    });
  });

  test("account: a malformed Postgres-tier body degrades to a schema-stable zero summary", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count event_scan_capped first_block last_block event_kinds { kind } registrations { netuid } recent_events { block_number } activity { tx_count modules_called { call_module } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account, {
      ss58: SS58,
      event_count: 0,
      subnet_count: 0,
      event_scan_capped: false,
      first_block: null,
      last_block: null,
      event_kinds: [],
      registrations: [],
      recent_events: [],
      activity: { tx_count: 0, modules_called: [] },
    });
  });

  test("accounts / account are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.accounts, 5);
    assert.equal(FIELD_COMPLEXITY.account, 5);
  });
});

describe("graphql — account_prometheus (#5703, Postgres-tier { data, generatedAt } + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_prometheus${argsClause} {
      schema_version address window total_announcements subnet_count concentration dominant_netuid
      subnets { netuid announcements first_announced_at last_announced_at }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed footprint, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier footprint for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              address: SS58,
              window: "7d",
              total_announcements: 5,
              subnet_count: 2,
              concentration: 0.68,
              dominant_netuid: 3,
              subnets: [
                {
                  netuid: 3,
                  announcements: 4,
                  first_announced_at: "2026-07-01T00:00:00.000Z",
                  last_announced_at: "2026-07-10T00:00:00.000Z",
                },
                {
                  netuid: 7,
                  announcements: 1,
                  first_announced_at: "2026-07-05T00:00:00.000Z",
                  last_announced_at: "2026-07-05T00:00:00.000Z",
                },
              ],
            },
            generatedAt: "2026-07-10T00:00:00.000Z",
          }),
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "7d")`),
      env,
    );
    assert.equal(status, 200);
    const p = body.data.account_prometheus;
    assert.equal(p.window, "7d");
    assert.equal(p.total_announcements, 5);
    assert.equal(p.subnet_count, 2);
    assert.equal(p.concentration, 0.68);
    assert.equal(p.dominant_netuid, 3);
    assert.equal(p.subnets[0].netuid, 3);
    assert.equal(p.subnets[0].announcements, 4);
    assert.equal(p.subnets[1].netuid, 7);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            data: { schema_version: 1, address: SS58, subnets: [] },
            generatedAt: null,
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}", window: "90d")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/prometheus`);
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("a Postgres-tier body missing the data envelope degrades to a schema-stable zeroed footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a partial data envelope degrades missing fields to their defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("account_prometheus is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_prometheus, 5);
  });
});

describe("graphql — account_stake_flow (#5706, Postgres-tier { data, generatedAt } + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_stake_flow${argsClause} {
      schema_version address window total_staked_tao total_unstaked_tao
      net_flow_tao gross_flow_tao flow_ratio direction stake_events unstake_events
      subnet_count concentration dominant_netuid
      subnets { netuid staked_tao unstaked_tao net_flow_tao gross_flow_tao flow_ratio direction stake_events unstake_events }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier scorecard for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              address: SS58,
              window: "7d",
              total_staked_tao: 100,
              total_unstaked_tao: 20,
              net_flow_tao: 80,
              gross_flow_tao: 120,
              flow_ratio: 0.6667,
              direction: "accumulating",
              stake_events: 4,
              unstake_events: 1,
              subnet_count: 2,
              concentration: 0.72,
              dominant_netuid: 3,
              subnets: [
                {
                  netuid: 3,
                  staked_tao: 90,
                  unstaked_tao: 10,
                  net_flow_tao: 80,
                  gross_flow_tao: 100,
                  flow_ratio: 0.8,
                  direction: "accumulating",
                  stake_events: 3,
                  unstake_events: 1,
                },
                {
                  netuid: 7,
                  staked_tao: 10,
                  unstaked_tao: 10,
                  net_flow_tao: 0,
                  gross_flow_tao: 20,
                  flow_ratio: 0,
                  direction: "churning",
                  stake_events: 1,
                  unstake_events: 0,
                },
              ],
            },
            generatedAt: "2026-07-10T00:00:00.000Z",
          }),
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "7d")`),
      env,
    );
    assert.equal(status, 200);
    const f = body.data.account_stake_flow;
    assert.equal(f.window, "7d");
    assert.equal(f.total_staked_tao, 100);
    assert.equal(f.net_flow_tao, 80);
    assert.equal(f.direction, "accumulating");
    assert.equal(f.subnet_count, 2);
    assert.equal(f.dominant_netuid, 3);
    assert.equal(f.subnets[0].netuid, 3);
    assert.equal(f.subnets[0].flow_ratio, 0.8);
    assert.equal(f.subnets[1].direction, "churning");
  });

  test("window and direction are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            data: { schema_version: 1, address: SS58, subnets: [] },
            generatedAt: null,
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}", window: "90d", direction: "in")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/stake-flow`);
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
    assert.equal(capturedUrl.searchParams.get("direction"), "in");
  });

  test("a Postgres-tier body missing the data envelope degrades to a schema-stable zeroed card", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a partial data envelope degrades missing fields to their defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("an unsupported direction is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", direction: "sideways")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/direction/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("account_stake_flow is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_stake_flow, 5);
  });
});

describe("graphql — account_portfolio (#5702, Postgres-tier flat body + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_portfolio${argsClause} {
      schema_version ss58 captured_at subnet_count position_count validator_count
      miner_count total_stake_tao total_emission_tao overall_yield
      stake_concentration { holders gini hhi }
      positions { netuid uid role active stake_tao emission_tao rank trust incentive dividends yield }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_portfolio, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      subnet_count: 0,
      position_count: 0,
      validator_count: 0,
      miner_count: 0,
      total_stake_tao: 0,
      total_emission_tao: 0,
      overall_yield: null,
      stake_concentration: null,
      positions: [],
    });
  });

  test("resolves the Postgres-tier portfolio (flat body, unlike the account-event footprint family)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            captured_at: "2026-07-10T00:00:00.000Z",
            subnet_count: 2,
            position_count: 2,
            validator_count: 1,
            miner_count: 1,
            total_stake_tao: 1500,
            total_emission_tao: 6,
            overall_yield: 0.004,
            stake_concentration: { holders: 2, gini: 0.2, hhi: 0.52 },
            positions: [
              {
                netuid: 3,
                uid: 5,
                role: "validator",
                active: true,
                stake_tao: 1000,
                emission_tao: 4,
                rank: 0.8,
                trust: 0.9,
                incentive: 0.1,
                dividends: 0.05,
                yield: 0.004,
              },
              {
                netuid: 7,
                uid: 9,
                role: "miner",
                active: true,
                stake_tao: 500,
                emission_tao: 2,
                rank: 0.5,
                trust: 0.5,
                incentive: 0.2,
                dividends: 0,
                yield: 0.004,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const p = body.data.account_portfolio;
    assert.equal(p.subnet_count, 2);
    assert.equal(p.total_stake_tao, 1500);
    assert.equal(p.stake_concentration.holders, 2);
    assert.equal(p.positions[0].netuid, 3);
    assert.equal(p.positions[0].role, "validator");
    assert.equal(p.positions[1].role, "miner");
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            positions: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/portfolio`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty card", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_portfolio, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      subnet_count: 0,
      position_count: 0,
      validator_count: 0,
      miner_count: 0,
      total_stake_tao: 0,
      total_emission_tao: 0,
      overall_yield: null,
      stake_concentration: null,
      positions: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_portfolio is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_portfolio, 5);
  });
});

describe("graphql — account_positions (#6324, Postgres-tier flat body + empty-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_positions${argsClause} {
      schema_version ss58 captured_at position_count total_stake_tao
      positions { hotkey netuid share_fraction stake_tao }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_positions, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      position_count: 0,
      total_stake_tao: 0,
      positions: [],
    });
  });

  test("resolves the Postgres-tier positions (flat body, matches GET /api/v1/accounts/{ss58}/positions parity)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            captured_at: "2026-07-10T00:00:00.000Z",
            position_count: 2,
            total_stake_tao: 1500,
            positions: [
              {
                hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
                netuid: 3,
                share_fraction: 0.5,
                stake_tao: 1000,
              },
              {
                hotkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
                netuid: 7,
                share_fraction: 0.25,
                stake_tao: 500,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const p = body.data.account_positions;
    assert.equal(p.position_count, 2);
    assert.equal(p.total_stake_tao, 1500);
    assert.equal(p.positions[0].netuid, 3);
    assert.equal(p.positions[0].share_fraction, 0.5);
    assert.equal(
      p.positions[1].hotkey,
      "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
    );
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            positions: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/positions`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty card", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_positions, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      position_count: 0,
      total_stake_tao: 0,
      positions: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_positions is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_positions, 5);
  });
});

describe("graphql — account_subnets (#5894, Postgres-tier flat body + empty-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_subnets${argsClause} {
      schema_version ss58 subnet_count
      subnets { netuid uid stake_tao validator_permit active }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty footprint, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_subnets, {
      schema_version: 1,
      ss58: SS58,
      subnet_count: 0,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier footprint (flat body, unlike the account-event footprint family)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            subnet_count: 2,
            subnets: [
              {
                netuid: 3,
                uid: 5,
                stake_tao: 1000,
                validator_permit: true,
                active: true,
              },
              {
                netuid: 7,
                uid: 9,
                stake_tao: 500,
                validator_permit: false,
                active: false,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const s = body.data.account_subnets;
    assert.equal(s.subnet_count, 2);
    assert.equal(s.subnets[0].netuid, 3);
    assert.equal(s.subnets[0].validator_permit, true);
    assert.equal(s.subnets[0].active, true);
    assert.equal(s.subnets[1].netuid, 7);
    assert.equal(s.subnets[1].validator_permit, false);
    assert.equal(s.subnets[1].active, false);
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            subnet_count: 0,
            subnets: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/subnets`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty footprint", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_subnets, {
      schema_version: 1,
      ss58: SS58,
      subnet_count: 0,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_subnets is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_subnets, 5);
  });
});

describe("graphql — account_extrinsics (#5891, Postgres-tier feed + empty-page fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_extrinsics${argsClause} {
      schema_version ss58 extrinsic_count limit offset next_cursor
      extrinsics { block_number extrinsic_index call_module call_function call_args success fee_tao }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty page, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_extrinsics, {
      schema_version: 1,
      ss58: SS58,
      extrinsic_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      extrinsics: [],
    });
  });

  test("resolves the Postgres-tier feed, JSON-encoding call_args to the String field", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            extrinsic_count: 1,
            limit: 100,
            offset: 0,
            next_cursor: "cursor-1",
            extrinsics: [
              {
                block_number: 5,
                extrinsic_index: 0,
                extrinsic_hash: `0x${"a".repeat(64)}`,
                signer: SS58,
                call_module: "SubtensorModule",
                call_function: "register",
                call_args: [{ name: "netuid", value: 1 }],
                success: true,
                fee_tao: 0.001,
                tip_tao: 0,
                observed_at: "2026-07-14T00:00:00.000Z",
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const s = body.data.account_extrinsics;
    assert.equal(s.extrinsic_count, 1);
    assert.equal(s.next_cursor, "cursor-1");
    const item = s.extrinsics[0];
    assert.equal(item.block_number, 5);
    assert.equal(item.call_module, "SubtensorModule");
    assert.equal(item.call_function, "register");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("ss58 + pagination/block-range args are forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            extrinsic_count: 0,
            limit: 5,
            offset: 10,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      query(
        `(ss58: "${SS58}", limit: 5, offset: 10, cursor: "abc123", block_start: 100, block_end: 200)`,
      ),
      env,
    );
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/extrinsics`);
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
    assert.equal(capturedUrl.searchParams.get("block_start"), "100");
    assert.equal(capturedUrl.searchParams.get("block_end"), "200");
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_extrinsics, {
      schema_version: 1,
      ss58: SS58,
      extrinsic_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      extrinsics: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_extrinsics is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_extrinsics, 5);
  });
});

// --- Subscription.chainEvents (#4983, ADR 0015) ---------------------------------
//
// The DO-runtime side of this wiring (ChainFirehoseHub.subscribeChainEvents,
// the graphql-ws WS transport) is covered in tests/chain-firehose-hub.test.mjs.
// These tests exercise the OTHER half: that the schema's chainEvents field is
// wired to a real subscribe() resolver that correctly bridges
// context.chainFirehose's repeater into graphql-js's own subscribe() engine
// -- using graphql-js's real subscribe() function (not a hand-rolled
// simulation) against a minimal fake hub, exactly the shape
// ChainFirehoseHub actually provides via context.
function fakeChainFirehose(pushAfterSubscribe) {
  const subscriptions = [];
  return {
    subscribeChainEvents(topics) {
      const pending = [];
      let waitingResolve = null;
      const repeater = {
        push(value) {
          if (waitingResolve) {
            const resolve = waitingResolve;
            waitingResolve = null;
            resolve({ value, done: false });
          } else {
            pending.push(value);
          }
        },
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              pending.length
                ? Promise.resolve({ value: pending.shift(), done: false })
                : new Promise((resolve) => {
                    waitingResolve = resolve;
                  }),
          };
        },
      };
      subscriptions.push({ repeater, topics });
      if (pushAfterSubscribe) pushAfterSubscribe(repeater);
      return repeater;
    },
    unsubscribeChainEvents(repeater) {
      const index = subscriptions.findIndex((s) => s.repeater === repeater);
      if (index !== -1) subscriptions.splice(index, 1);
    },
    subscriptions,
  };
}

async function subscribeChainEvents(query, hub, clientIp) {
  const document = parse(query);
  return subscribe({
    schema: chainEventsSchema,
    document,
    contextValue: { [GRAPHQL_SUBSCRIPTION_CONTEXT_KEY]: hub, clientIp },
  });
}

// graphql-js's execution results are null-prototype objects internally
// (Object.create(null)) -- deepStrictEqual against a plain object literal
// fails on prototype alone even with identical content. Round-tripping
// through JSON is also a MORE faithful comparison than a raw deep-equal:
// real clients only ever see this result after it's been JSON-serialized
// for the wire, same as every other transport in this repo.
function asPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("graphql — blocks_summary (#5664, Postgres-tier + retired-D1 fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty summary, never null", async () => {
    const { status, body } = await gql(
      `{ blocks_summary {
          schema_version block_count first_block last_block
          first_observed_at last_observed_at
          block_time { count } throughput { total_extrinsics }
          distinct_authors author_concentration { gini }
          distinct_spec_versions latest_spec_version
        } }`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks_summary, {
      schema_version: 1,
      block_count: 0,
      first_block: null,
      last_block: null,
      first_observed_at: null,
      last_observed_at: null,
      block_time: null,
      throughput: null,
      distinct_authors: 0,
      author_concentration: null,
      distinct_spec_versions: 0,
      latest_spec_version: null,
    });
  });

  test("resolves the Postgres-tier summary, including nested time/throughput/concentration", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          block_count: 3,
          first_block: 100,
          last_block: 102,
          first_observed_at: "2026-07-01T00:00:00.000Z",
          last_observed_at: "2026-07-01T00:00:24.000Z",
          block_time: {
            count: 2,
            mean_ms: 12000,
            min_ms: 11800,
            max_ms: 12200,
            p50_ms: 12000,
            p90_ms: 12200,
          },
          throughput: {
            total_extrinsics: 30,
            total_events: 90,
            mean_extrinsics_per_block: 10,
            mean_events_per_block: 30,
            max_extrinsics_in_block: 12,
          },
          distinct_authors: 2,
          author_concentration: {
            holders: 2,
            total: 3,
            gini: 0.17,
            hhi: 0.56,
            hhi_normalized: 0.11,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.67,
            top_5pct_share: 0.67,
            top_10pct_share: 0.67,
            top_20pct_share: 0.67,
            entropy: 0.92,
            entropy_normalized: 0.92,
          },
          distinct_spec_versions: 1,
          latest_spec_version: 199,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ blocks_summary {
          block_count first_block last_block latest_spec_version distinct_authors
          block_time { count mean_ms p50_ms p90_ms }
          throughput { total_extrinsics mean_extrinsics_per_block max_extrinsics_in_block }
          author_concentration { gini nakamoto_coefficient top_1pct_share entropy_normalized }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.blocks_summary;
    assert.equal(s.block_count, 3);
    assert.equal(s.first_block, 100);
    assert.equal(s.last_block, 102);
    assert.equal(s.latest_spec_version, 199);
    assert.equal(s.distinct_authors, 2);
    assert.equal(s.block_time.count, 2);
    assert.equal(s.block_time.mean_ms, 12000);
    assert.equal(s.block_time.p90_ms, 12200);
    assert.equal(s.throughput.total_extrinsics, 30);
    assert.equal(s.throughput.max_extrinsics_in_block, 12);
    assert.equal(s.author_concentration.gini, 0.17);
    assert.equal(s.author_concentration.nakamoto_coefficient, 1);
    assert.equal(s.author_concentration.top_1pct_share, 0.67);
  });

  test("forwards to /api/v1/blocks/summary with no query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ schema_version: 1, block_count: 0 });
        },
      },
    };
    await gql("{ blocks_summary { block_count } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/blocks/summary");
    assert.equal(capturedUrl.search, "");
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults, never null", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      // Every field absent -- the resolver's own ?? defaults must fill them in.
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ blocks_summary {
          schema_version block_count distinct_authors distinct_spec_versions
          first_block last_block block_time { count } throughput { total_extrinsics }
          author_concentration { gini } latest_spec_version
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks_summary, {
      schema_version: 1,
      block_count: 0,
      distinct_authors: 0,
      distinct_spec_versions: 0,
      first_block: null,
      last_block: null,
      block_time: null,
      throughput: null,
      author_concentration: null,
      latest_spec_version: null,
    });
  });
});

describe("graphql — runtime (#5898, Postgres-tier spec-version timeline + retired-D1 fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty timeline, never null", async () => {
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at
          transitions { spec_version block_number observed_at }
        } }`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 0,
      current_spec_version: null,
      coverage_from_block: null,
      coverage_from_at: null,
      transitions: [],
    });
  });

  test("resolves the Postgres-tier spec-version transition timeline", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          transitions: [
            {
              spec_version: 200,
              block_number: 100,
              observed_at: "2026-06-25T00:00:00.000Z",
            },
            {
              spec_version: 201,
              block_number: 500,
              observed_at: "2026-07-01T00:00:00.000Z",
            },
          ],
          transition_count: 2,
          current_spec_version: 201,
          coverage_from_block: 100,
          coverage_from_at: "2026-06-25T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at
          transitions { spec_version block_number observed_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 2,
      current_spec_version: 201,
      coverage_from_block: 100,
      coverage_from_at: "2026-06-25T00:00:00.000Z",
      transitions: [
        {
          spec_version: 200,
          block_number: 100,
          observed_at: "2026-06-25T00:00:00.000Z",
        },
        {
          spec_version: 201,
          block_number: 500,
          observed_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("forwards to /api/v1/runtime with no query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ schema_version: 1, transition_count: 0 });
        },
      },
    };
    await gql("{ runtime { transition_count } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/runtime");
    assert.equal(capturedUrl.search, "");
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults, never null", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      // Every field absent -- the resolver's own ?? / || defaults must fill them in.
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at transitions { spec_version }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 0,
      current_spec_version: null,
      coverage_from_block: null,
      coverage_from_at: null,
      transitions: [],
    });
  });
});

describe("graphql — incidents (#5660, Postgres-tier + retired-D1 fallback ledger)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }
  // Minimal D1 stub: every query returns no rows, so loadGlobalIncidentsLedger's
  // fallback path runs to a schema-stable empty ledger without a live DB.
  const emptyHealthDb = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };

  test("cold store: no Postgres flag falls back to the D1 ledger, schema-stable empty, never null", async () => {
    const { status, body } = await gql(
      "{ incidents { schema_version window surfaces { id } } }",
      { METAGRAPH_HEALTH_DB: emptyHealthDb },
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.incidents.schema_version, 1);
    assert.equal(body.data.incidents.window, "7d");
    assert.deepEqual(body.data.incidents.surfaces, []);
  });

  test("resolves the Postgres-tier ledger, including the JSON summary and typed surfaces", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          source: "postgres",
          summary: {
            incident_count: 2,
            active_count: 1,
            by_status: { down: 1, warn: 1 },
            by_severity: { high: 1, medium: 1 },
            by_kind: {},
            by_layer: {},
            by_provider: { acme: 2 },
          },
          surfaces: [
            {
              id: "inc-1",
              endpoint_id: "ep-1",
              state: "down",
              severity: "high",
              status: "down",
              reason: "probe timeout",
              netuid: 5,
              provider: "acme",
              health_stale: false,
              pool_eligible: true,
              user_reported: false,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ incidents(window: "30d") {
          schema_version window observed_at source
          summary
          surfaces { id endpoint_id state severity status reason netuid provider health_stale pool_eligible user_reported }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const inc = body.data.incidents;
    assert.equal(inc.window, "30d");
    assert.equal(inc.observed_at, "2026-07-01T00:00:00.000Z");
    // JSON scalar passes the dynamic-keyed summary through as-is.
    assert.equal(inc.summary.incident_count, 2);
    assert.equal(inc.summary.active_count, 1);
    assert.deepEqual(inc.summary.by_status, { down: 1, warn: 1 });
    assert.deepEqual(inc.summary.by_provider, { acme: 2 });
    assert.equal(inc.surfaces.length, 1);
    assert.equal(inc.surfaces[0].id, "inc-1");
    assert.equal(inc.surfaces[0].state, "down");
    assert.equal(inc.surfaces[0].netuid, 5);
    assert.equal(inc.surfaces[0].pool_eligible, true);
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      '{ incidents(window: "30d") { schema_version window observed_at source summary surfaces { id } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.incidents, {
      schema_version: 1,
      window: "30d",
      observed_at: null,
      source: null,
      summary: null,
      surfaces: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent empty ledger", async () => {
    const { body } = await gql(
      '{ incidents(window: "99d") { schema_version } }',
      {
        METAGRAPH_HEALTH_DB: emptyHealthDb,
      },
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.incidents ?? null, null);
  });
});

describe("graphql — subnet_registrations (#5720, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 5) {
          schema_version netuid window observed_at
          distinct_registrants registrations registrations_per_registrant
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_registrations, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_registrants: 0,
      registrations: 0,
      registrations_per_registrant: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_registrants: 3,
          registrations: 7,
          registrations_per_registrant: 2.33,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 5, window: "30d") {
          netuid window observed_at distinct_registrants registrations registrations_per_registrant
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_registrations;
    assert.equal(r.window, "30d");
    assert.equal(r.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(r.distinct_registrants, 3);
    assert.equal(r.registrations, 7);
    assert.equal(r.registrations_per_registrant, 2.33);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_registrants registrations registrations_per_registrant
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_registrations, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_registrants: 0,
      registrations: 0,
      registrations_per_registrant: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_registrations(netuid: 5, window: "99d") { registrations } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_registrations ?? null, null);
  });
});

describe("graphql — subnet_performance (#5714, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 5) {
          schema_version netuid neuron_count validator_count active_count captured_at
          incentive { holders gini } dividends { holders }
          trust { count } consensus { count } validator_trust { count }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_performance, {
      schema_version: 1,
      netuid: 5,
      neuron_count: 0,
      validator_count: 0,
      active_count: 0,
      captured_at: null,
      incentive: null,
      dividends: null,
      trust: null,
      consensus: null,
      validator_trust: null,
    });
  });

  test("resolves the Postgres-tier reward + score blocks", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          neuron_count: 4,
          validator_count: 2,
          active_count: 3,
          captured_at: "2026-07-01T00:00:00.000Z",
          incentive: {
            holders: 3,
            total: 1,
            gini: 0.4,
            hhi: 0.5,
            hhi_normalized: 0.25,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.6,
            top_5pct_share: 0.6,
            top_10pct_share: 0.6,
            top_20pct_share: 0.9,
            entropy: 1.4,
            entropy_normalized: 0.8,
          },
          dividends: {
            holders: 2,
            total: 0.6,
            gini: 0.2,
            hhi: 0.7,
            hhi_normalized: 0.4,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.83,
            top_5pct_share: 0.83,
            top_10pct_share: 0.83,
            top_20pct_share: 1,
            entropy: 0.9,
            entropy_normalized: 0.9,
          },
          trust: {
            count: 4,
            mean: 0.7,
            min: 0.4,
            max: 0.9,
            p10: 0.4,
            p25: 0.5,
            p50: 0.75,
            p75: 0.85,
            p90: 0.9,
          },
          consensus: {
            count: 4,
            mean: 0.6,
            min: 0.3,
            max: 0.8,
            p10: 0.3,
            p25: 0.4,
            p50: 0.65,
            p75: 0.75,
            p90: 0.8,
          },
          validator_trust: {
            count: 2,
            mean: 0.9,
            min: 0.85,
            max: 0.95,
            p10: 0.85,
            p25: 0.85,
            p50: 0.95,
            p75: 0.95,
            p90: 0.95,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 7) {
          netuid neuron_count validator_count active_count captured_at
          incentive { holders gini nakamoto_coefficient top_10pct_share }
          dividends { holders total }
          trust { count mean max }
          validator_trust { count min max }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const p = body.data.subnet_performance;
    assert.equal(p.netuid, 7);
    assert.equal(p.neuron_count, 4);
    assert.equal(p.validator_count, 2);
    assert.equal(p.active_count, 3);
    assert.equal(p.captured_at, "2026-07-01T00:00:00.000Z");
    assert.equal(p.incentive.holders, 3);
    assert.equal(p.incentive.nakamoto_coefficient, 1);
    assert.equal(p.dividends.holders, 2);
    assert.equal(p.dividends.total, 0.6);
    assert.equal(p.trust.count, 4);
    assert.equal(p.trust.max, 0.9);
    assert.equal(p.validator_trust.count, 2);
    assert.equal(p.validator_trust.min, 0.85);
  });

  test("forwards the performance path to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ subnet_performance(netuid: 3) { neuron_count } }", env);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/performance"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 9) {
          schema_version netuid neuron_count validator_count active_count
          incentive { holders } trust { count }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_performance, {
      schema_version: 1,
      netuid: 9,
      neuron_count: 0,
      validator_count: 0,
      active_count: 0,
      incentive: null,
      trust: null,
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_performance(netuid: -1) { neuron_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_performance ?? null, null);
  });

  test("subnet_performance is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_performance, 5);
  });
});

describe("graphql — subnet_concentration (#5901, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 5) {
          schema_version netuid neuron_count entity_count uids_per_entity captured_at
          stake { holders gini } emission { holders }
          entity_stake { holders } entity_emission { holders } validator_stake { holders }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_concentration, {
      schema_version: 1,
      netuid: 5,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });

  test("resolves the Postgres-tier stake + emission concentration blocks", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          neuron_count: 4,
          entity_count: 3,
          uids_per_entity: 1.3333,
          captured_at: "2026-07-01T00:00:00.000Z",
          stake: {
            holders: 4,
            total: 1000,
            gini: 0.4,
            hhi: 0.5,
            hhi_normalized: 0.25,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.6,
            top_5pct_share: 0.6,
            top_10pct_share: 0.6,
            top_20pct_share: 0.9,
            entropy: 1.4,
            entropy_normalized: 0.8,
          },
          emission: {
            holders: 3,
            total: 12.5,
            gini: 0.2,
            hhi: 0.7,
            hhi_normalized: 0.4,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.83,
            top_5pct_share: 0.83,
            top_10pct_share: 0.83,
            top_20pct_share: 1,
            entropy: 0.9,
            entropy_normalized: 0.9,
          },
          validator_stake: {
            holders: 2,
            total: 800,
            gini: 0.1,
            hhi: 0.55,
            hhi_normalized: 0.1,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.7,
            top_5pct_share: 0.7,
            top_10pct_share: 0.7,
            top_20pct_share: 1,
            entropy: 0.8,
            entropy_normalized: 0.8,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 7) {
          netuid neuron_count entity_count uids_per_entity captured_at
          stake { holders gini nakamoto_coefficient top_10pct_share }
          emission { holders total }
          validator_stake { holders gini }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const c = body.data.subnet_concentration;
    assert.equal(c.netuid, 7);
    assert.equal(c.neuron_count, 4);
    assert.equal(c.entity_count, 3);
    assert.equal(c.uids_per_entity, 1.3333);
    assert.equal(c.captured_at, "2026-07-01T00:00:00.000Z");
    assert.equal(c.stake.holders, 4);
    assert.equal(c.stake.nakamoto_coefficient, 1);
    assert.equal(c.stake.top_10pct_share, 0.6);
    assert.equal(c.emission.holders, 3);
    assert.equal(c.emission.total, 12.5);
    assert.equal(c.validator_stake.holders, 2);
    assert.equal(c.validator_stake.gini, 0.1);
  });

  test("forwards the concentration path to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ subnet_concentration(netuid: 3) { neuron_count } }", env);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/concentration"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 9) {
          schema_version netuid neuron_count entity_count uids_per_entity
          stake { holders } validator_stake { holders }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_concentration, {
      schema_version: 1,
      netuid: 9,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      stake: null,
      validator_stake: null,
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_concentration(netuid: -1) { neuron_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration ?? null, null);
  });

  test("subnet_concentration is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_concentration, 5);
  });
});

describe("graphql — subnet_concentration_history (#5901, neuron_daily trend + window validation)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_concentration_history(netuid: 5) {
          schema_version netuid window point_count points { snapshot_date stake_gini }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_concentration_history, {
      schema_version: 1,
      netuid: 5,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier per-day trend points", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "7d",
          point_count: 2,
          points: [
            {
              snapshot_date: "2026-07-02",
              neuron_count: 4,
              stake_gini: 0.42,
              stake_nakamoto_coefficient: 2,
              stake_top_10pct_share: 0.55,
              emission_gini: 0.3,
              emission_nakamoto_coefficient: 1,
              emission_top_10pct_share: 0.7,
            },
            {
              snapshot_date: "2026-07-01",
              neuron_count: 3,
              stake_gini: 0.4,
              stake_nakamoto_coefficient: 2,
              stake_top_10pct_share: 0.5,
              emission_gini: 0.28,
              emission_nakamoto_coefficient: 1,
              emission_top_10pct_share: 0.68,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_concentration_history(netuid: 7, window: "7d") {
          netuid window point_count
          points { snapshot_date neuron_count stake_gini stake_nakamoto_coefficient emission_top_10pct_share }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const h = body.data.subnet_concentration_history;
    assert.equal(h.netuid, 7);
    assert.equal(h.window, "7d");
    assert.equal(h.point_count, 2);
    assert.equal(h.points.length, 2);
    assert.equal(h.points[0].snapshot_date, "2026-07-02");
    assert.equal(h.points[0].stake_gini, 0.42);
    assert.equal(h.points[0].stake_nakamoto_coefficient, 2);
    assert.equal(h.points[1].emission_top_10pct_share, 0.68);
  });

  test("forwards the window to the concentration/history Postgres path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_concentration_history(netuid: 3, window: "90d") { point_count } }',
      env,
    );
    assert.ok(
      capturedUrl.pathname.endsWith("/subnets/3/concentration/history"),
    );
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("an unsupported window is a GraphQL error, not a silent series", async () => {
    const { body } = await gql(
      '{ subnet_concentration_history(netuid: 5, window: "5d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration_history ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ subnet_concentration_history(netuid: -1) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration_history ?? null, null);
  });

  test("subnet_concentration_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_concentration_history, 5);
  });
});

