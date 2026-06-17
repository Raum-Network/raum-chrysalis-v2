import { IntentReceipt } from "../types.js";

export class MemoryStore {
  private intents = new Map<string, IntentReceipt>();

  create(intent: IntentReceipt): IntentReceipt {
    this.intents.set(intent.id, intent);
    return intent;
  }

  get(id: string): IntentReceipt | undefined {
    return this.intents.get(id);
  }

  update(id: string, patch: Partial<IntentReceipt>): IntentReceipt {
    const current = this.intents.get(id);
    if (!current) throw new Error(`Intent not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.intents.set(id, next);
    return next;
  }

  list(): IntentReceipt[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const store = new MemoryStore();
