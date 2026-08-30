const crypto = require('crypto');
const { getDb } = require('./_db');

// Very small in-memory rate limiter (per serverless instance) to reduce spam.
// Not a substitute for a real rate limiter, but adds a basic layer of protection.
const recentSubmissions = global._recentSubmissions || new Map();
global._recentSubmissions = recentSubmissions;
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // 10 seconds between submissions per IP

const DEVICE_COOKIE_NAME = 'rsvp_device_id';
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

// Normalizes a guest's full name so minor differences (spacing, casing,
// Arabic alef/ya variants) still match as "the same person".
function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// Reads the device id cookie, or creates a new one and queues it to be set
// on the response. This id is set by the server (httpOnly), so it can't be
// cleared or spoofed from page JavaScript the way localStorage can.
function getOrCreateDeviceId(req, res) {
  const cookies = parseCookies(req);
  let deviceId = cookies[DEVICE_COOKIE_NAME];
  if (deviceId && /^[a-f0-9]{32}$/.test(deviceId)) {
    return deviceId;
  }
  deviceId = crypto.randomBytes(16).toString('hex');
  const isProd = process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    DEVICE_COOKIE_NAME +
      '=' +
      deviceId +
      '; Max-Age=' +
      DEVICE_COOKIE_MAX_AGE +
      '; Path=/; HttpOnly; SameSite=Lax' +
      (isProd ? '; Secure' : '')
  );
  return deviceId;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'POST') {
    try {
      const ip = getClientIp(req);
      const deviceId = getOrCreateDeviceId(req, res);

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

      const normalizedName = normalizeName(name + ' ' + familyName);

      const db = await getDb();

      // Real, server-side duplicate check: blocks a second RSVP from the
      // same browser (device cookie) OR the same guest name, regardless of
      // device, browser, or private-browsing tricks.
      const existing = await db.collection('rsvps').findOne({
        $or: [{ deviceId: deviceId }, { normalizedName: normalizedName }],
      });

      if (existing) {
        res.statusCode = 409;
        return res.end(
          JSON.stringify({
            ok: false,
            alreadySubmitted: true,
            error: 'تم تسجيل ردكم من قبل، شكرًا لكم 🤍',
          })
        );
      }

      const doc = {
        name,
        familyName,
        normalizedName,
        deviceId,
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