// Saathi AI endpoint (Netlify Function).
// The browser never sees the API key: it is read from the GEMINI_API_KEY environment variable set in Netlify.
// The browser can only ask for two fixed jobs ("understand" and "reasons"); the instructions live here,
// so the endpoint can't be used as a general-purpose chatbot.

const THEMES = ["work_stress", "sleep", "anxiety", "low_mood", "burnout", "loneliness", "relationships", "anger",
  "exam_stress", "focus", "grief", "self_esteem", "smoking", "parenting"];
const DURATIONS = ["days", "weeks", "months", "unknown"];
const SEVERITIES = ["mild", "moderate", "high"];
const PREFS = ["watch", "read", "do", "talk", "none"];

const UNDERSTAND_SYSTEM = `You help a workplace wellbeing app (YourDOST) understand how a user is feeling, so the app can suggest one next step from its own catalogue.
Read the user's note (it may be English, Hindi or Hinglish; personal details are already replaced with placeholders like [NAME]) and the feeling chips they tapped.
Return only the JSON fields asked for:
- themes: 1 to 3 themes from the allowed list, most important first. Use only what the user actually said.
- duration, severity: your best reading; use "unknown" for duration if not stated. severity is how much it affects their daily life.
- preference: "talk" only if they ask for a person; otherwise the format they say they prefer, or "none".
- possible_risk: true if anything hints at hopelessness, self-harm or not wanting to live. When unsure, say true. This only adds a human check; it never removes one.
- confidence: "low" if the note is too vague to pick themes.
- summary: one warm, plain sentence (max 25 words) starting "You're dealing with", addressed to the user. No diagnosis, no clinical labels, no advice.`;

const UNDERSTAND_SCHEMA = {
  type: "OBJECT",
  properties: {
    themes: { type: "ARRAY", items: { type: "STRING", enum: THEMES } },
    duration: { type: "STRING", enum: DURATIONS },
    severity: { type: "STRING", enum: SEVERITIES },
    preference: { type: "STRING", enum: PREFS },
    possible_risk: { type: "BOOLEAN" },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    summary: { type: "STRING" }
  },
  required: ["themes", "duration", "severity", "preference", "possible_risk", "confidence", "summary"],
  propertyOrdering: ["themes", "duration", "severity", "preference", "possible_risk", "confidence", "summary"]
};

const REASONS_SYSTEM = `Write a one-line reason (max 18 words, plain and warm, speaking to the user as "you") for why each suggested item fits this user.
Use only the facts given. No medical claims, no diagnosis, no promise that it will fix things. Return one reason per item id.`;

const REASONS_SCHEMA = {
  type: "OBJECT",
  properties: { reasons: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, why: { type: "STRING" } }, required: ["id", "why"] } } },
  required: ["reasons"]
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const env = name => (globalThis.Netlify?.env?.get?.(name)) ?? process.env[name];

