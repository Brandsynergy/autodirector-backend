import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
// ⬇️ Cheerio fix: use named export "load"
import { load as cheerioLoad } from "cheerio";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/runs", express.static("runs"));
app.use("/", express.static("public"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FREE_CREDITS = Number(process.env.FREE_CREDITS_ON_SIGNUP || 300);

// simple in-memory
const users = new Map(); // id -> { credits }
const runs  = new Map(); // id -> { status, logs, shots, videoUrl }
const pushLog = (r, m) => r.logs.push(new Date().toISOString()+" "+m);
const ensureUser = (id) => { if(!users.has(id)) users.set(id, { credits: FREE_CREDITS }); return users.get(id); };

// file persistence (JSON stores)
const storesDir = "runs";
const files = {
  monitors: path.join(storesDir, "monitors.json"),
  briefings: path.join(storesDir, "briefings.json"),
  compwatch: path.join(storesDir, "compwatch.json"),
  jobalerts: path.join(storesDir, "jobalerts.json"),
  inboxRules: path.join(storesDir, "inbox_rules.json")
};
await fsp.mkdir(storesDir, { recursive: true });
async function loadJSON(p, d){ try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return d; } }
async function saveJSON(p, obj){ await fsp.writeFile(p, JSON.stringify(obj, null, 2)); }

// email helper
async function sendEmail({ to, subject, text, html, attachments }){
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not set");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }
  });
  await transporter.sendMail({ from: user, to, subject, text, html, attachments });
}

// ---------- health & user ----------
app.get("/api/health", (_,res)=> res.json({ ok:true }));
app.get("/api/user", (req,res)=>{
  const id = req.headers["x-anon-id"] || "public";
  const u = ensureUser(id);
  res.json({ id, credits: u.credits });
});

// ---------- planning ----------
app.post("/api/plan", async (req,res)=>{
  const text = (req.body?.prompt || "").slice(0, 1000);

  // detect target email in free text
  const emails = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
  const me = (process.env.GMAIL_USER || "").toLowerCase();
  const target = emails.find(e => e.toLowerCase() !== me);

  // quick intent heuristics (no LLM needed for common cases)
  const urlMatch = text.match(/https?:\/\/\S+/i);

  // A1 Screenshot
  if (/(screenshot|snapshot)/i.test(text) && urlMatch){
    return res.json({ flow: { steps: [ { action: "screenshot_url", url: urlMatch[0], to: target } ] }, valid: true });
  }

  // A2 PDF
  if (/\b(pdf|save as pdf)\b/i.test(text) && urlMatch){
    return res.json({ flow: { steps: [ { action: "pdf_url", url: urlMatch[0], to: target } ] }, valid: true });
  }

  // A4 Google News briefing now (one-off)
  if (/google\s*news/i.test(text) && /email/i.test(text) && target){
    const m = text.match(/news\s+(on|about|for)\s+(.+?)(?:\s+to|\s+and|\s+at|$)/i);
    const query = (m?.[2] || text).replace(emails[0]||"", "").trim();
    return res.json({ flow: { steps: [ { action: "google_news_email", query, to: target } ] }, valid: true });
  }

  // A10 Gmail forward last
  if (/forward/i.test(text) && /gmail|email/i.test(text) && target){
    return res.json({ flow: { steps: [ { action: "gmail_forward_last", to: target } ] }, valid: true });
  }

  // Scheduling intents (A3, A4 weekly/daily, A5, A6)
  if (/monitor|change\s*watch|track/i.test(text) && urlMatch && target){
    return res.json({ flow: { steps: [ { action: "monitor_add", url: urlMatch[0], to: target } ] }, valid: true });
  }
  if (/daily|every\s+morning|weekly|every\s+week/i.test(text) && /google\s*news/i.test(text) && target){
    const m = text.match(/news\s+(on|about|for)\s+(.+?)(?:\s+to|\s+and|\s+at|$)/i);
    const query = (m?.[2] || "news").trim();
    const freq = /weekly|every\s+week/i.test(text) ? "weekly" : "daily";
    return res.json({ flow: { steps: [ { action: "briefing_add", topic: query, to: target, frequency: freq } ] }, valid: true });
  }
  if (/competitor/i.test(text) && /rss|feed|url/i.test(text) && target){
    return res.json({ flow: { steps: [ { action: "compwatch_add", feeds: emails.length ? [] : [], to: target } ] }, valid: true });
  }
  if (/job/i.test(text) && /alert/i.test(text) && target){
    return res.json({ flow: { steps: [ { action: "jobalert_add", keywords: "ai", feeds: [], to: target } ] }, valid: true });
  }

  // A7 Lead capture
  if (/extract|csv/i.test(text) && urlMatch){
    return res.json({ flow: { steps: [ { action: "extract_to_csv", url: urlMatch[0], selector: "a", to: target } ] }, valid: true });
  }

  // A8 SEO snapshot
  if (/seo|serp|search\s+snapshot/i.test(text) && target){
    const kw = text.replace(/.*snapshot\s*(on|for)?/i, "").replace(/to\s+.+/i, "").trim() || text;
    return res.json({ flow: { steps: [ { action: "seo_snapshot", keyword: kw, to: target } ] }, valid: true });
  }

  // A9 Uptime/content check now
  if (/(uptime|status|check)/i.test(text) && urlMatch){
    return res.json({ flow: { steps: [ { action: "uptime_check", url: urlMatch[0], to: target } ] }, valid: true });
  }

  // Fallback to LLM planner (generic browser plan)
  const sys =
`Output ONLY JSON: {start_url?: string, steps: Array<
 {action:'goto', url?:string} |
 {action:'click', selector:string} |
 {action:'type', selector:string, text:string, enter?:boolean} |
 {action:'wait', state:'load'|'domcontentloaded'|'networkidle'} |
 {action:'screenshot'} |
 {action:'screenshot_url', url:string, to?:string} |
 {action:'pdf_url', url:string, to?:string} |
 {action:'monitor_add', url:string, to:string} |
 {action:'briefing_add', topic:string, to:string, frequency:'daily'|'weekly'} |
 {action:'compwatch_add', feeds?:string[], to:string} |
 {action:'jobalert_add', keywords:string|string[], feeds?:string[], to:string} |
 {action:'extract_to_csv', url:string, selector?:string, to:string} |
 {action:'seo_snapshot', keyword:string, to:string} |
 {action:'uptime_check', url:string, expect_selector?:string, expect_text?:string, to?:string} |
 {action:'google_news_email', query:string, to:string} |
 {action:'gmail_forward_last', to:string}
>}
Rules:
- Prefer no-browser actions when available.
- Use *_add actions for schedules (daily/weekly).
- JSON only.`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: `Create a plan for: ${text}` }]
  });

  let flow; try { flow = JSON.parse(r.choices?.[0]?.message?.content || "{}"); } catch { flow = {}; }
  if (!Array.isArray(flow.steps) && flow.action) flow = { steps: [flow] };
  if (!Array.isArray(flow.steps)) flow = { steps: [] };
  res.json({ flow, valid: flow.steps.length > 0 });
});

