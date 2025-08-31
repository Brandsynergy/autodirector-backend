/**
 * Mediad AutoDirector — server.js (final hardening)
 * - Accepts prompt as body {prompt} or {q}, or query ?prompt=/ ?q=
 * - /run accepts {steps}, {plan:{steps}}, or just {prompt} and will plan+run.
 * - Survives missing Content-Type by capturing rawBody and trying to parse JSON.
 * - Includes image generation (no response_format), screenshots, link extraction, and Gmail send.
 */

import express from "express";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

// ------------ paths ------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// ------------ app ------------
const app = express();

// Capture raw body for cases where Content-Type isn't set
app.use((req, _res, next) => {
  req.rawBody = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { req.rawBody += chunk; });
  next();
});

// Parse JSON when header is correct
app.use(express.json({ limit: "2mb", type: ["application/json", "application/*+json"] }));
// Also parse x-www-form-urlencoded (some UIs send this)
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// CORS to be safe for any UI
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/public", express.static(PUBLIC_DIR));
app.use("/runs", express.static(RUNS_DIR));

// ------------ utils ------------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fileId = (ext = "png") => `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
const emailFromText = t => (String(t || "").match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/) || [null])[0];
const urlFromText = t => (String(t || "").match(/https?:\/\/[^\s)]+/i) || [null])[0];
const needsScreenshot = t => /\bscreenshot\b/i.test(t);
const needsLinks = t => /\b(get|latest)\b.*\blinks?\b/i.test(t) || /\bextract links?\b/i.test(t);
const needsImage = t => /\b(create|generate|make)\b.*\b(image|picture|photo|art)\b/i.test(t);

async function newestFileIn(dir) {
  const names = await fsp.readdir(dir);
  if (!names.length) return null;
  const stats = await Promise.all(names.map(async n => ({ n, t: (await fsp.stat(path.join(dir, n))).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return path.join(dir, stats[0].n);
}

// email (Gmail app password)
function smtp() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }
  });
}
async function sendEmail({ to, subject, text, attachments }) {
  const tx = smtp();
  if (!tx) throw new Error("Email not configured (GMAIL_USER, GMAIL_APP_PASSWORD).");
  await tx.sendMail({ from: process.env.GMAIL_USER, to, subject, text, attachments });
}

// screenshot
async function screenshotURL(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const name = fileId("png");
    const p = path.join(RUNS_DIR, name);
    await page.screenshot({ path: p, fullPage: true });
    return `/runs/${name}`;
  } finally { await browser.close(); }
}

// extract links
async function extractLinks(url, count = 5) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const links = await page.$$eval("a", as =>
      as.map(a => ({ title: (a.textContent || "").trim(), href: a.href }))
        .filter(x => x.href && x.title));
    return links.slice(0, Math.max(1, Math.min(20, count)));
  } finally { await browser.close(); }
}

// OpenAI image generation (no response_format)
async function generateImage(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set.");

  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024" })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "OpenAI image error");
  const d = j?.data?.[0];
  if (!d) throw new Error("OpenAI returned no image");

  const name = fileId("png");
  const p = path.join(RUNS_DIR, name);

  if (d.b64_json) await fsp.writeFile(p, Buffer.from(d.b64_json, "base64"));
  else if (d.url) {
    const ir = await fetch(d.url);
    await fsp.writeFile(p, Buffer.from(await ir.arrayBuffer()));
  } else throw new Error("OpenAI returned no usable image");

  return `/runs/${name}`;
}

// planner
function planFromPrompt(prompt) {
  const to = emailFromText(prompt);
  const url = urlFromText(prompt);

  if (needsImage(prompt)) {
    const steps = [{ action: "generate_image", prompt }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "image", to }, steps };
  }
  if (needsScreenshot(prompt) && url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }
  if (needsLinks(prompt) && url) {
    const m = prompt.match(/\b(\d{1,2})\b/);
    const count = m ? Math.max(1, Math.min(20, parseInt(m[1], 10))) : 5;
    const steps = [{ action: "extract_links", url, count }];
    if (to) steps.push({ action: "gmail_send_text", to });
    return { ok: true, plan: { kind: "links", url, to, count }, steps };
  }
  if (url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }
  return { ok: false, error: "Couldn’t detect a URL or an image/link task in the prompt." };
}

