import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/index.js";
import { agentManager } from "../../agents/AgentManager.js";
import { CreateIntentInput } from "../../types.js";

// System prompt that instructs the LLM on how to map natural language to the Chrysalis V2 schema.
const SYSTEM_PROMPT = `
You are Chrysalis V2 AI Assistant, a helpful assistant for Chrysalis V2 (formerly Arc Unified OS), a cross-chain USDC protocol.
Your job is to read natural language commands from users and convert them into structured cross-chain transaction intents.

GROUNDING DATA:
1. Supported Chains (sourceChain & destinationChain):
   - "ARC" (EVM Testnet)
   - "BASE_SEPOLIA" (EVM Sepolia)
   - "ETHEREUM_SEPOLIA" (EVM Sepolia)
   - "SOLANA_DEVNET" (Non-EVM Solana Devnet)
   - "STELLAR_TESTNET" (Soroban Stellar Testnet)

2. Supported Assets (asset):
   - "USDC" (supported on all chains, default asset)
   - "EURC" (supported on ARC, BASE_SEPOLIA, ETHEREUM_SEPOLIA, SOLANA_DEVNET)

3. Supported Protocols (protocol) and Actions (action) per chain:
   - EVM - ARC:
     - "ARC_USDC_TRANSFER" (Action: "transfer") -> Cross-chain transfer to another chain.
     - "ARC_USYC_TELLER" (Actions: "deposit" to mint USYC, "sell" to redeem USYC) -> USYC yield token.
   - EVM - BASE_SEPOLIA:
     - "BASE_USDC_TRANSFER" (Action: "transfer") -> Cross-chain transfer to another chain.
     - "BASE_UNISWAP_V3" (Action: "swap") -> Swap USDC to WETH. Must include metadata: { "tokenIn": "USDC", "tokenOut": "WETH" }.
     - "BASE_MORPHO_BLUE" (Action: "supply") -> Supply USDC to Morpho lending.
   - EVM - ETHEREUM_SEPOLIA:
     - "ETH_USDC_TRANSFER" (Action: "transfer") -> Cross-chain transfer to another chain.
     - "ETH_UNISWAP_V3" (Action: "swap") -> Swap USDC to WETH. Must include metadata: { "tokenIn": "USDC", "tokenOut": "WETH" }.
     - "ETH_AAVE_V3" (Action: "supply") -> Supply USDC to Aave lending.
   - Non-EVM - SOLANA_DEVNET:
     - "SOL_USDC_TRANSFER" (Action: "transfer") -> Cross-chain transfer to another chain.
     - "SOL_MARINADE" (Action: "supply") -> Stake USDC into Marinade (liquid staking).
   - Soroban - STELLAR_TESTNET:
     - "XLM_USDC_TRANSFER" (Action: "transfer") -> Cross-chain transfer to another chain.
     - "XLM_AQUARIUS" (Action: "Swap") -> Swap USDC to XLM.
     - "XLM_BLEND" (Action: "supply") -> Supply USDC to Blend lending.

INSTRUCTIONS:
1. Decode the user's command into the CreateIntentRequest format.
2. If the user's command does NOT represent an actionable transaction (e.g., they just say "hello" or ask a general question), do NOT generate an intent (set "intent" to null).
3. The response MUST be a JSON object containing:
   - "explanation": a concise, friendly sentence describing what was decoded or explaining your answer (e.g. "I've set up a swap of 10 USDC on Base to WETH using Uniswap V3.")
   - "intent": the parsed CreateIntentRequest object, or null.
4. Schema for "intent":
   - "sourceChain": Must be one of the supported chains. IMPORTANT: Always use the source chain from the user's connected chain context (provided in the "Connected EVM Chain" field) as the default source chain UNLESS the user explicitly specifies a different source chain in their message. For example, if the user says "bridge 5 USDC to Solana" and the connected chain is "BASE_SEPOLIA", use "BASE_SEPOLIA" as the source chain, not "SOLANA_DEVNET".
   - "destinationChain": Must match where the protocol runs. E.g., if staking on Marinade, destinationChain must be "SOLANA_DEVNET". If swapping on Uniswap on Base, destinationChain must be "BASE_SEPOLIA".
   - "asset": "USDC" or "EURC".
   - "amount": string value (e.g., "1.5").
   - "protocol": string (the exact protocol key from grounding data).
   - "action": string (the exact action key from grounding data).
   - "recipient": the target wallet address. Use the user's wallet address from context matching the destination chain's VM (EVM wallet for EVM chains, Solana wallet for Solana, Stellar wallet for Stellar).
   - "metadata": object containing any extra parameters required (e.g., { "tokenIn": "USDC", "tokenOut": "WETH" } for Uniswap swaps).

You must return ONLY a JSON block. No markdown wrapper (like \`\`\`json). Just the raw JSON object.
`;

export interface ChatContext {
  connectedWallet?: string; // EVM address
  connectedChain?: string;  // EVM chain key (e.g., "ARC", "BASE_SEPOLIA", "ETHEREUM_SEPOLIA")
  solanaWallet?: string;    // Solana address
  stellarWallet?: string;   // Stellar address
}

