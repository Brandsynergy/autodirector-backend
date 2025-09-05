// server.js  — Mediad AutoDirector (ESM)

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// create the app FIRST
const app = express();
const PORT = process.env.PORT || 10000;

// middleware
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// static folders
app.use("/runs", express.static(path.join(__dirname, "runs")));
app.use("/", express.static(path.join(__dirname, "public")));

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// -------- helpers --------

function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  // fix common typos like "https;//"
  s = s.replace(/^https;\//i, "https://").replace(/^http;\//i, "http://");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

async function takeScreenshot(url) {
  // lazy import so the server boots even if playwright isn’t ready yet
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

// -------- endpoints --------

// 1) Quick: one-shot (URL → screenshot → optional email)
app.post("/quick", async (req, res) => {
  try {
    const rawUrl = req.body?.url;
    const email = req.body?.email || undefined;
    const url = normalizeUrl(rawUrl);
    if (!url) return res.status(400).json({ ok: false, error: "Missing or invalid url" });

    const snap = await takeScreenshot(url);

    let emailResult = null;
    if (email) {
      emailResult = await sendEmail({
        to: email,
        subject: `Screenshot: ${new URL(url).hostname}`,
        text: `Screenshot of ${url} is attached.\nDirect link: ${req.protocol}://${req.get("host")}${snap.href}`,
        html: `<p>Screenshot of <a href="${url}">${url}</a> is attached.</p><p>Direct link: <a href="${snap.href}">${snap.href}</a></p>`,
        attachmentPath: snap.path,
      });
    }

    res.json({
      ok: true,
      link: snap.href,
      url: `${req.protocol}://${req.get("host")}${snap.href}`,
      email: emailResult?.to || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "unknown error" });
  }
});

// 2) Plan: extract steps from a simple English instruction
app.post("/plan", (req, res) => {
  const prompt = String(req.body?.prompt || "");
  // very simple pattern: “Screenshot <url> and email it to <email>”
  const m = prompt.match(/screenshot\s+(\S+)\s+and\s+email\s+it\s+to\s+([^\s]+)/i);
  const url = m?.[1] ? normalizeUrl(m[1]) : null;
  const to = m?.[2] ? m[2].replace(/[.,]$/, "") : null;

  const steps = [];
  if (url) steps.push({ action: "screenshot_url", url });
  if (to) steps.push({ action: "gmail_send_last", to });

  res.json({ ok: true, plan: { kind: "general", url, to }, steps });
});

let lastScreenshotPath = null;

// 3) Run: execute the steps from /plan
app.post("/run", async (req, res) => {
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
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || "unknown error" });
  }
});

// homepage fallback (if static misses for any reason)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// start
app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                                                                                                                                
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














