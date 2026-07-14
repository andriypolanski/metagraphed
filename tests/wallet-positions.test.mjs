import { describe, expect, test } from "vitest";

import {
  buildWalletPositions,
  DEFAULT_EXIT_SLIPPAGE,
  economicsByNetuidFromRows,
} from "../src/wallet-positions.mjs";

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("buildWalletPositions", () => {
  test("merges validator-own and nominator rows with valuation fields", () => {
    const econ = economicsByNetuidFromRows([
      {
        netuid: 1,
        alpha_price_tao: 2,
        tao_in_pool_tao: 10000,
        alpha_in_pool: 5000,
      },
      {
        netuid: 0,
        alpha_price_tao: 1,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
      },
    ]);

    const out = buildWalletPositions(
      {
        portfolio: {
          captured_at: "2026-07-14T08:00:00.000Z",
          positions: [
            {
              netuid: 1,
              uid: 3,
              role: "validator",
              active: true,
              stake_tao: 100,
              emission_tao: 1,
              rank: 1,
              trust: 0.9,
              incentive: 0.8,
              dividends: 0.7,
              yield: 0.01,
            },
            {
              netuid: 0,
              uid: 0,
              role: "validator",
              active: true,
              stake_tao: 50,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominator: {
          positions: [
            {
              hotkey: "5Hot",
              netuid: 3,
              share_fraction: 0.25,
              stake_tao: 40,
            },
          ],
        },
        economicsByNetuid: econ,
      },
      SS58,
    );

    expect(out.position_count).toBe(3);
    expect(out.total_stake_tao).toBe(190);
    expect(out.total_spot_mark_tao).toBeGreaterThan(0);
    expect(out.total_exit_value_tao).toBeGreaterThan(0);

    const own = out.positions.find((p) => p.position_kind === "validator-own");
    expect(own).toMatchObject({
      netuid: 1,
      hotkey: SS58,
      stake_tao: 100,
      alpha_stake_tao: 100,
      root_stake_tao: 0,
    });
    expect(own.spot_mark_tao).toBe(100);
    expect(own.exit_value_tao).toBeGreaterThan(0);

    const root = out.positions.find((p) => p.netuid === 0);
    expect(root.spot_mark_tao).toBe(50);
    expect(root.exit_value_tao).toBe(50);

    const nom = out.positions.find((p) => p.position_kind === "nominator");
    expect(nom).toMatchObject({
      netuid: 3,
      delegated_hotkey: "5Hot",
      role: "nominator",
      stake_tao: 40,
    });
    expect(nom.realized_yield_tao).toBeNull();
  });

  test("falls back to slippage band when pool reserves are absent", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 8,
              uid: 1,
              role: "miner",
              active: true,
              stake_tao: 200,
              emission_tao: 0,
              rank: null,
              trust: null,
              incentive: null,
              dividends: null,
              yield: null,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([[8, { alpha_price_tao: 1.5 }]]),
      },
      SS58,
    );

    expect(out.positions[0].exit_value_tao).toBeCloseTo(
      200 * (1 - DEFAULT_EXIT_SLIPPAGE),
      6,
    );
  });

  test("returns a schema-stable empty card", () => {
    const out = buildWalletPositions({}, SS58);
    expect(out).toMatchObject({
      schema_version: 1,
      ss58: SS58,
      position_count: 0,
      total_stake_tao: 0,
      total_spot_mark_tao: 0,
      total_exit_value_tao: 0,
      positions: [],
    });
  });

  test("accepts economicsByNetuid as a plain Record and labels miner-own rows", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 4,
              uid: 1,
              role: "miner",
              active: false,
              stake_tao: 80,
            },
            { netuid: null, stake_tao: 50 },
            { netuid: 5, stake_tao: 0 },
          ],
        },
        nominator: {
          positions: [
            { netuid: 6, stake_tao: 10 },
            { hotkey: "5Hot", stake_tao: 5 },
          ],
        },
        economicsByNetuid: { 4: { alpha_price_tao: 2 } },
      },
      SS58,
    );

    expect(out.position_count).toBe(1);
    expect(out.positions[0]).toMatchObject({
      position_kind: "miner-own",
      netuid: 4,
      alpha_amount: 40,
      spot_mark_tao: 80,
    });
  });

  test("sorts by spot_mark_tao descending and uses nominator captured_at", () => {
    const out = buildWalletPositions(
      {
        portfolio: { positions: [] },
        nominator: {
          captured_at: "2026-07-14T09:00:00.000Z",
          positions: [
            { hotkey: "5A", netuid: 2, stake_tao: 50 },
            { hotkey: "5B", netuid: 3, stake_tao: 100 },
          ],
        },
        economicsByNetuid: new Map([
          [2, { alpha_price_tao: 1 }],
          [3, { alpha_price_tao: 1 }],
        ]),
      },
      SS58,
    );

    expect(out.captured_at).toBe("2026-07-14T09:00:00.000Z");
    expect(out.positions[0].netuid).toBe(3);
    expect(out.positions[1].netuid).toBe(2);
  });

  test("falls back to slippage when the AMM quote rejects oversized unstake", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 9,
              uid: 1,
              role: "validator",
              active: true,
              stake_tao: 2000,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([
          [
            9,
            {
              alpha_price_tao: 1,
              tao_in_pool_tao: 100,
              alpha_in_pool: 1,
            },
          ],
        ]),
      },
      SS58,
    );

    expect(out.positions[0].exit_value_tao).toBeCloseTo(
      2000 * (1 - DEFAULT_EXIT_SLIPPAGE),
      6,
    );
  });

  test("uses stake_tao for spot mark when alpha price is absent", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 11,
              uid: 1,
              role: "validator",
              active: true,
              stake_tao: 75,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([[11, {}]]),
      },
      SS58,
    );

    expect(out.positions[0].spot_mark_tao).toBe(75);
    expect(out.positions[0].alpha_amount).toBeNull();
  });

  test("is cold-safe for non-array position inputs", () => {
    const out = buildWalletPositions(
      {
        portfolio: { positions: null },
        nominator: { positions: undefined },
      },
      SS58,
    );
    expect(out.positions).toEqual([]);
  });

  test("defaults portfolio uid/role and uses null economics map coercions", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          captured_at: "2026-07-14T10:00:00.000Z",
          positions: [
            {
              netuid: 7,
              active: true,
              stake_tao: 10,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: null,
      },
      SS58,
    );

    expect(out.captured_at).toBe("2026-07-14T10:00:00.000Z");
    expect(out.positions[0]).toMatchObject({
      uid: null,
      role: "miner",
      position_kind: "miner-own",
    });
  });

  test("tie-breaks equal spot marks by netuid and nulls totals when sums are non-finite", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 12,
              uid: 1,
              role: "validator",
              active: true,
              stake_tao: Number.MAX_VALUE,
            },
            {
              netuid: 5,
              uid: 2,
              role: "validator",
              active: true,
              stake_tao: Number.MAX_VALUE,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([
          [12, { alpha_price_tao: 1 }],
          [5, { alpha_price_tao: 1 }],
        ]),
      },
      SS58,
    );

    expect(out.positions[0].netuid).toBe(5);
    expect(out.positions[1].netuid).toBe(12);
    expect(out.total_stake_tao).toBe(0);
    expect(out.total_spot_mark_tao).toBe(0);
    expect(out.total_exit_value_tao).toBe(0);
  });

  test("rounds non-finite stake through valuation fallbacks", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 14,
              uid: 1,
              role: "validator",
              active: true,
              stake_tao: Infinity,
            },
            {
              netuid: 0,
              uid: 0,
              role: "validator",
              active: true,
              stake_tao: Infinity,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([[14, { alpha_price_tao: 2 }]]),
      },
      SS58,
    );

    expect(out.positions.find((p) => p.netuid === 14)).toMatchObject({
      alpha_stake_tao: 0,
      root_stake_tao: 0,
      spot_mark_tao: null,
      exit_value_tao: null,
    });
    expect(out.positions.find((p) => p.netuid === 0)).toMatchObject({
      root_stake_tao: 0,
      spot_mark_tao: null,
      exit_value_tao: null,
    });
    expect(out.total_stake_tao).toBe(0);
    expect(out.total_spot_mark_tao).toBe(0);
    expect(out.total_exit_value_tao).toBe(0);
  });

  test("tie-breaks equal finite spot marks by netuid", () => {
    const out = buildWalletPositions(
      {
        portfolio: {
          positions: [
            {
              netuid: 20,
              uid: 1,
              role: "validator",
              active: true,
              stake_tao: 40,
            },
            {
              netuid: 10,
              uid: 2,
              role: "validator",
              active: true,
              stake_tao: 40,
            },
          ],
        },
        nominator: { positions: [] },
        economicsByNetuid: new Map([
          [20, { alpha_price_tao: 2 }],
          [10, { alpha_price_tao: 2 }],
        ]),
      },
      SS58,
    );

    expect(out.positions.map((p) => p.netuid)).toEqual([10, 20]);
  });
});

describe("economicsByNetuidFromRows", () => {
  test("maps subnet economics rows by netuid", () => {
    const map = economicsByNetuidFromRows([
      {
        netuid: 1,
        alpha_price_tao: 1.2,
        tao_in_pool_tao: 100,
        alpha_in_pool: 50,
      },
    ]);
    expect(map.get(1)?.alpha_price_tao).toBe(1.2);
  });

  test("skips invalid netuids and non-positive economics cells", () => {
    const map = economicsByNetuidFromRows([
      { netuid: -1, alpha_price_tao: 1 },
      { netuid: 1.5, alpha_price_tao: 1 },
      {
        netuid: 2,
        alpha_price_tao: 0,
        tao_in_pool_tao: -5,
        alpha_in_pool: null,
      },
      null,
    ]);
    expect(map.size).toBe(1);
    expect(map.get(2)).toEqual({
      alpha_price_tao: null,
      tao_in_pool_tao: null,
      alpha_in_pool: null,
    });
  });

  test("is cold-safe for non-array input", () => {
    expect(economicsByNetuidFromRows(null).size).toBe(0);
    expect(economicsByNetuidFromRows(undefined).size).toBe(0);
  });
});
