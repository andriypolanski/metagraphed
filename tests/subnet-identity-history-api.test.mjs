import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function dbWith({ identityHistory } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/FROM subnet_identity_history/.test(sql)) {
                  return { results: identityHistory || [] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const ROW = {
  id: 1,
  block_number: 100,
  observed_at: 1_700_000_000_000,
  subnet_name: "MIAO",
  symbol: "α",
  description: "sound AI",
  github_repo: null,
  subnet_url: null,
  discord: null,
  logo_url: null,
  identity_hash: "hash-1",
};

test("GET /subnets/{netuid}/identity-history returns the identity timeline (#1647)", async () => {
  const env = dbWith({ identityHistory: [ROW] });
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 1);
  assert.equal(body.data.entries[0].subnet_name, "MIAO");
});

test("GET /subnets/{netuid}/identity-history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /subnets/{netuid}/identity-history is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 0);
  assert.deepEqual(body.data.entries, []);
});
