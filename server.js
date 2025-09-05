import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config ----------
const PORT = process.env.PORT || 10000;
const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// Gmail creds must be set in Render env vars
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD
  }
});

// ---------- helpers ----------
function normalizeUrl(input) {
  if (!input) return null;
  let u = String(input).trim();

  // fix common typo: https;//  or http;//
  u = u.replace(/;\/\//g, "://");

  // prepend https if missing scheme
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;

  try {
    return new URL(u).toString();
  } catch (_) {
    return null;
  }
}

function nowId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

// Always return an HTTPS absolute URL on Render
function getAbs(req, relPath) {
  const host = req.get("host");
  const protoHeader = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = protoHeader || req.protocol || "https";
  const base = `${proto}://${host}`;
  const url = new URL(relPath, base);
  if (host && host.endsWith(".onrender.com")) url.protocol = "https:";
  return url.toString();
}

async function takeScreenshot(url) {
  const id = nowId();
  const outPath = path.join(RUNS_DIR, `${id}.png`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();
  return outPath;
}

async function savePdf(url) {
  const id = nowId();
  const outPath = path.join(RUNS_DIR, `${id}.pdf`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.pdf({ path: outPath, format: "A4", printBackground: true });
  await browser.close();
  return outPath;
}

async function extractLinks(url, count = 3) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const links = await page.$$eval("a", (as) =>
    as
      .map((a) => ({
        href: a.href || "",
        text: (a.textContent || "").trim().replace(/\s+/g, " ")
      }))
      .filter((x) => x.href.startsWith("http"))
  );

  await browser.close();
  return links.slice(0, Math.max(1, Math.min(20, count)));
}

async function sendEmail({ to, subject, text, html, attachments = [] }) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }
  await transporter.sendMail({
    from: GMAIL_USER,
    to,
    subject,
    text,
    html,
    attachments
  });
}

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/runs", express.static(RUNS_DIR));
app.use("/", express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() });
});

