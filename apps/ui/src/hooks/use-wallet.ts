import { useEffect, useState } from "react";
import { getConnectedWallet, onWalletChange, setConnectedWallet } from "@/lib/metagraphed/wallet";

export function useWallet() {
  const [address, setAddress] = useState<string | null>(() => getConnectedWallet());

  useEffect(() => onWalletChange(setAddress), []);

  return {
    address,
    connected: address != null,
    connect: (next: string) => setConnectedWallet(next),
    disconnect: () => setConnectedWallet(null),
  };
}
