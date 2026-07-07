"use client";

import { ReactNode, createContext, useContext, useMemo, useState } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import {
  getAddress as getFreighterAddress,
  isAllowed as isFreighterAllowed,
  isConnected as isFreighterConnected,
  requestAccess as requestFreighterAccess,
} from "@stellar/freighter-api";

type SolanaInjectedProvider = {
  isPhantom?: boolean;
  isBackpack?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString: () => string };
  connect: () => Promise<{ publicKey?: { toString: () => string } } | void>;
  disconnect?: () => Promise<void>;
};

type SolanaWalletAdapter = {
  name: string;
  readyState: WalletReadyState;
  publicKey: { toString: () => string } | null;
  connect: () => Promise<void>;
  disconnect?: () => Promise<void>;
};

type WalletConnectionContextValue = {
  solanaAddress: string | null;
  solanaConnecting: boolean;
  connectSolanaWallet: () => Promise<void>;
  disconnectSolanaWallet: () => Promise<void>;
  stellarAddress: string | null;
  stellarConnecting: boolean;
  connectStellarWallet: () => Promise<void>;
  disconnectStellarWallet: () => Promise<void>;
  rippleAddress: string | null;
  rippleConnecting: boolean;
  connectRippleWallet: () => Promise<void>;
  disconnectRippleWallet: () => Promise<void>;
  lastWalletError: string | null;
  clearWalletError: () => void;
};

const WalletConnectionContext = createContext<WalletConnectionContextValue | null>(null);

function getWindowWallets() {
  return typeof window === "undefined" ? undefined : window as Window & Record<string, any>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSolanaProvider(provider: any): provider is SolanaInjectedProvider {
  return Boolean(provider?.connect && (provider.isPhantom || provider.isBackpack || provider.isSolflare || provider.publicKey || provider._publicKey));
}

async function waitForSolanaInjection(timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const wallets = getWindowWallets();
    if (wallets?.phantom?.solana || wallets?.solana || wallets?.backpack?.solana || wallets?.solflare) return;
    await sleep(100);
  }
}

async function findSolanaAdapter(): Promise<SolanaWalletAdapter | null> {
  await waitForSolanaInjection();

  const adapters: SolanaWalletAdapter[] = [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ];

  return adapters.find((adapter) =>
    adapter.readyState === WalletReadyState.Installed ||
    adapter.readyState === WalletReadyState.Loadable
  ) ?? null;
}

async function findSolanaProvider(): Promise<SolanaInjectedProvider | null> {
  await waitForSolanaInjection();

  const wallets = getWindowWallets();
  if (!wallets) return null;

  const candidates = [
    wallets.phantom?.solana,
    wallets.backpack?.solana,
    wallets.solflare,
    wallets.solana,
  ];

  return candidates.find(isSolanaProvider) ?? null;
}

export function freighterErrorMessage(error: unknown) {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  if (typeof error === "object" && "name" in error && typeof error.name === "string") return error.name;
  return String(error);
}

