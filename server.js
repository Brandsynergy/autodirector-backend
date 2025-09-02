// server.js (ESM) — full replacement

import express from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import playwright from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ------------------- CONFIG -------------------
const PORT = process.env.PORT || 10000;
const BASE_DIR = process.cwd();
const RUNS_DIR = path.join(BASE_DIR, "runs");
const PUBLIC_URL = process.env.PUBLIC_URL || `https://autodirector-backend-latest.onrender.com`;

// Gmail credentials (Render → Environment)
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || "";
const GMAIL_FROM = process.env.GMAIL_FROM || GMAIL_USER;

// ------------------- EMAIL -------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

async function sendEmailWithAttachment({ to, subject, text, html, filePath, cid = "screenshot" }) {
  await transporter.sendMail({
    from: GMAIL_FROM || GMAIL_USER,
    to: to || GMAIL_USER, // default to self if none given
    subject,
    text,
    html,
    attachments: filePath
      ? [{ filename: path.basename(filePath), path: filePath, cid }]
      : [],
  });
}

// ------------------- HELPERS -------------------
async function ensureRunsDir() {
  try { await fs.mkdir(RUNS_DIR, { recursive: true }); } catch {}
}

function publicFileUrl(relPath) {
  return `${PUBLIC_URL}/${relPath.replace(/^\//, "")}`;
}

async function takeScreenshot(url) {
  await ensureRunsDir();
  const browser = await playwright.chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const absPath = path.join(RUNS_DIR, filename);
  await page.screenshot({ path: absPath, fullPage: true });
  await browser.close();
  const relPath = `runs/${filename}`;
  return { absPath, relPath, link: publicFileUrl(relPath) };
}

// ------------------- STATIC -------------------
app.use("/runs", express.static(RUNS_DIR, { fallthrough: false }));

// Serve minimal UI
app.use(express.static(path.join(__dirname, "public")));

// ------------------- HEALTH -------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// ------------------- QUICK (works without planner) -------------------
app.post("/quick", async (req, res, next) => {
  try {
    const { url, email } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "Invalid URL" });
    }

    const sc = await takeScreenshot(url);
    const cid = `sc_${Date.now()}`;
    const subject = "Mediad AutoDirector: screenshot";
    const text = `Here is your screenshot of ${url}\nDirect link: ${sc.link}`;
    const html = `
      <p>Here is your screenshot of <a href="${url}">${url}</a>.</p>
      <p><strong>Inline image (from attachment):</strong></p>
      <p><img src="cid:${cid}" alt="screenshot" /></p>
      <p>Direct link to file: <a href="${sc.link}">${sc.link}</a></p>
    `;

    await sendEmailWithAttachment({
      to: email,
      subject,
      text,
      html,
      filePath: sc.absPath,
      cid,
    });

    res.json({ ok: true, link: `/${sc.relPath}`, email: email || GMAIL_USER });
  } catch (err) { next(err); }
});

// ------------------- PLAN (adds simple planner) -------------------
app.post("/plan", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();

  // Extract first URL
  const urlMatch = prompt.match(/https?:\/\/\S+/i);
  const url = urlMatch ? urlMatch[0].replace(/[)"'.,;]+$/, "") : null;

  // Extract email if any
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const to = emailMatch ? emailMatch[0] : GMAIL_USER;

  if (!url) {
    return res.json({ ok: false, error: "No URL detected in your prompt." });
  }

  // For now we only implement screenshot + email
  const plan = { kind: "screenshot", url, to };
  const steps = [
    { action: "screenshot_url", url },
    { action: "gmail_send_last", to },
  ];

  res.json({ ok: true, plan, steps });
});

// ------------------- RUN (executes planned steps) -------------------
app.post("/run", async (req, res, next) => {
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    if (!steps.length) return res.json({ ok: false, error: "No steps provided" });

    const results = [];
    let lastScreenshotPath = null; // absolute path
    let lastRel = null;           // relative (runs/xxx.png)

    for (const step of steps) {
      if (step.action === "screenshot_url") {
        const url = step.url;
        if (!url) throw new Error("screenshot_url missing 'url'");
        const sc = await takeScreenshot(url);
        lastScreenshotPath = sc.absPath;
        lastRel = sc.relPath;
        results.push({ action: "screenshot_url", path: `/${lastRel}` });

      } else if (step.action === "gmail_send_last") {
        const to = step.to || GMAIL_USER;
        if (!lastScreenshotPath) throw new Error("gmail_send_last has no screenshot to send");

        const cid = `sc_${Date.now()}`;
        const link = publicFileUrl(lastRel);
        const subject = "Mediad AutoDirector: screenshot";
        const text = `Here is your screenshot.\nDirect link: ${link}`;
        const html = `
          <p>Here is your screenshot:</p>
          <p><img src="cid:${cid}" alt="screenshot" /></p>
          <p>Direct link to file: <a href="${link}">${link}</a></p>
        `;

        await sendEmailWithAttachment({
          to, subject, text, html, filePath: lastScreenshotPath, cid
        });

        results.push({ action: "gmail_send_last", to });
      } else {
        results.push({ action: step.action, skipped: true, reason: "Unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (err) { next(err); }
});

// ------------------- ERROR HANDLER -------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Server error" });
});

// ------------------- START -------------------
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














