import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FREE_CREDITS = Number(process.env.FREE_CREDITS_ON_SIGNUP || 100);

// super-simple in-memory “database”
const users = new Map(); // id -> { credits }
const runs = new Map();  // id -> { status, logs, shots, videoUrl }

function ensureUser(id){
  if(!users.has(id)) users.set(id, { credits: FREE_CREDITS });
  return users.get(id);
}

app.get("/api/health", (_,res)=> res.json({ ok:true }));

app.get("/api/user", (req,res)=>{
  const id = req.headers["x-anon-id"] || "public";
  const u = ensureUser(id);
  res.json({ id, credits: u.credits });
});

app.post("/api/plan", async (req,res)=>{
  // turns plain English into a simple flow JSON
  const text = (req.body?.prompt || "").slice(0, 800);
  const sys =
`Output ONLY JSON: {start_url?: string, steps: Array<
 {action:'goto', url?:string} |
 {action:'click', selector:string} |
 {action:'type', selector:string, text:string, enter?:boolean} |
 {action:'wait', state:'load'|'domcontentloaded'|'networkidle'} |
 {action:'screenshot'}
>]}`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Create a plan for: ${text}` }
    ],
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

  // run in background
  (async()=>{
    const r = runs.get(id);
    const log = (m)=>{ r.logs.push(new Date().toISOString()+" "+m); };

    const browser = await chromium.launch();
    const context = await browser.newContext({ recordVideo: { dir: "runs" } });
    const page = await context.newPage();

    try{
      if (flow.start_url) {
        log("goto " + flow.start_url);
        await page.goto(flow.start_url, { waitUntil: "domcontentloaded" });
      }
      for (const [i,s] of (flow.steps||[]).entries()){
        if (s.action === "goto"){
          log(`[${i}] goto ${s.url}`);
          await page.goto(s.url, { waitUntil: "domcontentloaded" });
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
          const path = `runs/${id}-${i}.png`;
          await page.screenshot({ path, fullPage: true });
          r.shots.push({ url: `/${path}` });
        }
      }
      const v = await page.video()?.path().catch(()=>null);
      await context.close(); await browser.close();
      r.videoUrl = v ? `/${v}` : null;
      r.status = "done";
    }catch(e){
      r.logs.push("ERROR: "+e.message);
      try{ await context.close(); await browser.close(); }catch{}
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

// serve artifacts (screenshots/videos)
app.use("/runs", express.static("runs"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log("Automation backend on " + PORT));


