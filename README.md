# Saathi: a YourDOST prototype

Saathi helps a user find the one most useful next step in their wellbeing journey: a video, article,
self-check, program, instant chat or a session. Built by Pushkar Jain for the YourDOST product assignment (Task 3).
All people, companies and counsellors in it are fictional.

## How it is put together
- `index.html`: the whole app (HTML, CSS and JavaScript, no build step).
- `netlify/functions/ai.mjs`: a small server function at `/api/ai`. It holds the AI key and calls Google Gemini
  for two fixed jobs only: reading the user's note into tags, and writing one-line reasons for items the rules already chose.
- If `/api/ai` is not available (for example when you open `index.html` straight from your computer), the app
  uses a built-in word matcher instead, so it always works.

## Deploy on Netlify (free)
1. Push this folder to a GitHub repository.
2. In Netlify: Add new site → Import an existing project → pick the repository. No build command; publish directory is `.`.
3. Site configuration → Environment variables → add `GEMINI_API_KEY` (from https://aistudio.google.com).
   Optional: `GEMINI_MODEL` to force a model. If unset, the function picks the newest "flash" model your key can use.
4. Trigger a redeploy. The "Behind the scenes" panel shows "Real AI connected" when it works.

Never put the key in `index.html` or commit it to the repository.
