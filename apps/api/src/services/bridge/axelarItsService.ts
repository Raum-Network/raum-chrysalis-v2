import { env, findChainByKey } from "../../config/index.js";
import { RoutePlan } from "../../types.js";

export class AxelarItsService {
  describeRoute(plan: RoutePlan): Record<string, unknown> {
    const source = findChainByKey(plan.sourceChain);
    const destination = findChainByKey(plan.destinationChain);
    return {
      sourceVm: source.vm,
      destinationVm: destination.vm,
      method: "AXELAR_ITS"
    };
  }

  async executeBridge(plan: RoutePlan, metadata?: Record<string, any>): Promise<Record<string, unknown>> {
    if (env.demoMode) {
      return {
        status: "mocked",
        txHash: `0xmock_axelar_destination_tx_${Date.now().toString(16)}`,
        note: "DEMO_MODE enabled."
      };
    }

    const txHash = metadata?.userDepositTxHash;
    if (!txHash) {
      throw new Error("Axelar ITS bridge execution requires a source userDepositTxHash in metadata.");
    }

    console.log(`[AxelarItsService] Polling Axelar Scan for txHash: ${txHash}...`);
    
    const deadline = Date.now() + 20 * 60 * 1000; // 20 minutes timeout
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`https://testnet.api.gmp.axelarscan.io/?method=searchGMP&txHash=${txHash}`);
        const data = await response.json() as any;
        if (data && data.data && data.data.length > 0) {
          let txData = data.data[0];
          let txStatus = txData.status;

          if (txStatus === "executed" && txData.executed?.chain === "axelar") {
            const nextHash = txData.executed.transactionHash;
            if (nextHash) {
              const nextResponse = await fetch(`https://testnet.api.gmp.axelarscan.io/?method=searchGMP&txHash=${nextHash}`);
              const nextData = await nextResponse.json() as any;
              if (nextData && nextData.data && nextData.data.length > 0) {
                txData = nextData.data[0];
                txStatus = txData.status;
              }
            }
          }

          if (txStatus === "executed" && txData.executed?.transactionHash) {
            console.log(`[AxelarItsService] Axelar ITS bridge execution successful! Dest Tx: ${txData.executed.transactionHash}`);
            return {
              status: "submitted",
              txHash: txData.executed.transactionHash,
              sourceTxHash: txHash,
              axelarStatus: txStatus,
              circleProduct: "Axelar ITS"
            };
          } else if (txStatus === "error" || txStatus === "failed") {
            throw new Error(`Axelar ITS bridging failed with status: ${txStatus}`);
          }
        }
      } catch (err) {
        console.error("[AxelarItsService] Error polling Axelar scan:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Timed out waiting for Axelar ITS bridge execution for source tx: ${txHash}`);
  }
}

export const axelarItsService = new AxelarItsService();
