// Loads the single .env at the repo root, no matter where the server is started from.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });

export function env(name: string): string {
  return (process.env[name] ?? "").trim();
}
