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
import { bootDemoOperator } from "./routes/immune/demo-operator";
import immuneRouter from "./routes/immune";
import { ledgerCount, ledgerLastHash } from "./routes/immune/ledger";
import { getState, publicAuthoritySnapshot } from "./routes/immune/state";
import {
  bindRuntimeStaticDir,
  buildInfo,
  resolveRuntimeStaticDir,
  sourceAttestation,
} from "./source-attestation";
import { readinessHttpResult } from "./readiness";

const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = bindRuntimeStaticDir(resolveRuntimeStaticDir(__serverDir));

const app = express();

try {
  bootDemoOperator();
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(
    "[immune-standalone] operator boot failed (fail-closed):",
    error instanceof Error ? error.message : String(error),
  );
}

app.disable("x-powered-by");
// Behind the Hugging Face / nginx proxy, honor X-Forwarded-For so req.ip is the
// real visitor (per-IP rate limiting in the agent depends on this).
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

// Lightweight liveness probe (handy for Docker/HF healthchecks).
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "immune-standalone",
    transport_state: "REACHABLE",
    readiness_state: "NOT_EVALUATED",
    readiness_endpoint: "/readyz",
  });
});

// Truthful readiness is registered before static hosting and the SPA fallback.
// Runtime/read integrity is independent from signed authority/write readiness.
app.get("/readyz", (_req: Request, res: Response) => {
  const { statusCode, body } = readinessHttpResult();
  res.setHeader("Cache-Control", "no-store");
  res.status(statusCode).type("application/json").json(body);
});

app.get("/api/build-info", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(buildInfo());
});

app.get(
  "/.well-known/szl-source.json",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await sourceAttestation());
    } catch (error) {
      next(error);
    }
  },
);

// The real IMMUNE API — receipt chain, SENTRA, HUKLLA, threat intel.
app.use("/api/immune", immuneRouter);

// Any unmatched /api/* path is an honest 404 JSON (never falls through to the SPA).
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "not found" });
});

// Resolve the vite-built static frontend (dist/public). Checked in priority order
// so the same bundle works whether run from its dist dir (Docker /app/public),
// from the deploy dir, or straight from the workspace during local testing.
if (staticDir) {
  const indexPath = path.join(staticDir, "index.html");
  const sendIndex = (_req: Request, res: Response) => {
    let html = fs.readFileSync(indexPath, "utf8");
    try {
      const bootstrap = {
        ...publicAuthoritySnapshot(getState()),
        ledgerCount: ledgerCount(),
        lastHash: ledgerLastHash(),
      };
      const tag = `<script>window.__IMMUNE_BOOTSTRAP__=${JSON.stringify(bootstrap)};</script>`;
      html = html.includes("</head>")
        ? html.replace("</head>", `${tag}</head>`)
        : `${tag}${html}`;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "[immune-standalone] bootstrap inject failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  };
  app.get("/", sendIndex);
  app.use(
    express.static(staticDir, {
      index: false,
      maxAge: "5m",
    }),
  );
  // Static hosting above owns existing artifact bytes. Missing assets must
  // never receive index.html: that converts a missing script into a misleading
  // HTTP 200 and a browser parse error. Document navigation still uses the SPA.
  app.use((req: Request, res: Response, next: NextFunction) => {
    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(req.path);
    } catch {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ error: "invalid asset path" });
      return;
    }
    const destination = req.get("Sec-Fetch-Dest") ?? "";
    const assetDestination = /^(?:script|style|font|image|audio|video|track|worker|sharedworker|serviceworker|manifest)$/i;
    const assetSuffix = /\.(?:[cm]?js|css|map|json|wasm|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|ogg|wav|webm|pdf)$/i;
    if (
      requestedPath.startsWith("/assets/") ||
      assetSuffix.test(requestedPath) ||
      assetDestination.test(destination)
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: "asset not found" });
      return;
    }
    next();
  });
  // SPA fallback — serve index.html for any non-API, non-asset route.
  app.get("/{*splat}", sendIndex);
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

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
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
