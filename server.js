// server.js  (ESM, V2)
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const VERSION = "v2-normalize";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const RUNS_DIR = path.join(__dirname, "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

app.use(
  "/runs",
  express.static(RUNS_DIR, { maxAge: 0, setHeaders: res => res.set("Access-Control-Allow-Origin", "*") })
);

const PORT = process.env.PORT || 10000;

/* -------- URL NORMALIZER -------- */
function normalizeUrl(input) {
  if (!input) return null;
  let u = String(input).trim();

  // fix common typos
  u = u.replace(/^https;\/*/i, "https://").replace(/^http;\/*/i, "http://");

  // add scheme if missing
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");

  try {
    const urlObj = new URL(u);
    if (!["http:", "https:"].includes(urlObj.protocol)) return null;
    return urlObj.toString();
  } catch {
    return null;
  }
}

/* -------- EMAIL -------- */
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

/* -------- SCREENSHOT -------- */
async function takeScreenshot(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Invalid URL: ${rawUrl}`);

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  const filePath = path.join(RUNS_DIR, `${id}.png`);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    await ctx.close();
    await browser.close();
  }

  return { path: filePath, link: `/runs/${path.basename(filePath)}`, url };
}

/* -------- ENDPOINTS -------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", version: VERSION, time: new Date().toISOString() });
});

// Simple planner (extract url/email even when the url has https;//)
function planFromPrompt(prompt) {
  const txt = String(prompt || "");
  const emailMatch = txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const urlMatch = txt.match(/https[;:]\/\/\S+|http[;:]\/\/\S+|www\.\S+|[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i);

  const rawUrl = urlMatch ? urlMatch[0] : null;
  const url = rawUrl ? normalizeUrl(rawUrl) : null;
  const to = emailMatch ? emailMatch[0] : null;

  const steps = [];
  if (url) steps.push({ action: "screenshot_url", url: rawUrl }); // raw allowed; we normalize on run
  if (to) steps.push({ action: "gmail_send_last", to });

  return { kind: url ? "screenshot" : "general", url, to, steps };
}

app.post("/plan", (req, res) => {
  try {
    const { prompt } = req.body || {};
    const plan = planFromPrompt(prompt);
    res.json({ ok: true, plan, steps: plan.steps });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

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

app.post("/quick", async (req, res) => {
  try {
    const { url: rawUrl, email } = req.body || {};
    const shot = await takeScreenshot(rawUrl);
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

// Optional minimal UI if you kept /public; otherwise this is harmless.
app.get("/", (_req, res) => {
  res.send("Mediad AutoDirector API – v2-normalize");
});

app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














