// TumbuhRata (English) — /api/chat
// "Ask AI" for parents of toddlers ages 1-3. Same pattern as the
// Indonesian TumbuhRata /api/grade: GEMINI_API_KEY is read from Vercel env,
// WITHOUT a key the function answers 503 (fail-closed) and the page uses
// the local FAQ. Same free key as the other projects. No Groq fallback.
// Model chain: gemini-3.5-flash-lite -> gemini-3.6-flash -> gemini-flash-lite-latest.
// OpenAI-compatible endpoint first, then native generateContent.

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];

const SYSTEM_PROMPT = [
  'You are the TumbuhRata parenting assistant for parents of children ages 1-3 years.',
  'Answer briefly, to the point, in plain everyday English that parents can easily understand.',
  'Base your answers on official guidance: CDC (Learn the Signs. Act Early. milestones), WHO, AAP. Name the source when relevant.',
  'You are NOT a doctor and do NOT give diagnoses. Never diagnose a child, never give medicine doses or therapy.',
  'If there are red flags (for example seizures, trouble breathing, dehydration, loss of skills the child once had, unresponsiveness): direct the parent to a pediatrician / emergency care right away — do not reassure with "it is fine".',
  'If the question is outside toddler development, learning, or parenting for ages 1-3: politely decline and point to topics you can answer.',
  'Do not ask for the child\'s full name or date of birth. Maximum about 150 words per answer.',
].join(' ');

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function validMessages(body) {
  if (!body || typeof body !== 'object') return false;
  const m = body.messages;
  if (!Array.isArray(m) || m.length === 0 || m.length > 20) return false;
  for (const x of m) {
    if (!x || typeof x !== 'object') return false;
    if (x.role !== 'user' && x.role !== 'assistant') return false;
    if (typeof x.content !== 'string' || x.content.trim().length === 0 || x.content.length > 2000) return false;
  }
  if (m[m.length - 1].role !== 'user') return false;
  return true;
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompatible(key, messages) {
  for (const model of MODELS) {
    try {
      const r = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
            max_tokens: 600,
            temperature: 0.7,
          }),
        },
        20000
      );
      if (!r.ok) continue;
      const data = await r.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch (e) {
      // try next model / path
    }
  }
  return null;
}

async function callNative(key, messages) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  for (const model of MODELS) {
    try {
      const r = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
          }),
        },
        20000
      );
      if (!r.ok) continue;
      const data = await r.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('').trim() : '';
      if (text) return text;
    } catch (e) {
      // try next model
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return json(res, 400, { error: 'Body is not valid JSON' });
    }
  }
  if (!validMessages(body)) {
    return json(res, 400, { error: 'Invalid messages' });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return json(res, 503, { error: 'AI is not active — API key has not been added to this Vercel project yet' });
  }
  const messages = body.messages.map((m) => ({ role: m.role, content: m.content }));
  const ageMonths = Number(body.ageMonths);
  if (Number.isFinite(ageMonths) && ageMonths > 0) {
    messages.unshift({ role: 'user', content: 'Context: the child is ' + Math.round(ageMonths) + ' months old.' });
  }
  let reply = await callOpenAICompatible(key, messages);
  if (!reply) reply = await callNative(key, messages);
  if (!reply) {
    return json(res, 502, { error: 'AI failed to answer, please try again in a moment' });
  }
  return json(res, 200, { reply });
};
