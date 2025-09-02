// server.js (ESM) — full file with /plan and /run restored
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---- Static files ----
app.use(express.static(path.join(__dirname, "public")));

const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

app.use(
  "/runs",
  express.static(RUNS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// ---- Health ----
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// ---- Helpers ----
function absoluteUrl(req, p) {
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
  return p.startsWith("http") ? p : `${origin}${p}`;
}

async function takeScreenshot(targetUrl) {
  const stamp = Date.now();
  const rand = crypto.randomBytes(5).toString("hex");
  const rel = `/runs/${stamp}-${rand}.png`;
  const filePath = path.join(RUNS_DIR, path.basename(rel));

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.screenshot({ path: filePath, fullPage: true });
  await browser.close();

  return { rel, filePath };
}

async function extractLinks(targetUrl, count = 3) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

  const links = await page.$$eval("a[href]", (as) =>
    as
      .map((a) => a.href)
      .filter((h) => /^https?:\/\//i.test(h))
  );
  await browser.close();

  const uniq = [...new Set(links)];
  return uniq.slice(0, Math.max(1, Number(count) || 3));
}

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
}

// ---- QUICK (still available) ----
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ ok: false, error: "Missing url" });

    const { rel, filePath } = await takeScreenshot(url);
    const full = absoluteUrl(req, rel);

    const to = email || process.env.GMAIL_USER;
    try {
      const transporter = getTransporter();
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: "Mediad AutoDirector screenshot",
        text: `Here is your screenshot: ${full}`,
        html: `
          <div style="font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            <p>Here is your screenshot:</p>
            <p><a href="${full}">${full}</a></p>
            <p><img src="cid:snap1" alt="screenshot" style="max-width:100%;height:auto"/></p>
          </div>
        `,
        attachments: [{ filename: path.basename(rel), path: filePath, cid: "snap1" }],
      });
    } catch (mailErr) {
      return res.json({ ok: true, link: rel, url: full, email: to, mailError: mailErr.message });
    }

    res.json({ ok: true, link: rel, url: full, email: to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

// ---- PARSER for natural-language prompts (/plan) ----
const URL_RE = /(https?:\/\/[^\s]+)/gi;
const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;

function parsePrompt(promptRaw = "") {
  const prompt = String(promptRaw || "");
  const urls = (prompt.match(URL_RE) || []).map((u) => u.trim());
  const emailMatch = prompt.match(EMAIL_RE);
  const to = emailMatch ? emailMatch[1] : null;

  // try to find a number (e.g., "top 3", "last 5", "3 links")
  const countMatch =
    prompt.match(/(?:top|latest|recent)\s+(\d+)/i) ||
    prompt.match(/(\d+)\s+(?:links?|results?|items?)/i);
  const count = countMatch ? Number(countMatch[1]) : 3;

  const steps = [];

  // screenshot
  if (/screenshot/i.test(prompt) && urls[0]) {
    steps.push({ action: "screenshot_url", url: urls[0] });
  }

  // link extraction
  if (/links?|latest|recent/i.test(prompt) && urls[0]) {
    steps.push({ action: "extract_links", url: urls[0], count });
  }

  // choose email step depending on previous actions
  if (to) {
    if (steps.some((s) => s.action === "extract_links")) {
      steps.push({ action: "gmail_send_text", to });
    } else if (steps.length > 0) {
      steps.push({ action: "gmail_send_last", to });
    }
  }

  return {
    ok: true,
    plan: {
      kind: urls[0] ? "url_task" : "general",
      url: urls[0] || null,
      to,
      count,
    },
    steps,
  };
}

app.post("/plan", (req, res) => {
  const prompt = req.body?.prompt || "";
  const result = parsePrompt(prompt);
  res.json(result);
});

// ---- RUN the planned steps ----
app.post("/run", async (req, res) => {
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    if (!steps.length) return res.status(400).json({ ok: false, error: "No steps provided" });

    const ctx = { lastImage: null, lastText: null };
    const results = [];

    for (const step of steps) {
      if (step.action === "screenshot_url") {
        const { rel, filePath } = await takeScreenshot(step.url);
        const full = absoluteUrl(req, rel);
        ctx.lastImage = { rel, filePath, url: full };
        results.push({ action: "screenshot_url", url: step.url, path: rel, full });
      }

      else if (step.action === "extract_links") {
        const links = await extractLinks(step.url, step.count);
        ctx.lastText = links.join("\n");
        results.push({ action: "extract_links", url: step.url, count: links.length, links });
      }

      else if (step.action === "gmail_send_last") {
        if (!ctx.lastImage) throw new Error("No screenshot available to email (run screenshot step first).");
        const to = step.to || process.env.GMAIL_USER;
        const transporter = getTransporter();
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to,
          subject: "Mediad AutoDirector screenshot",
          text: `Screenshot: ${ctx.lastImage.url}`,
          html: `
            <div style="font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
              <p>Screenshot:</p>
              <p><a href="${ctx.lastImage.url}">${ctx.lastImage.url}</a></p>
              <p><img src="cid:snap1" alt="screenshot" style="max-width:100%;height:auto"/></p>
            </div>
          `,
          attachments: [
            { filename: path.basename(ctx.lastImage.rel), path: ctx.lastImage.filePath, cid: "snap1" },
          ],
        });
        results.push({ action: "gmail_send_last", to });
      }

      else if (step.action === "gmail_send_text") {
        const to = step.to || process.env.GMAIL_USER;
        const text = ctx.lastText || "(No text content available)";
        const transporter = getTransporter();
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to,
          subject: "Mediad AutoDirector results",
          text,
          html: `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap;">${text}</pre>`,
        });
        results.push({ action: "gmail_send_text", to, chars: text.length });
      }

      else {
        results.push({ action: step.action, error: "Unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Run failed" });
  }
});

// ---- UI at root ----
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














