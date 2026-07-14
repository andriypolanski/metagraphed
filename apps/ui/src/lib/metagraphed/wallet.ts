import { DEFAULT_GITHUB_REPO } from "@/lib/metagraphed/config";

export const WALLET_STORAGE_KEY = "mg-connected-wallet";
export const WALLET_EVT = "mg-wallet-change";

const SUPPORTED_WALLETS = [
  {
    name: "Polkadot.js",
    url: "https://polkadot.js.org/extension/",
  },
  {
    name: "Talisman",
    url: "https://talisman.xyz/",
  },
  {
    name: "SubWallet",
    url: "https://www.subwallet.app/",
  },
] as const;

export type WalletAccount = {
  address: string;
  name?: string;
  source?: string;
};

let cachedAddress: string | null | undefined;

function readStoredWallet(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(WALLET_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Currently connected ss58 address, or null when disconnected. */
export function getConnectedWallet(): string | null {
  if (cachedAddress !== undefined) return cachedAddress;
  cachedAddress = readStoredWallet();
  return cachedAddress;
}

export function setConnectedWallet(address: string | null) {
  cachedAddress = address;
  if (typeof window !== "undefined") {
    try {
      if (!address) window.localStorage.removeItem(WALLET_STORAGE_KEY);
      else window.localStorage.setItem(WALLET_STORAGE_KEY, address);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(WALLET_EVT, { detail: address }));
  }
}

export function onWalletChange(cb: (address: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<string | null>).detail ?? null);
  window.addEventListener(WALLET_EVT, handler);
  return () => window.removeEventListener(WALLET_EVT, handler);
}

export function supportedWalletLinks() {
  return SUPPORTED_WALLETS;
}

type InjectedExtension = {
  enable: (app: string) => Promise<{
    accounts: {
      get: () => Promise<Array<{ address: string; meta?: { name?: string; source?: string } }>>;
    };
  }>;
};

type InjectedWindow = Window & {
  injectedWeb3?: Record<string, InjectedExtension>;
};

/** Discover accounts from installed Polkadot-compatible extensions. */
export async function discoverExtensionAccounts(): Promise<WalletAccount[]> {
  if (typeof window === "undefined") return [];
  const injected = (window as InjectedWindow).injectedWeb3;
  if (!injected || Object.keys(injected).length === 0) return [];

  const accounts: WalletAccount[] = [];
  for (const [source, ext] of Object.entries(injected)) {
    try {
      const enabled = await ext.enable("Metagraphed");
      const list = await enabled.accounts.get();
      for (const acct of list) {
        if (!acct?.address) continue;
        accounts.push({
          address: acct.address,
          name: acct.meta?.name,
          source: acct.meta?.source ?? source,
        });
      }
    } catch {
      /* extension declined or unavailable */
    }
  }
  const seen = new Set<string>();
  return accounts.filter((a) => {
    if (seen.has(a.address)) return false;
    seen.add(a.address);
    return true;
  });
}

export const WALLET_DISCLAIMER =
  "Metagraphed never sees your keys. Connect only signs read access here — transactions are confirmed in your wallet.";

export const WALLET_DOCS_URL = DEFAULT_GITHUB_REPO;
