import "./env.js";
import express from "express";
import cors from "cors";
import { env } from "./env.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, llmProvider: env("LLM_PROVIDER") || "bedrock" });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
