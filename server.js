// server.js  (ESM)
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const RUNS_DIR = path.join(__dirname, "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

// Serve screenshots
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    maxAge: 0,
    setHeaders(res) {
      res.set("Access-Control-Allow-Origin", "*");
    },
  })
);

const PORT = process.env.PORT || 10000;

/* ----------------------- UTILITIES ----------------------- */

// Fix common URL mistakes and validate
function normalizeUrl(input) {
  if (!input) return null;
  let u = String(input).trim();

  // common paste typos like "https;//" or "http;//"
  u = u.replace(/^https;\/*/i, "https://").replace(/^http;\/*/i, "http://");

  // add scheme if missing
  if (!/^https?:\/\//i.test(u)) {
    u = "https://" + u.replace(/^\/+/, "");
  }

  try {
    const urlObj = new URL(u);
    if (!["http:", "https:"].includes(urlObj.protocol)) return null;
    return urlObj.toString();
  } catch {
    return null;
  }
}

async function takeScreenshot(url) {
  const fixed = normalizeUrl(url);
  if (!fixed) throw new Error(`Invalid URL: ${url}`);

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  const filePath = path.join(RUNS_DIR, `${id}.png`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    await page.goto(fixed, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }

  const link = `/runs/${path.basename(filePath)}`;
  return { path: filePath, link, url: fixed };
}

function smtp() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const from = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  await smtp().sendMail({ from, to, subject, text, html, attachments });
}

/* ----------------------- ENDPOINTS ----------------------- */

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// QUICK: { url, email? }
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    const shot = await takeScreenshot(url);
    const absolute = new URL(shot.link, `${req.protocol}://${req.get("host")}`).toString();

    if (email) {
      await sendEmail({
        to: email,
        subject: `Screenshot of ${shot.url}`,
        text: `Here is your screenshot: ${absolute}`,
        html: `<p>Here is your screenshot:</p><p><a href="${absolute}">${absolute}</a></p>`,
        attachments: [{ filename: path.basename(shot.path), path: shot.path }],
      });
    }
    res.json({ ok: true, link: shot.link, url: absolute, email: email || null });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Make a simple plan from natural language
function planFromPrompt(prompt) {
  const txt = String(prompt || "").trim();
  if (!txt) throw new Error("prompt is required");

  const urlMatch = txt.match(
    /https?:\/\/\S+|www\.\S+|[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i
  );
  const emailMatch = txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  const url = urlMatch ? urlMatch[0] : null;
  const to = emailMatch ? emailMatch[0] : null;

  const steps = [];
  if (url) steps.push({ action: "screenshot_url", url });
  if (to) steps.push({ action: "gmail_send_last", to });

  return { kind: url ? "screenshot" : "unknown", url, to, steps };
}

// PLAN: { prompt }
app.post("/plan", (req, res) => {
  try {
    const { prompt } = req.body || {};
    const plan = planFromPrompt(prompt);
    res.json({ ok: true, plan, steps: plan.steps });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// RUN: { steps: [...] }
app.post("/run", async (req, res) => {
  const steps = (req.body && req.body.steps) || [];
  const results = [];
  let lastShot = null;

  try {
    for (const step of steps) {
      if (step.action === "screenshot_url") {
        lastShot = await takeScreenshot(step.url);
        results.push({ action: "screenshot_url", link: lastShot.link, url: lastShot.url });
      } else if (step.action === "gmail_send_last") {
        if (!lastShot) throw new Error("No screenshot available for email step");
        const absolute = new URL(lastShot.link, `${req.protocol}://${req.get("host")}`).toString();
        await sendEmail({
          to: step.to,
          subject: `Screenshot of ${lastShot.url}`,
          text: `Here is your screenshot: ${absolute}`,
          html: `<p>Here is your screenshot:</p><p><a href="${absolute}">${absolute}</a></p>`,
          attachments: [{ filename: path.basename(lastShot.path), path: lastShot.path }],
        });
        results.push({ action: "gmail_send_last", to: step.to });
      } else {
        results.push({ action: step.action, skipped: true, reason: "Unknown action" });
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err), results });
  }
});

// Simple UI
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














