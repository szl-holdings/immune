// IMMUNE standalone server — a MINIMAL Express app for the public investor demo.
//
// It deliberately mounts ONLY the immune router (the real SHA-256 receipt-chain,
// SENTRA, HUKLLA tripwires, threat-intel endpoints) — no Bingle/Mulé/auth/DB.
// It also serves the vite-built static frontend (SPA) so a single Node process
// powers both the UI and /api/immune/* for Docker / Hugging Face Space deploys.
//
// Run:  PORT=7878 node immune-server.js   (from a dir containing ./public and
//       ./data/immune so the real ledger chain is served).
import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import immuneRouter from "./routes/immune";

const __serverDir = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Lightweight liveness probe (handy for Docker/HF healthchecks).
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "immune-standalone" });
});

// The real IMMUNE API — receipt chain, SENTRA, HUKLLA, threat intel.
app.use("/api/immune", immuneRouter);

// Any unmatched /api/* path is an honest 404 JSON (never falls through to the SPA).
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "not found" });
});

// Resolve the vite-built static frontend (dist/public). Checked in priority order
// so the same bundle works whether run from its dist dir (Docker /app/public),
// from the deploy dir, or straight from the workspace during local testing.
function resolveStaticDir(): string | null {
  const candidates = [
    process.env.IMMUNE_STATIC_DIR,
    path.resolve(__serverDir, "public"),
    path.resolve(__serverDir, "dist", "public"),
    path.resolve(process.cwd(), "public"),
    path.resolve(process.cwd(), "dist", "public"),
    path.resolve(__serverDir, "..", "..", "immune-demo", "dist", "public"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

const staticDir = resolveStaticDir();

if (staticDir) {
  app.use(
    express.static(staticDir, {
      index: "index.html",
      maxAge: "5m",
    })
  );
  // SPA fallback — serve index.html for any non-API, non-asset route.
  app.get("/{*splat}", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[immune-standalone] No static frontend found — serving API only. " +
      "Build the UI first (build-standalone.sh) or set IMMUNE_STATIC_DIR."
  );
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      service: "immune-standalone",
      note: "API only — static frontend not bundled",
      api: "/api/immune/state",
    });
  });
}

// Final safety net so errors never leak stack traces to the demo audience.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[immune-standalone] unhandled error:", message);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal error" });
  }
});

const rawPort = process.env.PORT || "7860";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", () => {
  const ledgerDir = path.resolve(process.cwd(), "data", "immune");
  const ledgerPresent = fs.existsSync(path.join(ledgerDir, "ledger.jsonl"));
  // eslint-disable-next-line no-console
  console.log(
    `[immune-standalone] listening on 0.0.0.0:${port} | static=${staticDir ?? "none"} | ledger=${ledgerPresent ? ledgerDir : "EMPTY (fresh chain)"}`
  );
});
