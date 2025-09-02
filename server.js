// server.js (ESM, Node 18+)
// Full backend: /health, /plan, /run, /api/capture, static /runs, static /public
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- storage for screenshots ----
const RUNS_DIR = process.env.RUNS_DIR || path.join(process.cwd(), "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

// serve the static site from /public and the images from /runs
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    fallthrough: false,
    setHeaders(res) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// ---- email transport (Gmail App Password) ----
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const abs = (req, rel) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}${rel.startsWith("/") ? rel : "/" + rel}`;
};

// ---- tiny helpers for plan ----
const URL_RX = /(https?:\/\/[^\s"']+)/i;
const EMAIL_RX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const NUM_RX = /\b(\d{1,3})\b/;

function extractUrl(s) {
  const m = s?.match(URL_RX);
  return m ? m[1] : null;
}
function extractEmail(s) {
  const m = s?.match(EMAIL_RX);
  return m ? m[0] : null;
}
function extractCount(s, def = 3) {
  const m = s?.match(NUM_RX);
  const n = m ? parseInt(m[1], 10) : def;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : def;
}

// produce a very simple plan from free-text
function makePlan(prompt) {
  const lc = (prompt || "").toLowerCase();
  const url = extractUrl(prompt);
  const to = extractEmail(prompt);

  if (!url) {
    return { ok: false, error: "No URL detected in your prompt." };
  }

  // “links” / “latest” => extract links then email them
  if (lc.includes("link")) {
    const count = extractCount(prompt, 3);
    return {
      ok: true,
      plan: { kind: "links", url, count, to },
      steps: [
        { action: "extract_links", url, count },
        ...(to ? [{ action: "gmail_send_text", to }] : []),
      ],
    };
  }

  // default: screenshot (and email if asked)
  const steps = [{ action: "screenshot_url", url }];
  if (lc.includes("email") || to) steps.push({ action: "gmail_send_last", to });
  return { ok: true, plan: { kind: "screenshot", url, to }, steps };
}

// ---- actions (run) ----
async function screenshotUrl(browser, url, outDir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: "networkidle" });
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const rel = `/runs/${filename}`;
  const absPath = path.join(outDir, filename);
  await page.screenshot({ path: absPath, fullPage: true });
  await page.close();
  return { path: rel, absPath };
}

async function extractLinks(browser, url, count) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const hrefs = await page.$$eval("a[href]", as =>
    Array.from(new Set(as.map(a => a.href)))
      .filter(h => /^https?:\/\//i.test(h))
      .slice(0, 50)
  );
  await page.close();
  return { links: hrefs.slice(0, count) };
}

// ---- routes ----
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() })
);

// natural-language planner
app.post("/plan", (req, res) => {
  const { prompt } = req.body || {};
  const plan = makePlan(prompt);
  if (!plan.ok) return res.status(400).json(plan);
  res.json(plan);
});

// executor
app.post("/run", async (req, res, next) => {
  try {
    const { steps } = req.body || {};
    if (!Array.isArray(steps) || steps.length === 0)
      return res.status(400).json({ ok: false, error: "No steps provided." });

    const browser = await chromium.launch();
    let lastShot = null;
    const results = [];

    for (const step of steps) {
      switch ((step.action || "").toLowerCase()) {
        case "screenshot_url": {
          if (!step.url) throw new Error("screenshot_url: missing 'url'.");
          const r = await screenshotUrl(browser, step.url, RUNS_DIR);
          lastShot = r;
          results.push({ action: "screenshot_url", path: r.path });
          break;
        }
        case "extract_links": {
          if (!step.url) throw new Error("extract_links: missing 'url'.");
          const r = await extractLinks(browser, step.url, step.count || 3);
          results.push({ action: "extract_links", links: r.links });
          break;
        }
        case "gmail_send_last": {
          const to = step.to || process.env.GMAIL_USER;
          if (!to) throw new Error("gmail_send_last: no destination and GMAIL_USER not set.");
          if (!lastShot?.absPath) throw new Error("gmail_send_last: no previous screenshot.");
          const link = abs(req, lastShot.path);
          await transporter.sendMail({
            from: `Mediad AutoDirector <${process.env.GMAIL_USER}>`,
            to,
            subject: "Your screenshot",
            text: `Here is your screenshot:\n${link}\n`,
            html: `<p>Here is your screenshot:</p><p><a href="${link}">${link}</a></p><p><img src="${link}" style="max-width:100%"/></p>`,
            attachments: [{ filename: path.basename(lastShot.absPath), path: lastShot.absPath }],
          });
          results.push({ action: "gmail_send_last", to });
          break;
        }
        case "gmail_send_text": {
          const to = step.to || process.env.GMAIL_USER;
          if (!to) throw new Error("gmail_send_text: no destination and GMAIL_USER not set.");
          const body =
            step.text ||
            (results.find(r => r.links)?.links || []).join("\n") ||
            "No content.";
          await transporter.sendMail({
            from: `Mediad AutoDirector <${process.env.GMAIL_USER}>`,
            to,
            subject: "Requested information",
            text: body,
          });
          results.push({ action: "gmail_send_text", to });
          break;
        }
        default:
          throw new Error(`Unknown action: ${step.action}`);
      }
    }

    await browser.close();
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// quick capture API used by the UI card
app.post("/api/capture", async (req, res, next) => {
  try {
    const { url, email } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "Missing 'url'." });
    const to = email || process.env.GMAIL_USER;
    if (!to) return res.status(400).json({ ok: false, error: "No destination and GMAIL_USER not set." });

    const browser = await chromium.launch();
    const r = await screenshotUrl(browser, url, RUNS_DIR);
    await browser.close();

    const link = abs(req, r.path);
    await transporter.sendMail({
      from: `Mediad AutoDirector <${process.env.GMAIL_USER}>`,
      to,
      subject: `Screenshot of ${url}`,
      text: `Here is your screenshot:\n${link}\n`,
      html: `<p>Here is your screenshot:</p><p><a href="${link}">${link}</a></p><p><img src="${link}" style="max-width:100%"/></p>`,
      attachments: [{ filename: path.basename(r.absPath), path: r.absPath }],
    });

    res.json({ ok: true, link: r.path, email: to });
  } catch (err) {
    next(err);
  }
});

// errors as JSON (no more generic “Unknown Error” pages)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














