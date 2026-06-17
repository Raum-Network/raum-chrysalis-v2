"use client";

import React, { useState, useRef, useEffect } from "react";

export interface AIAssistantProps {
  connectedWallet?: string;
  connectedChain?: string;
  solanaWallet?: string;
  stellarWallet?: string;
  apiUrl: string;
  onApplyIntent: (intent: any, quote?: any) => void;
  onExecuteIntent: (intent: any, quote?: any) => void;
}

interface Message {
  id: string;
  sender: "user" | "assistant";
  text: string;
  time: string;
  intent?: any;
  quote?: any;
}

const SUGGESTIONS = [
  "Swap 10 USDC on Base to WETH on Uniswap",
  "Bridge 5 USDC from Ethereum to Solana",
  "Stake 2 USDC on Solana into Marinade",
  "Supply 1 USDC to Aave V3 on Ethereum"
];

export default function AIAssistant({
  connectedWallet,
  connectedChain,
  solanaWallet,
  stellarWallet,
  apiUrl,
  onApplyIntent,
  onExecuteIntent
}: AIAssistantProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      sender: "assistant",
      text: "Hi! I'm your Chrysalis V2 AI Assistant. Tell me what transaction you want to perform (e.g. 'swap 5 USDC on Base to WETH on Uniswap' or 'bridge 10 USDC from Base to Stellar') and I'll find the best route!",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }
  ]);
  const [isLoading, setIsLoading] = useState(false);

  const historyEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom of chat
  useEffect(() => {
    if (isOpen) {
      historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen, isLoading]);

  const handleSend = async (textToSend: string) => {
    if (!textToSend.trim() || isLoading) return;

    const userTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const userMsg: Message = {
      id: Math.random().toString(),
      sender: "user",
      text: textToSend,
      time: userTime
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    // Client-side check: if source chain is non-EVM and wallet not connected, show message immediately
    const isSolanaSource = connectedChain === "SOLANA_DEVNET";
    const isStellarSource = connectedChain === "STELLAR_TESTNET";

    if (isSolanaSource && !solanaWallet) {
      const assistantTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: "assistant",
          text: "Your Solana wallet is not connected. Please connect your Phantom wallet to use Solana as the source chain, or select a different source chain from the dropdown.",
          time: assistantTime
        }
      ]);
      setIsLoading(false);
      return;
    }

    if (isStellarSource && !stellarWallet) {
      const assistantTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: "assistant",
          text: "Your Stellar wallet is not connected. Please connect your Freighter wallet to use Stellar as the source chain, or select a different source chain from the dropdown.",
          time: assistantTime
        }
      ]);
      setIsLoading(false);
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/agents/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: textToSend,
          connectedWallet,
          connectedChain,
          solanaWallet,
          stellarWallet
        })
      });

      if (!res.ok) {
        throw new Error(`Chat API error: ${res.statusText}`);
      }

      const data = await res.json();
      const assistantTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      // If intent has a destination chain that needs a wallet not connected, show wallet message instead
      if (data.intent) {
        const destChain = data.intent.destinationChain;
        if (destChain === "SOLANA_DEVNET" && !solanaWallet) {
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(),
              sender: "assistant",
              text: "Your Solana wallet is not connected. Please connect your Phantom wallet to receive on Solana, or choose a different destination chain.",
              time: assistantTime
            }
          ]);
          setIsLoading(false);
          return;
        }
        if (destChain === "STELLAR_TESTNET" && !stellarWallet) {
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(),
              sender: "assistant",
              text: "Your Stellar wallet is not connected. Please connect your Freighter wallet to receive on Stellar, or choose a different destination chain.",
              time: assistantTime
            }
          ]);
          setIsLoading(false);
          return;
        }
      }
      
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: "assistant",
          text: data.explanation || "I've decoded your intent. See details below:",
          time: assistantTime,
          intent: data.intent,
          quote: data.quote
        }
      ]);
    } catch (err) {
      console.error("[AIAssistant] Error sending chat message:", err);
      const assistantTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: "assistant",
          text: "Sorry, I ran into an issue communicating with the AI service. Please make sure the API server is running and a GEMINI_API_KEY is configured.",
          time: assistantTime
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const getChainName = (key: string) => {
    switch (key) {
      case "ARC": return "Arc Testnet";
      case "BASE_SEPOLIA": return "Base Sepolia";
      case "ETHEREUM_SEPOLIA": return "Ethereum Sepolia";
      case "SOLANA_DEVNET": return "Solana Devnet";
      case "STELLAR_TESTNET": return "Stellar Testnet";
      default: return key;
    }
  };

  const getProtocolName = (key: string) => {
    if (key.includes("TRANSFER")) return "USDC Transfer";
    if (key.includes("UNISWAP")) return "Uniswap V3";
    if (key.includes("AAVE")) return "Aave V3";
    if (key.includes("MORPHO")) return "Morpho Blue";
    if (key.includes("MARINADE")) return "Marinade Finance";
    if (key.includes("AQUARIUS")) return "Aquarius AMM";
    if (key.includes("BLEND")) return "Blend Capital";
    return key;
  };

  return (
    <>
      {/* Floating Sparkle Bubble */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="ai-chat-bubble"
        title="Open AI Assistant"
        aria-label="Open AI Assistant"
      >
        {isOpen ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M12 7v6M9 10h6" strokeWidth="1.5" />
          </svg>
        )}
      </button>

      {/* Drawer */}
      {isOpen && (
        <div className="ai-chat-drawer">
          <div className="ai-chat-header">
            <h3>
              AI Assistant <span>Gemini 3.5 Flash</span>
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="ai-chat-close"
              title="Close Panel"
              aria-label="Close Panel"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="ai-chat-history">
            {messages.map((msg) => (
              <div key={msg.id} className={`chat-msg ${msg.sender}`}>
                <div className="chat-bubble">
                  {msg.text}

                  {/* If assistant returned an actionable transaction intent, render the Action Card */}
                  {msg.sender === "assistant" && msg.intent && (
                    <div className="ai-action-card">
                      <div className="ai-action-title">
                        ✨ Decoded Transaction Plan
                      </div>
                      <div className="ai-action-details">
                        <div className="ai-action-detail-row">
                          <span>Action:</span>
                          <strong>{msg.intent.action?.toUpperCase()}</strong>
                        </div>
                        <div className="ai-action-detail-row">
                          <span>Amount:</span>
                          <strong>{msg.intent.amount} {msg.intent.asset || "USDC"}</strong>
                        </div>
                        <div className="ai-action-detail-row">
                          <span>Source Chain:</span>
                          <strong>{getChainName(msg.intent.sourceChain)}</strong>
                        </div>
                        <div className="ai-action-detail-row">
                          <span>Destination:</span>
                          <strong>{getChainName(msg.intent.destinationChain)}</strong>
                        </div>
                        <div className="ai-action-detail-row">
                          <span>Protocol:</span>
                          <strong>{getProtocolName(msg.intent.protocol)}</strong>
                        </div>
                        {msg.quote?.selected && (
                          <>
                            <div className="ai-action-detail-row">
                              <span>Recommended Rail:</span>
                              <strong>{msg.quote.selected.routeKind === "GATEWAY" ? "Circle Gateway" : msg.quote.selected.routeKind === "CCTP_V2" ? "Circle CCTP" : msg.quote.selected.routeKind}</strong>
                            </div>
                            <div className="ai-action-detail-row">
                              <span>Estimated Fee:</span>
                              <strong>{Number(msg.quote.selected.userPaysUsd).toFixed(3)} USDC</strong>
                            </div>
                            <div className="ai-action-detail-row">
                              <span>Time Estimate:</span>
                              <strong>~{msg.quote.selected.estimatedTimeSeconds} sec</strong>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="ai-action-buttons">
                        <button
                          onClick={() => {
                            onApplyIntent(msg.intent, msg.quote);
                            setIsOpen(false);
                          }}
                          className="ai-action-btn secondary"
                          title="Apply intent details to the form above"
                        >
                          Load Form
                        </button>
                        <button
                          onClick={() => {
                            onExecuteIntent(msg.intent, msg.quote);
                            setIsOpen(false);
                          }}
                          className="ai-action-btn primary"
                          title="Apply intent and immediately prompt execution"
                        >
                          Confirm &amp; Execute
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <span className="chat-msg-time">{msg.time}</span>
              </div>
            ))}

            {isLoading && (
              <div className="chat-msg assistant">
                <div className="chat-loading">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}

            <div ref={historyEndRef} />
          </div>

          {/* Quick Suggestions (rendered when chat history is short or user is idle) */}
          {messages.length <= 2 && !isLoading && (
            <div style={{ padding: "0 20px 8px 20px" }}>
              <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "6px" }}>Suggestions:</div>
              <div className="ai-chat-chips">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSend(s)}
                    className="ai-chat-chip"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="ai-chat-input-area">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend(input);
              }}
              className="ai-chat-form"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask AI to do a transaction..."
                className="ai-chat-input"
                disabled={isLoading}
                autoComplete="off"
              />
              <button
                type="submit"
                className="ai-chat-send"
                disabled={isLoading || !input.trim()}
                title="Send Message"
                aria-label="Send Message"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
