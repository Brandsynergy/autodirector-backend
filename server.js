// server.js (ESM)
// Replace your server.js with this entire file.

import express from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import playwright from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// --------------- CONFIG ---------------
const PORT = process.env.PORT || 10000;
const BASE_DIR = process.cwd();               // Render runs from /app
const RUNS_DIR = path.join(BASE_DIR, "runs");
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`; // Absolute URL for links in email

// Gmail creds
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || "";
const GMAIL_FROM = process.env.GMAIL_FROM || GMAIL_USER;

// --------------- EMAIL ---------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

/**
 * Send an email with the screenshot attached and embedded inline (cid).
 */
async function sendEmailWithAttachment({
  to,
  subject,
  text,
  html,
  filePath,
  cid = "screenshot",
}) {
  const message = {
    from: GMAIL_FROM,
    to: to || GMAIL_USER, // default to yourself if blank
    subject,
    text,
    html,
    attachments: filePath
      ? [
          {
            filename: path.basename(filePath),
            path: filePath,
            cid, // embed inline
          },
        ]
      : [],
  };

  await transporter.sendMail(message);
}

// --------------- UTIL ---------------
async function ensureRunsDir() {
  try {
    await fs.mkdir(RUNS_DIR, { recursive: true });
  } catch (_) {}
}

function publicFileUrl(relPath) {
  // relPath like "runs/123.png"
  return `${PUBLIC_URL}/${relPath.replace(/^\//, "")}`;
}

// --------------- STATIC ---------------
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    fallthrough: false,
    setHeaders(res, fp) {
      // best effort content-type
      const ext = path.extname(fp).toLowerCase();
      if (ext === ".png") res.type("png");
      else if (ext === ".jpg" || ext === ".jpeg") res.type("jpeg");
      else if (ext === ".gif") res.type("gif");
    },
  })
);

// --------------- HEALTH ---------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mediad-autodirector",
    time: new Date().toISOString(),
  });
});

// --------------- QUICK FORM (UI) ---------------
app.get("/", async (req, res) => {
  // Simple UI kept (so you can test quickly)
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------- QUICK ENDPOINT ---------------
app.post("/quick", async (req, res, next) => {
  try {
    await ensureRunsDir();

    const { url, email } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "Invalid URL" });
    }

    // 1) Capture screenshot with Playwright
    const browser = await playwright.chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const absPath = path.join(RUNS_DIR, filename);
    await page.screenshot({ path: absPath, fullPage: true });
    await browser.close();

    const relPath = `runs/${filename}`;
    const link = publicFileUrl(relPath);

    // 2) Email: attach + embed + include direct link
    const cid = `sc_${Date.now()}`;
    const subject = "Mediad AutoDirector: screenshot";
    const text = `Here is your screenshot of ${url}\nDirect link: ${link}`;
    const html = `
      <p>Here is your screenshot of <a href="${url}">${url}</a>.</p>
      <p><strong>Inline image (from attachment):</strong></p>
      <p><img src="cid:${cid}" alt="screenshot" /></p>
      <p>Direct link to file: <a href="${link}">${link}</a></p>
    `;

    await sendEmailWithAttachment({
      to: email,
      subject,
      text,
      html,
      filePath: absPath,
      cid,
    });

    res.json({ ok: true, link: `/${relPath}`, email: email || GMAIL_USER });
  } catch (err) {
    next(err);
  }
});

// --------------- ERROR HANDLING ---------------
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Server error" });
});

// --------------- START ---------------
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














