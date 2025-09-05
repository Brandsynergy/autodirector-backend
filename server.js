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
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

const RUNS_DIR = path.join(__dirname, "runs");
if (!existsSync(RUNS_DIR)) {
  await fs.mkdir(RUNS_DIR, { recursive: true });
}

app.use("/runs", express.static(RUNS_DIR, { maxAge: "365d", immutable: true }));
app.use("/", express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

const randomId = () => crypto.randomBytes(8).toString("hex");
const absoluteUrl = (req, rel) => new URL(rel, `${req.protocol}://${req.get("host")}`).toString();

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
    await page.waitForTimeout(500);
    await page.screenshot({ path: outPath, fullPage: true, type: "png" });
  } finally {
    await browser.close();
  }
}

function makeTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD.");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass }
  });
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const transporter = makeTransport();
  await transporter.sendMail({ from: process.env.GMAIL_USER, to, subject, text, html, attachments });
}

// POST /quick {url, email?}
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "Missing 'url'." });

    let target;
    try { target = new URL(url); } catch { return res.status(400).json({ ok: false, error: "Invalid URL." }); }
    if (!/^https?:$/.test(target.protocol)) {
      return res.status(400).json({ ok: false, error: "URL must start with http:// or https://"}); }
    if (target.protocol === "http:") target.protocol = "https:";

    const filename = `${Date.now()}-${randomId()}.png`;
    const outPath = path.join(RUNS_DIR, filename);

    await takeScreenshot(target.toString(), outPath);

    const rel = `/runs/${filename}`;
    const abs = absoluteUrl(req, rel);

    // Also provide inline base64 so the UI can always preview it
    const base64 = await fs.readFile(outPath, { encoding: "base64" });
    const dataUrl = `data:image/png;base64,${base64}`;

    if (email) {
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif">
          <h2>Mediad AutoDirector</h2>
          <p>Screenshot of <a href="${target.toString()}">${target.toString()}</a></p>
          <p><strong>Open image:</strong> <a href="${abs}">${abs}</a></p>
          <p>(PNG attached.)</p>
        </div>`;
      const text = `Screenshot link: ${abs}\nSource: ${target.toString()}`;

      await sendEmail({
        to: email,
        subject: "Mediad AutoDirector – Screenshot",
        text,
        html,
        attachments: [{ filename, path: outPath, contentType: "image/png" }]
      });
    }

    return res.json({ ok: true, link: rel, url: abs, inline: dataUrl, email: email || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// Friendly fallback
app.use((req, res) => {
  res
    .status(404)
    .type("text")
    .send(`Mediad AutoDirector

Endpoints:
  GET  /health
  POST /quick   (json: {"url":"https://...", "email":"you@example.com"})

Static:
  /runs/<file>.png

Visit / to use the simple web form.`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Mediad backend listening on ${PORT}`));
                                                                                                                                            
  
  
  
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                                                                                                                                
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














