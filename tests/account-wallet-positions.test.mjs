import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("GET /api/v1/accounts/{ss58}/wallet-positions (#5243)", () => {
  test("cold store (no METAGRAPH_NEURONS_SOURCE flag) -> 200 with an empty card", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/wallet-positions`,
      ),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_spot_mark_tao, 0);
    assert.equal(body.data.total_exit_value_tao, 0);
    assert.deepEqual(body.data.positions, []);
  });

  test("flag=postgres proxies to DATA_API and returns its shape", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/wallet-positions`,
      ),
      {
        ...createLocalArtifactEnv(),
        METAGRAPH_NEURONS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              ss58: SS58,
              captured_at: null,
              position_count: 1,
              total_stake_tao: 100,
              total_spot_mark_tao: 100,
              total_exit_value_tao: 95,
              positions: [
                {
                  position_kind: "validator-own",
                  netuid: 1,
                  hotkey: SS58,
                  delegated_hotkey: null,
                  uid: 2,
                  role: "validator",
                  active: true,
                  stake_tao: 100,
                  share_fraction: null,
                  alpha_amount: 50,
                  alpha_price_tao: 2,
                  root_stake_tao: 0,
                  alpha_stake_tao: 100,
                  spot_mark_tao: 100,
                  exit_value_tao: 95,
                  realized_yield_tao: null,
                },
              ],
            }),
        },
      },
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.position_count, 1);
    assert.equal(body.data.positions[0].position_kind, "validator-own");
    assert.equal(body.data.total_exit_value_tao, 95);
  });
});
