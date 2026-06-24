"use client";

import { DappShell, TerminalView } from "../../../components/DappShell";

export default function TerminalPage() {
  return (
    <DappShell title="Terminal" kicker="operator-grade queries">
      <TerminalView />
    </DappShell>
  );
}
