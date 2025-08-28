// server.js — robust file streaming + debug endpoints
const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 10000;
const app = express();

const ROOT = process.cwd();
const PUBLIC_DIR = path.resolve(ROOT, "public");
const RUNS_DIR = path.resolve(ROOT, "runs");
fs.mkdirSync(RUNS_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

// Serve static assets (logo, index.html, etc.)
app.use("/", express.static(PUBLIC_DIR, { fallthrough: true, maxAge: "1d" }));

// Absolute URL helper
function absUrl(req, p) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${p.startsWith("/") ? "" : "/"}${p}`;
}

// ---------- Health & debug ----------
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.get("/runs-list", (_req, res) => {
  try {
    const list = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith(".png"));
    res.json({ ok: true, count: list.length, files: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stream files explicitly (avoids any static middleware edge cases)
app.get("/file/:name", (req, res) => {
  const safe = path.basename(req.params.name);
  const file = path.join(RUNS_DIR, safe);

  fs.stat(file, (err, stat) => {
    if (err || !stat?.isFile()) {
      return res.status(404).type("text").send("File not found");
    }
    // Always tell the proxy/browser exactly what this is
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.status(500).type("text").end("read error"));
    stream.pipe(res);
  });
});

// Quick manual test: GET /shot?url=https://example.com
app.get("/shot", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");

  try {
    const out = await takeScreenshot(url);
    const fileUrl = absUrl(req, `/file/${out.file}`);
    res.json({ ok: true, file: out.file, url: fileUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Main API ----------
app.post("/run", async (req, res) => {
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    const results = [];

    for (const step of steps) {
      const action = String(step.action || "").toLowerCase();

      if (action === "screenshot_url") {
        const target = step.url;
        if (!target || typeof target !== "string") {
          throw new Error("screenshot_url: 'url' is required");
        }
        const out = await takeScreenshot(target);
        results.push({
          action,
          file: out.file,
          // Prefer the explicit file route (most robust):
          url: absUrl(req, `/file/${out.file}`),
          // Keep the static path as a secondary reference if you want:
          alt_url: absUrl(req, `/runs/${out.file}`)
        });
      } else {
        results.push({ action, skipped: true, reason: "unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// 404 fallback (clear message)
app.use((_req, res) => res.status(404).type("text").send("Not found"));

app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});

// ---------- helpers ----------
async function takeScreenshot(url) {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const file = `${id}-shot.png`;
  const fullPath = path.join(RUNS_DIR, file);
  await page.screenshot({ path: fullPath, fullPage: true });

  // Confirm the file exists & size is nonzero
  const stat = fs.statSync(fullPath);
  if (!stat.size) throw new Error("screenshot file is empty");

  await ctx.close();
  await browser.close();
  return { file, fullPath, size: stat.size };
}
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














