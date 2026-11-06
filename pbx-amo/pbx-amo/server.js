'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { normalizePhone, buildCallBody, buildUnsortedBody } = require('./lib');

const {
  DATABASE_URL,
  API_KEY,
  AMO_DOMAIN,
  AMO_TOKEN,
  AMO_PIPELINE_ID,
  SIP_WSS_URL,
  SIP_DOMAIN,
  SIP_USER,
  SIP_PASS,
  SIP_DISPLAY_NAME,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, API_KEY, AMO_DOMAIN, AMO_TOKEN })) {
  if (!v) {
    console.error(`Не задана переменная окружения ${k}`);
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const app = express();
app.use(express.json({ limit: '50kb' }));

// ---------- авторизация по общему ключу ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function auth(req, res, next) {
  if (!safeEqual(req.get('x-api-key'), API_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- amoCRM ----------
async function amo(method, urlPath, body, attempt = 0) {
  const res = await fetch(`https://${AMO_DOMAIN}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${AMO_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // amo ограничивает ~7 запросов/сек — один повтор при 429
  if (res.status === 429 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 1000));
    return amo(method, urlPath, body, attempt + 1);
  }
  if (res.status === 204) return null; // пустой результат поиска
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* не JSON */
  }
  if (!res.ok) {
    const err = new Error(`amo ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Поиск контакта по номеру. Ищем по последним 10 цифрам, затем сверяем телефоны.
async function findContact(phoneDigits) {
  const tail = phoneDigits.slice(-10);
  const data = await amo('GET', `/api/v4/contacts?query=${encodeURIComponent(tail)}&limit=10`);
  const contacts = data?._embedded?.contacts || [];
  for (const c of contacts) {
    const phones = (c.custom_fields_values || [])
      .filter((f) => f.field_code === 'PHONE')
      .flatMap((f) => f.values.map((v) => normalizePhone(v.value)));
    if (phones.includes(phoneDigits)) return c;
  }
  return null;
}

async function pushToAmo(row) {
  try {
    const contact = await findContact(row.phone);
    if (contact) {
      await amo('POST', '/api/v4/calls', buildCallBody(row));
    } else {
      await amo('POST', '/api/v4/leads/unsorted/sip', buildUnsortedBody(row, AMO_PIPELINE_ID));
    }
    await pool.query(`update calls set amo_status='sent', amo_error=null where call_uid=$1`, [row.call_uid]);
  } catch (e) {
    console.error('amo push failed:', e.message);
    await pool.query(`update calls set amo_status='error', amo_error=$2 where call_uid=$1`, [
      row.call_uid,
      e.message.slice(0, 500),
    ]);
  }
}

// ---------- API ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// Настройки SIP для софтфона (под ключом, т.к. содержат пароль)
app.get('/api/sip-config', auth, (_req, res) => {
  res.json({
    wssUrl: SIP_WSS_URL,
    domain: SIP_DOMAIN,
    user: SIP_USER,
    password: SIP_PASS,
    displayName: SIP_DISPLAY_NAME || SIP_USER,
    amoDomain: AMO_DOMAIN,
  });
});

// Кто звонит: ищем в amo, отдаём имя и ссылку на карточку
app.get('/api/lookup', auth, async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (phone.length < 10) return res.json({ found: false });
  try {
    const c = await findContact(phone);
    if (!c) return res.json({ found: false, phone });
    res.json({ found: true, phone, id: c.id, name: c.name, url: `https://${AMO_DOMAIN}/contacts/detail/${c.id}` });
  } catch (e) {
    console.error('lookup failed:', e.message);
    res.status(502).json({ found: false, error: 'amo_unavailable' });
  }
});

// События звонка от софтфона: ringing -> answered -> ended
app.post('/api/call-event', auth, async (req, res) => {
  const { callUid, direction, phone, operator, state } = req.body || {};
  const digits = normalizePhone(phone);
  if (!callUid || !['inbound', 'outbound'].includes(direction) || digits.length < 5 || !['ringing', 'answered', 'ended'].includes(state)) {
    return res.status(400).json({ error: 'bad_request' });
  }
  try {
    await pool.query(
      `insert into calls (call_uid, direction, phone, operator) values ($1,$2,$3,$4)
       on conflict (call_uid) do nothing`,
      [callUid, direction, digits, operator || null]
    );
    if (state === 'answered') {
      await pool.query(`update calls set answered_at=now(), status='answered' where call_uid=$1 and answered_at is null`, [callUid]);
      return res.json({ ok: true });
    }
    if (state === 'ended') {
      const { rows } = await pool.query(
        `update calls set
           ended_at = now(),
           duration_sec = coalesce(extract(epoch from (now() - answered_at))::int, 0),
           status = case when answered_at is null then 'missed' else 'answered' end
         where call_uid=$1 and ended_at is null
         returning *`,
        [callUid]
      );
      res.json({ ok: true });
      if (rows[0]) pushToAmo(rows[0]); // после ответа, не блокируем софтфон
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('call-event failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Последние звонки (для панели в софтфоне и отладки)
app.get('/api/calls', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { rows } = await pool.query(
    `select call_uid, direction, phone, operator, started_at, duration_sec, status, amo_status, amo_error
     from calls order by started_at desc limit $1`,
    [limit]
  );
  res.json(rows);
});

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log(`pbx-amo слушает порт ${PORT}`));
})().catch((e) => {
  console.error('Старт не удался:', e);
  process.exit(1);
});
