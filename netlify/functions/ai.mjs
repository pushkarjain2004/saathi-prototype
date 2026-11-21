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

// Model choice: GEMINI_MODEL if set, otherwise the newest "flash" model this key can use.
// Google retires model names over time, so on a "not found" error we look the list up again.
let resolvedModel = null;
async function pickModel(key, force) {
  if (resolvedModel && !force) return resolvedModel;
  const wanted = env("GEMINI_MODEL");
  if (wanted && !force) return (resolvedModel = wanted);
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not list AI models (${res.status})`);
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /flash/.test(n) && !/(image|tts|audio|live|exp|embedding|vision|thinking)/.test(n));
  const score = n => {
    const v = parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
    return v * 100 + (/lite/.test(n) ? 0 : 10) + (/preview/.test(n) ? 0 : 5) + (/latest/.test(n) ? 1 : 0);
  };
  names.sort((a, b) => score(b) - score(a));
  if (!names.length) throw new Error("No usable Gemini model for this key");
  return (resolvedModel = names[0]);
}

async function generate(key, model, { system, user, schema }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema }
      })
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally { clearTimeout(timer); }
}

async function callGemini(job) {
  const key = env("GEMINI_API_KEY");
  let model = await pickModel(key, false);
  let { res, data } = await generate(key, model, job);
  if (res.status === 404) { // model name retired or unknown: look up a current one and try once more
    model = await pickModel(key, true);
    ({ res, data } = await generate(key, model, job));
  }
  if (!res.ok) throw new Error(`AI service error ${res.status}${data?.error?.status ? " " + data.error.status : ""}`);
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  if (!text) throw new Error("AI returned no answer" + (data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ""));
  return { parsed: JSON.parse(text), model };
}

export default async (req) => {
  const key = env("GEMINI_API_KEY");
  if (req.method === "GET") {
    if (!key) return json(200, { available: false });
    try { return json(200, { available: true, provider: "Google Gemini", model: await pickModel(key, false) }); }
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
