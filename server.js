import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use("/runs", express.static("runs"));
app.use("/", express.static("public"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FREE_CREDITS = Number(process.env.FREE_CREDITS_ON_SIGNUP || 100);

// simple in-memory store
const users = new Map(); // id -> { credits }
const runs  = new Map(); // id -> { status, logs, shots, videoUrl }
function ensureUser(id){ if(!users.has(id)) users.set(id, { credits: FREE_CREDITS }); return users.get(id); }
function pushLog(r, m){ r.logs.push(new Date().toISOString()+" "+m); }

app.get("/api/health", (_,res)=> res.json({ ok:true }));

app.get("/api/user", (req,res)=>{
  const id = req.headers["x-anon-id"] || "public";
  const u = ensureUser(id);
  res.json({ id, credits: u.credits });
});

app.post("/api/plan", async (req,res)=>{
  const text = (req.body?.prompt || "").slice(0, 800);

  // Short-circuit for Gmail forwarding (no browser)
  const matches = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
  const gmailUser = (process.env.GMAIL_USER || "").toLowerCase();
  const dest = matches.find(e => e.toLowerCase() !== gmailUser);

  if (/gmail|email/i.test(text) && /forward/i.test(text) && dest) {
    return res.json({ flow: { steps: [ { action: "gmail_forward_last", to: dest } ] }, valid: true });
  }

  // Planner for generic browser steps + summarize/email step
  const sys =
`Output ONLY JSON: {start_url?: string, steps: Array<
 {action:'goto', url?:string} |
 {action:'click', selector:string} |
 {action:'type', selector:string, text:string, enter?:boolean} |
 {action:'wait', state:'load'|'domcontentloaded'|'networkidle'} |
 {action:'screenshot'} |
 {action:'summarize_and_email', to:string, note?:string} |
 {action:'gmail_forward_last', to:string}
>}
Rules:
- If task mentions "email it to <address>" for web results, include a final step:
  {"action":"summarize_and_email","to":"address"} after navigation/search.
- Use 'goto' → 'wait' → 'type' (with enter) patterns for searches.
- No commentary; JSON only.`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "system", content: sys }, { role: "user", content: `Create a plan for: ${text}` }],
    response_format: { type: "json_object" }
  });
  let flow = { steps: [] };
  try { flow = JSON.parse(r.choices?.[0]?.message?.content || "{}"); } catch {}
  res.json({ flow, valid: Array.isArray(flow.steps) });
});

