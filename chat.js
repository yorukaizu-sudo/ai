// Vercel Serverless Function  ->  /api/chat
// Env vars (Vercel > Project > Settings > Environment Variables):
//   GROQ_KEYS     = gsk_key1,gsk_key2,gsk_key3      (pisahkan dengan koma / baris baru)
//   PROXY_SECRET  = rahasia-bebas-kamu              (harus sama dengan di script Roblox)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Disimpan di memori instance (cukup untuk rotasi sederhana)
const cooldown = new Map(); // key -> timestamp (ms) kapan boleh dipakai lagi
let cursor = 0;

function getKeys() {
  return (process.env.GROQ_KEYS || "")
    .split(/[,\n\r]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Cek secret biar orang lain tidak bisa memakai proxy-mu
  const secret = process.env.PROXY_SECRET;
  if (secret && req.headers["x-proxy-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const keys = getKeys();
  if (keys.length === 0) {
    return res.status(500).json({ error: "GROQ_KEYS belum diisi di Vercel" });
  }

  // Hanya teruskan field yang diperlukan
  const b = req.body || {};
  const payload = {
    model: b.model,
    messages: b.messages,
    temperature: b.temperature,
    max_tokens: Math.min(Number(b.max_tokens) || 220, 500),
  };
  if (!payload.model || !Array.isArray(payload.messages)) {
    return res.status(400).json({ error: "Body tidak valid" });
  }

  const now = Date.now();
  let lastStatus = 429;
  let lastBody = { error: "Semua API key sedang limit" };

  // Coba semua key mulai dari urutan berputar (round-robin)
  for (let i = 0; i < keys.length; i++) {
    const idx = (cursor + i) % keys.length;
    const key = keys[idx];

    if ((cooldown.get(key) || 0) > now) continue; // key ini masih cooldown

    try {
      const r = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      });

      if (r.status === 429) {
        const retry = Number(r.headers.get("retry-after")) || 60;
        cooldown.set(key, Date.now() + Math.min(retry, 300) * 1000);
        lastStatus = 429;
        continue; // pindah ke key berikutnya
      }

      if (r.status === 401 || r.status === 403) {
        cooldown.set(key, Date.now() + 10 * 60 * 1000); // key mati/salah, istirahatkan 10 menit
        lastStatus = r.status;
        lastBody = { error: "Salah satu API key ditolak" };
        continue;
      }

      const text = await r.text();
      cursor = (idx + 1) % keys.length; // key berikutnya dipakai request selanjutnya
      res.setHeader("Content-Type", "application/json");
      return res.status(r.status).send(text);
    } catch (e) {
      lastStatus = 502;
      lastBody = { error: "Gagal menghubungi Groq" };
    }
  }

  return res.status(lastStatus).json(lastBody);
}
