// Plain-language layer for a non-clinical audience: expands chart jargon inline the first time it appears.
const TERMS: [RegExp, string][] = [
  [/\bDNR\/DNI\b/, "DNR/DNI (no CPR, no breathing tube)"],
  [/\bMOLST\b/, "MOLST (signed treatment orders)"],
  [/\boriented x3\b/i, "oriented x3 (knows who, where, and when)"],
  [/\bFull code\b/, "Full code (wants CPR if needed)"],
  [/\bcreatinine\b/, "creatinine (kidney function)"],
  [/\bhemoglobin\b/, "hemoglobin (blood count)"],
  [/\bacute kidney injury\b/, "acute kidney injury (sudden kidney strain)"],
  [/\bsundowning\b/i, "sundowning (evening confusion)"],
];

export function plain(text: string): string {
  let out = text;
  for (const [re, expanded] of TERMS) out = out.replace(re, expanded);
  return out;
}

export const cToF = (c: number) => Math.round((c * 9) / 5 * 10 + 320) / 10;
