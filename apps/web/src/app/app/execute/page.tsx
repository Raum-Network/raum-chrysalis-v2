"use client";

import { DappShell } from "../../../components/DappShell";
import FlowBuilder from "../../../components/FlowBuilder";

export default function ExecutePage() {
  return (
    <DappShell title="Execute" kicker="bridge + protocol route">
      <section className="execute-stage app-shell">
        <FlowBuilder />
      </section>
    </DappShell>
  );
}