// Quick tool: screenshot + optional email
app.post("/quick", async (req, res) => {
  try {
    const raw = req.body?.url;
    const email = (req.body?.email || "").trim();
    const url = normalizeUrl(raw);
    if (!url) return res.status(400).json({ ok: false, error: "Invalid URL" });

    const filePath = await takeScreenshot(url);
    const fileRel = "/runs/" + path.basename(filePath);
    const absolute = getAbs(req, fileRel);

    if (email) {
      const subject = "Mediad AutoDirector – Screenshot";
      const text = `Here is the screenshot for ${url}.\n\nLink: ${absolute}`;
      const html = `<p>Here is the screenshot for <a href="${url}">${url}</a>.</p><p><a href="${absolute}">${absolute}</a></p>`;
      await sendEmail({
        to: email,
        subject,
        text,
        html,
        attachments: [{ filename: path.basename(filePath), path: filePath }]
      });
    }

    res.json({ ok: true, link: fileRel, url: absolute, email: email || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- PLAN (very simple parser) ----------
app.post("/plan", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.json({ ok: false, error: "Missing prompt" });

    // Pull the first URL-like string in the prompt
    const urlMatch = prompt.match(/https?[s]?:\/\/[^\s"']+|(?:\b[\w.-]+\.[a-z]{2,}\b)/i);
    const rawUrl = urlMatch ? urlMatch[0] : null;
    const url = normalizeUrl(rawUrl);

    const toMatch = prompt.match(/[^\s]+@[^\s]+/);
    const to = toMatch ? toMatch[0] : null;

    const lower = prompt.toLowerCase();

    let steps = [];
    let kind = "general";

    if (/screenshot/.test(lower) && url) {
      kind = "screenshot";
      steps.push({ action: "screenshot_url", url });
      if (to) steps.push({ action: "gmail_send_last", to });
    } else if ((/pdf/.test(lower) || /save.*as.*pdf/.test(lower)) && url) {
      kind = "pdf";
      steps.push({ action: "pdf_url", url });
      if (to) steps.push({ action: "gmail_send_last", to });
    } else if (/links?/.test(lower) && url) {
      kind = "links";
      const count = /top\s+(\d+)/.test(lower) ? parseInt(lower.match(/top\s+(\d+)/)[1]) : 3;
      steps.push({ action: "extract_links", url, count });
      if (to) steps.push({ action: "gmail_send_text", to });
    }

    res.json({
      ok: true,
      plan: { kind, url, to, count: steps.find(s => s.action === "extract_links")?.count || null },
      steps
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- RUN ----------
app.post("/run", async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  if (!steps.length) return res.json({ ok: false, error: "No steps provided" });

  const results = [];
  try {
    for (const step of steps) {
      const name = step.action;

      if (name === "screenshot_url") {
        const url = normalizeUrl(step.url);
        if (!url) throw new Error("screenshot_url requires a valid 'url'");
        const filePath = await takeScreenshot(url);
        results.push({ action: name, path: filePath, rel: "/runs/" + path.basename(filePath) });
      }

      else if (name === "pdf_url") {
        const url = normalizeUrl(step.url);
        if (!url) throw new Error("pdf_url requires a valid 'url'");
        const filePath = await savePdf(url);
        results.push({ action: name, path: filePath, rel: "/runs/" + path.basename(filePath) });
      }

      else if (name === "extract_links") {
        const url = normalizeUrl(step.url);
        if (!url) throw new Error("extract_links requires a valid 'url'");
        const count = step.count || 3;
        const links = await extractLinks(url, count);
        results.push({ action: name, links });
      }

      else if (name === "gmail_send_last") {
        const to = step.to;
        if (!to) throw new Error("gmail_send_last requires 'to'");
        const last = results[results.length - 1] || {};
        const subject = "Mediad AutoDirector – result";

        let text = "See attached result.";
        let html = "<p>See attached result.</p>";

        const attachments = [];
        if (last.path && fs.existsSync(last.path)) {
          attachments.push({ filename: path.basename(last.path), path: last.path });
          const rel = "/runs/" + path.basename(last.path);
          const abs = getAbs(req, rel);
          text += `\n\nLink: ${abs}`;
          html += `<p><a href="${abs}">${abs}</a></p>`;
        } else if (Array.isArray(last.links) && last.links.length > 0) {
          text = last.links.map((l, i) => `${i + 1}. ${l.text} — ${l.href}`).join("\n");
          html = "<h3>Links</h3><ol>" +
                 last.links.map((l) => `<li><a href="${l.href}">${l.text}</a></li>`).join("") +
                 "</ol>";
        } else {
          text = "No file or links available from the previous step.";
          html = "<p><b>No file or links available</b> from the previous step.</p>";
        }

        // Always add small debug so emails are never blank
        const debug = JSON.stringify(last, null, 2);
        text += `\n\n---\nDebug:\n${debug}`;
        html += `<hr><pre style="white-space:pre-wrap;font-family:monospace">${debug}</pre>`;

        await sendEmail({ to, subject, text, html, attachments });
        results.push({ action: name, to, sent: true });
      }

      else if (name === "gmail_send_text") {
        const to = step.to;
        if (!to) throw new Error("gmail_send_text requires 'to'");
        const last = results[results.length - 1] || {};
        const subject = "Mediad AutoDirector – results";

        let text = "See results below.";
        let html = "<p>See results below.</p>";

        if (Array.isArray(last.links) && last.links.length > 0) {
          text = last.links.map((l, i) => `${i + 1}. ${l.text} — ${l.href}`).join("\n");
          html = "<h3>Links</h3><ol>" +
                 last.links.map((l) => `<li><a href="${l.href}">${l.text}</a></li>`).join("") +
                 "</ol>";
        } else if (Array.isArray(last.links) && last.links.length === 0) {
          text = "No links were found on that page.";
          html = "<p><b>No links were found</b> on that page.</p>";
        } else if (last.action) {
          text = `No items were returned by action "${last.action}".`;
          html = `<p>No items were returned by action "<b>${last.action}</b>".</p>`;
        }

        const debug = JSON.stringify(last, null, 2);
        text += `\n\n---\nDebug:\n${debug}`;
        html += `<hr><pre style="white-space:pre-wrap;font-family:monospace">${debug}</pre>`;

        await sendEmail({ to, subject, text, html });
        results.push({ action: name, to, sent: true });
      }

      else {
        throw new Error(`Unknown action: ${name}`);
      }
    }

    res.json({ ok: true, results: results.map((r) => {
      if (r.rel) return { action: r.action, path: r.rel };
      return r;
    })});
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mediad backend listening on ${PORT}`);
});
                                                                                                                                                                                                                                                                                                                                
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                                   
  
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                            
  
  
  
                                                                                                                        
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                                          
  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














