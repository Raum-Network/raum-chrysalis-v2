"use client";

import { DappShell, DashboardView } from "../../components/DappShell";

export default function AppPage() {
  return (
    <DappShell title="Dashboard" kicker="live dapp cockpit">
      <DashboardView />
    </DappShell>
  );
}
