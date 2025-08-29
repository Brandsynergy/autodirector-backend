// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));

// --- Static assets ---
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/runs", express.static(path.join(__dirname, "runs"), { fallthrough: false }));

// --- Health check ---
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --- Frontend ---
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Helper: email sender (uses Gmail app password) ---
async function sendEmail({ to, subject, text, attachments = [] }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD; // app password (not your normal login)
  if (!user || !pass) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars.");
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: user,
    to,
    subject,
    text,
    attachments,
  });
}

// --- Helper: screenshot ---
async function takeScreenshot(url) {
  const runsDir = path.join(__dirname, "runs");
  if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });

  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const outPath = path.join(runsDir, `${id}-shot.png`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();

  // public URL
  const publicUrl = `/runs/${path.basename(outPath)}`;
  return { filePath: outPath, publicUrl };
}

// --- “Plan” endpoint (very simple planner) ---
app.post("/plan", async (req, res) => {
  try {
    const prompt = `${req.body?.prompt || ""}`.toLowerCase();

    // Naive parse: "screenshot <url> and email to <address>"
    const urlMatch = prompt.match(/https?:\/\/\S+/i);
    const emailMatch = prompt.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);

    const steps = [];
    if (urlMatch) steps.push({ action: "screenshot_url", url: urlMatch[0] });
    if (emailMatch) steps.push({ action: "email_last_screenshot", to: emailMatch[0] });

    res.json({ steps: steps.length ? steps : [{ action: "noop" }] });
  } catch (e) {
    res.status(500).json({ error: e.message || "plan_failed" });
  }
});

// --- “Run” endpoint executes steps ---
app.post("/run", async (req, res) => {
  const logs = [];
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    let lastShot = null;

    for (const step of steps) {
      if (step.action === "screenshot_url") {
        logs.push(`screenshot_url ${step.url}`);
        const shot = await takeScreenshot(step.url);
        lastShot = shot;
        // Return absolute URL to the client
        const base = process.env.BASE_URL || ""; // set on Render if you want absolute URLs
        logs.push(`done: ${base}${shot.publicUrl}`);
      } else if (step.action === "email_last_screenshot" && lastShot) {
        logs.push(`email_last_screenshot -> ${step.to}`);
        await sendEmail({
          to: step.to,
          subject: "Mediad AutoDirector – screenshot",
          text: "Attached is your screenshot.",
          attachments: [{ filename: path.basename(lastShot.filePath), path: lastShot.filePath }],
        });
        logs.push("email_sent");
      } else {
        logs.push(`skip ${step.action}`);
      }
    }

    res.json({ ok: true, logs });
  } catch (e) {
    logs.push(`ERROR: ${e.message}`);
    res.status(500).json({ ok: false, logs });
  }
});

// --- Error fallthrough (keep very simple) ---
app.use((err, _req, res, _next) => {
  res.status(500).send("Unknown Error");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














