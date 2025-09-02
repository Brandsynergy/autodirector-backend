// server.js (ESM)
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Ensure folders exist
const RUNS_DIR = path.join(__dirname, "runs");
const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/runs", express.static(RUNS_DIR));
app.use(express.static(PUBLIC_DIR));

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mediad-autodirector",
    time: new Date().toISOString(),
  });
});

// Helpers
const absUrl = (req, rel) =>
  new URL(rel, `${req.protocol}://${req.get("host")}`).toString();

const rand = () => Math.random().toString(16).slice(2, 10);

// ---------- ACTION EXECUTORS ----------
async function doScreenshot(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const filename = `${Date.now()}-${rand()}.png`;
    const filepath = path.join(RUNS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    return { filepath, filename };
  } finally {
    await browser.close();
  }
}

function mailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars (needed for email)."
    );
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

async function sendEmailWithAttachment({ to, subject, text, attachmentPath }) {
  const transport = mailer();
  const user = process.env.GMAIL_USER;
  const mailTo = to || user;
  await transport.sendMail({
    from: user,
    to: mailTo,
    subject: subject || "AutoDirector",
    text: text || "See attachment.",
    attachments: attachmentPath
      ? [{ filename: path.basename(attachmentPath), path: attachmentPath }]
      : undefined,
  });
  return { to: mailTo };
}

async function extractLinks(url, count = 3) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const out = anchors
        .map((a) => a.href.trim())
        .filter((u) => u.startsWith("http"));
      // de-dupe
      return Array.from(new Set(out));
    });
    return links.slice(0, count);
  } finally {
    await browser.close();
  }
}

async function createImageWithOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set (needed for image generation).");
  }
  // Use the HTTP API directly; no response_format param, avoids earlier errors.
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
      // return base64
      response_format: "b64_json",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error: ${text}`);
  }
  const data = await resp.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned.");

  const buf = Buffer.from(b64, "base64");
  const filename = `${Date.now()}-${rand()}-img.png`;
  const filepath = path.join(RUNS_DIR, filename);
  fs.writeFileSync(filepath, buf);
  return { filepath, filename };
}

// ---------- /plan : VERY SIMPLE RULE-BASED PARSER ----------
app.post("/plan", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const lower = prompt.toLowerCase();

    // Grab first URL + email if present
    const urlMatch = prompt.match(
      /(https?:\/\/[^\s"']+)|(www\.[^\s"']+)/i
    );
    const emailMatch = prompt.match(
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
    );
    const url = urlMatch ? (urlMatch[1] || urlMatch[2]) : null;
    const to = emailMatch ? emailMatch[0] : null;

    let steps = [];
    let kind = "unknown";

    if (lower.includes("screenshot") && url) {
      kind = "screenshot";
      steps.push({ action: "screenshot_url", url });
      steps.push({ action: "gmail_send_last", to });
    } else if (
      (lower.includes("create image") ||
        lower.includes("generate image") ||
        lower.includes("picture")) &&
      prompt
    ) {
      kind = "create_image";
      const imagePrompt = prompt.replace(/send.*$/i, "").trim();
      steps.push({ action: "create_image", prompt: imagePrompt });
      steps.push({ action: "gmail_send_last", to });
    } else if (
      (lower.includes("get the latest links") ||
        lower.includes("extract links") ||
        lower.includes("send links")) &&
      url
    ) {
      kind = "links";
      const count = /(\d+)\s*links/.test(lower)
        ? parseInt(lower.match(/(\d+)\s*links/)[1], 10)
        : 3;
      steps.push({ action: "extract_links", url, count });
      steps.push({ action: "gmail_send_text", to });
    } else {
      return res.json({ ok: false, error: "No URL detected in your prompt." });
    }

    return res.json({
      ok: true,
      plan: { kind, url, to },
      steps,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- /run : EXECUTE STEPS ----------
app.post("/run", async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;
  if (!steps || steps.length === 0) {
    return res.json({ ok: false, error: "No steps provided" });
  }
  const results = [];
  const state = {}; // to carry last file or text between steps

  try {
    for (const step of steps) {
      const { action } = step;
      if (action === "screenshot_url") {
        const { filepath, filename } = await doScreenshot(step.url);
        state.lastFilePath = filepath;
        results.push({
          action,
          path: `/runs/${filename}`,
        });
      } else if (action === "gmail_send_last") {
        if (!state.lastFilePath && !step.attachmentPath) {
          throw new Error("No attachment available to send.");
        }
        const sent = await sendEmailWithAttachment({
          to: step.to,
          subject: "AutoDirector Result",
          text: "See attached file.",
          attachmentPath: step.attachmentPath || state.lastFilePath,
        });
        results.push({ action, to: sent.to });
      } else if (action === "extract_links") {
        const links = await extractLinks(step.url, step.count || 3);
        state.text = links.join("\n");
        results.push({ action, links });
      } else if (action === "gmail_send_text") {
        const text = step.text || state.text || "(no text)";
        const sent = await sendEmailWithAttachment({
          to: step.to,
          subject: "AutoDirector Links",
          text,
        });
        results.push({ action, to: sent.to });
      } else if (action === "create_image") {
        const { filepath, filename } = await createImageWithOpenAI(
          step.prompt
        );
        state.lastFilePath = filepath;
        results.push({ action, path: `/runs/${filename}` });
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
    }

    return res.json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Fallback: serve the app
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Mediad AutoDirector listening on ${PORT}`);
});
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














