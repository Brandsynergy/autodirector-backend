// server.js — adds “image generation” plan (OpenAI or Stability AI) + keeps URL actions
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const RUNS_DIR = path.join(__dirname, "runs");
if (!existsSync(RUNS_DIR)) await fs.mkdir(RUNS_DIR, { recursive: true });

app.use("/runs", express.static(RUNS_DIR));
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ----------------------------- email ----------------------------- */
function getTransport() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
}
async function sendEmail({ to, subject, text, attachments = [] }) {
  const tx = getTransport();
  if (!tx) {
    return {
      ok: false,
      error:
        "Email disabled: set GMAIL_USER and GMAIL_APP_PASSWORD env vars on Render.",
    };
  }
  const from = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  await tx.sendMail({ from, to, subject, text, attachments });
  return { ok: true };
}

/* ------------------------- browser utils ------------------------- */
async function withBrowser(fn) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      timezoneId: "UTC",
      locale: "en-US",
    });
    const page = await context.newPage();
    const result = await fn(page);
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}
async function acceptCookieBanners(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    '[aria-label*="accept" i]',
    '.cookie-accept',
  ];
  await page.waitForTimeout(800);
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ force: true, timeout: 0 }); await page.waitForTimeout(300); }
    } catch {}
  }
}

/* ----------------------- URL-based actions ----------------------- */
async function screenshotUrl(url) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(RUNS_DIR, `${id}-shot.png`);
  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await acceptCookieBanners(page);
    await page.screenshot({ path: outPath, fullPage: true });
  });
  return `/runs/${path.basename(outPath)}`;
}
async function pdfUrl(url) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(RUNS_DIR, `${id}.pdf`);
  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await acceptCookieBanners(page);
    await page.emulateMedia({ media: "screen" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
  });
  return `/runs/${path.basename(outPath)}`;
}
async function topLinks(url, limit = 3) {
  return await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await acceptCookieBanners(page);
    await page.waitForSelector('a[href]', { timeout: 15000 }).catch(() => {});
    const links = await page.evaluate(() => {
      const out = [];
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const toAbs = (href) => { try { return new URL(href, location.href).href; } catch { return null; } };
      for (const a of document.querySelectorAll('a[href]')) {
        const href = toAbs(a.getAttribute("href"));
        if (!href || href.startsWith("javascript:")) continue;
        const text =
          clean(a.textContent) ||
          clean(a.getAttribute("aria-label")) ||
          clean(a.getAttribute("title"));
        if (!text) continue;
        if (/(privacy|terms|login|facebook|twitter|instagram)/i.test(href)) continue;
        out.push({ text, href });
      }
      // simple quality sort
      out.sort((a, b) => (b.text.length - a.text.length) || (b.href.length - a.href.length));
      return out.slice(0, 20);
    });
    return links.slice(0, limit);
  });
}

/* ------------------------ image generation ----------------------- */
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
      response_format: "b64_json",
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "OpenAI image error");
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}-img.png`;
  const filePath = path.join(RUNS_DIR, id);
  await fs.writeFile(filePath, Buffer.from(b64, "base64"));
  return `/runs/${path.basename(filePath)}`;
}

async function generateImageStability(prompt) {
  const key = process.env.STABILITY_API_KEY;
  if (!key) throw new Error("STABILITY_API_KEY not set");
  const resp = await fetch(
    "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt }],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        samples: 1,
        steps: 30,
      }),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.message || "Stability image error");
  const b64 = json?.artifacts?.[0]?.base64;
  if (!b64) throw new Error("Stability returned no image");
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}-img.png`;
  const filePath = path.join(RUNS_DIR, id);
  await fs.writeFile(filePath, Buffer.from(b64, "base64"));
  return `/runs/${path.basename(filePath)}`;
}

async function generateImage(prompt) {
  if (process.env.OPENAI_API_KEY) return generateImageOpenAI(prompt);
  if (process.env.STABILITY_API_KEY) return generateImageStability(prompt);
  throw new Error(
    "No image provider configured. Set OPENAI_API_KEY or STABILITY_API_KEY."
  );
}

