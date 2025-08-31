/**
 * Mediad AutoDirector — server.js (ESM, robust)
 *
 * Env vars:
 *  - OPENAI_API_KEY
 *  - GMAIL_USER
 *  - GMAIL_APP_PASSWORD
 */

import express from "express";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

// -------------------- setup --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// simple CORS (so any UI shape will work)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/public", express.static(PUBLIC_DIR));
app.use("/runs", express.static(RUNS_DIR));

// -------------------- helpers --------------------
function emailFromText(text) {
  const m = String(text || "").match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0] : null;
}
function urlFromText(text) {
  const m = String(text || "").match(/https?:\/\/[^\s)]+/i);
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
  if (!files.length) return null;
  const stats = await Promise.all(files.map(async f => ({ f, t: (await fsp.stat(f)).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return stats[0].f;
}
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

// email
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
  const tx = buildTransport();
  if (!tx) throw new Error("Email not configured (GMAIL_USER, GMAIL_APP_PASSWORD).");
  await tx.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject: subject || "Mediad AutoDirector",
    text: text || "",
    attachments: attachments || [],
  });
}

// screenshot
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

// extract links
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

// OpenAI image generation (NO response_format)
async function generateImageOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set.");

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

// planner
function plan(prompt) {
  const to = emailFromText(prompt);
  const url = urlFromText(prompt);

  if (needsImage(prompt)) {
    const imagePrompt = prompt.trim();
    const steps = [{ action: "generate_image", prompt: imagePrompt }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "image", prompt: imagePrompt, to }, steps };
  }

  if (needsScreenshot(prompt) && url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }

  if (needsLinks(prompt) && url) {
    const countMatch = prompt.match(/\b(\d{1,2})\b/);
    const count = countMatch ? Math.max(1, Math.min(20, parseInt(countMatch[1], 10))) : 5;
    const steps = [{ action: "extract_links", url, count }];
    if (to) steps.push({ action: "gmail_send_text", to });
    return { ok: true, plan: { kind: "links", url, to, count }, steps };
  }

  if (url) {
    const steps = [{ action: "screenshot_url", url }];
    if (to) steps.push({ action: "gmail_send_last", to });
    return { ok: true, plan: { kind: "screenshot", url, to }, steps };
  }

  return { ok: false, error: "No URL or image instruction detected in prompt." };
}

// -------------------- routes --------------------
app.get("/health", (_req, res) => res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() }));

app.get("/", (_req, res) => {
  try { res.sendFile(path.join(PUBLIC_DIR, "index.html")); }
  catch { res.type("text").send("Mediad AutoDirector backend"); }
});

// /plan tolerant to q|prompt (body or query). Supports POST and GET.
function getPromptFrom(req) {
  return (req.body?.prompt ?? req.body?.q ?? req.query?.prompt ?? req.query?.q ?? "").toString();
}
app.post("/plan", (req, res) => {
  const prompt = getPromptFrom(req);
  log("PLAN prompt:", prompt.slice(0, 120));
  if (!prompt) return res.json({ ok: false, error: "Missing prompt" });
  const p = plan(prompt);
  return res.json(p);
});
app.get("/plan", (req, res) => {
  const prompt = getPromptFrom(req);
  log("PLAN (GET) prompt:", prompt.slice(0, 120));
  if (!prompt) return res.json({ ok: false, error: "Missing prompt" });
  const p = plan(prompt);
  return res.json(p);
});

// /run accepts steps OR {plan:{steps}} OR just a prompt (it will plan+run)
function extractSteps(req) {
  if (Array.isArray(req.body?.steps)) return req.body.steps;
  if (Array.isArray(req.body?.plan?.steps)) return req.body.plan.steps;
  if (typeof req.query?.steps === "string") {
    try { const parsed = JSON.parse(req.query.steps); if (Array.isArray(parsed)) return parsed; } catch {}
  }
  return null;
}

app.post("/run", async (req, res) => {
  try {
    let steps = extractSteps(req);

    // If no steps but prompt present, do plan+run
    if (!steps) {
      const prompt = getPromptFrom(req);
      if (prompt) {
        const p = plan(prompt);
        if (!p.ok) return res.json(p);
        steps = p.steps;
      }
    }

    if (!steps || !steps.length) {
      return res.json({ ok: false, error: "No steps provided" });
    }

    const results = [];
    for (const step of steps) {
      log("RUN step:", step.action);
      switch (step.action) {
        case "screenshot_url": {
          const rel = await screenshotURL(step.url);
          results.push({ action: step.action, path: rel });
          break;
        }
        case "generate_image": {
          const rel = await generateImageOpenAI(step.prompt);
          results.push({ action:
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














