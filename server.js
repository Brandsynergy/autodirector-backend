 // server.js — Mediad AutoDirector v4-automation (ESM)
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const VERSION = "v4-automation";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const RUNS_DIR = path.join(__dirname, "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });
app.use("/runs", express.static(RUNS_DIR, { maxAge: 0 }));

const PORT = process.env.PORT || 10000;

/* ---------------- Utilities ---------------- */
function normalizeUrl(input) {
  if (!input) return null;
  let u = String(input).trim();

  // fix common typos like https;//example.com
  u = u.replace(/^https;\/*/i, "https://").replace(/^http;\/*/i, "http://");

  // add scheme if missing
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");

  try {
    const urlObj = new URL(u);
    if (!["http:", "https:"].includes(urlObj.protocol)) return null;
    return urlObj.toString();
  } catch {
    return null;
  }
}

function getAbs(req, rel) {
  return new URL(rel, `${req.protocol}://${req.get("host")}`).toString();
}

/* ---------------- Email ---------------- */
function transporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars.");
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const from = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  await transporter().sendMail({ from, to, subject, text, html, attachments });
}

/* ---------------- Browser tasks ---------------- */
async function withPage(fn) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function takeScreenshot(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Invalid URL: ${rawUrl}`);

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  const filename = `${id}.png`;
  const filePath = path.join(RUNS_DIR, filename);

  await withPage(async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: filePath, fullPage: true });
  });

  return { path: filePath, link: `/runs/${filename}`, url };
}

async function savePdf(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Invalid URL: ${rawUrl}`);

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  const filename = `${id}.pdf`;
  const filePath = path.join(RUNS_DIR, filename);

  await withPage(async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    // Playwright Chromium only
    await page.emulateMedia({ media: "screen" });
    await page.pdf({ path: filePath, format: "A4", printBackground: true });
  });

  return { path: filePath, link: `/runs/${filename}`, url };
}

