// server.js
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

/* ------------------------ email helpers ------------------------ */

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

/* ------------------------ browser helpers ---------------------- */

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
  const candidates = [
    '#onetrust-accept-btn-handler',
    '#onetrust-accept-btn',
    'button[aria-label*="accept" i]',
    'button[aria-label*="agree" i]',
    'button[aria-label*="consent" i]',
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    'button:has-text("Agree & Continue")',
    'button:has-text("Consent")',
    'button:has-text("Allow all")',
    'button:has-text("OK")',
    '[data-testid="accept-recommended-btn"]',
    '.accept-cookies, .cookie-accept, .ot-sdk-button',
  ];
  try {
    await page.waitForTimeout(1200);
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ force: true, timeout: 0 });
        await page.waitForTimeout(500);
      }
    }
  } catch {}
}

async function autoScroll(page, steps = 4) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
    await page.waitForTimeout(500);
  }
}

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
    await autoScroll(page, 5);

    const links = await page.evaluate(() => {
      const toAbs = (href) => {
        try { return new URL(href, location.href).href; } catch { return null; }
      };
      const bestText = (a) => {
        const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
        let t = clean(a.textContent);
        if (t.length < 10) {
          const cand = a.querySelector("h1,h2,h3,strong,em,span,p");
          if (cand) t = clean(cand.textContent);
        }
        if (t.length < 10) t = clean(a.getAttribute("aria-label"));
        if (t.length < 10) t = clean(a.getAttribute("title"));
        return t;
      };

      const raw = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = toAbs(a.getAttribute("href"));
        if (!href) continue;
        if (href.startsWith("javascript:")) continue;
        if (href === "#" || href.endsWith("#")) continue;

        const text = bestText(a);
        if (!text) continue;

        // filter obvious junk/social/footer/legal
        if (/(facebook|twitter|instagram|linkedin|pinterest|privacy|terms|subscribe|login)/i.test(href)) continue;

        raw.push({ text, href });
      }

      // normalize + dedupe
      const normalize = (u) => {
        try {
          const url = new URL(u);
          url.hash = "";
          url.search = "";
          return url.toString();
        } catch {
          return u;
        }
      };

      const seen = new Set();
      const unique = [];
      for (const r of raw) {
        const key = normalize(r.href);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(r);
      }

      // prefer longer text and deeper paths
      unique.sort((a, b) => (b.text.length - a.text.length) || (b.href.length - a.href.length));
      return unique;
    });

    const picked = links.slice(0, limit);
    if (picked.length > 0) return picked;

    // graceful fallback instead of []
    return [{ text: url, href: url }];
  });
}

/* ----------------------------- planner ----------------------------- */

function parsePrompt(prompt) {
  const p = prompt.toLowerCase();
  const urlMatch = prompt.match(/(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/i);
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  const url = urlMatch ? urlMatch[0].replace(/^www\./i, "https://") : null;
  const to = emailMatch ? emailMatch[0] : null;

  const wantsPDF = /\bpdf\b/.test(p) || /\bsave as pdf\b/.test(p);
  const wantsLink = /\blink(s)?\b/.test(p) || /\blatest\b/.test(p) || /\brecent\b/.test(p);

  if (wantsLink) return { kind: "links", url, to, count: 3 };
  if (wantsPDF) return { kind: "pdf", url, to };
  return { kind: "screenshot", url, to };
}

/* ------------------------------ routes ----------------------------- */

app.post("/run", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ ok: false, error: "No prompt" });

    const plan = parsePrompt(prompt);
    const steps = [];
    const results = {};

    if (!plan.url) return res.status(400).json({ ok: false, error: "No URL detected in your prompt." });

    if (plan.kind === "links") {
      steps.push({ action: "extract_links", url: plan.url, count: plan.count });
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
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














