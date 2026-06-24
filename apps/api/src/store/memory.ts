import { sql } from "@vercel/postgres";
import type { IntentReceipt } from "../types.js";

type ListOptions = {
  owner?: string;
  limit?: number;
};

function hasPostgresEnv() {
  return Boolean(
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL
  );
}

function txHashFrom(receipt: IntentReceipt): string | null {
  const bridge = receipt.bridgeReceipt ?? {};
  const protocol = receipt.protocolReceipt ?? {};
  const metadata = receipt.input.metadata ?? {};
  return String(
    protocol.txHash ??
    protocol.stellarTxHash ??
    protocol.solanaTxHash ??
    metadata.userDepositTxHash ??
    bridge.txHash ??
    bridge.burnTxHash ??
    bridge.stellarTxHash ??
    bridge.solanaTxHash ??
    bridge.mintTxHash ??
    ""
  ) || null;
}

function ownerFrom(receipt: IntentReceipt): string | null {
  const metadata = receipt.input.metadata ?? {};
  return String(
    metadata.sourceWalletAddress ??
    metadata.evmReceiptWalletAddress ??
    metadata.solanaAddress ??
    metadata.stellarAddress ??
    receipt.input.recipient ??
    ""
  ) || null;
}

function matchesOwner(receipt: IntentReceipt, owner: string) {
  const needles = owner.split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return true;
  const metadata = receipt.input.metadata ?? {};
  const candidates = [
    ownerFrom(receipt),
    receipt.input.recipient,
    metadata.sourceWalletAddress,
    metadata.evmReceiptWalletAddress,
    metadata.solanaAddress,
    metadata.stellarAddress
  ].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  return needles.some((needle) => candidates.includes(needle));
}

export class IntentStore {
  private intents = new Map<string, IntentReceipt>();
  private initialized = false;
  private readonly usePostgres = hasPostgresEnv();

  get storageKind() {
    return "Chrysalis V2";
  }

  private async ensureTable() {
    if (!this.usePostgres || this.initialized) return;
    await sql`
      CREATE TABLE IF NOT EXISTS chrysalis_transactions (
        id TEXT PRIMARY KEY,
        owner TEXT,
        status TEXT NOT NULL,
        source_chain TEXT NOT NULL,
        destination_chain TEXT NOT NULL,
        protocol TEXT NOT NULL,
        action TEXT NOT NULL,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        route_kind TEXT,
        tx_hash TEXT,
        receipt JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS chrysalis_transactions_owner_idx ON chrysalis_transactions (owner)`;
    await sql`CREATE INDEX IF NOT EXISTS chrysalis_transactions_updated_idx ON chrysalis_transactions (updated_at DESC)`;
    this.initialized = true;
  }

  async create(intent: IntentReceipt): Promise<IntentReceipt> {
    this.intents.set(intent.id, intent);
    await this.persist(intent);
    return intent;
  }

  async get(id: string): Promise<IntentReceipt | undefined> {
    if (!this.usePostgres) return this.intents.get(id);
    await this.ensureTable();
    const result = await sql<{ receipt: IntentReceipt }>`
      SELECT receipt
      FROM chrysalis_transactions
      WHERE id = ${id}
      LIMIT 1
    `;
    return result.rows[0]?.receipt;
  }

  async update(id: string, patch: Partial<IntentReceipt>): Promise<IntentReceipt> {
    const current = await this.get(id);
    if (!current) throw new Error(`Intent not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.intents.set(id, next);
    await this.persist(next);
    return next;
  }

  async list(options: ListOptions = {}): Promise<IntentReceipt[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    if (!this.usePostgres) {
      return [...this.intents.values()]
        .filter((item) => !options.owner || matchesOwner(item, options.owner))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }

    await this.ensureTable();
    let result;
    if (options.owner) {
      const owners = options.owner.split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
      if (owners.length > 0) {
        const arrayLiteral = `{${owners.join(",")}}`;
        result = await sql<{ receipt: IntentReceipt }>`
          SELECT receipt
          FROM chrysalis_transactions
          WHERE lower(owner) = ANY(${arrayLiteral}::text[])
             OR lower(receipt->'input'->'metadata'->>'sourceWalletAddress') = ANY(${arrayLiteral}::text[])
             OR lower(receipt->'input'->'metadata'->>'evmReceiptWalletAddress') = ANY(${arrayLiteral}::text[])
             OR lower(receipt->'input'->>'recipient') = ANY(${arrayLiteral}::text[])
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
      } else {
        result = await sql<{ receipt: IntentReceipt }>`
          SELECT receipt
          FROM chrysalis_transactions
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
      }
    } else {
      result = await sql<{ receipt: IntentReceipt }>`
        SELECT receipt
        FROM chrysalis_transactions
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }
    return result.rows.map((row) => row.receipt);
  }

  private async persist(receipt: IntentReceipt) {
    if (!this.usePostgres) return;
    await this.ensureTable();
    await sql`
      INSERT INTO chrysalis_transactions (
        id, owner, status, source_chain, destination_chain, protocol, action,
        amount, asset, route_kind, tx_hash, receipt, created_at, updated_at
      )
      VALUES (
        ${receipt.id},
        ${ownerFrom(receipt)},
        ${receipt.status},
        ${receipt.input.sourceChain},
        ${receipt.input.destinationChain},
        ${receipt.input.protocol},
        ${receipt.input.action},
        ${receipt.input.amount},
        ${receipt.input.asset},
        ${receipt.plan?.routeKind ?? receipt.input.preferredRoute ?? null},
        ${txHashFrom(receipt)},
        ${JSON.stringify(receipt)}::jsonb,
        ${receipt.createdAt},
        ${receipt.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        owner = EXCLUDED.owner,
        status = EXCLUDED.status,
        source_chain = EXCLUDED.source_chain,
        destination_chain = EXCLUDED.destination_chain,
        protocol = EXCLUDED.protocol,
        action = EXCLUDED.action,
        amount = EXCLUDED.amount,
        asset = EXCLUDED.asset,
        route_kind = EXCLUDED.route_kind,
        tx_hash = EXCLUDED.tx_hash,
        receipt = EXCLUDED.receipt,
        updated_at = EXCLUDED.updated_at
    `;
  }
}

export const store = new IntentStore();
