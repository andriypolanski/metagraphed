import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Fingerprint, Radio } from "lucide-react";
import { chainIdentityHistoryQuery } from "@/lib/metagraphed/queries";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { classNames } from "@/lib/metagraphed/format";
import type { ChainIdentityChange } from "@/lib/metagraphed/types";

function identitySnapshotDetail(change: ChainIdentityChange): string | undefined {
  if (change.description) return change.description;
  if (change.subnet_url) return change.subnet_url;
  if (change.github_repo) return change.github_repo;
  if (change.discord) return change.discord;
  if (change.symbol) return `symbol · ${change.symbol}`;
  return undefined;
}

function identityTitle(change: ChainIdentityChange): string {
  const name = change.subnet_name?.trim() || `SN${change.netuid}`;
  return change.symbol?.trim() ? `${name} · ${change.symbol}` : name;
}

/**
 * Homepage feed of the most recent on-chain SubnetIdentitiesV3 changes
 * network-wide (#3474).
 */
export function RecentIdentityChanges({
  className,
  limit = 10,
}: {
  className?: string;
  limit?: number;
}) {
  const { data: res } = useSuspenseQuery(chainIdentityHistoryQuery(limit));
  const changes = res.data.changes ?? [];

  return (
    <div className={classNames("rounded-lg border border-border bg-card p-5", className)}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            On-chain identity
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            Recent subnet identity changes
          </h3>
        </div>
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted">
          <Fingerprint className="size-3" aria-hidden />
          live
        </span>
      </div>
      {changes.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-xs text-ink-muted">
          <Radio className="size-3.5" aria-hidden />
          No recent identity changes observed.
        </div>
      ) : (
        <ol className="space-y-2.5">
          {changes.map((change) => {
            const detail = identitySnapshotDetail(change);
            return (
              <li
                key={`${change.netuid}:${change.identity_hash}`}
                className="flex items-start gap-2.5 group"
              >
                <span
                  className="mt-0.5 inline-flex size-5 items-center justify-center rounded border border-accent/40 text-accent shrink-0"
                  aria-hidden
                >
                  <Fingerprint className="size-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: change.netuid }}
                    className="text-xs font-medium text-ink-strong truncate block group-hover:text-accent transition-colors"
                  >
                    {identityTitle(change)}
                  </Link>
                  <div className="flex items-baseline gap-2 mt-0.5 min-w-0">
                    {detail ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted truncate">
                        {detail}
                      </span>
                    ) : null}
                    {change.observed_at ? (
                      <span className="font-mono text-[10px] text-ink-muted shrink-0">
                        <TimeAgo at={change.observed_at} />
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