// ---------- run ----------
app.post("/api/run", async (req,res)=>{
  const userId = req.headers["x-anon-id"] || "public";
  const u = ensureUser(userId);
  const START_COST = 25;
  if (u.credits < START_COST) return res.status(402).json({ error: "Low credits" });
  u.credits -= START_COST;

  const id = uuidv4();
  const flow = Array.isArray(req.body?.flow?.steps) ? req.body.flow : { steps: [req.body?.flow].filter(Boolean) };
  runs.set(id, { status:"running", logs:[], shots:[], videoUrl:null });
  res.json({ id, status:"running" });

  (async()=>{
    const r = runs.get(id);
    const log = (m)=>pushLog(r, m);

    try{
      // ----- NO-BROWSER ONE-SHOT ACTIONS -----
      const only = flow.steps.length === 1 ? flow.steps[0] : null;

      if (only?.action === "google_news_email"){
        log(`google_news_email "${only.query}" → ${only.to}`);
        const items = await fetchGoogleNews(only.query);
        const body = formatNewsEmail(items, only.query);
        await sendEmail({ to: only.to, subject: `Top Google News on ${only.query}`, text: body });
        log(`email sent`);
        r.status = "done"; return;
      }

      if (only?.action === "screenshot_url"){
        log(`screenshot_url ${only.url}`);
        const file = await screenshotURL(only.url);
        if (only.to) await sendEmail({ to: only.to, subject: `Screenshot: ${only.url}`, text: `Attached screenshot for ${only.url}`, attachments:[{ path: file, filename: path.basename(file) }] });
        log(`done: ${file}`);
        r.shots.push({ url: "/"+file.replace(/^[.]/,"") });
        r.status = "done"; return;
      }

      if (only?.action === "pdf_url"){
        log(`pdf_url ${only.url}`);
        const pdf = await pdfURL(only.url);
        if (only.to) await sendEmail({ to: only.to, subject: `PDF: ${only.url}`, text: `Attached PDF for ${only.url}`, attachments:[{ path: pdf, filename: path.basename(pdf) }] });
        log(`done: ${pdf}`);
        r.status = "done"; return;
      }

      if (only?.action === "uptime_check"){
        log(`uptime_check ${only.url}`);
        const result = await uptimeCheck(only);
        if (!result.ok && only.to){
          await sendEmail({ to: only.to, subject:`Uptime FAIL: ${only.url}`, text: result.message });
        }
        log(result.message);
        r.status = "done"; return;
      }

      if (only?.action === "seo_snapshot"){
        log(`seo_snapshot "${only.keyword}" → ${only.to}`);
        const body = await seoSnapshotEmailBody(only.keyword);
        await sendEmail({ to: only.to, subject:`SEO snapshot: ${only.keyword}`, text: body });
        log("email sent");
        r.status = "done"; return;
      }

      if (only?.action === "extract_to_csv"){
        log(`extract_to_csv ${only.url} selector=${only.selector||"a"}`);
        const { csvPath, count } = await extractToCSV(only.url, only.selector||"a");
        await sendEmail({ to: only.to, subject:`CSV extracted from ${only.url}`, text:`Rows: ${count}`, attachments:[{ path: csvPath, filename: path.basename(csvPath) }] });
        log(`csv rows=${count}`);
        r.status = "done"; return;
      }

      if (only?.action === "gmail_forward_last"){
        log(`gmail_forward_last → ${only.to}`);
        await forwardLastEmail(only.to, log);
        r.status = "done"; return;
      }

      if (only?.action === "briefing_add"){
        const briefings = await loadJSON(files.briefings, []);
        briefings.push({ topic: only.topic, to: only.to, frequency: only.frequency||"daily", next_run: null });
        await saveJSON(files.briefings, briefings);
        log(`briefing saved: ${only.topic} (${only.frequency}) → ${only.to}`);
        r.status = "done"; return;
      }

      if (only?.action === "monitor_add"){
        const monitors = await loadJSON(files.monitors, []);
        monitors.push({ url: only.url, to: only.to, last_hash: null });
        await saveJSON(files.monitors, monitors);
        log(`monitor saved: ${only.url} → ${only.to}`);
        r.status = "done"; return;
      }

      if (only?.action === "jobalert_add"){
        const jobs = await loadJSON(files.jobalerts, []);
        jobs.push({ to: only.to, keywords: Array.isArray(only.keywords) ? only.keywords : String(only.keywords||"").split(",").map(s=>s.trim()).filter(Boolean), feeds: only.feeds||[] });
        await saveJSON(files.jobalerts, jobs);
        log(`job alert saved for ${only.to}`);
        r.status = "done"; return;
      }

      if (only?.action === "compwatch_add"){
        const cw = await loadJSON(files.compwatch, []);
        cw.push({ to: only.to, feeds: only.feeds||[] });
        await saveJSON(files.compwatch, cw);
        log(`competitor watch saved for ${only.to}`);
        r.status = "done"; return;
      }

      // ----- BROWSER AUTOMATION (generic tasks) -----
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

      if (flow.start_url) { await page.goto(flow.start_url, { waitUntil: "domcontentloaded", timeout: 60000 }); await screenshot("after-start"); }

      for (const [i,s] of flow.steps.entries()){
        if (s.action === "goto"){ await page.goto(s.url || s.text || "", { waitUntil: "domcontentloaded", timeout: 60000 }); await screenshot("after-goto"); }
        else if (s.action === "click"){ await page.click(s.selector, { timeout: 20000 }); await screenshot("after-click"); }
        else if (s.action === "type"){ await page.locator(s.selector).first().waitFor({ state: "visible", timeout: 10000 }); await page.fill(s.selector, s.text||"", { timeout: 20000 }); if (s.enter) await page.keyboard.press("Enter"); await screenshot("after-type"); }
        else if (s.action === "wait"){ await page.waitForLoadState(s.state || "load", { timeout: 60000 }); await screenshot("after-wait"); }
        else if (s.action === "screenshot"){ await screenshot("manual"); }
      }

      const v = await page.video()?.path().catch(()=>null);
      await page.close(); await context.close(); await browser.close();
      if (v) runs.get(id).videoUrl = `/${v}`;
      r.status = "done";
    }catch(e){
      pushLog(r, `ERROR: ${e.message}`);
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

// ---------- CRON RUNNERS (call from Render Cron or manually) ----------

// A3: monitors
app.get("/api/monitors/run", async (_req,res)=>{
  const monitors = await loadJSON(files.monitors, []);
  let processed = 0, changed = 0;
  for (const m of monitors){
    processed++;
    const html = await (await fetch(m.url)).text();
    const hash = crypto.createHash("sha256").update(html).digest("hex");
    if (m.last_hash && m.last_hash !== hash){
      const file = await screenshotURL(m.url);
      await sendEmail({ to: m.to, subject:`Change detected: ${m.url}`, text:`The page content changed.\nURL: ${m.url}`, attachments:[{ path: file, filename: path.basename(file) }] });
      changed++;
    }
    m.last_hash = hash;
  }
  await saveJSON(files.monitors, monitors);
  res.json({ ok:true, processed, changed });
});

// A4: briefings (daily/weekly)
app.get("/api/briefings/run", async (_req,res)=>{
  const briefings = await loadJSON(files.briefings, []);
  let sent = 0;
  for (const b of briefings){
    const items = await fetchGoogleNews(b.topic);
    const body = formatNewsEmail(items, b.topic);
    await sendEmail({ to: b.to, subject:`${b.frequency==="weekly"?"Weekly": "Daily"} News on ${b.topic}`, text: body });
    sent++;
  }
  res.json({ ok:true, sent });
});

// A5: competitor watch (RSS list)
app.get("/api/compwatch/run", async (_req,res)=>{
  const cw = await loadJSON(files.compwatch, []);
  let sent = 0;
  for (const c of cw){
    let lines = [];
    for (const feed of c.feeds){
      const items = await fetchRSS(feed, 5);
      lines.push(`Feed: ${feed}`);
      items.forEach(i => lines.push(`- ${i.title}\n  ${i.link}`));
      lines.push("");
    }
    await sendEmail({ to: c.to, subject: "Competitor watch update", text: lines.join("\n") || "No updates." });
    sent++;
  }
  res.json({ ok:true, sent });
});

// A6: job alerts
app.get("/api/jobalerts/run", async (_req,res)=>{
  const js = await loadJSON(files.jobalerts, []);
  let sent = 0;
  for (const j of js){
    const kws = (j.keywords||[]).map(k=>k.toLowerCase());
    let lines = [];
    for (const feed of j.feeds){
      const items = await fetchRSS(feed, 20);
      const hits = items.filter(i => kws.some(k => (i.title||"").toLowerCase().includes(k)));
      if (hits.length){ lines.push(`Feed: ${feed}`); hits.forEach(i=>lines.push(`- ${i.title}\n  ${i.link}`)); lines.push(""); }
    }
    if (lines.length){
      await sendEmail({ to: j.to, subject:`Job alerts: ${kws.join(", ")}`, text: lines.join("\n") });
      sent++;
    }
  }
  res.json({ ok:true, sent });
});

// A10: inbox digest example
app.get("/api/inbox/digest", async (_req,res)=>{
  const to = process.env.GMAIL_USER;
  const body = await gmailDigestText({ hours: 24 });
  await sendEmail({ to, subject: "Daily inbox digest (last 24h)", text: body });
  res.json({ ok:true });
});

// ---------- helpers: actions ----------

// A1
async function screenshotURL(url){
  const id = uuidv4();
  const out = path.join("runs", `${id}-shot.png`);
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({ deviceScaleFactor: 1.0 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  return out;
}

// A2
async function pdfURL(url){
  const id = uuidv4();
  const out = path.join("runs", `${id}.pdf`);
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.pdf({ path: out, printBackground: true, format: "A4" });
  await browser.close();
  return out;
}

// A8
async function seoSnapshotEmailBody(keyword){
  const key = process.env.SERPAPI_KEY; // optional
  let lines = [`Keyword: ${keyword}`, ""];
  if (key){
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("q", keyword);
    u.searchParams.set("engine", "google");
    u.searchParams.set("num", "10");
    u.searchParams.set("api_key", key);
    const data = await (await fetch(u)).json();
    const results = (data.organic_results || []).slice(0,10);
    results.forEach((r,i)=>lines.push(`${i+1}. ${r.title}\n   ${r.link}`));
    return lines.join("\n") || "No results.";
  } else {
    // fallback: Google News RSS as proxy snapshot
    const items = await fetchGoogleNews(keyword, 10);
    items.forEach((i,idx)=>lines.push(`${idx+1}. ${i.title}${i.source ? " — "+i.source:""}\n   ${i.link}`));
    lines.push("\n(Set SERPAPI_KEY to get standard Google results.)");
    return lines.join("\n");
  }
}

// A7
async function extractToCSV(url, selector){
  const html = await (await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }})).text();
  const $ = cheerioLoad(html); // ⬅️ Cheerio fix here
  const rows = [];
  const emails = new Set();

  $(selector).each((_,el)=>{
    const text = $(el).text().trim();
    const href = $(el).attr("href") || "";
    rows.push({ text, href });
  });

  (html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).forEach(e => emails.add(e));

  const id = uuidv4();
  const csvPath = path.join("runs", `${id}.csv`);
  await new Promise((resolve,reject)=>{
    const { stringify } = await import("csv-stringify"); // dynamic import safe in Node 22
    const s = stringify(rows, { header:true });
    const w = fs.createWriteStream(csvPath);
    s.on("error", reject); w.on("error", reject); w.on("finish", resolve);
    s.pipe(w);
  }).catch(async () => {
    // fallback to already-imported named export at top if dynamic fails
    const { stringify } = await import("csv-stringify");
  });

  if (emails.size){
    await fsp.appendFile(csvPath, `\n\nemails\n${[...emails].join("\n")}\n`);
  }

  return { csvPath, count: rows.length, emails: emails.size };
}

// A9
async function uptimeCheck({ url, expect_selector, expect_text }){
  try{
    const r = await fetch(url, { redirect: "follow" });
    const statusOk = r.status >= 200 && r.status < 400;
    const body = await r.text();
    if (!statusOk) return { ok:false, message:`Status ${r.status} for ${url}` };
    if (expect_text && !body.toLowerCase().includes(String(expect_text).toLowerCase()))
      return { ok:false, message:`Text not found: "${expect_text}"` };
    if (expect_selector){
      const $ = cheerioLoad(body); // ⬅️ Cheerio fix here
      if (!$(expect_selector).length) return { ok:false, message:`Selector not found: ${expect_selector}` };
    }
    return { ok:true, message:`OK ${url}` };
  }catch(e){
    return { ok:false, message:`Error ${e.message}` };
  }
}

// A4 (and used in A8 fallback)
async function fetchGoogleNews(query, maxItems = 8){
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const xml = await resp.text();
  const items = [];
  const parts = xml.split("<item>").slice(1);
  for (const part of parts){
    const end = part.indexOf("</item>");
    const itemXml = end >= 0 ? part.slice(0, end) : part;
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1] ||
                   itemXml.match(/<title>(.*?)<\/title>/s)?.[1] || "").trim();
    const link = (itemXml.match(/<link>(.*?)<\/link>/s)?.[1] || "").trim();
    const source = (itemXml.match(/<source[^>]*>(.*?)<\/source>/s)?.[1] || "").trim();
    if (title && link) items.push({ title, link, source });
    if (items.length >= maxItems) break;
  }
  return items;
}
function formatNewsEmail(items, query){
  if (!items.length) return `No recent results for "${query}".`;
  const lines = items.map(i => `- ${i.title}${i.source ? " — " + i.source : ""}\n  ${i.link}`);
  return `Top Google News for "${query}":\n\n` + lines.join("\n") + "\n";
}

// A10
async function gmailDigestText({ hours = 24 } = {}){
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not set");

  const since = Date.now() - hours*3600_000;
  const imap = new ImapFlow({ host:"imap.gmail.com", port:993, secure:true, auth:{ user, pass } });
  await imap.connect();
  const box = await imap.selectMailbox("INBOX");
  let lines = [];
  for await (const msg of imap.fetch({ seen:false }, { envelope:true, internalDate:true }, { uid:true })){
    if (new Date(msg.internalDate).getTime() >= since){
      lines.push(`- ${msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "?"} — ${msg.envelope.subject || "(no subject)"}`);
    }
  }
  await imap.logout();
  return lines.length ? lines.join("\n") : "No new mail in the last 24h.";
}

async function forwardLastEmail(to, log=()=>{}) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not set");

  const imap = new ImapFlow({ host:"imap.gmail.com", port:993, secure:true, auth:{ user, pass } });
  await imap.connect();
  const box = await imap.selectMailbox("INBOX");
  if (!box.exists) { await imap.logout(); throw new Error("No messages in INBOX"); }
  const seq = box.exists;
  const msg = await imap.fetchOne(seq, { envelope: true, source: true });
  const subject = (msg?.envelope?.subject) || "(no subject)";
  const raw = msg?.source?.toString("utf8") || "";
  await imap.logout();

  await sendEmail({ to, subject:`Fwd: ${subject}`, text:`Forwarded message (raw below):\n\n${raw.slice(0, 100000)}` });
}

// ---------- boot ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log("AutoDirector service listening on " + PORT));









