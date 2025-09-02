// server.js (ESM)
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// folders & config
const RUNS_DIR = path.join(__dirname, "runs");
fs.mkdirSync(RUNS_DIR, { recursive: true });

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";

// health
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() })
);

// serve screenshots
app.use("/runs", express.static(RUNS_DIR, { fallthrough: false }));

// ---------- helpers ----------
async function doScreenshot(url) {
  const ts = Date.now();
  const name = `${ts}-${Math.random().toString(36).slice(2, 12)}.png`;
  const full = path.join(RUNS_DIR, name);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.screenshot({ path: full, fullPage: true });
  await browser.close();

  return `/runs/${name}`;
}

async function sendEmail({ to, link }) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  }
  const absoluteLink = `${BASE_URL}${link}`;
  const filePath = path.join(RUNS_DIR, path.basename(link));
  const cid = `shot-${Date.now()}@mediad`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const html = `
    <p>Here is your screenshot:</p>
    <p><img src="cid:${cid}" alt="screenshot" /></p>
    <p>Direct link: <a href="${absoluteLink}">${absoluteLink}</a></p>`;
  const text = `Here is your screenshot.\nDirect link: ${absoluteLink}\n(If the image doesn't display, click the link.)`;

  await transporter.sendMail({
    from: `"Mediad AutoDirector" <${GMAIL_USER}>`,
    to,
    subject: "Your screenshot",
    text,
    html,
    attachments: [{ filename: path.basename(filePath), path: filePath, cid }],
  });
}

// ---------- routes ----------

// One-shot endpoint (already working)
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const link = await doScreenshot(url);
    if (email || GMAIL_USER) {
      await sendEmail({ to: email || GMAIL_USER, link });
    }
    res.json({ ok: true, link, email: email || GMAIL_USER || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// New: /plan (simple parser)
app.post("/plan", (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.json({ ok: false, error: "No prompt" });

  const urlMatch = prompt.match(/https?:\/\/\S+/i);
  if (!urlMatch) return res.json({ ok: false, error: "No URL detected in your prompt." });

  const emailMatch = prompt.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  const plan = { kind: "screenshot", url: urlMatch[0], to: emailMatch?.[1] };
  const steps = [{ action: "screenshot_url", url: plan.url }];
  if (plan.to) steps.push({ action: "gmail_send_last", to: plan.to });

  res.json({ ok: true, plan, steps });
});

// New: /run (executes steps from /plan)
app.post("/run", async (req, res) => {
  try {
    const { steps } = req.body || {};
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.json({ ok: false, error: "No steps provided" });
    }

    let lastLink = null;
    const results = [];
    for (const step of steps) {
      if (step.action === "screenshot_url") {
        lastLink = await doScreenshot(step.url);
        results.push({ action: "screenshot_url", path: lastLink });
      } else if (step.action === "gmail_send_last") {
        const to = step.to || GMAIL_USER;
        if (!to) throw new Error("No destination email");
        await sendEmail({ to, link: lastLink });
        results.push({ action: "gmail_send_last", to });
      } else {
        results.push({ action: step.action, skipped: true, reason: "Unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Basic UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














