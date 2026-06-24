"use client";

import { DappShell, DashboardView } from "../../components/DappShell";

export default function AppPage() {
  return (
    <DappShell title="Dashboard" >
      <DashboardView />
    </DappShell>
  );
}