app.post("/api/run", async (req,res)=>{
  const userId = req.headers["x-anon-id"] || "public";
  const u = ensureUser(userId);
  const START_COST = 25;
  if (u.credits < START_COST) return res.status(402).json({ error: "Low credits" });
  u.credits -= START_COST;

  const id = uuidv4();
  const flow = req.body?.flow || { steps: [] };
  runs.set(id, { status:"running", logs:[], shots:[], videoUrl:null });
  res.json({ id, status:"running" });

  (async()=>{
    const r = runs.get(id);
    const log = (m)=>pushLog(r, m);

    try{
      // Special Gmail action (no browser)
      if (flow.steps?.length === 1 && flow.steps[0].action === "gmail_forward_last"){
        log(`gmail_forward_last → ${flow.steps[0].to}`);
        await forwardLastEmail(flow.steps[0].to, log);
        r.status = "done";
        return;
      }

      // Browser automation
      const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const context = await browser.newContext({
        recordVideo: { dir: "runs" },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
      });
      const page = await context.newPage();

      const screenshot = async (label)=>{
        const p = path.join("runs", `${id}-${Date.now()}.png`);
        await page.screenshot({ path: p, fullPage: true });
        r.shots.push({ url: `/${p}`, label });
      };

      if (flow.start_url) {
        log("goto " + flow.start_url);
        await page.goto(flow.start_url, { waitUntil: "domcontentloaded" });
        await handleGoogleConsent(page, log);
        await screenshot("after-start");
      }

      for (const [i,s] of (flow.steps||[]).entries()){
        if (s.action === "goto"){
          const url = s.url || s.text || "";
          log(`[${i}] goto ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await handleGoogleConsent(page, log);
          await screenshot("after-goto");
        } else if (s.action === "click"){
          log(`[${i}] click ${s.selector}`);
          await page.click(s.selector);
          await screenshot("after-click");
        } else if (s.action === "type"){
          log(`[${i}] type ${s.selector}`);
          try{
            // wait for the field to be visible, then type
            await page.locator(s.selector).first().waitFor({ state: "visible", timeout: 5000 });
            await page.fill(s.selector, s.text || "");
          } catch {
            // Fallback for Google News: open the search UI then fill
            if (page.url().includes("news.google.")) {
              log(`[${i}] fallback: open search UI`);
              await page.locator('button[aria-label="Search"]').first().click({ timeout: 2000 }).catch(()=>{});
              await page.locator('input[aria-label="Search"]').first().fill(s.text || "", { timeout: 5000 }).catch(()=>{});
            } else {
              throw new Error(`Unable to type into ${s.selector}`);
            }
          }
          if (s.enter) await page.keyboard.press("Enter");
          await screenshot("after-type");
        } else if (s.action === "wait"){
          log(`[${i}] wait ${s.state}`);
          await page.waitForLoadState(s.state || "load");
          await screenshot("after-wait");
        } else if (s.action === "screenshot"){
          log(`[${i}] screenshot`);
          await screenshot("manual");
        } else if (s.action === "summarize_and_email"){
          log(`[${i}] summarize_and_email → ${s.to}`);
          const summary = await summarizePageForEmail(page);
          await sendEmail({
            to: s.to,
            subject: "Requested summary",
            text: summary
          });
          log(`[${i}] email sent`);
        } else if (s.action === "gmail_forward_last"){
          log(`[${i}] gmail_forward_last → ${s.to}`);
          await forwardLastEmail(s.to, log);
        }
      }

      await page.close();
      const v = await page.video()?.path().catch(()=>null);
      await context.close(); await browser.close();

      r.videoUrl = v ? `/${v}` : null;
      r.status = "done";
    }catch(e){
      log(`ERROR: ${e.message}`);
      r.status = "error";
    }
  })();
});

app.get("/api/run/:id", (req,res)=>{
  const userId = req.headers["x-anon-id"] || "public";
  const u = ensureUser(userId);
  const r = runs.get(req.params.id);
  if(!r) return res.status(404).json({ error:"Not found" });
  res.json({ ...r, credits_after: u.credits });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log("AutoDirector service listening on " + PORT));

/* ---------- Helpers ---------- */

// Click Google/EU consent if it appears (safe no-op if not present)
async function handleGoogleConsent(page, log=()=>{}){
  const tryClick = async (scope) => {
    const sels = [
      'button:has-text("I agree")',
      'button:has-text("Accept all")',
      '#L2AG',
      'div[role="button"]:has-text("I agree")',
      'button:has-text("Accept")'
    ];
    for (const s of sels){
      try {
        const el = scope.locator(s).first();
        if (await el.count()) {
          await el.click({ timeout: 1500 });
          log(`consent: clicked ${s}`);
          return true;
        }
      } catch {}
    }
    return false;
  };

  try {
    // top-level
    if (await tryClick(page)) return;
    // in iframes
    for (const f of page.frames()){
      if (f === page.mainFrame()) continue;
      if (await tryClick(f)) return;
    }
  } catch {}
}

// Summarize visible page text and return a short email body
async function summarizePageForEmail(page){
  const visibleText = await page.evaluate(()=>document.body.innerText.slice(0, 20000));
  const prompt = `From the following page text, extract the 5 most relevant recent headlines (with their site names if present). 
Return plain text bullets like: "- Title — Source". Keep it under 1200 characters.
Text:
${visibleText}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "system", content: "You write concise, factual bullet summaries." }, { role: "user", content: prompt }]
  });
  return resp.choices?.[0]?.message?.content?.trim() || "(no summary)";
}

async function sendEmail({ to, subject, text }){
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not set");

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }
  });
  await transporter.sendMail({ from: user, to, subject, text });
}

// Forward most recent email
async function forwardLastEmail(to, log=()=>{}) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not set");

  const imap = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass }
  });
  await imap.connect();
  const box = await imap.selectMailbox("INBOX");
  if (!box.exists) { await imap.logout(); throw new Error("No messages in INBOX"); }
  const seq = box.exists;
  const msg = await imap.fetchOne(seq, { envelope: true, source: true });
  const subject = (msg?.envelope?.subject) || "(no subject)";
  const raw = msg?.source?.toString("utf8") || "";
  await imap.logout();

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }
  });

  const info = await transporter.sendMail({
    from: user,
    to,
    subject: `Fwd: ${subject}`,
    text: `Forwarded message (raw below):\n\n${raw.slice(0, 100000)}`
  });

  log(`Forwarded with MessageID: ${info.messageId}`);
}





