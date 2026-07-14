import { describe, expect, test } from "vitest";
import {
  buildAccountPositions,
  buildNominatorPositions,
  DEFAULT_EXIT_SLIPPAGE,
} from "../src/account-positions.mjs";

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("buildNominatorPositions", () => {
  test("keeps positive net stake rows as nominator positions", () => {
    const out = buildNominatorPositions([
      { netuid: 1, hotkey: "5Hot", net_stake_tao: 10, net_alpha_amount: 8 },
      { netuid: 2, hotkey: "5Hot2", net_stake_tao: 0, net_alpha_amount: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      position_kind: "nominator",
      netuid: 1,
      delegated_hotkey: "5Hot",
      role: "nominator",
      stake_tao: 10,
      alpha_amount: 8,
    });
  });
});

describe("buildAccountPositions", () => {
  test("merges validator-own and nominator rows with valuation fields", () => {
    const portfolio = {
      captured_at: "2026-07-14T00:00:00.000Z",
      positions: [
        {
          netuid: 1,
          uid: 3,
          role: "validator",
          active: true,
          stake_tao: 100,
          emission_tao: 1,
          rank: 0.1,
          trust: 0.2,
          incentive: 0.3,
          dividends: 0.4,
          yield: 0.01,
        },
      ],
    };
    const priceByNetuid = new Map([
      [1, 2],
      [3, 2],
    ]);
    const out = buildAccountPositions(
      {
        portfolio,
        nominatorRows: [
          { netuid: 3, hotkey: "5Val", net_stake_tao: 5, net_alpha_amount: 2 },
        ],
        priceByNetuid,
      },
      SS58,
    );
    expect(out.position_count).toBe(2);
    expect(out.total_spot_mark_tao).toBeGreaterThan(0);
    const own = out.positions.find((p) => p.position_kind === "validator-own");
    const nom = out.positions.find((p) => p.position_kind === "nominator");
    expect(own?.hotkey).toBe(SS58);
    expect(own?.spot_mark_tao).toBe(100);
    expect(own?.exit_value_tao).toBeCloseTo(100 * (1 - DEFAULT_EXIT_SLIPPAGE));
    expect(nom?.delegated_hotkey).toBe("5Val");
    expect(nom?.spot_mark_tao).toBeCloseTo(4);
  });

  test("root netuid 0 is exempt from exit slippage", () => {
    const out = buildAccountPositions(
      {
        portfolio: {
          positions: [
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
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out.positions[0].spot_mark_tao).toBe(50);
    expect(out.positions[0].exit_value_tao).toBe(50);
    expect(out.positions[0].root_stake_tao).toBe(50);
    expect(out.positions[0].alpha_stake_tao).toBe(0);
  });

  test("empty inputs yield a schema-stable empty card", () => {
    const out = buildAccountPositions(
      {
        portfolio: { positions: [] },
        nominatorRows: [],
        priceByNetuid: new Map(),
      },
      SS58,
    );
    expect(out).toMatchObject({
      schema_version: 1,
      ss58: SS58,
      position_count: 0,
      total_spot_mark_tao: 0,
      total_exit_value_tao: 0,
      positions: [],
    });
  });
});