// Model choice: GEMINI_MODEL if set, then the flash models this key can use (stable before preview,
// newest first). Google retires and overloads models over time, so if one fails we try the next.
let ranked = null;      // cached list of candidate models
let lastGood = null;    // the model that answered most recently
async function listModels(key) {
  if (ranked) return ranked;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not list AI models (${res.status})`);
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /flash/.test(n) && !/(image|tts|audio|live|exp|embedding|vision|thinking)/.test(n));
  const score = n => {
    const v = parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
    return (/preview/.test(n) ? 0 : 1000) + v * 10 + (/lite/.test(n) ? 3 : 0) + (/latest/.test(n) ? 1 : 0);
  };
  names.sort((x, y) => score(y) - score(x));
  if (!names.length) throw new Error("No usable Gemini model for this key");
  return (ranked = names);
}
async function candidates(key) {
  const list = [];
  if (lastGood) list.push(lastGood);
  if (env("GEMINI_MODEL")) list.push(env("GEMINI_MODEL"));
  for (const n of await listModels(key)) list.push(n);
  return [...new Set(list)];
}

// Thinking makes answers slow; this job is simple classification, so turn it down where the model allows.
function thinkingFor(model) {
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: /pro/.test(model) ? 128 : 0 };
  if (/gemini-[3-9]/.test(model)) return { thinkingLevel: "low" };
  return null;
}
async function generate(key, model, job, ms, withThinkingConfig = true) {
  const { system, user, schema } = job;
  const tc = withThinkingConfig ? thinkingFor(model) : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema, ...(tc ? { thinkingConfig: tc } : {}) }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 400 && tc && /thinking/i.test(JSON.stringify(data))) return generate(key, model, job, ms, false); // model doesn't accept that setting
    return { res, data };
  } finally { clearTimeout(timer); }
}

async function callGemini(job) {
  const key = env("GEMINI_API_KEY");
  const deadline = Date.now() + 9000; // stay under Netlify's ~10 s limit
  const tried = [];
  for (const model of (await candidates(key)).slice(0, 4)) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    let res, data;
    try { ({ res, data } = await generate(key, model, job, Math.min(left, 5000))); }
    catch (e) { tried.push(`${model}: ${e.name === "AbortError" ? "timed out" : "network"}`); continue; }
    if (!res.ok) {
      tried.push(`${model}: ${res.status}${data?.error?.status ? " " + data.error.status : ""}`);
      if (lastGood === model) lastGood = null;
      if ([404, 429, 500, 503].includes(res.status)) continue; // retired, busy or out of quota: try the next model
      break;
    }
    const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (!text) { tried.push(`${model}: empty answer`); continue; }
    lastGood = model;
    return { parsed: JSON.parse(text), model };
  }
  throw new Error("AI service unavailable (" + tried.join("; ") + ")");
}

export default async (req) => {
  const key = env("GEMINI_API_KEY");
  if (req.method === "GET") {
    if (!key) return json(200, { available: false });
    try { const c = await candidates(key); return json(200, { available: true, provider: "Google Gemini", model: c[0] }); }
    catch (e) { return json(200, { available: false, error: String(e.message || e) }); }
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!key) return json(503, { error: "AI not configured" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Bad request" }); }

  try {
    if (body.task === "understand") {
      const note = String(body.note || "").slice(0, 1200);
      const chips = (Array.isArray(body.chips) ? body.chips : []).map(String).slice(0, 10);
      const { parsed: o, model } = await callGemini({ system: UNDERSTAND_SYSTEM, user: JSON.stringify({ note, chips }), schema: UNDERSTAND_SCHEMA });
      // Check the answer again on our side: only allowed values get through.
      const out = {
        themes: (o.themes || []).filter(t => THEMES.includes(t)).slice(0, 3),
        duration: DURATIONS.includes(o.duration) ? o.duration : "unknown",
        severity: SEVERITIES.includes(o.severity) ? o.severity : "moderate",
        preference: PREFS.includes(o.preference) ? o.preference : "none",
        possible_risk: o.possible_risk === true,
        confidence: ["low", "medium", "high"].includes(o.confidence) ? o.confidence : "low",
        summary: String(o.summary || "").slice(0, 220)
      };
      return json(200, { out, model });
    }
    if (body.task === "reasons") {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 3).map(i => ({ id: String(i.id).slice(0, 8), type: String(i.type).slice(0, 20), title: String(i.title).slice(0, 80), minutes: Number(i.minutes) || 0, about: String(i.about).slice(0, 200) }));
      const user = { themes: (body.user?.themes || []).map(String).slice(0, 3), duration: String(body.user?.duration || ""), affects_day: String(body.user?.affects_day || ""), time_available: String(body.user?.time_available || ""), context: String(body.user?.context || "").slice(0, 200) };
      const { parsed, model } = await callGemini({ system: REASONS_SYSTEM, user: JSON.stringify({ user, items }), schema: REASONS_SCHEMA });
      const reasons = {};
      for (const r of parsed.reasons || []) if (items.some(i => i.id === r.id)) reasons[r.id] = String(r.why).slice(0, 160);
      return json(200, { reasons, model });
    }
    return json(400, { error: "Unknown task" });
  } catch (e) {
    return json(502, { error: e.name === "AbortError" ? "AI timed out" : String(e.message || e).slice(0, 200) });
  }
};

export const config = { path: "/api/ai" };