export function WalletConnectionProvider({ children }: { children: ReactNode }) {
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [solanaConnecting, setSolanaConnecting] = useState(false);
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);
  const [stellarConnecting, setStellarConnecting] = useState(false);
  const [rippleAddress, setRippleAddress] = useState<string | null>(null);
  const [rippleConnecting, setRippleConnecting] = useState(false);
  const [lastWalletError, setLastWalletError] = useState<string | null>(null);

  async function connectSolanaWallet() {
    console.log("[WalletConnection] connectSolanaWallet clicked");
    setLastWalletError(null);
    setSolanaConnecting(true);
    try {
      const adapter = await findSolanaAdapter();
      if (adapter) {
        console.log(`[WalletConnection] ${adapter.name} adapter found, calling connect()...`);
        await adapter.connect();
        const pubkey = adapter.publicKey?.toString();
        if (!pubkey) throw new Error(`${adapter.name} connected, but no public key was returned.`);
        setSolanaAddress(pubkey);
        return;
      }

      const provider = await findSolanaProvider();
      if (!provider) {
        throw new Error("No Solana wallet was detected in this browser tab. Make sure Phantom is enabled for this site, disable extension site restrictions, then refresh.");
      }
      const resp = await provider.connect();
      const pubkey = resp?.publicKey?.toString() ?? provider.publicKey?.toString();
      if (!pubkey) throw new Error("Solana wallet connected, but no public key was returned.");
      setSolanaAddress(pubkey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastWalletError(msg);
      console.error("[WalletConnection] Solana connect error:", msg);
    } finally {
      setSolanaConnecting(false);
    }
  }

  async function disconnectSolanaWallet() {
    try {
      const adapter = await findSolanaAdapter();
      if (adapter?.disconnect) await adapter.disconnect();
      const provider = await findSolanaProvider();
      if (provider?.disconnect) await provider.disconnect();
    } catch { /* ignore */ }
    setSolanaAddress(null);
  }

  async function connectStellarWallet() {
    console.log("[WalletConnection] connectStellarWallet clicked");
    setLastWalletError(null);
    setStellarConnecting(true);
    try {
      const connected = await isFreighterConnected();
      if (connected.error) throw new Error(freighterErrorMessage(connected.error) ?? "Freighter connection check failed.");
      if (!connected.isConnected) throw new Error("Freighter extension was not detected. Make sure it is enabled for this browser tab, then refresh.");

      const allowed = await isFreighterAllowed();
      if (allowed.error) throw new Error(freighterErrorMessage(allowed.error) ?? "Freighter permission check failed.");

      const result = allowed.isAllowed ? await getFreighterAddress() : await requestFreighterAccess();
      if (result.error) throw new Error(freighterErrorMessage(result.error) ?? "Freighter access was rejected.");
      const address = result.address;
      if (!address) throw new Error("Freighter did not return a Stellar address. Make sure the extension is unlocked and this site is allowed.");
      setStellarAddress(address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastWalletError(msg);
      console.error("[WalletConnection] Stellar connect error:", msg);
    } finally {
      setStellarConnecting(false);
    }
  }

  async function disconnectStellarWallet() {
    setStellarAddress(null);
  }

  async function connectRippleWallet() {
    console.log("[WalletConnection] connectRippleWallet clicked");
    setLastWalletError(null);
    setRippleConnecting(true);
    try {
      const wallets = getWindowWallets();
      const crossmarkSdk = wallets?.xrpl?.crossmark || wallets?.crossmark;
      if (!crossmarkSdk) {
        throw new Error("Crossmark extension was not detected. Please install it and refresh.");
      }
      
      let result;
      if (crossmarkSdk.methods && typeof crossmarkSdk.methods.signInAndWait === 'function') {
        result = await crossmarkSdk.methods.signInAndWait();
      } else if (typeof crossmarkSdk.signInAndWait === 'function') {
        result = await crossmarkSdk.signInAndWait();
      } else {
        throw new Error("signInAndWait not found on Crossmark SDK.");
      }
      
      const addr = result?.address || result?.response?.data?.address;
      if (!addr) throw new Error("Crossmark did not return a Ripple address.");
      setRippleAddress(addr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastWalletError(msg);
      console.error("[WalletConnection] Ripple connect error:", msg);
    } finally {
      setRippleConnecting(false);
    }
  }

  async function disconnectRippleWallet() {
    setRippleAddress(null);
  }

  const value = useMemo<WalletConnectionContextValue>(() => ({
    solanaAddress,
    solanaConnecting,
    connectSolanaWallet,
    disconnectSolanaWallet,
    stellarAddress,
    stellarConnecting,
    connectStellarWallet,
    disconnectStellarWallet,
    rippleAddress,
    rippleConnecting,
    connectRippleWallet,
    disconnectRippleWallet,
    lastWalletError,
    clearWalletError: () => setLastWalletError(null),
  }), [
    solanaAddress,
    solanaConnecting,
    stellarAddress,
    stellarConnecting,
    rippleAddress,
    rippleConnecting,
    lastWalletError
  ]);

  return (
    <WalletConnectionContext.Provider value={value}>
      {children}
    </WalletConnectionContext.Provider>
  );
}

export function useWalletConnections() {
  const value = useContext(WalletConnectionContext);
  if (!value) throw new Error("useWalletConnections must be used inside WalletConnectionProvider");
  return value;
}
