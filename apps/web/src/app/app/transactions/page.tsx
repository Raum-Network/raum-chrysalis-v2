"use client";

import { DappShell, TransactionsView } from "../../../components/DappShell";

export default function TransactionsPage() {
  return (
    <DappShell title="Transactions" kicker="route history with live chain checks">
      <TransactionsView />
    </DappShell>
  );
}
