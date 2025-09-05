import express from "express";
import cors from "cors";
import morgan from "morgan";
import nodemailer from "nodemailer";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1); // respect X-Forwarded-Proto/Host on Render
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// --- folders
const RUNS_DIR = path.join(__dirname, "runs");
if (!existsSync(RUNS_DIR)) {
  await fs.mkdir(RUNS_DIR, { recursive: true });
}

// --- static files
app.use("/runs", express.static(RUNS_DIR, { maxAge: "365d", immutable: true }));
app.use("/", express.static(path.join(__dirname, "public")));

// --- health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// helpers
const randomId = () => crypto.randomBytes(8).toString("hex");
const absoluteUrl = (req, rel) => {
  // on Render, trust proxy lets req.protocol become 'https'
  return new URL(rel, `${req.protocol}://${req.get("host")}`).toString();
};

// screenshot with Playwright / Chromium
async function takeScreenshot(url, outPath) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 800 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(500); // tiny settle
    await page.screenshot({ path: outPath, fullPage: true, type: "png" });
  } finally {
    await browser.close();
  }
}

// email
function makeTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD; // 16-char app password
  if (!user || !pass) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars.");
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass }
  });
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const transporter = makeTransport();
  const from = process.env.GMAIL_USER;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,       // plain-text fallback (shows even if images are blocked)
    html,
    attachments // attach PNG so it's never “blank”
  });
}

// --- POST /quick { url, email? }
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url) {
      return res.status(400).json({ ok: false, error: "Missing 'url' field." });
    }

    // validate URL and force https if user typed http
    let target;
    try {
      target = new URL(url);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid URL." });
    }
    if (!/^https?:$/.test(target.protocol)) {
      return res.status(400).json({ ok: false, error: "URL must start with http:// or https://"});
    }
    if (target.protocol === "http:") target.protocol = "https:";

    const filename = `${Date.now()}-${randomId()}.png`;
    const outPath = path.join(RUNS_DIR, filename);

    // 1) screenshot
    await takeScreenshot(target.toString(), outPath);

    // 2) build links
    const rel = `/runs/${filename}`;
    const abs = absoluteUrl(req, rel);

    // 3) optionally email
    if (email) {
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif">
          <h2>Mediad AutoDirector</h2>
          <p>Here is your screenshot of <a href="${target.toString()}">${target.toString()}</a>.</p>
          <p><strong>Open image:</strong> <a href="${abs}">${abs}</a></p>
          <p>(Image is also attached to this email.)</p>
        </div>`;
      const text = `Here is your screenshot:\n${abs}\nSource: ${target.toString()}`;

      await sendEmail({
        to: email,
        subject: "Mediad AutoDirector – Screenshot",
        text,
        html,
        attachments: [
          {
            filename,
            path: outPath,
            contentType: "image/png"
          }
        ]
      });
    }

    // 4) return both relative and absolute URL
    return res.json({ ok: true, link: rel, url: abs, email: email || null });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// Friendly fallback if someone GETs a non-existent route
app.use((req, res) => {
  res
    .status(404)
    .type("text")
    .send(
`Mediad AutoDirector

Endpoints:
  GET  /health
  POST /quick   (json: {"url":"https://...", "email":"you@example.com"})

Static:
  /runs/<file>.png

Visit / to use the simple web form.`
    );
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                                                                                                                                
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














