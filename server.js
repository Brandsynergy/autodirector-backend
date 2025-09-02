// server.js (ESM) — complete drop-in
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { chromium } from "playwright"; // render image via Playwright

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ensure /runs exists
const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// serve static images with CORS so email clients can load them
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    setHeaders: (res) => res.setHeader("Access-Control-Allow-Origin", "*"),
  })
);

// health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "mediad-autodirector",
    time: new Date().toISOString(),
  });
});

// Build an absolute URL from a path like "/runs/abc.png"
function absoluteUrl(req, p) {
  const origin =
    process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
  return p.startsWith("http") ? p : `${origin}${p}`;
}

// take a screenshot to /runs/<stamp>-<rand>.png and return its relative path
async function takeScreenshot(targetUrl) {
  const stamp = Date.now();
  const rand = crypto.randomBytes(5).toString("hex");
  const rel = `/runs/${stamp}-${rand}.png`;
  const filePath = path.join(__dirname, rel);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.screenshot({ path: filePath, fullPage: true });
  await browser.close();

  return { rel, filePath };
}

// Gmail transporter (uses your app password)
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "Missing GMAIL_USER or GMAIL_APP_PASSWORD environment variable"
    );
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

/**
 * Quick endpoint used by the UI and by your curl test.
 * Body: { url: "https://cnn.com", email: "you@domain.com" (optional) }
 * If email is omitted, it will send to GMAIL_USER.
 */
app.post("/quick", async (req, res) => {
  try {
    const { url, email } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }

    const { rel, filePath } = await takeScreenshot(url);
    const full = absoluteUrl(req, rel);

    // send email (inline + link)
    try {
      const transporter = getTransporter();

      const to = email || process.env.GMAIL_USER;
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: "AutoDirector screenshot",
        text: `Here is your screenshot: ${full}`,
        html: `
          <p>Here is your screenshot:</p>
          <p><a href="${full}">${full}</a></p>
          <p><img src="cid:snap1" alt="screenshot" style="max-width:100%;height:auto"/></p>
        `,
        attachments: [
          {
            filename: path.basename(rel),
            path: filePath,     // attach the file
            cid: "snap1"        // inline content-id
          },
        ],
      });
    } catch (mailErr) {
      // We still return ok with the link so you can copy it,
      // but include the mail error for visibility.
      return res.json({
        ok: true,
        link: rel,
        url: full,
        email: email || process.env.GMAIL_USER,
        mailError: mailErr.message,
      });
    }

    res.json({
      ok: true,
      link: rel,       // relative path (kept for backward compatibility)
      url: full,       // absolute URL (this fixes "Unknown Error")
      email: email || process.env.GMAIL_USER,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

// simple homepage so hitting the root doesn't show "Cannot GET /"
app.get("/", (_req, res) => {
  res.type("text").send(
    `Mediad AutoDirector\n\nEndpoints:\nGET  /health\nPOST /quick {url, email?}\nStatic: /runs/<file>`
  );
});

app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














