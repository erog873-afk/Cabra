
// Запуск: BOT_TOKEN=... ADMIN_ID=... DATABASE_URL=postgres://... node server.js   (Node 18+, зависимость: pg)
// ADMIN_ID — ваш Telegram ID. Только он может добавлять и удалять задания.
// Проверка заданий: бот должен быть АДМИНИСТРАТОРОМ канала/группы, на которую подписываются.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
types.setTypeParser(1700, v => Number(v)); // NUMERIC -> число

const BOT_TOKEN = process.env.BOT_TOKEN || '8758871773:AAFoZe3Mc2tX8e_JwXdE1xgCJ6Oh3pRzB0s';
const ADMIN_ID = process.env.ADMIN_ID || '8642237301';
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const STRICT_CHECK = process.env.STRICT_CHECK !== '0'; // проверка подписки включена; отключить: STRICT_CHECK=0
const MIN_WAIT_MS = 3000; // минимум между «Начать» и «Проверить задание»
if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) { console.error('Задайте BOT_TOKEN, ADMIN_ID и DATABASE_URL'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === '0' ? false : { rejectUnauthorized: false },
  max: 10
});
pool.on('error', e => console.log('[db] pool error:', e.message));

const WEEK_MS = 7 * 24 * 3600 * 1000;
const round2 = n => Math.round(n * 100) / 100;
const q = (text, params) => pool.query(text, params);

// Транзакция: fn получает клиента, при ошибке всё откатывается
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

// Начислить звёзды + запись в журнал (внутри транзакции). Возвращает новый баланс.
async function addStars(c, uid, delta, reason, ref) {
  const r = await c.query('UPDATE ma_users SET stars = ROUND(stars + $2, 2), updated_at = now() WHERE id = $1 RETURNING stars', [uid, delta]);
  await c.query('INSERT INTO ma_stars_log (user_id, delta, reason, ref) VALUES ($1, $2, $3, $4)', [uid, delta, reason, ref || null]);
  return r.rows[0].stars;
}

// Таймер лидеров: 7 дней. Когда цикл заканчивается, начинается новый.
async function cycleEnd() {
  const now = Date.now();
  const r = await q("SELECT value FROM ma_meta WHERE key = 'leaders_end'");
  let end = r.rows[0] ? Number(r.rows[0].value) : 0;
  if (!end || end <= now) {
    end = now + WEEK_MS;
    await q("INSERT INTO ma_meta (key, value) VALUES ('leaders_end', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(end)]);
  }
  return end;
}

// Создание таблиц + разовый перенос старых tasks.json / users.json / leaders-cycle.json (если они лежат рядом)
async function initDb() {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch { return def; } };

  const migrated = await q("SELECT 1 FROM ma_meta WHERE key = 'migrated'");
  if (!migrated.rowCount) {
    await tx(async c => {
      const tasks = readJson('tasks.json', []);
      for (const t of Array.isArray(tasks) ? tasks : []) {
        await c.query('INSERT INTO ma_tasks (id, title, url, reward, icon) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
          [String(t.id), String(t.title || ''), String(t.url || ''), Number(t.reward) || 1, String(t.icon || '')]);
      }
      const ids = new Set((await c.query('SELECT id FROM ma_tasks')).rows.map(r => r.id));
      const users = readJson('users.json', {});
      for (const [id, u] of Object.entries(users)) {
        if (!/^\d+$/.test(id) || !u) continue;
        await c.query('INSERT INTO ma_users (id, name, photo, stars) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
          [id, String(u.name || ''), String(u.photo || ''), Number(u.stars) || 0]);
        for (const tid of u.done || []) if (ids.has(tid))
          await c.query('INSERT INTO ma_user_tasks (user_id, task_id, done_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING', [id, tid]);
        for (const [tid, ts] of Object.entries(u.started || {})) if (ids.has(tid))
          await c.query('INSERT INTO ma_user_tasks (user_id, task_id, started_at) VALUES ($1,$2,to_timestamp($3/1000.0)) ON CONFLICT DO NOTHING', [id, tid, Number(ts) || Date.now()]);
        if (Number(u.stars) > 0)
          await c.query("INSERT INTO ma_stars_log (user_id, delta, reason, ref) VALUES ($1,$2,'import','users.json')", [id, Number(u.stars)]);
      }
      const cyc = readJson('leaders-cycle.json', null);
      if (cyc && Number(cyc.end) > Date.now())
        await c.query("INSERT INTO ma_meta (key, value) VALUES ('leaders_end', $1) ON CONFLICT (key) DO NOTHING", [String(Number(cyc.end))]);

      // Если заданий нет совсем — одно тестовое (удалите его в админ-панели)
      if (!(await c.query('SELECT 1 FROM ma_tasks LIMIT 1')).rowCount) {
        let icon = '';
        for (const f of ['index.html', 'tasks.html']) {
          try { icon = fs.readFileSync(path.join(__dirname, f), 'utf8').match(/DEFAULT_ICON\s*=\s*"(data:image\/png;base64,[A-Za-z0-9+\/=]+)"/)[1]; break; } catch {}
        }
        await c.query('INSERT INTO ma_tasks (id, title, url, reward, icon) VALUES ($1,$2,$3,$4,$5)',
          ['test-task', 'Тестовое задание', process.env.TEST_CHANNEL || 'https://t.me/your_channel', 1, icon]);
      }
      await c.query("INSERT INTO ma_meta (key, value) VALUES ('migrated', '1') ON CONFLICT DO NOTHING");
    });
    console.log('[db] инициализация/перенос данных выполнены');
  }
}

