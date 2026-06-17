import { env } from "../../config/index.js";

interface TokenPrices {
  ethereum: number;
  solana: number;
  stellar: number;
  bitcoin: number;
}

export class LiveQuoteService {
  private priceCache: TokenPrices | null = null;
  private priceCacheTime = 0;
  private readonly cacheDurationMs = 60_000; // Cache token prices for 1 minute

  async getChainlinkPrice(feedAddress: string, rpcUrl: string): Promise<number> {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            {
              to: feedAddress,
              data: "0xfeaf968c" // latestRoundData() selector
            },
            "latest"
          ]
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        if (data.result && data.result !== "0x") {
          // answer is the second 32-byte word (bytes 32 to 64, chars 66 to 130)
          const answerHex = data.result.slice(66, 130);
          const answerVal = BigInt("0x" + answerHex);
          return Number(answerVal) / 1e8; // Chainlink USD feeds standard is 8 decimals
        }
      }
    } catch {
      // Quietly fallback
    }
    return 0;
  }

  /** Live native-token spot prices from Coingecko, with Chainlink + static fallbacks. */
  async getTokenPrices(): Promise<TokenPrices> {
    const now = Date.now();
    if (this.priceCache && now - this.priceCacheTime < this.cacheDurationMs) {
      return this.priceCache;
    }

    const fallbackPrices: TokenPrices = {
      ethereum: 3500,
      solana: 150,
      stellar: 0.1,
      bitcoin: 65000
    };

    let prices: Partial<TokenPrices> = {};

    // Primary: Coingecko simple price (no API key required on testnet/dev).
    try {
      const ids = "ethereum,solana,stellar,bitcoin";
      const res = await fetch(`${env.coingeckoApiUrl}/simple/price?ids=${ids}&vs_currencies=usd`, {
        headers: { Accept: "application/json" }
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        prices = {
          ethereum: Number(data?.ethereum?.usd) || undefined,
          solana: Number(data?.solana?.usd) || undefined,
          stellar: Number(data?.stellar?.usd) || undefined,
          bitcoin: Number(data?.bitcoin?.usd) || undefined
        };
      }
    } catch {
      // Quietly fallback to Chainlink/static below.
    }

    // Secondary: Chainlink ETH/USD feed if Coingecko ETH missing.
    if (!prices.ethereum) {
      const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
      const ethFeed = process.env.CHAINLINK_ETH_USD_FEED || "0xa24A68DD788e1D7eb4CA517765CFb2b7e217e7a3";
      const ethPrice = await this.getChainlinkPrice(ethFeed, rpcUrl);
      if (ethPrice > 0) prices.ethereum = ethPrice;
    }

    this.priceCache = {
      ethereum: prices.ethereum ?? fallbackPrices.ethereum,
      solana: prices.solana ?? fallbackPrices.solana,
      stellar: prices.stellar ?? fallbackPrices.stellar,
      bitcoin: prices.bitcoin ?? fallbackPrices.bitcoin
    };
    this.priceCacheTime = now;
    return this.priceCache;
  }

  /**
   * Live Solana fee estimate in USD. Combines the base signature fee (5000 lamports)
   * with the live median priority fee from getRecentPrioritizationFees.
   */
  async getSolanaGasUsd(rpcUrl: string, solPriceUsd: number, computeUnits = 200_000): Promise<number | null> {
    try {
      const baseLamports = 5000; // one signature
      let microLamportsPerCu = 0;
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRecentPrioritizationFees", params: [[]] })
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const fees: any[] = data?.result ?? [];
        if (fees.length > 0) {
          const sorted = fees.map((f) => Number(f.prioritizationFee) || 0).sort((a, b) => a - b);
          microLamportsPerCu = sorted[Math.floor(sorted.length / 2)];
        }
      }
      const priorityLamports = (microLamportsPerCu * computeUnits) / 1_000_000;
      const totalLamports = baseLamports + priorityLamports;
      return (totalLamports / 1e9) * solPriceUsd;
    } catch {
      return null;
    }
  }

  /**
   * Live Stellar/Soroban fee estimate in USD from the network base fee (in stroops).
   */
  async getStellarGasUsd(rpcUrl: string, xlmPriceUsd: number): Promise<number | null> {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getFeeStats", params: [] })
      });
      let baseFeeStroops = 100; // Stellar minimum base fee per operation
      if (res.ok) {
        const data = (await res.json()) as any;
        const inclusion = data?.result?.sorobanInclusionFee ?? data?.result?.inclusionFee;
        const mode = Number(inclusion?.mode ?? inclusion?.p50);
        if (Number.isFinite(mode) && mode > 0) baseFeeStroops = mode;
      }
      // A Soroban invoke typically bundles a few operations; model ~3 ops.
      const xlm = (baseFeeStroops * 3) / 1e7;
      return xlm * xlmPriceUsd;
    } catch {
      return null;
    }
  }

  async getLiveGasPriceWei(rpcUrl: string): Promise<bigint> {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_gasPrice",
          params: []
        })
      });
      if (res.ok) {
        const data = await res.json() as any;
        if (data.result) {
          return BigInt(data.result);
        }
      }
    } catch {
      // Quietly fallback
    }
    return 0n;
  }

  async getCctpLiveFeeBps(sourceDomain: number, destDomain: number, wantsFast: boolean): Promise<number | null> {
    try {
      const irisUrl = `${env.circleIrisApiUrl}/v2/burn/USDC/fees/${sourceDomain}/${destDomain}`;
      const headers: Record<string, string> = {
        "Accept": "application/json"
      };
      if (env.circleApiKey) {
        headers["Authorization"] = `Bearer ${env.circleApiKey}`;
      }
      const res = await fetch(irisUrl, { headers });
      if (res.ok) {
        const data = await res.json() as any;
        const fees = data.fees || [];
        const threshold = wantsFast ? 1000 : 2000;
        const feeInfo = fees.find((f: any) => f.finalityThreshold === threshold) || fees[0];
        if (feeInfo) {
          return Number(feeInfo.fee ?? feeInfo.minimumFee ?? 0);
        }
      }
    } catch {
      // Quietly fallback
    }
    return null;
  }
}

export const liveQuoteService = new LiveQuoteService();