// helpers to read prompt/steps no matter how they’re sent
function getPrompt(req) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const q = req.query || {};
  let p = b.prompt ?? b.q ?? q.prompt ?? q.q ?? "";
  if (!p && typeof req.rawBody === "string" && req.rawBody.trim()) {
    try { const parsed = JSON.parse(req.rawBody); p = parsed.prompt ?? parsed.q ?? ""; } catch {}
  }
  return String(p || "");
}

function getSteps(req) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (Array.isArray(b.steps)) return b.steps;
  if (Array.isArray(b?.plan?.steps)) return b.plan.steps;

  // From query (?steps=[...])
  if (typeof req.query?.steps === "string") {
    try { const x = JSON.parse(req.query.steps); if (Array.isArray(x)) return x; } catch {}
  }

  // From rawBody
  if (typeof req.rawBody === "string" && req.rawBody.trim()) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (Array.isArray(parsed?.steps)) return parsed.steps;
      if (Array.isArray(parsed?.plan?.steps)) return parsed.plan.steps;
    } catch {}
  }
  return null;
}

// ------------ routes ------------
app.get("/health", (_req, res) => res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() }));

app.get("/", (_req, res) => {
  const index = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.type("text").send("Mediad AutoDirector backend");
});

app.post("/plan", (req, res) => {
  const prompt = getPrompt(req);
  if (!prompt) return res.json({ ok: false, error: "Missing prompt." });
  return res.json(planFromPrompt(prompt));
});

app.get("/plan", (req, res) => {
  const prompt = getPrompt(req);
  if (!prompt) return res.json({ ok: false, error: "Missing prompt." });
  return res.json(planFromPrompt(prompt));
});

app.post("/run", async (req, res) => {
  try {
    let steps = getSteps(req);

    // If the UI sends just a prompt, plan+run automatically
    if (!steps) {
      const prompt = getPrompt(req);
      if (prompt) {
        const p = planFromPrompt(prompt);
        if (!p.ok) return res.json(p);
        steps = p.steps;
      }
    }

    if (!steps || !steps.length) {
      return res.json({ ok: false, error: "No steps provided" });
    }

    const results = [];
    for (const step of steps) {
      switch (step.action) {
        case "screenshot_url": {
          const rel = await screenshotURL(step.url);
          results.push({ action: step.action, path: rel });
          break;
        }
        case "generate_image": {
          const rel = await generateImage(step.prompt);
          results.push({ action: step.action, path: rel });
          break;
        }
        case "extract_links": {
          const links = await extractLinks(step.url, step.count || 5);
          results.push({ action: step.action, links });
          break;
        }
        case "gmail_send_last": {
          const file = await newestFileIn(RUNS_DIR);
          if (!file) throw new Error("Nothing to send yet.");
          await sendEmail({
            to: step.to,
            subject: "Mediad AutoDirector – file",
            text: "Attached is the latest file.",
            attachments: [{ filename: path.basename(file), path: file }],
          });
          results.push({ action: step.action, to: step.to });
          break;
        }
        case "gmail_send_text": {
          const linkStep = results.find(r => r.links);
          const text = linkStep
            ? linkStep.links.map((l, i) => `${i + 1}. ${l.title}\n${l.href}`).join("\n\n")
            : (step.text || "No content.");
          await sendEmail({ to: step.to, subject: "Mediad AutoDirector – links", text });
          results.push({ action: step.action, to: step.to });
          break;
        }
        default:
          throw new Error(`Unknown action: ${step.action}`);
      }
    }
    return res.json({ ok: true, results });
  } catch (e) {
    log("RUN error:", e?.message || e);
    return res.json({ ok: false, error: e?.message || String(e) });
  }
});

// ------------ start ------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Mediad backend listening on ${PORT}`));
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














