"use client";

import { ReactNode } from "react";
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider, http } from "wagmi";
import { baseSepolia, sepolia } from "wagmi/chains";
import { defineChain } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletConnectionProvider } from "./components/WalletConnectionContext";
import "@rainbow-me/rainbowkit/styles.css";

// Arc Testnet as a custom viem/wagmi chain
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

// Ripple EVM Testnet as custom chain
export const rippleEvmTestnet = defineChain({
  id: 1449000,
  name: "Ripple EVM Testnet",
  nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.xrplevm.org"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.xrplevm.org" } },
});

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "demo_arc_os_project";

const PUBLIC_ROUTER_FALLBACKS: Record<number, `0x${string}` | undefined> = {
  [arcTestnet.id]: "0xB8d19Db51A912010b913201af33CB0CF5Df1FE83",
  [baseSepolia.id]: "0x78c7b90a0AD6302e4811A49aE921cB7e6BB15de4",
  [sepolia.id]: "0x8a996eB1AC6580662b66CE5Df7f1892EA6382e72",
  [rippleEvmTestnet.id]: "0x78c7b90a0AD6302e4811A49aE921cB7e6BB15de4",
};

export const wagmiConfig = getDefaultConfig({
  appName: "Chrysalis V2",
  projectId,
  chains: [arcTestnet, baseSepolia, sepolia, rippleEvmTestnet],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
    [baseSepolia.id]: http("https://sepolia.base.org"),
    [sepolia.id]: http("https://sepolia.infura.io/v3/cea2942c462d447983f9f20783cd2f64"),
    [rippleEvmTestnet.id]: http("https://rpc.testnet.xrplevm.org"),
  },
  ssr: true
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#e8000f",
            accentColorForeground: "white",
            borderRadius: "none",
            fontStack: "system",
          })}
          locale="en-US"
        >
          <WalletConnectionProvider>
            {children}
          </WalletConnectionProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// USDC token addresses per chain (for balance reads)
export const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  [arcTestnet.id]: "0x3600000000000000000000000000000000000000",
  [baseSepolia.id]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [sepolia.id]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  [rippleEvmTestnet.id]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// Router addresses per chain
export const ROUTER_ADDRESSES: Record<number, `0x${string}` | undefined> = {
  [arcTestnet.id]: process.env.NEXT_PUBLIC_ARC_ROUTER as `0x${string}` | undefined ?? PUBLIC_ROUTER_FALLBACKS[arcTestnet.id],
  [baseSepolia.id]: process.env.NEXT_PUBLIC_BASE_ROUTER as `0x${string}` | undefined ?? PUBLIC_ROUTER_FALLBACKS[baseSepolia.id],
  [sepolia.id]: process.env.NEXT_PUBLIC_ETHEREUM_ROUTER as `0x${string}` | undefined ?? PUBLIC_ROUTER_FALLBACKS[sepolia.id],
  [rippleEvmTestnet.id]: process.env.NEXT_PUBLIC_RIPPLE_EVM_ROUTER as `0x${string}` | undefined ?? PUBLIC_ROUTER_FALLBACKS[rippleEvmTestnet.id],
};

// Chain key → chainId map
export const CHAIN_KEY_TO_ID: Record<string, number> = {
  ARC: arcTestnet.id,
  BASE_SEPOLIA: baseSepolia.id,
  ETHEREUM_SEPOLIA: sepolia.id,
  RIPPLE_EVM_TESTNET: rippleEvmTestnet.id,
};

export const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;
