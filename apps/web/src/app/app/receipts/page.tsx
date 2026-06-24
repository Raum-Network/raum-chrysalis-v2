"use client";

import { DappShell, TransactionsView } from "../../../components/DappShell";

export default function ReceiptsPage() {
  return (
    <DappShell title="Receipts" kicker="Arc receipt NFTs">
      <TransactionsView receiptsOnly />
    </DappShell>
  );
}
