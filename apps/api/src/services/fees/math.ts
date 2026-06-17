export function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(n) ? n : fallback;
}

export function usd(value: number): string {
  const rounded = Math.max(0, value);
  if (rounded === 0) return "0.000000";
  if (rounded < 0.000001) return rounded.toExponential(2);
  return rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
}

export function amount(value: number): string {
  const rounded = Math.max(0, value);
  if (rounded === 0) return "0";
  return rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function bpsOf(value: number, bps: number): number {
  return value * bps / 10_000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
