// server.js
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || ""; // optional, will infer if empty
const RUNS_DIR = path.resolve("runs");

// --- helpers ---------------------------------------------------------------

async function ensureRunsDir() {
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  // sanity check write access
  const test = path.join(RUNS_DIR, ".ok");
  await fsp.writeFile(test, "ok");
  await fsp.unlink(test);
}

function inferBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

const emailRegex =
  /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const urlRegex =
  /(https?:\/\/[^\s"']+)/i;

function planFromPrompt(prompt) {
  const steps = [];
  const urlMatch = prompt.match(urlRegex);
  const emailMatch = prompt.match(emailRegex);

  // screenshot intent
  if (/screenshot|capture|snap|shot/i.test(prompt) && urlMatch) {
    steps.push({ action: "screenshot_url", url: urlMatch[1] });
  }

  // pdf intent (optional)
  if (/pdf/i.test(prompt) && urlMatch) {
    steps.push({ action: "pdf_url", url: urlMatch[1] });
  }

  // email intent
  if (/(email|mail|send)\s+.*\s+to/i.test(prompt) && emailMatch) {
    steps.push({ action: "email_last", to: emailMatch[1] });
  }

  // default – if only a URL was given with the word email
  if (steps.length === 0 && urlMatch) {
    steps.push({ action: "screenshot_url", url: urlMatch[1] });
    if (emailMatch) steps.push({ action: "email_last", to: emailMatch[1] });
  }

  if (steps.length === 0) {
    // fallback
    steps.push({ action: "help" });
  }

  return { steps };
}

function mailer() {
  // Expect these on Render:
  // SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, FROM_EMAIL
  if (!process.env.SMTP_HOST) {
    return null; // will no-op and log
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// --- middleware ------------------------------------------------------------

app.use(express.json({ limit: "1mb" }));

// serve static UI (if you have one)
app.use(express.static(path.resolve("public")));

// serve the /runs directory as raw files (the important bit)
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    fallthrough: false,
    maxAge: "1h",
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    },
  })
);

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- planner ---------------------------------------------------------------

app.post("/plan", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const plan = planFromPrompt(prompt);
    res.json(plan);
  } catch (e) {
    console.error("plan error", e);
    res.status(400).json({ error: "Bad prompt" });
  }
});

// --- runner ----------------------------------------------------------------

app.post("/run", async (req, res) => {
  const start = Date.now();
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    if (!steps.length) return res.status(400).send("No steps");

    await ensureRunsDir();
    const baseUrl = inferBaseUrl(req);
    const lines = [];
    let lastFilePath = null;
    let lastFileName = null;

    // one Chromium for the whole run
    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const step of steps) {
      if (step.action === "screenshot_url") {
        const url = step.url;
        const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-shot.png`;
        const abs = path.join(RUNS_DIR, id);
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        await page.screenshot({ path: abs, fullPage: true });
        lastFilePath = abs;
        lastFileName = id;
        lines.push(`done: ${baseUrl}/runs/${id}`);
      } else if (step.action === "pdf_url") {
        // optional: simple PDF capture (Chromium only)
        const url = step.url;
        const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.pdf`;
        const abs = path.join(RUNS_DIR, id);
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        // emulate print to pdf
        await page.pdf({ path: abs, format: "A4", printBackground: true });
        lastFilePath = abs;
        lastFileName = id;
        lines.push(`done: ${baseUrl}/runs/${id}`);
      } else if (step.action === "email_last") {
        if (!lastFilePath || !lastFileName) {
          lines.push("skip: nothing to email yet");
          continue;
        }
        const to = step.to;
        const tx = mailer();
        const from = process.env.FROM_EMAIL || process.env.SMTP_USER || "no-reply@example.com";
        if (!tx) {
          console.warn("SMTP not configured – would have emailed:", to);
          lines.push(`warn: SMTP not configured (set SMTP_* env). Would have emailed ${to}`);
        } else {
          await tx.sendMail({
            from,
            to,
            subject: `Mediad AutoDirector result: ${lastFileName}`,
            text: `Your file is attached.\n\nLink: ${baseUrl}/runs/${lastFileName}`,
            html: `<p>Your file is attached.</p><p>Link: <a href="${baseUrl}/runs/${lastFileName}">${baseUrl}/runs/${lastFileName}</a></p>`,
            attachments: [{ path: lastFilePath, filename: lastFileName }],
          });
          lines.push(`emailed: ${to}`);
        }
      } else if (step.action === "help") {
        lines.push(
          `hint: try "Screenshot https://example.com and email it to you@example.com"`
        );
      } else {
        lines.push(`skip: unknown action "${step.action}"`);
      }
    }

    await browser.close();

    const ms = Date.now() - start;
    res.type("text/plain").send(["planning…", "running…", ...lines, `time: ${ms}ms`].join("\n"));
  } catch (e) {
    console.error("run error", e);
    res.status(500).type("text/plain").send("error: " + (e?.message || "Unknown"));
  }
});

// fallback 404
app.use((req, res) => res.status(404).type("text/plain").send("Not found"));

// start
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