export class GeminiChatService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    if (env.geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(env.geminiApiKey);
    } else {
      console.warn("[GeminiChatService] GEMINI_API_KEY/GOOGLE_API_KEY is not configured. Chat responses will fall back to static Mock responses.");
    }
  }

  async chat(message: string, context?: ChatContext): Promise<{
    explanation: string;
    intent: CreateIntentInput | null;
    quote?: any;
    error?: string;
  }> {
    // Check if source chain requires a wallet that's not connected
    const sourceChainFromContext = context?.connectedChain;
    const isSolanaSource = sourceChainFromContext === "SOLANA_DEVNET";
    const isStellarSource = sourceChainFromContext === "STELLAR_TESTNET";
    
    if (isSolanaSource && !context?.solanaWallet) {
      return {
        explanation: "Your Solana wallet is not connected. Please connect your Phantom wallet to use Solana as the source chain, or select a different source chain from the dropdown.",
        intent: null
      };
    }
    
    if (isStellarSource && !context?.stellarWallet) {
      return {
        explanation: "Your Stellar wallet is not connected. Please connect your Freighter wallet to use Stellar as the source chain, or select a different source chain from the dropdown.",
        intent: null
      };
    }

    if (!this.genAI) {
      return this.mockChatFallback(message, context);
    }

    try {
      const model = this.genAI.getGenerativeModel({ model: env.geminiModel });
      const prompt = `
Context:
- Connected EVM Wallet: ${context?.connectedWallet ?? "Not connected"}
- Connected EVM Chain: ${context?.connectedChain ?? "Not connected"}
- Connected Solana Wallet: ${context?.solanaWallet ?? "Not connected"}
- Connected Stellar Wallet: ${context?.stellarWallet ?? "Not connected"}

User Message: "${message}"

Generate JSON response:
`;

      const response = await model.generateContent({
        contents: [
          { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
          { role: "user", parts: [{ text: prompt }] }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      });

      const rawText = response.response.text();
      console.log("[GeminiChatService] Raw Gemini response:", rawText);

      // Try to extract valid JSON from the response
      let text = rawText.trim();

      // Method 1: Try parsing directly
      try {
        const parsed = JSON.parse(text);
        return await this.processIntent(parsed, context);
      } catch {}

      // Method 2: Strip markdown code blocks
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          const parsed = JSON.parse(codeBlockMatch[1].trim());
          return await this.processIntent(parsed, context);
        } catch {}
      }

      // Method 3: Find first { ... last } using bracket counting
      const firstBrace = text.indexOf("{");
      if (firstBrace !== -1) {
        let depth = 0;
        let lastBrace = -1;
        for (let i = firstBrace; i < text.length; i++) {
          if (text[i] === "{") depth++;
          if (text[i] === "}") depth--;
          if (depth === 0) { lastBrace = i; break; }
        }
        if (lastBrace !== -1) {
          const jsonStr = text.substring(firstBrace, lastBrace + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            return await this.processIntent(parsed, context);
          } catch {}
        }
      }

      return {
        explanation: "Sorry, I couldn't parse the AI response. Please try again.",
        intent: null
      };
    } catch (err) {
      console.error("[GeminiChatService] Error in Gemini API chat:", err);
      return {
        explanation: "Sorry, I encountered an error while processing your request. Please try again.",
        intent: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private async processIntent(parsed: { explanation: string; intent: CreateIntentInput | null }, context?: ChatContext): Promise<{
    explanation: string;
    intent: CreateIntentInput | null;
    quote?: any;
  }> {
    if (!parsed.intent) {
      return {
        explanation: parsed.explanation,
        intent: null
      };
    }

    // Check if the decoded intent's destination chain needs a wallet that's not connected
    const destChain = parsed.intent.destinationChain;
    if (destChain === "SOLANA_DEVNET" && !context?.solanaWallet) {
      return {
        explanation: "Your Solana wallet is not connected. Please connect your Phantom wallet to receive on Solana, or choose a different destination chain.",
        intent: null
      };
    }
    if (destChain === "STELLAR_TESTNET" && !context?.stellarWallet) {
      return {
        explanation: "Your Stellar wallet is not connected. Please connect your Freighter wallet to receive on Stellar, or choose a different destination chain.",
        intent: null
      };
    }

    // Try to enrich with a live quote if an intent was parsed
    let quote: any = undefined;
    try {
      const quoteInput = { ...parsed.intent, approved: false, quoteOnly: true };
      console.log("[GeminiChatService] Running quote for AI-decoded intent:", quoteInput);
      quote = await agentManager.quote(quoteInput);
    } catch (quoteErr) {
      console.warn("[GeminiChatService] Quoting failed for parsed intent:", quoteErr);
    }

    return {
      explanation: parsed.explanation,
      intent: parsed.intent,
      quote
    };
  }

  private mockChatFallback(message: string, context?: ChatContext): {
    explanation: string;
    intent: CreateIntentInput | null;
    quote?: any;
  } {
    const cleanMsg = message.toLowerCase();
    let explanation = "I can help you build cross-chain intents. Try saying something like 'swap 10 USDC on Base to WETH on Uniswap'.";
    let intent: CreateIntentInput | null = null;

    // Use source chain from context (dropdown) as default unless user specifies otherwise
    const defaultSourceChain = context?.connectedChain || "ARC";

    if (cleanMsg.includes("swap") && (cleanMsg.includes("uniswap") || cleanMsg.includes("base") || cleanMsg.includes("ethereum"))) {
      const isBase = cleanMsg.includes("base");
      const isEthereum = cleanMsg.includes("ethereum");
      // Use user-specified chain or default to context chain
      let chain = defaultSourceChain;
      if (isBase) chain = "BASE_SEPOLIA";
      if (isEthereum) chain = "ETHEREUM_SEPOLIA";
      
      const protocol = chain === "BASE_SEPOLIA" ? "BASE_UNISWAP_V3" : chain === "ETHEREUM_SEPOLIA" ? "ETH_UNISWAP_V3" : "BASE_UNISWAP_V3";
      intent = {
        sourceChain: chain,
        destinationChain: chain,
        asset: "USDC",
        amount: "10",
        protocol,
        action: "swap",
        recipient: context?.connectedWallet ?? "0x0000000000000000000000000000000000000000",
        metadata: {
          tokenIn: "USDC",
          tokenOut: "WETH"
        }
      };
      explanation = `[Mock Fallback] I've prepared a Uniswap V3 swap of 10 USDC on ${chain === "BASE_SEPOLIA" ? "Base Sepolia" : chain === "ETHEREUM_SEPOLIA" ? "Ethereum Sepolia" : "Arc Testnet"} to WETH.`;
    } else if (cleanMsg.includes("marinade") || cleanMsg.includes("solana")) {
      // If user mentions Solana, use context chain as source unless they specify otherwise
      let source = defaultSourceChain;
      if (cleanMsg.includes("from ethereum") || cleanMsg.includes("from eth")) source = "ETHEREUM_SEPOLIA";
      if (cleanMsg.includes("from base")) source = "BASE_SEPOLIA";
      if (cleanMsg.includes("from arc")) source = "ARC";
      
      intent = {
        sourceChain: source,
        destinationChain: "SOLANA_DEVNET",
        asset: "USDC",
        amount: "5",
        protocol: "SOL_MARINADE",
        action: "supply",
        recipient: context?.solanaWallet ?? "2aB4...SolAddress",
      };
      explanation = `[Mock Fallback] I've prepared a cross-chain staking intent: transfer 5 USDC from ${source === "BASE_SEPOLIA" ? "Base Sepolia" : source === "ETHEREUM_SEPOLIA" ? "Ethereum Sepolia" : "Arc Testnet"} to Solana Devnet and stake it on Marinade Finance.`;
    } else if (cleanMsg.includes("bridge") || cleanMsg.includes("transfer")) {
      // Use context chain as default source unless user specifies otherwise
      let source = defaultSourceChain;
      if (cleanMsg.includes("from ethereum") || cleanMsg.includes("from eth")) source = "ETHEREUM_SEPOLIA";
      if (cleanMsg.includes("from base")) source = "BASE_SEPOLIA";
      if (cleanMsg.includes("from arc")) source = "ARC";
      if (cleanMsg.includes("from solana")) source = "SOLANA_DEVNET";
      if (cleanMsg.includes("from stellar")) source = "STELLAR_TESTNET";
      
      const dest = cleanMsg.includes("solana") ? "SOLANA_DEVNET" : cleanMsg.includes("stellar") ? "STELLAR_TESTNET" : "BASE_SEPOLIA";
      const protocol = dest === "SOLANA_DEVNET" ? "SOL_USDC_TRANSFER" : dest === "STELLAR_TESTNET" ? "XLM_USDC_TRANSFER" : "BASE_USDC_TRANSFER";
      intent = {
        sourceChain: source,
        destinationChain: dest,
        asset: "USDC",
        amount: "10",
        protocol,
        action: "transfer",
        recipient: dest === "SOLANA_DEVNET" ? (context?.solanaWallet ?? "2aB4...") : dest === "STELLAR_TESTNET" ? (context?.stellarWallet ?? "GD...") : (context?.connectedWallet ?? "0x..."),
      };
      explanation = `[Mock Fallback] I've prepared a cross-chain transfer of 10 USDC from ${source} to ${dest}.`;
    }

    // Check if the intent's destination chain needs a wallet that's not connected
    if (intent) {
      const destChain = intent.destinationChain;
      if (destChain === "SOLANA_DEVNET" && !context?.solanaWallet) {
        return {
          explanation: "Your Solana wallet is not connected. Please connect your Phantom wallet to receive on Solana, or choose a different destination chain.",
          intent: null
        };
      }
      if (destChain === "STELLAR_TESTNET" && !context?.stellarWallet) {
        return {
          explanation: "Your Stellar wallet is not connected. Please connect your Freighter wallet to receive on Stellar, or choose a different destination chain.",
          intent: null
        };
      }
    }

    return {
      explanation,
      intent
    };
  }
}

export const geminiChatService = new GeminiChatService();
