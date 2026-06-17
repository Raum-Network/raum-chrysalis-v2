export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}
