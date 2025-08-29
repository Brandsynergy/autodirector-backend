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

// static files
const RUNS_DIR = path.join(__dirname, "runs");
if (!existsSync(RUNS_DIR)) {
  await fs.mkdir(RUNS_DIR, { recursive: true });
}
app.use("/runs", express.static(RUNS_DIR));
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ------------------------- email helpers ------------------------- */

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

/* ------------------------- browser helpers ------------------------- */

async function withBrowser(fn) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const result = await fn(page);
    await ctx.close();
    return result;
  } finally {
    await browser.close();
  }
}

async function screenshotUrl(url) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(RUNS_DIR, `${id}-shot.png`);
  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: outPath, fullPage: true });
  });
  return `/runs/${path.basename(outPath)}`;
}

async function pdfUrl(url) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(RUNS_DIR, `${id}.pdf`);
  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
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

/**
 * Extract top N links on a page (visible anchors).
 * Returns array like: [{text, href}, ...]
 */
async function topLinks(url, limit = 3) {
  return await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // collect anchors with visible text and absolute hrefs
    const links = await page.evaluate(() => {
      const toAbs = (href) => {
        try {
          return new URL(href, location.href).href;
        } catch {
          return null;
        }
      };
      const items = [];
      for (const a of [...document.querySelectorAll("a")]) {
        const text = (a.textContent || "").trim().replace(/\s+/g, " ");
        const href = toAbs(a.getAttribute("href") || "");
        if (!href || !text) continue;
        // ignore nav/footers heuristically
        if (text.length < 6) continue;
        items.push({ text, href });
      }
      return items.slice(0, 50); // raw top sample
    });
    // de-dupe by href and keep first N
    const seen = new Set();
    const unique = [];
    for (const l of links) {
      if (seen.has(l.href)) continue;
      seen.add(l.href);
      unique.push(l);
      if (unique.length >= limit) break;
    }
    return unique;
  });
}

/* --------------------------- planner ---------------------------- */

function parsePrompt(prompt) {
  const p = prompt.toLowerCase();

  // crude URL + email detection
  const urlMatch = prompt.match(
    /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/i
  );
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  const url = urlMatch ? urlMatch[0].replace(/^www\./i, "https://") : null;
  const to = emailMatch ? emailMatch[0] : null;

  const wantsPDF = /\bpdf\b/.test(p) || /\bsave as pdf\b/.test(p);
  const wantsLink =
    /\blink\b/.test(p) ||
    /\blinks\b/.test(p) ||
    /\blatest\b/.test(p) ||
    /\brecent\b/.test(p);

  // default to screenshot unless explicitly link/PDF
  if (wantsLink) {
    return { kind: "links", url, to, count: 3 };
  }
  if (wantsPDF) {
    return { kind: "pdf", url, to };
  }
  return { kind: "screenshot", url, to };
}

/* --------------------------- routes ----------------------------- */

app.post("/run", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ ok: false, error: "No prompt" });

    const plan = parsePrompt(prompt);
    const steps = [];
    const results = {};

    if (!plan.url) {
      return res
        .status(400)
        .json({ ok: false, error: "No URL detected in your prompt." });
    }

    if (plan.kind === "links") {
      steps.push({ action: "extract_links", url: plan.url, count: plan.count });
      const links = await topLinks(plan.url, plan.count || 3);
      results.links = links;

      if (plan.to) {
        steps.push({ action: "gmail_send_text", to: plan.to });
        const text =
          `Here are the top ${links.length} links from ${plan.url}:\n\n` +
          links.map((l, i) => `${i + 1}. ${l.text}\n${l.href}`).join("\n\n");
        await sendEmail({
          to: plan.to,
          subject: `Links from ${plan.url}`,
          text,
        });
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
          attachments: [
            {
              filename: path.basename(pdfPath),
              path: path.join(__dirname, pdfPath),
            },
          ],
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
        attachments: [
          {
            filename: path.basename(shotPath),
            path: path.join(__dirname, shotPath),
          },
        ],
      });
    }

    res.json({ ok: true, plan, steps, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// very small UI
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Mediad backend listening on ${PORT}`)
);
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














