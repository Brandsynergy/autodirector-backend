// Mediad AutoDirector – backend
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { chromium } from "playwright"; // provided by the Docker base image

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- middleware ----------
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// serve static assets
app.use(express.static(path.join(__dirname, "public")));       // /logo.png, /index.html
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/runs", express.static(path.join(__dirname, "runs"))); // screenshots & videos

// ---------- tiny in-memory run store ----------
const runs = new Map(); // id -> {status, logs[], shots[], videoUrl?}

// ---------- helper: simple planner from natural text ----------
function planFromPrompt(prompt) {
  const p = (prompt || "").trim();
  const urlMatch = p.match(/https?:\/\/\S+/i);
  const wantsPdf = /\bpdf\b/i.test(p);
  const wantsShot = /\bscreenshot\b/i.test(p) || !wantsPdf;
  const emailToMatch =
    p.match(/\bemail\s+to\s+([^\s"“”']+)|\bto:\s*([^\s"“”']+)/i);
  let to =
    (emailToMatch && (emailToMatch[1] || emailToMatch[2])) || null;
  if (to && (to.includes("…") || to.includes("..."))) to = null; // ignore ellipsis

  const steps = [];
  if (urlMatch) {
    const url = urlMatch[0].replace(/[””'")]+$/, "");
    if (wantsPdf) steps.push({ action: "pdf_url", url });
    if (wantsShot) steps.push({ action: "screenshot_url", url });
  }
  if (to) steps.push({ action: "email_results", to });

  return { steps };
}

// ---------- email helper (optional) ----------
async function sendEmail({ to, subject, text, attachments = [] }) {
  const {
    SMTP_HOST,
    SMTP_PORT = "587",
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE = "false"
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { ok: false, message: "SMTP not configured; skipped email." };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: `"Mediad AutoDirector" <${SMTP_USER}>`,
    to,
    subject,
    text,
    attachments
  });

  return { ok: true };
}

// ---------- API: plan ----------
app.post("/api/plan", (req, res) => {
  try {
    const { prompt } = req.body || {};
    const flow = planFromPrompt(prompt);
    return res.json({ flow });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ---------- API: run ----------
app.post("/api/run", async (req, res) => {
  const { flow } = req.body || {};
  if (!flow || !Array.isArray(flow.steps)) {
    return res.status(400).json({ error: "Invalid flow" });
  }

  const id = uuidv4();
  runs.set(id, { status: "running", logs: [], shots: [] });
  res.json({ id });

  (async () => {
    const log = (msg) => {
      const r = runs.get(id);
      if (!r) return;
      r.logs.push(new Date().toISOString() + " " + msg);
    };

    let browser, context, page;
    try {
      // Prepare Playwright with video recording
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        recordVideo: { dir: path.join(__dirname, "runs", id + "_video") }
      });
      page = await context.newPage();

      for (const step of flow.steps) {
        if (step.action === "screenshot_url") {
          log(`screenshot_url ${step.url}`);
          await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(1500);
          const shotPath = path.join("runs", `${id}-shot.png`);
          await page.screenshot({ path: path.join(__dirname, shotPath), fullPage: true });
          const r = runs.get(id);
          r.shots.push({ url: `/${shotPath}` });
        }

        if (step.action === "pdf_url") {
          log(`pdf_url ${step.url}`);
          await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(1500);
          const pdfPath = path.join("runs", `${id}.pdf`);
          try {
            await page.pdf({ path: path.join(__dirname, pdfPath), format: "A4", printBackground: true });
            const r = runs.get(id);
            r.pdfUrl = `/${pdfPath}`;
          } catch (e) {
            log("page.pdf not supported on this build; skipped.");
          }
        }

        if (step.action === "email_results") {
          const r = runs.get(id);
          const attachments = [];

          if (r?.shots?.length) {
            const p = r.shots[0].url.replace(/^\//, "");
            attachments.push({ filename: "screenshot.png", path: path.join(__dirname, p) });
          }
          if (r?.pdfUrl) {
            const p = r.pdfUrl.replace(/^\//, "");
            attachments.push({ filename: "page.pdf", path: path.join(__dirname, p) });
          }

          log(`email_results → ${step.to}`);
          const resp = await sendEmail({
            to: step.to,
            subject: "Mediad AutoDirector results",
            text: "See attached file(s) produced by your automation.",
            attachments
          });
          log(resp.ok ? "email sent" : resp.message);
        }
      }

      // Capture video link if exists
      try {
        const v = await page.video();
        if (v) {
          const p = await v.path();
          // Playwright writes as .webm in the recordVideo dir
          const rel = path.relative(__dirname, p);
          const r = runs.get(id);
          if (r) r.videoUrl = "/" + rel.replace(/\\/g, "/");
        }
      } catch (_) {}

      await context.close();
      await browser.close();

      const r = runs.get(id);
      if (r) r.status = "done";
    } catch (e) {
      const r = runs.get(id);
      if (r) {
        r.status = "error";
        r.logs.push("ERROR: " + String(e));
      }
      try { await context?.close(); await browser?.close(); } catch {}
    }
  })();
});

// ---------- API: poll run ----------
app.get("/api/run/:id", (req, res) => {
  const r = runs.get(req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  res.json(r);
});

// health + SPA fallback
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`AutoDirector service listening on ${PORT}`);
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














