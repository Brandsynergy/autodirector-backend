// server.js  (ESM)  — Mediad AutoDirector v3-ui
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const VERSION = "v3-ui";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const RUNS_DIR = path.join(__dirname, "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

// Serve screenshots
app.use("/runs", express.static(RUNS_DIR, { maxAge: 0 }));

const PORT = process.env.PORT || 10000;

/* ---------------- URL NORMALIZER ---------------- */
function normalizeUrl(input) {
  if (!input) return null;
  let u = String(input).trim();

  // fix common typos
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

/* ---------------- EMAIL ---------------- */
function smtp() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const from = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  await smtp().sendMail({ from, to, subject, text, html, attachments });
}

/* ---------------- SCREENSHOT ---------------- */
async function takeScreenshot(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Invalid URL: ${rawUrl}`);

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  const filename = `${id}.png`;
  const filePath = path.join(RUNS_DIR, filename);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    await ctx.close();
    await browser.close();
  }

  return { path: filePath, link: `/runs/${filename}`, url };
}

/* ---------------- SIMPLE PLANNER ---------------- */
function planFromPrompt(prompt) {
  const txt = String(prompt || "");
  const emailMatch = txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const urlMatch = txt.match(
    /https[;:]\/\/\S+|http[;:]\/\/\S+|www\.\S+|[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i
  );

  const rawUrl = urlMatch ? urlMatch[0] : null;
  const url = rawUrl ? normalizeUrl(rawUrl) : null;
  const to = emailMatch ? emailMatch[0] : null;

  const steps = [];
  if (url) steps.push({ action: "screenshot_url", url: rawUrl }); // raw accepted; normalized at runtime
  if (to) steps.push({ action: "gmail_send_last", to });

  return { kind: url ? "screenshot" : "general", url, to, steps };
}

/* ---------------- API ENDPOINTS ---------------- */
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
  let lastShot = null;

  try {
    for (const step of steps) {
      if (step.action === "screenshot_url") {
        lastShot = await takeScreenshot(step.url);
        results.push({ action: "screenshot_url", link: lastShot.link, url: lastShot.url });
      } else if (step.action === "gmail_send_last") {
        if (!lastShot) throw new Error("No screenshot available for email step");
        const absolute = new URL(lastShot.link, `${req.protocol}://${req.get("host")}`).toString();
        await sendEmail({
          to: step.to,
          subject: `Screenshot of ${lastShot.url}`,
          text: `Here is your screenshot: ${absolute}`,
          html: `<p>Here is your screenshot:</p><p><a href="${absolute}">${absolute}</a></p>`,
          attachments: [{ filename: path.basename(lastShot.path), path: lastShot.path }],
        });
        results.push({ action: "gmail_send_last", to: step.to });
      } else {
        results.push({ action: step.action, skipped: true, reason: "Unknown action" });
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
    const absolute = new URL(shot.link, `${req.protocol}://${req.get("host")}`).toString();

    if (email) {
      await sendEmail({
        to: email,
        subject: `Screenshot of ${shot.url}`,
        text: `Here is your screenshot: ${absolute}`,
        html: `<p>Here is your screenshot:</p><p><a href="${absolute}">${absolute}</a></p>`,
        attachments: [{ filename: path.basename(shot.path), path: shot.path }],
      });
    }
    res.json({ ok: true, link: shot.link, url: absolute, email: email || null });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

/* ---------------- MINIMAL BUILT-IN UI ---------------- */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mediad AutoDirector</title>
<style>
  :root { --bg:#0b1020; --panel:#151b2e; --text:#e8ecff; --muted:#9aa3c1; --accent:#5aa0ff; --ok:#22c55e; --err:#ef4444; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font:16px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
  .wrap { max-width: 820px; margin: 48px auto; padding: 0 20px; }
  .card { background: linear-gradient(180deg, #161d33, #11182a); border:1px solid #1d2742; border-radius: 16px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
  .logo { width:36px; height:36px; display:inline-block; }
  .h1 { font-size: 20px; font-weight:700; letter-spacing: .5px; }
  .muted { color: var(--muted); font-size: 14px; }
  .row { display:flex; gap:12px; margin-top:16px; }
  .row > .field { flex:1 }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; padding:12px 14px; border-radius:10px; border:1px solid #263153; background:#0e1426; color:var(--text); }
  input::placeholder { color:#6f7ba1; }
  button { padding:12px 16px; border-radius:10px; border:none; background:var(--accent); color:white; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:not-allowed; }
  .out { margin-top:18px; background:#0e1426; border:1px solid #263153; border-radius:12px; padding:12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; color:#d9e2ff; }
  .thumb { margin-top:12px; border-radius:12px; overflow:hidden; border:1px solid #263153; max-height:420px; }
  .thumb img { width:100%; display:block; }
  .bad { color: var(--err); font-weight:600; }
  .good { color: var(--ok); font-weight:600; }
  .links { margin-top:8px; }
  .links a { color:#b9d5ff; text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  footer { margin-top:18px; color:#7e8ab0; font-size:12px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <!-- simple inline SVG to avoid missing logo files -->
      <svg class="logo" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="4" y="4" width="56" height="56" rx="14" fill="#1a2a4a"/>
        <path d="M18 40 L30 20 L34 28 L46 20 L34 44 L30 36 Z" fill="#5aa0ff"/>
      </svg>
      <div>
        <div class="h1">Mediad AutoDirector</div>
        <div class="muted">One-click website screenshot → optional email.</div>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <div class="field">
          <label>Website URL</label>
          <input id="url" placeholder="e.g. https://www.cnn.com or cnn.com or https;//cnn.com" />
        </div>
        <div class="field">
          <label>Send to (optional)</label>
          <input id="email" placeholder="you@example.com" />
        </div>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button id="btn">Run Quick</button>
      </div>
      <div class="out" id="out">Output will appear here…</div>
      <div class="thumb" id="thumb" style="display:none">
        <img id="img" alt="Screenshot result"/>
      </div>
      <div class="links" id="links" style="display:none"></div>
      <footer>API version: <strong>${VERSION}</strong></footer>
    </div>
  </div>

<script>
const btn = document.getElementById('btn');
const url = document.getElementById('url');
const email = document.getElementById('email');
const out = document.getElementById('out');
const thumb = document.getElementById('thumb');
const img = document.getElementById('img');
const links = document.getElementById('links');

function log(msg) { out.textContent = msg; }
function asJson(obj) { return JSON.stringify(obj, null, 2); }

btn.addEventListener('click', async () => {
  btn.disabled = true;
  thumb.style.display = 'none';
  links.style.display = 'none';
  log('Working… this can take ~5–15 seconds.');
  try {
    const resp = await fetch('/quick', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ url: url.value, email: email.value || null })
    });
    const data = await resp.json();
    if (!data.ok) {
      log('❌ Error: ' + (data.error || 'Unknown error'));
      return;
    }
    log('✅ Success:\\n' + asJson(data));
    const full = data.url || (location.origin + data.link);
    img.src = full;
    thumb.style.display = 'block';
    links.innerHTML = '<a href="'+full+'" target="_blank" rel="noreferrer">Open screenshot</a>' + (data.email ? ' • emailed to ' + data.email : '');
    links.style.display = 'block';
  } catch (e) {
    log('❌ Error: ' + e);
  } finally {
    btn.disabled = false;
  }
});
</script>
</body>
</html>
`;

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

// 404
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














