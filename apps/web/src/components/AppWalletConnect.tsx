"use client";

import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useWalletConnections } from "./WalletConnectionContext";

function truncateAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function AppWalletConnect() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const {
    solanaAddress,
    solanaConnecting,
    connectSolanaWallet,
    disconnectSolanaWallet,
    stellarAddress,
    stellarConnecting,
    connectStellarWallet,
    disconnectStellarWallet,
    lastWalletError,
    clearWalletError,
  } = useWalletConnections();

  useEffect(() => {
    if (!open) clearWalletError();
  }, [open, clearWalletError]);

  const connectedCount = [isConnected, Boolean(solanaAddress), Boolean(stellarAddress)].filter(Boolean).length;
  const triggerLabel = connectedCount > 0
    ? `${connectedCount} Wallet${connectedCount === 1 ? "" : "s"} Connected`
    : "Connect Wallet";

  return (
    <ConnectButton.Custom>
      {({ openConnectModal, openAccountModal }) => (
        <>
          <button type="button" className="wallet-connect-trigger" onClick={() => setOpen(true)}>
            {triggerLabel}
          </button>

          {open && (
            <div className="wallet-choice-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
              <div className="wallet-choice-modal" role="dialog" aria-modal="true" aria-label="Connect wallet" onMouseDown={(e) => e.stopPropagation()}>
                <div className="wallet-choice-header">
                  <div>
                    <h2>Connect Wallet</h2>
                    <p>Choose the wallet for the chain you want to use.</p>
                  </div>
                  <button type="button" className="wallet-choice-close" aria-label="Close wallet selector" onClick={() => setOpen(false)}>x</button>
                </div>

                <div className="wallet-choice-list">
                  <button
                    type="button"
                    className="wallet-choice-option"
                    onClick={() => {
                      setOpen(false);
                      if (isConnected) openAccountModal?.();
                      else openConnectModal?.();
                    }}
                  >
                    <span className="wallet-choice-icon rainbow-icon" aria-hidden="true" />
                    <span>
                      <strong>RainbowKit</strong>
                      <small>{isConnected && address ? truncateAddr(address) : "EVM wallets"}</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="wallet-choice-option"
                    onClick={async () => {
                      if (solanaAddress) {
                        await disconnectSolanaWallet();
                      } else {
                        await connectSolanaWallet();
                      }
                    }}
                    disabled={solanaConnecting}
                  >
                    <span className="wallet-choice-icon phantom-icon" aria-hidden="true" />
                    <span>
                      <strong>Phantom</strong>
                      <small>{solanaConnecting ? "Connecting..." : solanaAddress ? truncateAddr(solanaAddress) : "Solana wallet"}</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="wallet-choice-option"
                    onClick={async () => {
                      if (stellarAddress) {
                        await disconnectStellarWallet();
                      } else {
                        await connectStellarWallet();
                      }
                    }}
                    disabled={stellarConnecting}
                  >
                    <span className="wallet-choice-icon freighter-icon" aria-hidden="true" />
                    <span>
                      <strong>Freighter</strong>
                      <small>{stellarConnecting ? "Connecting..." : stellarAddress ? truncateAddr(stellarAddress) : "Stellar wallet"}</small>
                    </span>
                  </button>
                </div>

                {lastWalletError && <p className="wallet-choice-error">{lastWalletError}</p>}
              </div>
            </div>
          )}
        </>
      )}
    </ConnectButton.Custom>
  );
}
