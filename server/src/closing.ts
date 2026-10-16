// What the physician says to close the call once they decide, and the nurse's acknowledgement.
// Plays in voiced replay (ElevenLabs TTS) and is shown as a prompt during live calls.
import type { Resident } from "./db.js";
import type { Disposition } from "./note.js";

export type ClosingLine = { speaker: "nurse" | "doctor"; text: string };

export function closingLines(r: Resident, script: string, disposition: Disposition): ClosingLine[] {
  const nurse = script === "joseph" ? "Ray" : "Linda";
  const she = r.sex === "F" ? "she" : "he";
  const her = r.sex === "F" ? "her" : "him";
  const hers = r.sex === "F" ? "her" : "his";
  if (disposition === "treat_in_place") {
    return [
      { speaker: "doctor", text: `Okay ${nurse}, let's treat ${her} here tonight. I'm uploading a note with the treatment plan to ${hers} chart now. Call me back right away if anything changes.` },
      { speaker: "nurse", text: "Got it, I'll look for the note in the chart. Thank you, Doctor." },
    ];
  }
  return [
    { speaker: "doctor", text: `${nurse}, ${she} needs to go to the hospital tonight. Please call EMS for transfer to the emergency department. I'm posting a note to the chart recommending hospital transfer.` },
    { speaker: "nurse", text: `Okay, calling EMS now. I'll send ${hers} MOLST and med list with ${her}. Thank you, Doctor.` },
  ];
}
