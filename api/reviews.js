/* Отзывы клиентов: хранение и выдача.
   Работает на Vercel вместе с базой Upstash Redis (Vercel → Storage → Upstash for Redis → Connect).
   После подключения базы Vercel сам добавит переменные KV_REST_API_URL и KV_REST_API_TOKEN.

   GET  /api/reviews                     — список опубликованных отзывов (новые сверху)
   POST /api/reviews                     — новый отзыв { rating, name, org, text, project }
   DELETE /api/reviews?id=...&token=...  — удалить отзыв (нужна переменная ADMIN_TOKEN в Vercel) */

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "reviews";
const MAX_KEEP = 200;
const PROJECTS = ["lider", "blade"];

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

function ipOf(req) {
  const xf = String(req.headers["x-forwarded-for"] || "");
  return (xf.split(",")[0] || req.headers["x-real-ip"] || "unknown").trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) {
    res.status(503).json({ error: "storage_not_connected" });
    return;
  }
  try {
    if (req.method === "GET") {
      const raw = await redis(["LRANGE", KEY, "0", "99"]);
      const list = (raw || []).map(function (s) { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      res.status(200).json({ reviews: list });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};

      /* скрытое поле-ловушка для ботов */
      if (clean(body.website, 200)) { res.status(200).json({ ok: true }); return; }

      const name = clean(body.name, 60);
      const org = clean(body.org, 80);
      const text = clean(body.text, 1200);
      const rating = Math.max(1, Math.min(5, Math.round(Number(body.rating) || 5)));
      const project = PROJECTS.indexOf(body.project) >= 0 ? body.project : "";
      if (!name || text.length < 10) { res.status(400).json({ error: "invalid" }); return; }
      if (/(https?:\/\/|www\.)/i.test(text + " " + name + " " + org)) { res.status(400).json({ error: "links_not_allowed" }); return; }

      /* не больше 3 отзывов в час с одного адреса */
      const rl = "rl:" + ipOf(req);
      const n = await redis(["INCR", rl]);
      if (n === 1) await redis(["EXPIRE", rl, "3600"]);
      if (n > 3) { res.status(429).json({ error: "too_many" }); return; }

      const review = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name: name, org: org, text: text, rating: rating, project: project,
        date: new Date().toISOString()
      };
      await redis(["LPUSH", KEY, JSON.stringify(review)]);
      await redis(["LTRIM", KEY, "0", String(MAX_KEEP - 1)]);
      res.status(201).json({ ok: true, review: review });
      return;
    }

    if (req.method === "DELETE") {
      const admin = process.env.ADMIN_TOKEN;
      const q = req.query || {};
      if (!admin || q.token !== admin) { res.status(403).json({ error: "forbidden" }); return; }
      const raw = await redis(["LRANGE", KEY, "0", "-1"]);
      const hit = (raw || []).filter(function (s) { try { return JSON.parse(s).id === q.id; } catch (e) { return false; } })[0];
      if (!hit) { res.status(404).json({ error: "not_found" }); return; }
      await redis(["LREM", KEY, "1", hit]);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
};