// Проверка подписи initData по документации Telegram. Возвращает пользователя или null.
function verify(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); params.delete('hash');
  if (!hash) return null;
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const ok = calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  if (!ok) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null; // старше суток
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// Подписан ли пользователь на канал/группу из ссылки https://t.me/<username>.
// Возвращает { ok: true } или { ok: false, error: 'текст для пользователя' }.
async function checkSubscription(link, userId) {
  const m = String(link).match(/^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:[?#].*)?$/);
  if (!m) return { ok: false, error: 'Для этого задания автоматическая проверка недоступна: нужна публичная ссылка вида https://t.me/название.' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '@' + m[1], user_id: Number(userId) })
    });
    const d = await r.json();
    if (!d.ok) {
      console.log('[check] getChatMember error:', d.description);
      return { ok: false, error: 'Не удалось проверить подписку. Бот должен быть администратором этого канала.' };
    }
    const status = d.result && d.result.status;
    if (['creator', 'administrator', 'member'].includes(status) || (status === 'restricted' && d.result.is_member)) return { ok: true };
    return { ok: false, notDone: true, error: 'Вы не выполнили задание' };
  } catch (e) {
    console.log('[check] network error:', e.message);
    return { ok: false, error: 'Не удалось связаться с Telegram. Попробуйте позже.' };
  }
}

// ---------- Linkni: подписки на спонсоров ----------
// Ссылка задания: https://t.me/linknibot/app?startapp=x_КОД  (КОД — sell code из кабинета Linkni, например 3cfkf).
// Каждому человеку к ссылке добавляется свой sub code (u<ID>), по нему сервер находит именно его подписку.
// Проверка: запрос к API Linkni (подписки за последний час). Вебхук POST /webhook сохраняет события; если задан
// LINKNI_WEBHOOK_KEY, укажите в кабинете адрес https://ваш-сервер/webhook?key=ВАШ_КЛЮЧ — без ключа вебхук не принимается.
const LINKNI_RE = /^https:\/\/(?:t|telegram)\.me\/linknibot\/app\?startapp=x_([A-Za-z0-9]+)(?:_[A-Za-z0-9-]*)?$/i;
const LINKNI_KEY = process.env.LINKNI_WEBHOOK_KEY || '';
// Автоматическое задание «Подписаться на спонсоров»: показывается всем и повторяется — каждый раз Linkni даёт новых спонсоров.
// Ваш код Linkni (sell code) — LINKNI_CODE (по умолчанию 3cfkf; LINKNI_CODE=off — отключить). Награда за каждое выполнение — LINKNI_REWARD (0.3).
const LINKNI_CODE = (process.env.LINKNI_CODE || '3cfkf').trim();
const LINKNI_AUTO = LINKNI_CODE !== '' && LINKNI_CODE.toLowerCase() !== 'off';
const LINKNI_REWARD = Number(process.env.LINKNI_REWARD) || 0.3;
const LINKNI_TITLE = process.env.LINKNI_TITLE || 'Подписаться на спонсоров';
const linkniLast = new Map();
const linkniCode = u => { const m = String(u).match(LINKNI_RE); return m ? m[1] : null; };
const linkniSub = uid => 'u' + uid;
const linkniUrl = (u, uid) => { const c = linkniCode(u); return c ? `https://t.me/linknibot/app?startapp=x_${c}_${linkniSub(uid)}` : u; };

