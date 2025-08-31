// Replace your existing generateImageOpenAI with this version
async function generateImageOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  // Note: no `response_format` here
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.error?.message || "OpenAI image error");
  }

  const d = json?.data?.[0];
  if (!d) throw new Error("OpenAI returned no image");

  // Prepare output file
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}-img.png`;
  const filePath = path.join(RUNS_DIR, id);

  // Handle either base64 or hosted URL
  if (d.b64_json) {
    await fs.writeFile(filePath, Buffer.from(d.b64_json, "base64"));
  } else if (d.url) {
    const imgResp = await fetch(d.url);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    await fs.writeFile(filePath, buf);
  } else {
    throw new Error("OpenAI returned no image");
  }

  return `/runs/${path.basename(filePath)}`;
}
                                                            
  
  
  
                                                                                                                                                                                    
  
  
  
  
  
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                                                                                  
  
  
  
  
  
  
  
  
  
  
                                                                                                    
  
  
  
  
  
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  














