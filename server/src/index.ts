import "./env.js";
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { getFacilityForResident, getResident, listResidents } from "./db.js";
import { recallForResident, seedMemory } from "./memory.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, llmProvider: env("LLM_PROVIDER") || "bedrock" });
});

app.get("/api/residents", (_req, res) => {
  res.json(listResidents().map(({ id, name, age, sex, room }) => ({ id, name, age, sex, room })));
});

app.get("/api/residents/:id", (req, res) => {
  const r = getResident(req.params.id);
  if (!r) return res.status(404).json({ error: "resident not found" });
  res.json({ resident: r, facility: getFacilityForResident(r.id) });
});

app.get("/api/residents/:id/memory", async (req, res) => {
  if (!getResident(req.params.id)) return res.status(404).json({ error: "resident not found" });
  res.json(await recallForResident(req.params.id));
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  void seedMemory();
});
