// server.js — Mediad AutoDirector (ESM) — HTTPS-safe links + fallback UI

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Tell Express to trust Render's proxy so req.protocol becomes 'https'
app.set("trust proxy", 1);

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve generated screenshots
app.use(
  "/runs",
  express.static(path.join(__dirname, "runs"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".png")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

// Serve optional /public if present (no crash if missing)
app.use("/", express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---------- helpers ----------
function absoluteBase(req) {
  // Respect Render / proxies
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
  return `${proto}://${req.get("host")}`;
}
function absoluteUrl(req, p) {
  return `${absoluteBase(req)}${p.startsWith("/") ? p : `/${p}`}`;
}

function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  // fix common typos like "https;//"
  s = s.replace(/^https;\//i, "https://").replace(/^http;\//i, "http://");
  // add protocol if missing
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

async function takeScreenshot(url) {
  const { chromium } = await import("playwright");
  await fs.mkdir(path.join(__dirname, "runs"), { recursive: true });

  const file = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const outPath = path.join(__dirname, "runs", file);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();

  return { file, path: outPath, href: `/runs/${file}` };
}

async function sendEmail({ to, subject, text, html, attachmentPath }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const mail = {
    from: `Mediad <${user}>`,
    to: to || process.env.DEFAULT_TO || user,
    subject: subject || "Mediad AutoDirector",
    text: text || "See the attached screenshot.",
    html: html || "<p>See the attached screenshot.</p>",
    attachments: attachmentPath ? [{ filename: path.basename(attachmentPath), path: attachmentPath }] : [],
  };

  const info = await transporter.sendMail(mail);
  return { messageId: info.messageId, to: mail.to };
}

// ---------- endpoints ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

app.post("/quick", async (req, res, next) => {
  try {
    const rawUrl = req.body?.url;
    const email = req.body?.email || undefined;
    const url = normalizeUrl(rawUrl);
    if (!url) return res.status(400).json({ ok: false, error: "Missing or invalid url" });

    const snap = await takeScreenshot(url);

    let emailResult = null;
    if (email) {
      const abs = absoluteUrl(req, snap.href);
      emailResult = await sendEmail({
        to: email,
        subject: `Screenshot: ${new URL(url).hostname}`,
        text: `Screenshot of ${url} is attached.\nDirect link: ${abs}`,
        html: `<p>Screenshot of <a href="${url}">${url}</a> is attached.</p><p>Direct link: <a href="${abs}">${abs}</a></p>`,
        attachmentPath: snap.path,
      });
    }

    res.json({
      ok: true,
      link: snap.href,                              // relative
      url: absoluteUrl(req, snap.href),             // absolute HTTPS
      email: emailResult?.to || null,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/plan", (req, res) => {
  const prompt = String(req.body?.prompt || "");
  // very simple “screenshot X and email to Y” parser
  const m = prompt.match(/screenshot\s+(\S+)\s+and\s+email\s+it\s+to\s+([^\s]+)/i);
  const url = m?.[1] ? normalizeUrl(m[1]) : null;
  const to = m?.[2] ? m[2].replace(/[.,]$/, "") : null;

  const steps = [];
  if (url) steps.push({ action: "screenshot_url", url });
  if (to) steps.push({ action: "gmail_send_last", to });

  res.json({ ok: true, plan: { kind: "general", url, to }, steps });
});

let lastScreenshotPath = null;

app.post("/run", async (req, res, next) => {
  try {
    const steps = req.body?.steps || [];
    const results = [];

    for (const step of steps) {
      if (step.action === "screenshot_url") {
        const url = normalizeUrl(step.url);
        if (!url) throw new Error("Invalid URL");
        const snap = await takeScreenshot(url);
        lastScreenshotPath = snap.path;
        results.push({ action: "screenshot_url", path: snap.href });
      } else if (step.action === "gmail_send_last") {
        const to = step.to || process.env.DEFAULT_TO;
        if (!to) throw new Error('Missing "to" email');
        if (!lastScreenshotPath) throw new Error("No screenshot available yet");
        const sent = await sendEmail({
          to,
          subject: "Mediad AutoDirector – result",
          text: "See attached.",
          html: "<p>See attached.</p>",
          attachmentPath: lastScreenshotPath,
        });
        results.push({ action: "gmail_send_last", to: sent.to });
      } else {
        throw new Error(`Unknown action: ${step.action}`);
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// ---------- homepage (with fallback UI if public/index.html missing) ----------
const HOMEPAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mediad AutoDirector</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0}
.wrap{max-width:860px;margin:40px auto;padding:24px;background:#111827;border-radius:14px}
h1{font-size:26px;margin:0 0 6px} p{margin:0 0 18px;color:#9ca3af}
label{display:block;margin:14px 0 6px;font-weight:600}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #1f2937;background:#0b1220;color:#e5e7eb}
button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:#60a5fa;color:#041025;font-weight:700;cursor:pointer}
pre,.result{margin-top:18px;padding:14px;background:#0b1220;border:1px solid #1f2937;border-radius:10px;overflow:auto}
a{color:#93c5fd}
</style>
</head><body>
<div class="wrap">
  <h1>Mediad AutoDirector</h1>
  <p>Capture a live webpage screenshot and (optionally) email it.</p>
  <label>Website URL</label>
  <input id="url" placeholder="https://www.cnn.com" value="https://www.cnn.com" />
  <label>Destination email (optional)</label>
  <input id="email" placeholder="you@example.com (leave blank to skip email)" />
  <button id="go">Capture & Email</button>
  <div id="out" class="result" style="display:none"></div>
  <div id="img" class="result" style="display:none"></div>
</div>
<script>
const byId = id => document.getElementById(id);
byId('go').onclick = async () => {
  const url = byId('url').value.trim();
  const email = byId('email').value.trim();
  byId('out').style.display = 'block';
  byId('img').style.display = 'none';
  byId('out').textContent = 'Working…';
  try {
    const res = await fetch('/quick', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url, email: email || undefined })
    });
    const data = await res.json();
    byId('out').textContent = JSON.stringify(data, null, 2);
    if (data.ok && (data.url || data.link)) {
      const link = data.url || (location.origin + data.link);
      byId('img').style.display = 'block';
      byId('img').innerHTML = \`<div>Link: <a href="\${link}" target="_blank">\${link}</a></div>
      <div style="margin-top:12px"><img src="\${link}" style="max-width:100%"/></div>\`;
    }
  } catch (e) {
    byId('out').textContent = 'Error: ' + (e?.message || e);
  }
};
</script>
</body></html>`;

app.get("/", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "public", "index.html");
    const html = await fs.readFile(filePath, "utf8");
    res.type("html").send(html);
  } catch {
    // Enforce https on mixed links
    res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
    res.type("html").send(HOMEPAGE_HTML);
  }
});

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err?.message || "unknown error" });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                                                                                                                                
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














