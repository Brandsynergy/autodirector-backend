// server.js (ESM) — complete file
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// middleware
app.use(cors());
app.use(express.json());

// serve /public (for the UI and logo)
app.use(express.static(path.join(__dirname, "public")));

// ensure /runs exists and serve it
const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// absolute URL helper (fixes “Unknown Error” in emails)
function absoluteUrl(req, p) {
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
  return p.startsWith("http") ? p : `${origin}${p}`;
}

// take screenshot and save to /runs/<stamp>-<rand>.png
async function takeScreenshot(targetUrl) {
  const stamp = Date.now();
  const rand = crypto.randomBytes(5).toString("hex");
  const rel = `/runs/${stamp}-${rand}.png`;
  const filePath = path.join(__dirname, rel);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.screenshot({ path: filePath, fullPage: true });
  await browser.close();

  return { rel, filePath };
}

// Gmail transporter (uses app password)
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
}

// POST /quick  { url: "https://cnn.com", email?: "you@..." }
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ ok: false, error: "Missing url" });

    const { rel, filePath } = await takeScreenshot(url);
    const full = absoluteUrl(req, rel);

    // email (inline + link). If email omitted, send to GMAIL_USER.
    const to = email || process.env.GMAIL_USER;
    try {
      const transporter = getTransporter();
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: "Mediad AutoDirector screenshot",
        text: `Here is your screenshot: ${full}`,
        html: `
          <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;">
            <p>Here is your screenshot:</p>
            <p><a href="${full}">${full}</a></p>
            <p><img src="cid:snap1" alt="screenshot" style="max-width:100%;height:auto"/></p>
          </div>
        `,
        attachments: [
          { filename: path.basename(rel), path: filePath, cid: "snap1" } // inline + attachment
        ],
      });
    } catch (mailErr) {
      // still return link so you can open it
      return res.json({ ok: true, link: rel, url: full, email: to, mailError: mailErr.message });
    }

    res.json({ ok: true, link: rel, url: full, email: to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

// UI at "/"
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














