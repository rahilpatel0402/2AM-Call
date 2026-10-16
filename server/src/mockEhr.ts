// Mock web EHR portal for the Anchor Browser demo. A plain, generic nursing home portal (no real vendor names
// or branding) with a demo login, a resident chart (medications, MOLST, allergies), and a progress-note form.
// Synthetic data only. It stands in for facility EHRs that on-call physician groups can reach only via the web.
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { getResident, listResidents } from "./db.js";

export const EHR_DEMO_USER = "oncall.demo";
export const EHR_DEMO_PASSWORD = "Synthetic-2am!";

type PostedNote = { id: string; residentId: string; ts: string; author: string; text: string };
const postedNotes: PostedNote[] = [];
const sessions = new Set<string>();

export function notesFor(residentId: string): PostedNote[] {
  return postedNotes.filter((n) => n.residentId === residentId);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:Verdana,Arial,sans-serif;font-size:13px;background:#e9edf1;margin:0;color:#222}
.bar{background:#3b5a75;color:#fff;padding:8px 14px;font-weight:bold}.bar small{font-weight:normal;opacity:.8;margin-left:8px}
.wrap{max-width:900px;margin:16px auto;background:#fff;border:1px solid #b9c3cc;padding:16px}
h1{font-size:18px;margin:0 0 10px}h2{font-size:14px;background:#dfe6ec;padding:4px 8px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #c9d1d8;padding:4px 6px;text-align:left}th{background:#f1f4f6}
label{display:block;margin:8px 0 2px}input,textarea{font:inherit;padding:4px;border:1px solid #9aa7b2}textarea{width:100%;height:220px}
button{background:#3b5a75;color:#fff;border:0;padding:6px 14px;margin-top:8px;cursor:pointer}
.note{border:1px solid #c9d1d8;padding:8px;margin:6px 0;white-space:pre-wrap;background:#fafbfc}.meta{color:#556;font-size:11px}
.banner{background:#fff3cd;border:1px solid #e0c36b;padding:4px 8px;margin-bottom:10px;font-size:11px}
</style></head><body><div class="bar">Resident Care Portal <small>Bayview Rehab and Nursing (synthetic demo)</small></div>
<div class="wrap"><div class="banner">SYNTHETIC DATA. Demo portal for The 2 AM Call. Not a real EHR.</div>${body}</div></body></html>`;

function authed(req: Request): boolean {
  const sid = /ehr_sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  return !!sid && sessions.has(sid);
}

export function mockEhrRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get("/", (req: Request, res: Response) => {
    if (authed(req)) return res.redirect("/ehr/residents");
    res.send(page("Sign in", `<h1>Sign in</h1>
<form method="post" action="/ehr/login">
<label for="username">Username</label><input id="username" name="username" autocomplete="off">
<label for="password">Password</label><input id="password" name="password" type="password">
<br><button type="submit">Sign in</button></form>`));
  });

  r.post("/login", (req: Request, res: Response) => {
    if (req.body.username !== EHR_DEMO_USER || req.body.password !== EHR_DEMO_PASSWORD) {
      return res.status(401).send(page("Sign in", `<h1>Sign in failed</h1><p>Invalid username or password.</p><a href="/ehr/">Try again</a>`));
    }
    const sid = randomUUID();
    sessions.add(sid);
    res.setHeader("Set-Cookie", `ehr_sid=${sid}; Path=/ehr; HttpOnly; SameSite=Lax`);
    res.redirect("/ehr/residents");
  });

  r.get("/residents", (req: Request, res: Response) => {
    if (!authed(req)) return res.redirect("/ehr/");
    const rows = listResidents().map((x) => `<tr><td><a href="/ehr/residents/${x.id}">${esc(x.name)}</a></td><td>${x.room}</td><td>${x.age} ${x.sex}</td></tr>`).join("");
    res.send(page("Census", `<h1>Census</h1><table><tr><th>Resident</th><th>Room</th><th>Age/Sex</th></tr>${rows}</table>`));
  });

  r.get("/residents/:id", (req: Request, res: Response) => {
    if (!authed(req)) return res.redirect("/ehr/");
    const x = getResident(req.params.id);
    if (!x) return res.status(404).send(page("Not found", "<p>Resident not found.</p>"));
    const meds = x.medications.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.dose)}</td><td>${esc(m.class ?? "")}</td></tr>`).join("");
    const notes = [...notesFor(x.id)].reverse().map((n) => `<div class="note"><div class="meta">${esc(n.ts)} · ${esc(n.author)}</div>${esc(n.text)}</div>`).join("") || "<p>No notes posted tonight.</p>";
    res.send(page(x.name, `<h1>${esc(x.name)}</h1><p>Room ${x.room} · ${x.age} ${x.sex} · PCP ${esc(x.pcp)}</p>
<h2>Code status / MOLST</h2><p id="code-status">${esc(x.code_status.value)}. MOLST: ${esc(x.code_status.molst)}</p>
<h2>Allergies</h2><p id="allergies">${esc(x.allergies.join(", "))}</p>
<h2>Active medications</h2><table id="medications"><tr><th>Medication</th><th>Dose</th><th>Class</th></tr>${meds}</table>
<h2>Progress notes</h2>${notes}
<h2>Add progress note</h2><form method="post" action="/ehr/residents/${x.id}/notes">
<label for="author">Author</label><input id="author" name="author" size="40">
<label for="note">Note</label><textarea id="note" name="note"></textarea>
<button type="submit">Save note</button></form>`));
  });

  r.post("/residents/:id/notes", (req: Request, res: Response) => {
    if (!authed(req)) return res.redirect("/ehr/");
    const text = String(req.body.note ?? "").trim();
    if (text) postedNotes.push({ id: randomUUID(), residentId: req.params.id, ts: new Date().toLocaleString("en-US"), author: String(req.body.author || "On-call physician"), text });
    res.redirect(`/ehr/residents/${req.params.id}`);
  });

  return r;
}
