/**
 * Mediad AutoDirector – server.js (full replacement)
 *
 * What’s fixed/changed:
 * - NO usage of `response_format` with OpenAI (prevents "Unknown parameter: 'response_format'" errors)
 * - Robust image generation: supports either `b64_json` or hosted `url` responses, always saves a PNG in /runs
 * - Simple planner for common actions: screenshot a URL, generate an image from a prompt, extract links, email results
 * - Health endpoint and static serving of /public and /runs
 *
 * Required env vars:
 *  - OPENAI_API_KEY
 *  - GMAIL_USER (the Gmail address you’re sending from)
 *  - GMAIL_APP_PASSWORD (the 16-character App Password)
 *
 * Base image: mcr.microsoft.com/playwright:v1.55.0-jammy
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

// --- paths
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, "runs");

// --- ensure runs dir exists
if (!fs.existsSync(RUNS_DIR)) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// static
app.use("/public", express.static(PUBLIC_DIR));
app.use("/runs", express.static(RUNS_DIR));

// --- health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// --- basic index
app.get("/", async (_req, res) => {
  try {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  } catch {
    res.type("text").send("Mediad AutoDirector backend");
  }
});

// ---- helpers ---------------------------------------------------------------

function emailFromText(text) {
  const m = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0] : null;
}

function urlFromText(text) {
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function needsScreenshot(text) {
  return /\bscreenshot\b/i.test(text);
}

function needsLinks(text) {
  return /\b(get|latest)\b.*\blinks?\b/i.test(text) || /\bextract links?\b/i.test(text);
}

function needsImage(text) {
  return /\b(create|generate|make)\b.*\b(image|picture|photo|art)\b/i.test(text);
}

function fileId(ext = "png") {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
}

async function newestFileIn(dir) {
  const files = (await fsp.readdir(dir)).map(f => path.join(dir, f));
  if (files.length === 0) return null;
  const stats = await Promise.all(files.map(async f => ({ f, t: (await fsp.stat(f)).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return stats[0].f;
}

// -- email (SMTP via Gmail App Password)
function buildTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

async function sendEmail({ to, subject, text, attachments }) {
  const transporter = buildTransport();
  if (!transporter) throw new Error("Email not configured: set GMAIL_USER and GMAIL_APP_PASSWORD");

  const from = process.env.GMAIL_USER;
  await transporter.sendMail({
    from,
    to,
    subject: subject || "Mediad AutoDirector",
    text: text || "",
    attachments: attachments || [],
  });
}

// -- screenshot via Playwright
async function screenshotURL(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const filename = fileId("png");
    const filePath = path.join(RUNS_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    return `/runs/${filename}`;
  } finally {
    await browser.close();
  }
}

// -- extract top links (title + href) using Playwright
async function extractLinks(url, count = 5) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);

    const links = await page.$$eval("a", as =>
      as
        .map(a => ({ title: (a.textContent || "").trim(), href: a.href }))
        .filter(x => x.href && x.title)
        .slice(0, 100)
    );
    return links.slice(0, count);
  } finally {
    await browser.close();
  }
}

// -- OpenAI Image Generation (NO response_format)
async function generateImageOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
      // NOTE: NO response_format here (fixes the error you saw)
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.error?.message || "OpenAI image error");
  }

  const d = json?.data?.[0];
  if (!d) throw new Error("OpenAI returned no image");

  const filename = fileId("png");
  const filePath = path.join(RUNS_DIR, filename);

  if (d.b64_json) {
    await fsp.writeFile(filePath, Buffer.from(d.b64_json, "base64"));
  } else if (d.url) {
    const imgResp = await fetch(d.url);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    await fsp.writeFile(filePath, buf);
  } else {
    throw new Error("OpenAI returned no usable image");
  }

  return `/runs/${filename}`;
}

// ---- planner ---------------------------------------------------------------

/**
 * Very simple planner:
 * - "screenshot <url> ... email to <address>"
 * - "create/generate image ... send to <address>"
 * - "get/extract links <url> ... email to <address>"
 */
function plan(prompt) {
  const to = emailFromText(prompt);
  const url = urlFromText(prompt);

  // generate image
  if (needsImage(prompt)) {
    const imagePrompt = prompt.trim();
    const steps = [{ action: "generate_image", prompt: imagePrompt }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "image", prompt: imagePrompt, to }, steps };
  }

  // screenshot
  if (needsScreenshot(prompt) && url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }

  // extract links
  if (needsLinks(prompt) && url) {
    const countMatch = prompt.match(/\b(\d{1,2})\b/);
    const count = countMatch ? Math.max(1, Math.min(20, parseInt(countMatch[1], 10))) : 5;
    const steps = [
      { action: "extract_links", url, count },
    ];
    if (to) steps.push({ action: "gmail_send_text", to });
    return { ok: true, plan: { kind: "links", url, to, count }, steps };
  }

  // fallback: if a URL exists, allow screenshot + optional email
  if (url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }

  return { ok: false, error: "I could not detect a supported action. Include a URL for screenshots/links, or a prompt to create an image, and (optionally) an email address." };
}

// ---- API endpoints ---------------------------------------------------------

app.post("/plan", (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.json({ ok: false, error: "Missing prompt" });
    return res.json(plan(prompt));
  } catch (err) {
    return res.json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/run", async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  if (!steps.length) return res.json({ ok: false, error: "No steps provided" });

  const results = [];
  try {
    for (const step of steps) {
      switch (step.action) {
        case "screenshot_url": {
          if (!step.url) throw new Error("screenshot_url requires 'url'");
          const rel = await screenshotURL(step.url);
          results.push({ action: step.action, path: rel });
          break;
        }
        case "generate_image": {
          if (!step.prompt) throw new Error("generate_image requires 'prompt'");
          const rel = await generateImageOpenAI(step.prompt);
          results.push({ action: step.action, path: rel });
          break;
        }
        case "extract_links": {
          if (!step.url) throw new Error("extract_links requires 'url'");
          const links = await extractLinks(step.url, step.count || 5);
          results.push({ action: step.action, links });
          break;
        }
        case "gmail_send_last": {
          if (!step.to) throw new Error("gmail_send_last requires 'to'");
          const newest = await newestFileIn(RUNS_DIR);
          if (!newest) throw new Error("Nothing to send (no files in /runs yet)");
          await sendEmail({
            to: step.to,
            subject: "Mediad AutoDirector – file",
            text: "Attached is the latest file.",
            attachments: [{ filename: path.basename(newest), path: newest }],
          });
          results.push({ action: step.action, to: step.to });
          break;
        }
        case "gmail_send_text": {
          if (!step.to) throw new Error("gmail_send_text requires 'to'");
          // Find links from a previous step result (if any)
          const linkStep = results.find(r => r.links);
          const body = linkStep
            ? linkStep.links.map((l, i) => `${i + 1}. ${l.title}\n${l.href}`).join("\n\n")
            : (step.text || "No content.");
          await sendEmail({
            to: step.to,
            subject: "Mediad AutoDirector – links",
            text: body,
          });
          results.push({ action: step.action, to: step.to });
          break;
        }
        default:
          throw new Error(`Unknown action: ${step.action}`);
      }
    }

    return res.json({ ok: true, results });
  } catch (err) {
    return res.json({ ok: false, error: err.message || String(err), results });
  }
});

// --- start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














