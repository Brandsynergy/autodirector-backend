// server.js  — CommonJS version to avoid ESM headaches
const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 10000;
const app = express();

// ---- folders
const ROOT = process.cwd();
const PUBLIC_DIR = path.resolve(ROOT, "public");
const RUNS_DIR = path.resolve(ROOT, "runs");

// ensure runs dir exists
fs.mkdirSync(RUNS_DIR, { recursive: true });

// ---- middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// serve static assets
app.use("/runs", express.static(RUNS_DIR, { fallthrough: false, maxAge: "1d" }));
app.use("/", express.static(PUBLIC_DIR, { fallthrough: true }));

// absolute URL helper
function absUrl(req, p) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${p.startsWith("/") ? "" : "/"}${p}`;
}

// ---- routes

// health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// simple file streamer (extra safe)
app.get("/file/:name", (req, res) => {
  const safe = path.basename(req.params.name); // prevent path traversal
  const file = path.join(RUNS_DIR, safe);
  fs.access(file, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).type("text").send("File not found");
    res.sendFile(file);
  });
});

/**
 * POST /run
 * Expected JSON:
 * {
 *   "steps": [
 *     {"action":"screenshot_url", "url":"https://cnn.com"}
 *   ]
 * }
 */
app.post("/run", async (req, res) => {
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    const results = [];

    for (const step of steps) {
      const action = (step.action || "").toLowerCase();

      if (action === "screenshot_url") {
        const target = step.url;
        if (!target || typeof target !== "string") {
          throw new Error("screenshot_url: 'url' is required");
        }
        const out = await takeScreenshot(target);
        results.push({
          action,
          file: out.file,
          relative_url: `/runs/${out.file}`,
          url: absUrl(req, `/runs/${out.file}`),
        });
      } else {
        // Unknown actions are ignored but reported
        results.push({ action, skipped: true, reason: "unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// fallback 404 for anything else (no vague “Unknown Error” pages)
app.use((req, res) => {
  res.status(404).type("text").send("Not found");
});

app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});

// ---- helpers

async function takeScreenshot(url) {
  // Render/containers often need --no-sandbox
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const file = `${id}-shot.png`;
  const fullPath = path.join(RUNS_DIR, file);
  await page.screenshot({ path: fullPath, fullPage: true });

  await ctx.close();
  await browser.close();

  return { file, fullPath };
}
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














