// Exposes the mock EHR portal (http://localhost:3001/ehr) at a public URL so Anchor's cloud browser can reach it.
// Uses a free Cloudflare quick tunnel. Writes the URL to server/.ehr-url for the server to use.
import { spawn } from "node:child_process";
import fs from "node:fs";

const bin = "tools/cloudflared.exe";
if (!fs.existsSync(bin)) {
  console.error("Missing tools/cloudflared.exe. Download: https://github.com/cloudflare/cloudflared/releases/latest");
  process.exit(1);
}
const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", "http://localhost:3001"], { stdio: ["ignore", "pipe", "pipe"] });
let found = false;
const onData = (buf) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
  if (m && !found) {
    found = true;
    fs.writeFileSync("server/.ehr-url", m[0]);
    console.log(`EHR portal public URL: ${m[0]}/ehr/  (written to server/.ehr-url)`);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("exit", (code) => {
  fs.rmSync("server/.ehr-url", { force: true });
  console.log(`tunnel exited (${code})`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
