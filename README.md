# AutoDirector Backend (Render-ready)

This is a minimal backend you can push to GitHub and deploy on Render.

## Quick Steps
1. Create a GitHub repo, upload these files.
2. On Render → New → Web Service → Build from repo → pick this repo.
3. Set environment variables:
   - `OPENAI_API_KEY` = your key
   - `CORS_ORIGIN` = *
   - (optional) `FREE_CREDITS_ON_SIGNUP` = 100
4. Deploy. Copy the live URL (e.g. `https://your-app.onrender.com`).
5. In Lovable.dev, paste the single `AutoDirector.jsx` file (included separately) and set 