const linkniTask = uid => ({ id: 'linkni', title: LINKNI_TITLE, url: linkniUrl(`https://t.me/linknibot/app?startapp=x_${LINKNI_CODE}`, uid), reward: LINKNI_REWARD, icon: '', done: false, auto: true });

async function checkLinkni(code, userId) {
  const sub = linkniSub(userId);
  try {
    const r = await fetch(`https://go.linkni.me/api/subscriptions?code=${encodeURIComponent(code)}&user_id=${Number(userId)}&sub_code=${encodeURIComponent(sub)}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    const mine = (Array.isArray(arr) ? arr : []).filter(x => x && String(x.user_id) === String(userId));
    const subs = mine.filter(x => x.status === 'subscribed');
    if (subs.length) return { ok: true, ts: Math.max(...subs.map(x => Date.parse(x.timestamp) || Date.now())) };
    if (mine.some(x => x.status === 'no_sponsors')) return { ok: false, noSponsors: true, error: 'Сейчас нет заданий от спонсоров. Попробуйте позже.' };
    return { ok: false, notDone: true, error: 'Вы не выполнили задание' };
  } catch (e) {
    console.log('[linkni] api error:', e.message);
    if (LINKNI_KEY) { // запасной вариант: событие, пришедшее на вебхук за последний час
      const r = await q("SELECT (extract(epoch FROM max(created_at)) * 1000)::float8 AS ts FROM ma_linkni_events WHERE user_id = $1 AND sell_code = $2 AND status = 'subscribed' AND sub_code = $3 AND created_at > now() - interval '1 hour'", [userId, code, sub]);
      if (r.rows[0] && r.rows[0].ts) return { ok: true, ts: r.rows[0].ts };
    }
    return { ok: false, error: 'Не удалось проверить задание. Попробуйте позже.' };
  }
}

// ---------- Приглашение: окно Telegram «Отправить сообщение» ----------
// Кнопка «Пригласить» в профиле просит у сервера «готовое сообщение» (savePreparedInlineMessage) и открывает его через shareMessage.
// Настройки (все необязательные): APP_LINK — ссылка на приложение (по умолчанию https://t.me/<username бота>), PUBLIC_URL — адрес сайта для картинки,
// INVITE_TEXT, INVITE_BUTTON — текст сообщения и кнопки. Картинка — файл invite.jpg (или invite.png) рядом с server.js.
let BOT_USERNAME = process.env.BOT_USERNAME || '';
const INVITE_IMAGE_URL = 'https://static46.tgcnt.ru/posts/_0/d8/d82d6a965a47e0e72f71cef162707aae.jpg'; // <-- вставьте сюда прямую ссылку на картинку (https://...jpg/png), либо задайте переменную INVITE_IMAGE
async function botApi(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(8000)
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.description || ('HTTP ' + r.status));
  return d.result;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg'
};
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json']);

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 300000) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
});


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Вебхук Linkni: POST /webhook  {"user_id":..,"status":"subscribed|not_subscribed|no_sponsors","sell_code":"..","sub_code":".."}
    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (LINKNI_KEY && url.searchParams.get('key') !== LINKNI_KEY) return send(res, 403, { error: 'Нет доступа' });
      const d = await body(req);
      const st = String(d.status || '');
      if (/^\d{1,15}$/.test(String(d.user_id)) && ['subscribed', 'not_subscribed', 'no_sponsors'].includes(st)) {
        await q('INSERT INTO ma_linkni_events (user_id, status, sell_code, sub_code) VALUES ($1,$2,$3,$4)',
          [String(d.user_id), st, String(d.sell_code || '').slice(0, 40), String(d.sub_code || '').slice(0, 80)]);
      }
      return send(res, 200, { ok: true });
    }

    // Статика: index.html и подключаемые к нему файлы (cases-store.js, balance-widget.js, roulette.html, картинки...).
    // Служебные файлы (server.js, package.json, *.json с данными) отдавать нельзя.
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 404, { error: 'Не найдено' });
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(__dirname, name);
      const ext = path.extname(file).toLowerCase();
      const ok = file.startsWith(__dirname + path.sep) && MIME[ext] && !PRIVATE.has(path.basename(file)) &&
        fs.existsSync(file) && fs.statSync(file).isFile();
      if (!ok) return send(res, 404, { error: 'Не найдено' });
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache' });
      return res.end(fs.readFileSync(file));
    }

    const user = verify(req.headers['x-init-data']);
    if (!user) { console.log('[auth] 401: initData ' + (req.headers['x-init-data'] ? 'не прошла проверку подписи (BOT_TOKEN не от этого бота?)' : 'отсутствует (открыто не из Telegram?)')); return send(res, 401, { error: 'Откройте приложение из Telegram' }); }
    const isAdmin = String(user.id) === String(ADMIN_ID);
    if (url.pathname.startsWith('/api/admin/') && !isAdmin) console.log('[auth] 403: id ' + user.id + ' не равен ADMIN_ID');
    const uid = String(user.id);

    // Создаём пользователя при первом заходе и обновляем имя/фото для таблицы лидеров
    {
      const nm = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 40) || user.username || ('ID ' + uid.slice(-4));
      const ph = typeof user.photo_url === 'string' && /^https:\/\//.test(user.photo_url) ? user.photo_url : '';
      await q(`INSERT INTO ma_users (id, name, photo) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, photo = EXCLUDED.photo, updated_at = now()
               WHERE ma_users.name IS DISTINCT FROM EXCLUDED.name OR ma_users.photo IS DISTINCT FROM EXCLUDED.photo`, [uid, nm, ph]);
    }

    // Приглашение друзей: готовое сообщение для окна «Отправить сообщение»
    if (req.method === 'POST' && url.pathname === '/api/invite') {
      if (!BOT_USERNAME) { try { BOT_USERNAME = (await botApi('getMe')).username || ''; } catch (e) { console.log('[invite] getMe:', e.message); } }
      const base = process.env.APP_LINK || (BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : '');
      if (!base) return send(res, 500, { error: 'Не удалось определить ссылку на приложение' });
      const link = base + (base.includes('?') ? '&' : '?') + 'startapp=ref_' + uid;
      const en = (user.language_code || 'ru') === 'en';
      const text = process.env.INVITE_TEXT || (en ? '⭐ Want me to give you stars and gifts?\n\nGet them every 24 hours in the free roulette!' : '⭐ Хочешь подарю тебе звезды и подарки?\n\nПолучай их каждые 24 часа в бесплатной рулетке!');
      const btn = process.env.INVITE_BUTTON || (en ? 'Get' : 'Получить');
      const markup = { inline_keyboard: [[{ text: btn, url: link }]] };
      const origin = process.env.PUBLIC_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      const imgFile = ['invite.jpg', 'invite.png'].find(f => fs.existsSync(path.join(__dirname, f)));
      // Картинка по ссылке: INVITE_IMAGE (или константа ниже). Если пусто — берётся invite.jpg/png рядом с server.js
      const imgUrl = process.env.INVITE_IMAGE || INVITE_IMAGE_URL || (imgFile ? `${origin}/${imgFile}` : '');
      const result = imgUrl
        ? { type: 'photo', id: 'invite', photo_url: imgUrl, thumbnail_url: imgUrl, caption: text, reply_markup: markup }
        : { type: 'article', id: 'invite', title: en ? 'Invitation' : 'Приглашение', input_message_content: { message_text: text }, reply_markup: markup };
      try {
        const saved = await botApi('savePreparedInlineMessage', { user_id: Number(uid), result, allow_user_chats: true, allow_bot_chats: false, allow_group_chats: true, allow_channel_chats: false });
        return send(res, 200, { id: saved.id, link, text });
      } catch (e) {
        console.log('[invite] savePreparedInlineMessage:', e.message);
        return send(res, 200, { link, text }); // запасной вариант: клиент откроет обычную отправку ссылки
      }
    }

    // Таблица лидеров: топ-50 по звёздам + место текущего пользователя (чужие ID не отдаём)
    if (req.method === 'GET' && url.pathname === '/api/leaders') {
      const top = (await q('SELECT id::text AS id, name, photo, stars FROM ma_users WHERE stars > 0 ORDER BY stars DESC, created_at ASC LIMIT 50')).rows
        .map((x, i) => ({ rank: i + 1, name: x.name || ('ID ' + x.id.slice(-4)), photo: x.photo || '', stars: x.stars, me: x.id === uid }));
      const mine = (await q('SELECT name, photo, stars FROM ma_users WHERE id = $1', [uid])).rows[0] || { name: '', photo: '', stars: 0 };
      const total = (await q('SELECT count(*)::int AS n FROM ma_users WHERE stars > 0')).rows[0].n;
      const rank = mine.stars > 0 ? (await q('SELECT count(*)::int + 1 AS r FROM ma_users WHERE stars > $1', [mine.stars])).rows[0].r : null;
      return send(res, 200, { top, me: { rank, stars: mine.stars, photo: mine.photo || '', name: mine.name || '' }, total, endsAt: await cycleEnd() });
    }

    // Список заданий + баланс и отметки «выполнено» для этого пользователя
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const stars = (await q('SELECT stars FROM ma_users WHERE id = $1', [uid])).rows[0].stars;
      const tasks = (await q(`SELECT t.id, t.title, t.url, t.reward, t.icon, (ut.done_at IS NOT NULL) AS done
                              FROM ma_tasks t LEFT JOIN ma_user_tasks ut ON ut.task_id = t.id AND ut.user_id = $1
                              ORDER BY t.pos`, [uid])).rows;
      return send(res, 200, { tasks: tasks.map(t => ({ ...t, url: linkniUrl(t.url, uid) })).concat(LINKNI_AUTO ? [linkniTask(uid)] : []), isAdmin, stars });
    }

    // Человек нажал «Начать»: запоминаем момент
    const st = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/start$/);
    if (req.method === 'POST' && st && st[1] === 'linkni') return send(res, 200, { ok: true });
    if (req.method === 'POST' && st) {
      const r = await q('INSERT INTO ma_user_tasks (user_id, task_id) SELECT $1, id FROM ma_tasks WHERE id = $2 ON CONFLICT DO NOTHING RETURNING 1', [uid, st[1]]);
      if (!r.rowCount && !(await q('SELECT 1 FROM ma_tasks WHERE id = $1', [st[1]])).rowCount) return send(res, 404, { error: 'Задание не найдено' });
      return send(res, 200, { ok: true });
    }

    // Проверка выполнения задания
    const chk = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/check$/);
    if (req.method === 'POST' && chk && chk[1] === 'linkni') {
      if (!LINKNI_AUTO) return send(res, 404, { error: 'Задание не найдено' });
      const last = linkniLast.get(uid) || 0;               // не чаще раза в 3 секунды на человека
      if (Date.now() - last < MIN_WAIT_MS) return send(res, 200, { ok: false, notDone: true, error: 'Вы не выполнили задание' });
      linkniLast.set(uid, Date.now());
      const result = await checkLinkni(LINKNI_CODE, user.id);
      if (!result.ok) return send(res, 200, { ok: false, notDone: !!result.notDone, noSponsors: !!result.noSponsors, error: result.error });
      // Награда — за каждую НОВУЮ подписку (новее предыдущей награждённой), повторно за одну и ту же не выдаётся
      const out = await tx(async c => {
        const r = await c.query(`INSERT INTO ma_linkni_claims (user_id, last_ts) VALUES ($1, to_timestamp($2 / 1000.0))
                                 ON CONFLICT (user_id) DO UPDATE SET last_ts = EXCLUDED.last_ts WHERE ma_linkni_claims.last_ts < EXCLUDED.last_ts
                                 RETURNING 1`, [uid, result.ts]);
        if (!r.rowCount) return null;
        return { reward: LINKNI_REWARD, stars: await addStars(c, uid, LINKNI_REWARD, 'linkni', LINKNI_CODE) };
      });
      if (!out) return send(res, 200, { ok: false, notDone: true, error: 'Вы не выполнили задание' });
      return send(res, 200, { ok: true, ...out });
    }
    if (req.method === 'POST' && chk) {
      const task = (await q('SELECT id, url, reward FROM ma_tasks WHERE id = $1', [chk[1]])).rows[0];
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      const ut = (await q('SELECT started_at, done_at FROM ma_user_tasks WHERE user_id = $1 AND task_id = $2', [uid, task.id])).rows[0];
      if (ut && ut.done_at) return send(res, 200, { ok: true, already: true, stars: (await q('SELECT stars FROM ma_users WHERE id = $1', [uid])).rows[0].stars });
      if (!ut || Date.now() - ut.started_at.getTime() < MIN_WAIT_MS) return send(res, 200, { ok: false, notDone: true, error: 'Вы не выполнили задание' });
      const lcode = linkniCode(task.url);
      if (lcode) {
        const result = await checkLinkni(lcode, user.id);
        if (!result.ok) return send(res, 200, { ok: false, notDone: !!result.notDone, noSponsors: !!result.noSponsors, error: result.error });
      } else if (STRICT_CHECK) {
        const result = await checkSubscription(task.url, user.id);
        if (!result.ok) return send(res, 200, { ok: false, notDone: !!result.notDone, noSponsors: !!result.noSponsors, error: result.error });
      }
      // Атомарно: отметка «выполнено» и начисление — только если ещё не выполнено (защита от двойных запросов)
      const out = await tx(async c => {
        const r = await c.query('UPDATE ma_user_tasks SET done_at = now() WHERE user_id = $1 AND task_id = $2 AND done_at IS NULL RETURNING 1', [uid, task.id]);
        if (!r.rowCount) return { already: true, stars: (await c.query('SELECT stars FROM ma_users WHERE id = $1', [uid])).rows[0].stars };
        return { reward: task.reward, stars: await addStars(c, uid, task.reward, 'task', task.id) };
      });
      return send(res, 200, { ok: true, ...out });
    }

    // Дальше только для администратора. Проверка делается здесь, на сервере.
    if (!isAdmin) return send(res, 403, { error: 'Нет доступа' });

    if (req.method === 'POST' && url.pathname === '/api/admin/tasks') {
      const d = await body(req);
      const title = String(d.title || '').trim().slice(0, 80);
      const link = String(d.url || '').trim();
      const reward = round2(Number(d.reward));
      const icon = String(d.icon || '');
      if (!title) return send(res, 400, { error: 'Введите название' });
      if (!/^https:\/\//.test(link) || link.length > 500) return send(res, 400, { error: 'Некорректная ссылка' });
      if (!(reward > 0 && reward <= 100000)) return send(res, 400, { error: 'Некорректная награда' });
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon) || icon.length > 200000) return send(res, 400, { error: 'Некорректная иконка' });
      await q('INSERT INTO ma_tasks (id, title, url, reward, icon) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), title, link, reward, icon]);
      return send(res, 200, { ok: true });
    }

    const del = url.pathname.match(/^\/api\/admin\/tasks\/([\w-]+)$/);
    if (req.method === 'DELETE' && del) {
      await q('DELETE FROM ma_tasks WHERE id = $1', [del[1]]);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.log('[error]', e && e.message);
    send(res, 400, { error: 'Некорректный запрос' });
  }
});

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log('Server started on port ' + PORT));
}).catch(e => { console.error('[db] не удалось подключиться/создать таблицы:', e.message); process.exit(1); });