async function extractLinks(rawUrl, count = 3) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Invalid URL: ${rawUrl}`);

  const items = await withPage(async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    const anchors = await page.$$eval("a", (as) =>
      as
        .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") || "" }))
        .filter((x) => x.href && x.text)
    );
    return anchors;
  });

  // absolutize and dedupe
  const seen = new Set();
  const out = [];
  for (const a of items) {
    let href = a.href;
    try {
      href = new URL(href, url).toString();
    } catch {}
    if (!seen.has(href)) {
      seen.add(href);
      out.push({ text: a.text.slice(0, 150), href });
    }
    if (out.length >= count) break;
  }
  return out;
}

/* ---------------- Planner ---------------- */
function parseCount(text, fallback = 3) {
  const m = String(text).match(/top\s+(\d+)|first\s+(\d+)|(\d+)\s+(?:links|items|articles)/i);
  if (!m) return fallback;
  const n = Number(m[1] || m[2] || m[3]);
  return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : fallback;
}

function parseEmail(text) {
  const m = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function parseUrl(text) {
  const m = String(text).match(
    /https[;:]\/\/\S+|http[;:]\/\/\S+|www\.\S+|[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i
  );
  return m ? m[0] : null;
}

function wantsLinks(text) {
  return /(get|latest|top|extract).*(links|articles|stories)/i.test(text);
}

function wantsScreenshot(text) {
  return /(screenshot|capture|image)/i.test(text);
}

function wantsPdf(text) {
  return /\b(pdf|save as pdf|print to pdf)\b/i.test(text);
}

function planFromPrompt(prompt) {
  const p = String(prompt || "");
  const rawUrl = parseUrl(p);
  const url = rawUrl ? normalizeUrl(rawUrl) : null;
  const email = parseEmail(p);
  const count = parseCount(p, 3);

  const steps = [];

  if (wantsLinks(p)) {
    steps.push({ action: "extract_links", url: rawUrl || null, count });
    if (email) steps.push({ action: "gmail_send_text", to: email });
  } else if (wantsPdf(p)) {
    steps.push({ action: "save_pdf_url", url: rawUrl || null });
    if (email) steps.push({ action: "gmail_send_last", to: email });
  } else {
    // default to screenshot
    steps.push({ action: "screenshot_url", url: rawUrl || null });
    if (email) steps.push({ action: "gmail_send_last", to: email });
  }

  return { kind: "auto", url, to: email, count, steps };
}

/* ---------------- API ---------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", version: VERSION, time: new Date().toISOString() });
});

app.post("/plan", (req, res) => {
  try {
    const { prompt } = req.body || {};
    const plan = planFromPrompt(prompt);
    res.json({ ok: true, plan, steps: plan.steps });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/run", async (req, res) => {
  const steps = (req.body && req.body.steps) || [];
  const results = [];
  let lastArtifact = null; // { path, link, url }

  try {
    for (const step of steps) {
      const name = String(step.action || "").trim();

      if (name === "screenshot_url") {
        if (!step.url) throw new Error("screenshot_url requires a URL");
        lastArtifact = await takeScreenshot(step.url);
        results.push({ action: name, link: lastArtifact.link, url: lastArtifact.url });
      }

      else if (name === "save_pdf_url") {
        if (!step.url) throw new Error("save_pdf_url requires a URL");
        lastArtifact = await savePdf(step.url);
        results.push({ action: name, link: lastArtifact.link, url: lastArtifact.url });
      }

      else if (name === "extract_links") {
        if (!step.url) throw new Error("extract_links requires a URL");
        const links = await extractLinks(step.url, Number(step.count) || 3);
        lastArtifact = null; // not a file; it’s data
        results.push({ action: name, count: links.length, links });
      }

      else if (name === "gmail_send_text") {
        const to = step.to;
        if (!to) throw new Error("gmail_send_text requires 'to'");
        const last = results[results.length - 1];
        const subject = "Mediad AutoDirector – results";
        let text = "See results below.";
        let html = "<p>See results below.</p>";

        if (last?.links) {
          text = last.links.map((l, i) => `${i + 1}. ${l.text} — ${l.href}`).join("\n");
          html = "<ol>" + last.links.map((l) => `<li><a href="${l.href}">${l.text}</a></li>`).join("") + "</ol>";
        }

        await sendEmail({ to, subject, text, html });
        results.push({ action: name, to });
      }

      else if (name === "gmail_send_last") {
        const to = step.to;
        if (!to) throw new Error("gmail_send_last requires 'to'");
        if (!lastArtifact) throw new Error("No file to attach for gmail_send_last.");
        const absolute = req ? getAbs(req, lastArtifact.link) : lastArtifact.link;

        await sendEmail({
          to,
          subject: `Mediad AutoDirector – ${lastArtifact.url}`,
          text: `Here is your file: ${absolute}`,
          html: `<p>Here is your file: <a href="${absolute}">${absolute}</a></p>`,
          attachments: [{ filename: path.basename(lastArtifact.path), path: lastArtifact.path }],
        });

        results.push({ action: name, to, attachment: lastArtifact.link });
      }

      else {
        results.push({ action: name, skipped: true, reason: "Unknown action" });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err), results });
  }
});

app.post("/quick", async (req, res) => {
  try {
    const { url: rawUrl, email } = req.body || {};
    const shot = await takeScreenshot(rawUrl);
    const absolute = getAbs(req, shot.link);
    if (email) {
      await sendEmail({
        to: email,
        subject: `Mediad AutoDirector – ${shot.url}`,
        text: `Here is your screenshot: ${absolute}`,
        html: `<p>Here is your screenshot: <a href="${absolute}">${absolute}</a></p>`,
        attachments: [{ filename: path.basename(shot.path), path: shot.path }],
      });
    }
    res.json({ ok: true, link: shot.link, url: absolute, email: email || null });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

/* ---------------- Minimal UI (Plan/Run + Quick) ---------------- */
const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Mediad AutoDirector</title>
<style>
  :root{--bg:#0b1020;--panel:#151b2e;--text:#e8ecff;--muted:#9aa3c1;--accent:#5aa0ff;--ok:#22c55e;--err:#ef4444}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{max-width:900px;margin:40px auto;padding:0 20px}
  .card{background:linear-gradient(180deg,#161d33,#11182a);border:1px solid #1d2742;border-radius:16px;padding:18px 20px;box-shadow:0 10px 30px rgba(0,0,0,.4);margin-bottom:22px}
  h1{font-size:20px;margin:0 0 8px}
  .muted{color:var(--muted);font-size:13px;margin-bottom:12px}
  label{display:block;color:var(--muted);font-size:12px;margin:10px 0 6px}
  input,textarea{width:100%;background:#0e1426;border:1px solid #263153;border-radius:10px;color:var(--text);padding:10px 12px}
  textarea{min-height:90px}
  .row{display:flex;gap:10px;align-items:flex-end}
  .row>div{flex:1}
  button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:600;cursor:pointer}
  pre{background:#0e1426;border:1px solid #263153;border-radius:10px;padding:10px;white-space:pre-wrap}
  .ok{color:var(--ok)} .err{color:var(--err)}
</style>
</head><body>
<div class="wrap">
  <div class="card">
    <h1>Mediad AutoDirector</h1>
    <div class="muted">Plan → Run automation from a natural-language prompt. Version <b>${VERSION}</b></div>
    <label>Prompt</label>
    <textarea id="prompt" placeholder='e.g. "Get top 3 links from https://inc.com and email to you@example.com"'></textarea>
    <div class="row" style="margin-top:10px">
      <button id="btnPlan">Plan</button>
      <button id="btnRun">Run (uses last plan)</button>
    </div>
    <label>Planned Steps</label>
    <pre id="planBox">[ ]</pre>
    <label>Run Output</label>
    <pre id="runBox">—</pre>
  </div>

  <div class="card">
    <h1>Quick: Screenshot</h1>
    <div class="row">
      <div><label>Website URL</label><input id="qUrl" placeholder="https://cnn.com or https;//cnn.com"/></div>
      <div><label>Email (optional)</label><input id="qEmail" placeholder="you@example.com"/></div>
      <div style="flex:0"><button id="qBtn">Run Quick</button></div>
    </div>
    <label>Output</label>
    <pre id="qOut">—</pre>
  </div>
</div>
<script>
let lastSteps = [];
const planBox = document.getElementById('planBox');
const runBox = document.getElementById('runBox');
const btnPlan = document.getElementById('btnPlan');
const btnRun = document.getElementById('btnRun');
const promptEl = document.getElementById('prompt');

btnPlan.onclick = async () => {
  runBox.textContent = '—';
  const resp = await fetch('/plan', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: promptEl.value })
  });
  const data = await resp.json();
  if (!data.ok) { planBox.textContent = 'Error: ' + data.error; return; }
  lastSteps = data.steps || [];
  planBox.textContent = JSON.stringify(lastSteps, null, 2);
};

btnRun.onclick = async () => {
  const resp = await fetch('/run', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ steps: lastSteps })
  });
  const data = await resp.json();
  runBox.textContent = JSON.stringify(data, null, 2);
};

const qUrl = document.getElementById('qUrl');
const qEmail = document.getElementById('qEmail');
const qBtn = document.getElementById('qBtn');
const qOut = document.getElementById('qOut');

qBtn.onclick = async () => {
  const resp = await fetch('/quick', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ url: qUrl.value, email: qEmail.value || null })
  });
  const data = await resp.json();
  qOut.textContent = JSON.stringify(data, null, 2);
};
</script>
</body></html>`;
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

app.use((_req, res) => res.status(404).send("Not Found"));
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














