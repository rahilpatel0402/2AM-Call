// Chart and facility store. Synthetic JSON from /data, loaded into memory once at boot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, "../../data");

export type Avpu = "A" | "C" | "V" | "P" | "U";

export type Resident = {
  id: string; name: string; age: number; sex: "F" | "M";
  room: string; pcp: string; admitted: string;
  diagnoses: string[];
  code_status: { value: string; molst: string; source: string };
  goals_of_care: { summary: string; source: string };
  baseline: { mental_status: string; mobility: string; source: string };
  allergies: string[];
  medications: { name: string; dose: string; class?: string; high_risk?: boolean }[];
  vitals_history: { ts: string; sbp: number; dbp: number; hr: number; rr: number; temp_c: number; spo2: number; o2: string; avpu: Avpu }[];
  labs: { ts: string; name: string; value: number; unit: string }[];
  recent_hospitalization?: { discharged: string; reason: string; source: string };
  notes: { id: string; ts: string; author: string; text: string }[];
};

export type Facility = {
  id: string; name: string;
  overnight: {
    rn_on_site: boolean; iv_fluids: boolean; iv_antibiotics: boolean;
    stat_labs: { available: boolean; turnaround_hours: number };
    mobile_xray: { available: boolean; earliest: string };
    ct_imaging: boolean; oxygen_max_lpm: number; telemetry: boolean;
    pharmacy_stat_delivery_hours: number;
  };
};

export type PriorCall = {
  id: string; residentId: string; ts: string; physician: string;
  reason: string; disposition: string; summary: string;
};

export type ScriptLine = { speaker: "nurse" | "doctor"; text: string; delayMs: number };

function readJson<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, ...parts), "utf8")) as T;
}

const residents = new Map<string, Resident>();
for (const file of fs.readdirSync(path.join(DATA_DIR, "residents"))) {
  if (!file.endsWith(".json")) continue;
  const r = readJson<Resident>("residents", file);
  residents.set(r.id, r);
}

const facility = readJson<Facility>("facility.json");
export const seedPriorCalls = readJson<PriorCall[]>("prior_calls.json");

export function listResidents(): Resident[] {
  return [...residents.values()];
}

export function getResident(id: string): Resident | undefined {
  return residents.get(id);
}

// Single synthetic facility for the demo; every resident lives there.
export function getFacilityForResident(_id: string): Facility {
  return facility;
}

export function getScript(name: string): ScriptLine[] | undefined {
  const file = path.join(DATA_DIR, "scripts", `${name.replace(/[^a-z]/gi, "")}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as ScriptLine[]) : undefined;
}
