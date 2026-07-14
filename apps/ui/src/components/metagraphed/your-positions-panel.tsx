import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowUpFromLine, Boxes, Coins, Wallet } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  StatTile,
  TableState,
} from "@jsonbored/ui-kit";
import { useWallet } from "@/hooks/use-wallet";
import { accountWalletPositionsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { taoCompact } from "@/components/metagraphed/neuron-table";
import type { WalletPosition } from "@/lib/metagraphed/types";
import { requestStakeAction } from "@/lib/metagraphed/stake-actions";

const KPI_TILE = "rounded-xl border border-border bg-card";

function fmtTao(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${taoCompact(v)} τ`;
}

function positionLabel(pos: WalletPosition): string {
  if (pos.position_kind === "nominator") {
    return pos.delegated_hotkey
      ? `→ ${shortHash(pos.delegated_hotkey) ?? pos.delegated_hotkey}`
      : "delegated";
  }
  if (pos.role === "validator") return "validator-own";
  if (pos.role === "miner") return "miner-own";
  return "own";
}

function PositionActions({ position }: { position: WalletPosition }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <button
        type="button"
        onClick={() => requestStakeAction("unstake", position)}
        className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:border-ink/30 hover:text-ink-strong"
      >
        <ArrowUpFromLine className="size-3" aria-hidden />
        Unstake
      </button>
      <button
        type="button"
        onClick={() => requestStakeAction("move", position)}
        className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:border-ink/30 hover:text-ink-strong"
      >
        <ArrowLeftRight className="size-3" aria-hidden />
        Move
      </button>
    </div>
  );
}

export function YourPositionsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { address } = useWallet();
  const result = useQuery({
    ...accountWalletPositionsQuery(address ?? ""),
    enabled: open && address != null,
  });
  const data = result.data?.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl p-0 bg-paper text-ink border-l border-border flex flex-col"
      >
        <SheetHeader className="px-5 py-4 border-b border-border space-y-1">
          <SheetTitle className="font-display text-base font-semibold text-ink-strong inline-flex items-center gap-2">
            <Wallet className="size-4 text-accent" /> Your positions
          </SheetTitle>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Cross-subnet holdings for the connected wallet — validator-owned neurons and
            coldkey-delegated stake. Spot mark uses alpha × price; exit value simulates a 5%
            slippage band on alpha subnets.
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!address ? (
            <TableState
              variant="empty"
              title="No wallet connected"
              description="Connect a Polkadot.js, Talisman, or SubWallet extension to load your positions."
            />
          ) : result.isPending && !data ? (
            <div className="space-y-3">
              <div className="h-20 rounded-xl border border-border bg-card animate-pulse" />
              <div className="h-40 rounded-xl border border-border bg-card animate-pulse" />
            </div>
          ) : result.isError ? (
            <TableState
              variant="error"
              title="Could not load positions"
              description="The positions tier failed — try again shortly."
              error={result.error}
              onRetry={() => void result.refetch()}
            />
          ) : !data || data.positions.length === 0 ? (
            <TableState
              variant="empty"
              title="No positions found"
              description="This wallet has no registered neurons or reconstructed delegated stake in the current window."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  icon={Boxes}
                  eyebrow="Positions"
                  tone="accent"
                  value={formatNumber(data.position_count)}
                  className={KPI_TILE}
                />
                <StatTile
                  icon={Coins}
                  eyebrow="Spot mark"
                  value={fmtTao(data.total_spot_mark_tao)}
                  hint="alpha × price"
                  className={KPI_TILE}
                />
                <StatTile
                  icon={Coins}
                  eyebrow="Exit value"
                  value={fmtTao(data.total_exit_value_tao)}
                  hint="incl. slippage"
                  className={KPI_TILE}
                />
              </div>
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-surface/50 text-ink-muted">
                      <tr>
                        <th className="px-3 py-2.5 font-mono text-[10px] uppercase tracking-widest">
                          Subnet
                        </th>
                        <th className="px-3 py-2.5 font-mono text-[10px] uppercase tracking-widest">
                          Kind
                        </th>
                        <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                          Spot
                        </th>
                        <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                          Exit
                        </th>
                        <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                          Root / Alpha
                        </th>
                        <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.positions.map((pos) => (
                        <tr
                          key={`${pos.position_kind}-${pos.netuid}-${pos.delegated_hotkey ?? pos.uid}`}
                        >
                          <td className="px-3 py-3 font-mono text-[12px]">
                            <Link
                              to="/subnets/$netuid"
                              params={{ netuid: pos.netuid }}
                              className="text-ink hover:text-accent hover:underline"
                            >
                              SN{pos.netuid}
                            </Link>
                          </td>
                          <td className="px-3 py-3 font-mono text-[11px] text-ink-muted">
                            {positionLabel(pos)}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-[11px] tabular-nums">
                            {fmtTao(pos.spot_mark_tao)}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-[11px] tabular-nums">
                            {fmtTao(pos.exit_value_tao)}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-[10px] tabular-nums text-ink-muted">
                            {fmtTao(pos.root_stake_tao)} / {fmtTao(pos.alpha_stake_tao)}
                          </td>
                          <td className="px-3 py-3">
                            <PositionActions position={pos} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
