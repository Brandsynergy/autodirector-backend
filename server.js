// server.js (ESM)
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Ensure runs dir exists
const RUNS_DIR = process.env.RUNS_DIR || path.join(__dirname, "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/runs",
  express.static(RUNS_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".png")) res.type("png");
    },
  })
);

// Simple health check
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "mediad-autodirector", time: new Date().toISOString() })
);

// ----- planning (very simple) -----
function planFromPrompt(prompt = "") {
  const urlMatch = prompt.match(/https?:\/\/\S+/i);
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (urlMatch && emailMatch) {
    const url = urlMatch[0];
    const to = emailMatch[0];
    return {
      ok: true,
      plan: { kind: "screenshot", url, to },
      steps: [
        { action: "screenshot_url", url },
        { action: "gmail_send_last", to },
      ],
    };
  }
  return { ok: false, error: "No URL/email detected in prompt." };
}

app.post("/plan", (req, res) => {
  const out = planFromPrompt(req.body?.prompt);
  if (!out.ok) return res.json({ ok: false, error: out.error });
  res.json(out);
});

// -----
                                                                                                                                                                                                                                                                                        
  
  
  
  
  
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                    
                      
                      
                      
                      
  
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














