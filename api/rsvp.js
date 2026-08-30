const { getDb } = require('./_db');

// Very small in-memory rate limiter (per serverless instance) to reduce spam.
// Not a substitute for a real rate limiter, but adds a basic layer of protection.
const recentSubmissions = global._recentSubmissions || new Map();
global._recentSubmissions = recentSubmissions;
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // 10 seconds between submissions per IP

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'POST') {
    try {
      const ip = getClientIp(req);
      const lastSubmission = recentSubmissions.get(ip);
      const now = Date.now();
      if (lastSubmission && now - lastSubmission < RATE_LIMIT_WINDOW_MS) {
        res.statusCode = 429;
        return res.end(JSON.stringify({ ok: false, error: 'يرجى الانتظار قليلاً قبل الإرسال مرة أخرى.' }));
      }

      let body = req.body;
      if (!body || typeof body === 'string') {
        try {
          body = JSON.parse(body || '{}');
        } catch (e) {
          body = {};
        }
      }

      const name = sanitizeString(body.name, 120);
      const familyName = sanitizeString(body.familyName, 120);
      const attending = body.attending === 'yes' ? 'yes' : (body.attending === 'no' ? 'no' : '');
      const countRaw = parseInt(body.count, 10);
      const count = Number.isFinite(countRaw) ? Math.min(Math.max(countRaw, 1), 20) : 1;

      if (!name || !familyName || !attending) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'برجاء تعبئة جميع الحقول المطلوبة.' }));
      }

      const db = await getDb();
      const doc = {
        name,
        familyName,
        count,
        attending,
        createdAt: new Date(),
        ip,
        userAgent: sanitizeString(req.headers['user-agent'], 300),
      };

      await db.collection('rsvps').insertOne(doc);
      recentSubmissions.set(ip, now);

      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('RSVP submit error:', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'حدث خطأ في الخادم، برجاء المحاولة لاحقًا.' }));
    }
  }

  if (req.method === 'GET') {
    try {
      const adminKey = process.env.ADMIN_KEY;
      const providedKey = req.headers['x-admin-key'] || (req.query && req.query.key);

      if (!adminKey || providedKey !== adminKey) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error: 'غير مصرح.' }));
      }

      const db = await getDb();
      const list = await db
        .collection('rsvps')
        .find({})
        .sort({ createdAt: -1 })
        .limit(1000)
        .toArray();

      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, count: list.length, data: list }));
    } catch (err) {
      console.error('RSVP list error:', err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'حدث خطأ في الخادم.' }));
    }
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
};
