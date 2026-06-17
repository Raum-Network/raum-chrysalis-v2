export type KaminoAdapterAction =
  | "DepositReserveLiquidity"
  | "WithdrawReserveLiquidity"
  | "BorrowObligationLiquidity"
  | "RepayObligationLiquidity"
  | "RefreshReserve"
  | "RefreshObligation";

export type RaydiumAdapterAction =
  | "SwapBaseInput"
  | "SwapBaseOutput"
  | "Deposit"
  | "Withdraw"
  | "InitializePool";

export type AquariusAdapterAction =
  | "SwapChained"
  | "SwapChainedStrictReceive"
  | "Deposit"
  | "Withdraw";

export type BlendAdapterAction =
  | "supply"
  | "withdraw"
  | "borrow"
  | "repay"
  | "Supply"
  | "Withdraw"
  | "Borrow"
  | "Repay";

export interface SolanaRemainingAccountMeta {
  pubkey: string;
  isWritable: boolean;
  isSigner: boolean;
}

export interface SolanaAdapterInvocationTemplate {
  programId: string;
  instruction: "execute";
  intentId: string;
  action: KaminoAdapterAction | RaydiumAdapterAction;
  amountIn: string;
  limitAmount: string;
  cpiDataBase64: string;
  remainingAccounts: SolanaRemainingAccountMeta[];
  memo?: string;
}

export interface SorobanAdapterInvocationTemplate {
  contractId: string;
  method: "execute";
  intentId: string;
  action: AquariusAdapterAction | BlendAdapterAction;
  targetContractId: string;
  targetMethod: string;
  argsXdr: string[];
  amount: string;
  memo?: string;
}

export function createSolanaAdapterInvocation(input: SolanaAdapterInvocationTemplate): SolanaAdapterInvocationTemplate {
  return input;
}

export function createSorobanAdapterInvocation(input: SorobanAdapterInvocationTemplate): SorobanAdapterInvocationTemplate {
  return input;
}
