// server.js (ESM)
// Express backend for Mediad AutoDirector

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

// Where screenshots are stored
const RUNS_DIR = path.join(__dirname, "runs");
fs.mkdirSync(RUNS_DIR, { recursive: true });

// Serve /runs as static so you can open images in the browser
app.use("/runs", express.static(RUNS_DIR, { maxAge: "1d" }));

// Keep track of the last artifact path for gmail_send_last
let lastArtifactPath = null;

// ---------- Utilities ----------
function newId(ext = ".png") {
  const stamp = Date.now();
  const rand = Math.random().toString(16).slice(2, 10);
  return `${stamp}-${rand}${ext}`;
}

function findFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s"')]+/i);
  return m ? m[0] : null;
}

// Create a single Chromium browser to reuse between runs.
// (Safer on memory than launching for each step.)
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

// Screenshot helper
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

  // Save for gmail_send_last
  lastArtifactPath = filePath;

  // Return a URL path that the client can open
  const publicPath = `/runs/${id}`;
  return publicPath;
}

// Email helper
async function sendEmailWithLast(to) {
  if (!lastArtifactPath || !fs.existsSync(lastArtifactPath)) {
    throw new Error("No image available to send — run screenshot_url first.");
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error("GMAIL_USER and/or GMAIL_APP_PASSWORD are not set in environment variables.");
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const filename = path.basename(lastArtifactPath);

  await transporter.sendMail({
    from: `"Mediad AutoDirector" <${user}>`,
    to,
    subject: "Your requested screenshot",
    text: `Please find the requested screenshot attached.\n\nDirect link (if accessible): ${process.env.BASE_URL ? process.env.BASE_URL + "/runs/" + filename : "(no BASE_URL set)"}\n`,
    attachments: [
      {
        filename,
        path: lastArtifactPath,
      },
    ],
  });
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: SERVICE_NAME, time: new Date().toISOString() });
});

/**
 * Very simple planner:
 * - If prompt contains a URL, we plan to screenshot it and email it to the detected address
 *   (or fall back to GMAIL_USER if no email was provided in the prompt).
 */
app.post("/plan", (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.json({ ok: false, error: "Missing 'prompt'." });

    const url = findFirstUrl(prompt);
    if (!url) {
      return res.json({ ok: false, error: "No URL detected in your prompt." });
    }

    // Try to spot an email address in the prompt
    const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const to = emailMatch ? emailMatch[0] : process.env.GMAIL_USER || "you@example.com";

    const plan = { kind: "screenshot", url, to };
    const steps = [
      { action: "screenshot_url", url },
      { action: "gmail_send_last", to },
    ];

    res.json({ ok: true, plan, steps });
  } catch (err) {
    console.error("Error in /plan:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * Execute steps:
 * Supported actions:
 * - screenshot_url { url }
 * - gmail_send_last { to }
 */
app.post("/run", async (req, res) => {
  try {
    const steps = req.body?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.json({ ok: false, error: "No steps provided" });
    }

    const results = [];
    for (const step of steps) {
      const action = step?.action;

      if (action === "screenshot_url") {
        if (!step.url) throw new Error("screenshot_url requires 'url'.");
        const publicPath = await takeScreenshot(step.url);
        results.push({ action, path: publicPath });

      } else if (action === "gmail_send_last") {
        const to = step?.to || process.env.GMAIL_USER;
        if (!to) throw new Error("gmail_send_last requires 'to' or GMAIL_USER env.");
        await sendEmailWithLast(to);
        results.push({ action, to });

      } else {
        throw new Error(`Unsupported action: ${action}`);
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error("Error in /run:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- Global error logging ----------
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














