import { describe, expect, it, vi, beforeEach } from "vitest";
import { accountWalletPositionsQuery, normalizeWalletPosition } from "@/lib/metagraphed/queries";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

vi.mock("@/lib/metagraphed/client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/metagraphed/client";

const mockedApiFetch = vi.mocked(apiFetch);

describe("normalizeWalletPosition", () => {
  it("shapes a full wallet position row", () => {
    expect(
      normalizeWalletPosition({
        position_kind: "nominator",
        netuid: 3,
        hotkey: null,
        delegated_hotkey: "5Hot",
        uid: null,
        role: "nominator",
        active: true,
        stake_tao: 5,
        alpha_amount: 2,
        alpha_price_tao: 2,
        root_stake_tao: 0,
        alpha_stake_tao: 5,
        spot_mark_tao: 4,
        exit_value_tao: 3.8,
        realized_yield_tao: null,
      }),
    ).toMatchObject({
      position_kind: "nominator",
      netuid: 3,
      delegated_hotkey: "5Hot",
      spot_mark_tao: 4,
      exit_value_tao: 3.8,
    });
  });

  it("returns null for invalid rows", () => {
    expect(normalizeWalletPosition({ netuid: "nope" })).toBeNull();
    expect(normalizeWalletPosition(null)).toBeNull();
  });
});

describe("accountWalletPositionsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("requests the wallet-positions path and shapes the envelope", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {
        ss58: ALICE,
        position_count: 1,
        total_spot_mark_tao: 10,
        total_exit_value_tao: 9.5,
        positions: [
          {
            position_kind: "validator-own",
            netuid: 1,
            hotkey: ALICE,
            delegated_hotkey: null,
            uid: 2,
            role: "validator",
            active: true,
            stake_tao: 10,
            spot_mark_tao: 10,
            exit_value_tao: 9.5,
            root_stake_tao: 0,
            alpha_stake_tao: 10,
          },
        ],
      },
      meta: { generated_at: "2026-07-14T00:00:00.000Z" },
      url: "/api/v1/accounts/x/wallet-positions",
    });

    const opts = accountWalletPositionsQuery(ALICE);
    const result = await opts.queryFn!({ signal: new AbortController().signal } as never);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/wallet-positions`,
      {
        signal: expect.any(AbortSignal),
      },
    );
    expect(result.data.position_count).toBe(1);
    expect(result.data.positions[0]?.position_kind).toBe("validator-own");
  });
});
