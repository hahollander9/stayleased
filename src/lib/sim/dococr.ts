import { createHash } from 'node:crypto';

/** DocOcr simulator (§3.4): deterministic "extraction" from uploaded income
 * documents. The extracted figure derives from the document bytes, so the
 * same file always reads the same — and a mismatch vs stated income raises a
 * review flag (never an auto-decline, per M5.4). */

export interface OcrResult {
  extractedMonthlyIncomeCents: number;
  anomaly: boolean;
  note: string;
}

export function extractIncome(docBytes: Uint8Array, statedMonthlyCents: number): OcrResult {
  const h = createHash('sha256').update(docBytes).digest();
  const wobble = ((h[0]! << 8) | h[1]!) / 65535; // 0..1 deterministic per document
  // 85% of documents corroborate (±8%); the rest read materially different
  const corroborates = wobble < 0.85;
  const factor = corroborates ? 0.92 + (wobble / 0.85) * 0.16 : 0.45 + wobble * 0.35;
  const extracted = Math.max(0, Math.round((statedMonthlyCents * factor) / 100) * 100);
  const deltaPct = statedMonthlyCents > 0 ? Math.abs(extracted - statedMonthlyCents) / statedMonthlyCents : 1;
  const anomaly = deltaPct > 0.25;
  return {
    extractedMonthlyIncomeCents: extracted,
    anomaly,
    note: anomaly
      ? `Document reads ~$${(extracted / 100).toFixed(0)}/mo vs stated $${(statedMonthlyCents / 100).toFixed(0)}/mo (${Math.round(deltaPct * 100)}% variance)`
      : `Document corroborates stated income (±${Math.round(deltaPct * 100)}%)`,
  };
}
