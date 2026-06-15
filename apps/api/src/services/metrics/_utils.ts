export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function moneyStr(v: number | string): string {
  return Number(v).toFixed(4);
}
