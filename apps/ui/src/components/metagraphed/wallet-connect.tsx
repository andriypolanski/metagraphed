import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, LogOut, Wallet } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  CopyableCode,
} from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { useWallet } from "@/hooks/use-wallet";
import {
  WALLET_DISCLAIMER,
  discoverExtensionAccounts,
  supportedWalletLinks,
  type WalletAccount,
} from "@/lib/metagraphed/wallet";
import { shortHash } from "@/lib/metagraphed/blocks";
import { classNames } from "@/lib/metagraphed/format";

export function WalletConnect() {
  const { address, connected, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<WalletAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAccounts() {
    setLoading(true);
    setError(null);
    try {
      const found = await discoverExtensionAccounts();
      setAccounts(found);
      if (found.length === 0) {
        setError("No extension accounts found. Install a supported wallet and create an account.");
      }
    } catch {
      setError("Could not reach a wallet extension.");
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !connected) void loadAccounts();
  }

  function pickAccount(acct: WalletAccount) {
    connect(acct.address);
    setOpen(false);
  }

  if (connected && address) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink/30 transition-colors min-h-11"
                aria-label="Connected wallet"
              >
                <Wallet className="size-3 text-accent" aria-hidden />
                <span className="text-ink-strong">{shortHash(address) ?? address}</span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Connected wallet
          </TooltipContent>
        </Tooltip>
        <ClampedPopoverContent align="end" className="w-72 p-3 space-y-3">
          <div>
            <div className="mg-label">Connected</div>
            <CopyableCode label="address" value={address} className="mt-1 w-full" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/accounts/$ss58"
              params={{ ss58: address }}
              className="inline-flex flex-1 items-center justify-center rounded border border-border bg-card px-2 py-1.5 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30"
              onClick={() => setOpen(false)}
            >
              Explorer view
            </Link>
            <button
              type="button"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1.5 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30"
            >
              <LogOut className="size-3" aria-hidden />
              Disconnect
            </button>
          </div>
        </ClampedPopoverContent>
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors min-h-11"
            >
              <Wallet className="size-3" aria-hidden />
              <span>Connect</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Connect a wallet to see your positions
        </TooltipContent>
      </Tooltip>
      <ClampedPopoverContent align="end" className="w-80 p-3 space-y-3">
        <div>
          <div className="font-display text-sm font-semibold text-ink-strong">Connect wallet</div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{WALLET_DISCLAIMER}</p>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-muted">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Looking for extensions…
          </div>
        ) : null}
        {error ? <p className="text-[11px] text-health-warn">{error}</p> : null}
        {accounts && accounts.length > 0 ? (
          <ul className="space-y-1">
            {accounts.map((acct) => (
              <li key={acct.address}>
                <button
                  type="button"
                  onClick={() => pickAccount(acct)}
                  className="w-full rounded border border-border bg-card px-2.5 py-2 text-left hover:border-ink/30"
                >
                  <div className="font-medium text-[12px] text-ink-strong">
                    {acct.name ?? "Account"}
                  </div>
                  <div className="font-mono text-[10px] text-ink-muted">
                    {shortHash(acct.address) ?? acct.address}
                    {acct.source ? ` · ${acct.source}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="border-t border-border pt-2">
          <div className="mg-label mb-1">Supported wallets</div>
          <ul className="space-y-1">
            {supportedWalletLinks().map((w) => (
              <li key={w.name}>
                <a
                  href={w.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-accent-text hover:underline"
                >
                  {w.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => void loadAccounts()}
          className={classNames(
            "w-full rounded border border-border bg-card px-2 py-1.5 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30",
            loading && "opacity-60",
          )}
          disabled={loading}
        >
          Refresh extensions
        </button>
      </ClampedPopoverContent>
    </Popover>
  );
}