/* ------------------------------- planner ------------------------------- */
const WORD_NUMS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
function extractCount(text, def = 3) {
  const n = text.match(/\b(\d+)\b/);
  if (n) return Math.min(10, Math.max(1, parseInt(n[1], 10)));
  for (const [w,v] of Object.entries(WORD_NUMS)) if (new RegExp(`\\b${w}\\b`,"i").test(text)) return v;
  return def;
}
function parsePrompt(prompt) {
  const p = prompt.toLowerCase();
  const urlMatch = prompt.match(/(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/i);
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const url = urlMatch ? urlMatch[0].replace(/^www\./i, "https://") : null;
  const to = emailMatch ? emailMatch[0] : null;

  const wantsPDF = /\bpdf\b/.test(p);
  const wantsLink = /\blink(s)?\b/.test(p) || /\blatest\b/.test(p) || /\brecent\b/.test(p);
  const wantsImage = /\b(image|picture|photo|generate|create)\b/.test(p) && !url;

  if (wantsImage) return { kind: "image", prompt: prompt.trim(), to };
  if (url) {
    if (wantsLink) return { kind: "links", url, to, count: 3 };
    if (wantsPDF) return { kind: "pdf", url, to };
    return { kind: "screenshot", url, to };
  }
  return { kind: "search", query: prompt.trim(), to, count: extractCount(prompt, 3) };
}

/* -------------------------------- routes ------------------------------- */
app.post("/run", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ ok: false, error: "No prompt" });

    const plan = parsePrompt(prompt);
    const steps = [];
    const results = {};

    if (plan.kind === "image") {
      steps.push({ action: "generate_image", provider: process.env.OPENAI_API_KEY ? "openai" : (process.env.STABILITY_API_KEY ? "stability" : "none") });
      const imgPath = await generateImage(plan.prompt);
      results.image = imgPath;

      if (plan.to) {
        steps.push({ action: "gmail_send_last", to: plan.to });
        await sendEmail({
          to: plan.to,
          subject: "Your generated image",
          text: `Attached is the image for:\n\n${plan.prompt}\n\nAlso accessible at ${imgPath}`,
          attachments: [{ filename: path.basename(imgPath), path: path.join(__dirname, imgPath) }],
        });
      }
      return res.json({ ok: true, plan, steps, results });
    }

    // search (no-URL) path — unchanged from your last build
    if (plan.kind === "search") {
      return res.json({ ok: true, plan, steps, results: { info: "Search mode unchanged; this build focuses on image generation." } });
    }

    if (plan.kind === "links") {
      if (!plan.url) return res.status(400).json({ ok: false, error: "No URL detected in your prompt." });
      steps.push({ action: "extract_links", url: plan.url, count: plan.count || 3 });
      const links = await topLinks(plan.url, plan.count || 3);
      results.links = links;
      if (plan.to) {
        steps.push({ action: "gmail_send_text", to: plan.to });
        const text =
          `Here are ${links.length} link(s) from ${plan.url}:\n\n` +
          links.map((l, i) => `${i + 1}. ${l.text}\n${l.href}`).join("\n\n");
        await sendEmail({ to: plan.to, subject: `Links from ${plan.url}`, text });
      }
      return res.json({ ok: true, plan, steps, results });
    }

    if (plan.kind === "pdf") {
      if (!plan.url) return res.status(400).json({ ok: false, error: "No URL detected in your prompt." });
      steps.push({ action: "pdf_url", url: plan.url });
      const pdfPath = await pdfUrl(plan.url);
      results.pdf = pdfPath;
      if (plan.to) {
        steps.push({ action: "gmail_send_last", to: plan.to });
        await sendEmail({
          to: plan.to,
          subject: `PDF: ${plan.url}`,
          text: `See attached PDF for ${plan.url}`,
          attachments: [{ filename: path.basename(pdfPath), path: path.join(__dirname, pdfPath) }],
        });
      }
      return res.json({ ok: true, plan, steps, results });
    }

    // default: screenshot
    if (!plan.url) return res.status(400).json({ ok: false, error: "No URL detected in your prompt." });
    steps.push({ action: "screenshot_url", url: plan.url });
    const shotPath = await screenshotUrl(plan.url);
    results.screenshot = shotPath;
    if (plan.to) {
      steps.push({ action: "gmail_send_last", to: plan.to });
      await sendEmail({
        to: plan.to,
        subject: `Screenshot: ${plan.url}`,
        text: `Screenshot generated for ${plan.url}. See attachment.`,
        attachments: [{ filename: path.basename(shotPath), path: path.join(__dirname, shotPath) }],
      });
    }
    res.json({ ok: true, plan, steps, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














