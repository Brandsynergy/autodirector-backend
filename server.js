// server.js  (ESM)
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Make sure a persistent /app/runs exists (or attach a Render Disk to /app/runs)
const RUNS_DIR = process.env.RUNS_DIR || path.join(process.cwd(), "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

// Serve screenshots statically (handles GET and HEAD)
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    fallthrough: false,
    setHeaders(res) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// Tiny HTML UI (optional). If you already have an index.html, you can remove this.
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mediad AutoDirector</title>
<style>body{font-family:system-ui,Segoe UI,Arial;background:#0b0f1a;color:#e8eefc;padding:24px}input,button{font-size:16px}input{width:100%;padding:14px;border-radius:10px;border:none;background:#10162a;color:#e8eefc}button{width:100%;padding:16px;margin-top:12px;border-radius:10px;border:none;background:#5ea3ff;color:#001130;font-weight:700;cursor:pointer}</style>
</head>
<body>
  <h1>Mediad AutoDirector</h1>
  <p>Capture a web page and email the screenshot.</p>
  <div>
    <label>Website URL</label>
    <input id="u" placeholder="https://www.cnn.com" value="https://www.cnn.com">
  </div>
  <div style="margin-top:10px">
    <label>Destination email (optional)</label>
    <input id="e" placeholder="you@example.com">
  </div>
  <button id="go">Capture & Email</button>
  <pre id="out" style="margin-top:12px;white-space:pre-wrap"></pre>
<script>
document.getElementById('go').onclick = async () => {
  const url = document.getElementById('u').value.trim();
  const email = document.getElementById('e').value.trim();
  const r = await fetch('/api/capture', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ url, email: email || undefined })
  });
  const j = await r.json();
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
};
</script>
</body></html>`);
});

// Nodemailer (Gmail App Password required)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

function absoluteUrl(req, relativePath) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}${relativePath.startsWith("/") ? relativePath : "/" + relativePath}`;
}

// Main API: capture & email
app.post("/api/capture", async (req, res, next) => {
  try {
    const { url, email } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "Missing 'url'." });

    const to = email || process.env.GMAIL_USER;
    if (!to) return res.status(400).json({ ok: false, error: "No destination email and GMAIL_USER not set." });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "networkidle" });

    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
    const relPath = `/runs/${filename}`;
    const absPath = path.join(RUNS_DIR, filename);
    await page.screenshot({ path: absPath, fullPage: true });
    await browser.close();

    const link = absoluteUrl(req, relPath);

    // Email with attachment + link in the body
    await transporter.sendMail({
      from: `Mediad AutoDirector <${process.env.GMAIL_USER}>`,
      to,
      subject: `Screenshot of ${url}`,
      text: `Here is your screenshot:\n${link}\n`,
      html: `<p>Here is your screenshot:</p><p><a href="${link}">${link}</a></p><p><img src="${link}" alt="screenshot" style="max-width:100%"/></p>`,
      attachments: [{ filename, path: absPath }],
    });

    res.json({ ok: true, link: relPath, email: to });
  } catch (err) {
    next(err);
  }
});

// JSON error handler (no "Unknown Error" anymore)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
});

// 404 as JSON
app.use((req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














