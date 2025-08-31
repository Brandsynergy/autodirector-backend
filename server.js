// server.js (ESM)
// Mediad AutoDirector backend: serves a small UI and supports screenshot + email

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const SERVICE_NAME = process.env.SERVICE_NAME || "mediad-autodirector";

// Ensure screenshot folder exists
const RUNS_DIR = path.join(__dirname, "runs");
fs.mkdirSync(RUNS_DIR, { recursive: true });

// Serve static UI from /public and screenshots from /runs
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.use("/runs", express.static(RUNS_DIR, { maxAge: "1d" }));

// Track last screenshot for email step
let lastArtifactPath = null;

// ---------- Helpers ----------
function newId(ext = ".png") {
  const stamp = Date.now();
  const rand = Math.random().toString(16).slice(2, 10);
  return `${stamp}-${rand}${ext}`;
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

async function takeScreenshot(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

  const id = newId(".png");
  const filePath = path.join(RUNS_DIR, id);
  await page.screenshot({ path: filePath, fullPage: true });

  await page.close();
  await context.close();

  lastArtifactPath = filePath;
  return `/runs/${id}`;
}

async function sendEmailWithLast(to) {
  if (!lastArtifactPath || !fs.existsSync(lastArtifactPath)) {
    throw new Error("No screenshot available to send. Capture one first.");
  }
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD environment variables.");
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: `"Mediad AutoDirector" <${user}>`,
    to,
    subject: "Requested screenshot",
    text: "See attached screenshot.",
    attachments: [{ filename: path.basename(lastArtifactPath), path: lastArtifactPath }],
  });
}

// ---------- API ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: SERVICE_NAME, time: new Date().toISOString() });
});

// Simple “planner” (optional)
app.post("/plan", (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  const url = prompt.match(/https?:\/\/[^\s"')]+/i)?.[0];
  const email = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || process.env.GMAIL_USER || "you@example.com";
  if (!url) return res.json({ ok: false, error: "No URL found in prompt." });

  const steps = [
    { action: "screenshot_url", url },
    { action: "gmail_send_last", to: email },
  ];
  res.json({ ok: true, plan: { kind: "screenshot", url, to: email }, steps });
});

// Execute steps
app.post("/run", async (req, res) => {
  try {
    const steps = req.body?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.json({ ok: false, error: "No steps provided." });
    }
    const results = [];
    for (const step of steps) {
      if (step.action === "screenshot_url") {
        if (!step.url) throw new Error("screenshot_url requires 'url'.");
        const publicPath = await takeScreenshot(step.url);
        results.push({ action: "screenshot_url", path: publicPath });
      } else if (step.action === "gmail_send_last") {
        const to = step.to || process.env.GMAIL_USER;
        if (!to) throw new Error("gmail_send_last requires 'to' or set GMAIL_USER.");
        await sendEmailWithLast(to);
        results.push({ action: "gmail_send_last", to });
      } else {
        throw new Error(`Unsupported action: ${step.action}`);
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error("Error in /run:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Friendly root fallback (serves UI even if index isn’t auto-resolved)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404 JSON for unknown API routes (keeps UI friendly)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

// Error logging
process.on("unhandledRejection", (r) => console.error("Unhandled rejection:", r));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e));

// Start
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














