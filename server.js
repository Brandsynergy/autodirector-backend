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
const runs = new Map();  // id -> { status, logs, shots, videoUrl }
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

  const sys =
`Output ONLY JSON: {start_url?: string, steps: Array<
 {action:'goto', url?:string} |
 {action:'click', selector:string} |
 {action:'type', selector:string, text:string, enter?:boolean} |
 {action:'wait', state:'load'|'domcontentloaded'|'networkidle'} |
 {action:'screenshot'} |
 {action:'gmail_forward_last', to:string}
>}
Rules:
- If task mentions Gmail forwarding, output only {"action":"gmail_forward_last","to":"..."}.
- Otherwise use normal browser steps.
- No commentary. JSON only.`;

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
      // Special Gmail action
      if (flow.steps?.length === 1 && flow.steps[0].action === "gmail_forward_last"){
        log(`gmail_forward_last → ${flow.steps[0].to}`);
        await forwardLastEmail(flow.steps[0].to, log);
        r.status = "done";
        return;
      }

      // Browser automation path
      const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const context = await browser.newContext({
        recordVideo: { dir: "runs" },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
      });
      const page = await context.newPage();

      if (flow.start_url) {
        log("goto " + flow.start_url);
        await page.goto(flow.start_url, { waitUntil: "domcontentloaded" });
      }

      for (const [i,s] of (flow.steps||[]).entries()){
        if (s.action === "goto"){
          const url = s.url || s.text || "";
          log(`[${i}] goto ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });
        } else if (s.action === "click"){
          log(`[${i}] click ${s.selector}`);
          await page.click(s.selector);
        } else if (s.action === "type"){
          log(`[${i}] type ${s.selector}`);
          await page.fill(s.selector, s.text || "");
          if (s.enter) await page.keyboard.press("Enter");
        } else if (s.action === "wait"){
          log(`[${i}] wait ${s.state}`);
          await page.waitForLoadState(s.state || "load");
        } else if (s.action === "screenshot"){
          log(`[${i}] screenshot`);
          const p = path.join("runs", `${id}-${i}.png`);
          await page.screenshot({ path: p, fullPage: true });
          r.shots.push({ url: `/${p}` });
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

/* ---------- Gmail helper ---------- */
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




