// server.js
// Mediad AutoDirector – tiny backend with /plan and /run endpoints

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import { chromium } from "playwright"; // requires "playwright" in package.json

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// Middleware & static
app.use(express.json({ limit: "1mb" }));
app.use("/runs", express.static(path.join(__dirname, "runs")));   // expose results
app.use("/", express.static(path.join(__dirname, "public")));     // serve index.html

// ensure runs folder exists
fs.mkdirSync(path.join(__dirname, "runs"), { recursive: true });

// ───────────────────────────────────────────────────────────────────────────────
// Helpers

function isURL(str) {
  try { new URL(str); return true; } catch { return false; }
}

function parsePrompt(prompt) {
  const p = prompt.trim();

  // 1) Screenshot …
  const mShot = p.match(/screenshot\s+(https?:\/\/\S+)/i);
  if (mShot) {
    const url = mShot[1];
    const to = (p.match(/\bto\s+([^\s,;]+@[^\s,;]+)/i) || [])[1] || null;
    return {
      steps: [{ action: "screenshot_url", url, to }],
      summary: `Take screenshot of ${url}${to ? " and email to " + to : ""}.`,
    };
  }

  // 2) Save as PDF …
  const mPdf = p.match(/save\s+(https?:\/\/\S+)\s+as\s+pdf/i);
  if (mPdf) {
    const url = mPdf[1];
    const to = (p.match(/\bto\s+([^\s,;]+@[^\s,;]+)/i) || [])[1] || null;
    return {
      steps: [{ action: "pdf_url", url, to }],
      summary: `Save ${url} as PDF${to ? " and email to " + to : ""}.`,
    };
  }

  // 3) Forward last X emails …
  const mFwd = p.match(/forward my last\s+(\d+)\s+emails\s+to\s+([^\s,;]+@[^\s,;]+)/i);
  if (mFwd) {
    return {
      steps: [{ action: "gmail_forward_last", count: parseInt(mFwd[1], 10), to: mFwd[2] }],
      summary: `Forward last ${mFwd[1]} emails to ${mFwd[2]}.`,
    };
  }

  // Fallback – not recognized
  return {
    steps: [{ action: "noop", note: "Could not understand prompt. Try: 'Screenshot https://example.com and email to …'" }],
    summary: "Unrecognized prompt",
  };
}

function runId(ext = "") {
  const id = crypto.randomUUID();
  return ext ? `${id}.${ext.replace(/^\./, "")}` : id;
}

// ───────────────────────────────────────────────────────────────────────────────
// Routes

app.get("/health", (_req, res) => res.json({ ok: true }));

// PLAN – returns a JSON plan derived from the natural-language prompt
app.post("/plan", (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing 'prompt' string in body." });
  }
  const plan = parsePrompt(prompt);
  return res.json(plan);
});

// RUN – executes a minimal subset (screenshot/pdf). Email forwarding is stubbed.
app.post("/run", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing 'prompt' string in body." });
  }

  const plan = parsePrompt(prompt);
  const log = [];
  const result = { plan, log };

  try {
    if (!plan.steps?.length) {
      result.message = "Nothing to do.";
      return res.json(result);
    }

    const step = plan.steps[0];

    if (step.action === "screenshot_url") {
      if (!isURL(step.url)) throw new Error("Invalid URL for screenshot.");
      log.push(`goto ${step.url}`);

      const browser = await chromium.launch({ args: ["--no-sandbox"], headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 60000 });

      const fname = runId("png");
      const filePath = path.join(__dirname, "runs", fname);
      await page.screenshot({ path: filePath, fullPage: true });
      await browser.close();

      result.screenshot_url = `runs/${fname}`;
      log.push(`done: ${result.screenshot_url}`);

      // Optional: email sending can be added here if SMTP envs are present.
      return res.json(result);
    }

    if (step.action === "pdf_url") {
      if (!isURL(step.url)) throw new Error("Invalid URL for PDF.");
      log.push(`goto ${step.url}`);

      const browser = await chromium.launch({ args: ["--no-sandbox"], headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(step.url, { waitUntil: "networkidle", timeout: 90000 });

      const fname = runId("pdf");
      const filePath = path.join(__dirname, "runs", fname);
      await page.pdf({ path: filePath, format: "A4", printBackground: true });
      await browser.close();

      result.pdf_url = `runs/${fname}`;
      log.push(`done: ${result.pdf_url}`);
      return res.json(result);
    }

    if (step.action === "gmail_forward_last") {
      // Stub for now – keeps UI responsive (no 404)
      result.message =
        "Email forwarding is not enabled in this minimal build. If you want it, I can add IMAP + Nodemailer with Gmail App Password.";
      log.push("gmail_forward_last: not configured");
      return res.json(result);
    }

    // Unknown action
    result.message = "No operation performed.";
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err), log });
  }
});

// Fallback 404 – keep JSON style for unknown API paths
app.use((req, res, next) => {
  if (req.path.startsWith("/plan") || req.path.startsWith("/run")) {
    return res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  }
  return next();
});

// Start server
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                        
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














