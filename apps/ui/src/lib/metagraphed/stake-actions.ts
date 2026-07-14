import { toast } from "sonner";
import type { WalletPosition } from "@/lib/metagraphed/types";

export type StakeActionKind = "unstake" | "move";

export const STAKE_ACTION_EVT = "metagraphed:stake-action";

export type StakeActionDetail = {
  kind: StakeActionKind;
  position: WalletPosition;
};

/** Entry point for #5242 / #5244 modals — dispatches a document event and toasts until those ship. */
export function requestStakeAction(kind: StakeActionKind, position: WalletPosition) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<StakeActionDetail>(STAKE_ACTION_EVT, {
        detail: { kind, position },
      }),
    );
  }
  const label = kind === "unstake" ? "Unstake" : "Move stake";
  toast.message(`${label} flow opens in a follow-up issue`, {
    description: `SN${position.netuid} · ${position.position_kind}. This panel only routes the action — transaction construction lives in #5242/#5244.`,
  });
}
