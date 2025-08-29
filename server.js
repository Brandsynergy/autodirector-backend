// server.js — Mediad AutoDirector (drop-in replacement)

import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Serve static UI and screenshots
app.use(express.static(path.join(__dirname, "public")));
app.use("/runs", express.static(path.join(__dirname, "runs")));

const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// --------- helpers

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL_RE =
  /(https?:\/\/[^\s"'<>]+)|(www\.[^\s"'<>]+)/i;

function extractUrl(text) {
  const m = text.match(URL_RE);
  if (!m) return null;
  const raw = m[0];
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function extractEmail(text) {
  const m = text.match(EMAIL_RE);
  return m ? m[0] : null;
}

function ok(res, data) {
  res.json({ ok: true, ...data });
}
function fail(res, message) {
  res.status(400).json({ ok: false, error: message });
}

// --------- planner

app.post("/plan", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    if (!prompt.trim()) return fail(res, "Empty prompt.");

    const url = extractUrl(prompt);
    const to = extractEmail(prompt);

    const steps = [];
    if (url) steps.push({ action: "screenshot_url", url });
    if (to) steps.push({ action: "gmail_send_last", to });

    if (!steps.length) {
      return fail(
        res,
        "I couldn’t find a URL or an email address in your request."
      );
    }

    ok(res, { steps });
  } catch (e) {
    fail(res, `Planner error: ${e.message}`);
  }
});

// --------- runner

app.post("/run", async (req, res) => {
  const steps = req.body?.steps;
  if (!Array.isArray(steps) || !steps.length) {
    return fail(res, "No steps provided to run.");
  }

  const ctx = { lastFile: null, lastPublicUrl: null, log: [] };

  try {
    for (const step of steps) {
      switch (step.action) {
        case "screenshot_url":
          await doScreenshot(step.url, ctx);
          ctx.log.push(`screenshot_url → ${ctx.lastPublicUrl}`);
          break;
        case "gmail_send_last":
          await doEmail(step.to, ctx);
          ctx.log.push(`gmail_send_last → ${step.to}`);
          break;
        default:
          throw new Error(`Unknown action: ${step.action}`);
      }
    }

    // IMPORTANT: keep backward compatibility for the UI
    ok(res, {
      message: ctx.lastPublicUrl
        ? `done: ${ctx.lastPublicUrl}`
        : "done",
      image_url: ctx.lastPublicUrl || null,   // <— UI expects this
      lastPublicUrl: ctx.lastPublicUrl,
      log: ctx.log,
    });
  } catch (e) {
    fail(res, `Run failed: ${e.message}`);
  }
});

// --------- actions

async function doScreenshot(targetUrl, ctx) {
  if (!targetUrl) throw new Error("Missing URL for screenshot.");

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const filePath = path.join(RUNS_DIR, `${id}-shot.png`);
  const publicUrl = `/runs/${id}-shot.png`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    await browser.close();
  }

  const stat = fs.statSync(filePath);
  if (!stat.size) throw new Error("Screenshot file is empty.");

  ctx.lastFile = filePath;
  ctx.lastPublicUrl = publicUrl;
}

async function doEmail(to, ctx) {
  if (!to) throw new Error("Missing recipient.");
  if (!ctx.lastFile || !fs.existsSync(ctx.lastFile)) {
    throw new Error("No screenshot available to email.");
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Email not configured (GMAIL_USER/GMAIL_APP_PASSWORD).");
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: user,
    to,
    subject: "Mediad AutoDirector – Screenshot",
    text: `Screenshot attached.\nLink: ${ctx.lastPublicUrl || "n/a"}`,
    attachments: [{ filename: path.basename(ctx.lastFile), path: ctx.lastFile }],
  });
}

// --------- health

app.get("/health", (_req, res) => res.type("text").send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














