import express from 'express';
import fetch from 'node-fetch';
import { q } from './db.js';

const app = express();
app.use(express.json());

// Простая админ-аутентификация по токену
function auth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).json({ ok:false, error: 'unauthorized' });
  next();
}

// 1) Добавить бота
app.post('/admin/bots', auth, async (req, res) => {
  const { token, username, display_name } = req.body;
  if (!token) return res.status(400).json({ ok:false, error:'token required' });
  const r = await q('insert into bots(token, username, display_name) values ($1,$2,$3) returning *', [token, username||null, display_name||null]);
  return res.json({ ok:true, bot:r.rows[0] });
});

// 2) Выставить вебхук всем активным ботам
app.post('/admin/set-webhooks', auth, async (req, res) => {
  const base = process.env.PUBLIC_BASE_URL;
  const { rows:bots } = await q('select * from bots where is_active = true');
  const results = [];
  for (const b of bots) {
    const url = `https://api.telegram.org/bot${b.token}/setWebhook`;
    const wh = `${base}/tg/${b.id}/webhook`;
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: wh })}).then(r=>r.json());
    results.push({ bot_id:b.id, ok:r.ok, desc:r.description });
  }
  res.json({ ok:true, results });
});

// 3) Webhook на входящие апдейты
app.post('/tg/:botId/webhook', async (req, res) => {
  const botId = Number(req.params.botId);
  const update = req.body;
  try {
    const { rows } = await q('select * from bots where id=$1 and is_active=true', [botId]);
    if (!rows.length) return res.sendStatus(404);
    const bot = rows[0];

    const api = (method, payload) => fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    }).then(r=>r.json());

    const msg = update.message;
    const cbq = update.callback_query;

    if (msg && msg.text && msg.text.startsWith('/start')) {
      const chat = msg.chat;
      const payload = (msg.text.split(' ')[1] || '');
      await q(`insert into subscribers(bot_id, chat_id, username, first_name, last_name, lang, start_payload, last_seen_at)
               values ($1,$2,$3,$4,$5,$6,$7, now())
               on conflict do nothing`,
               [botId, chat.id, chat.username||null, chat.first_name||null, chat.last_name||null, msg.from?.language_code||null, payload]);
      await q('insert into events(bot_id, chat_id, type, payload) values ($1,$2,$3,$4)', [botId, chat.id, 'start', { start: payload }]);

      // Приветствие по умолчанию
      await api('sendMessage', {
        chat_id: chat.id,
        text: 'Привет! 👋 Нажмите «Начать», чтобы получить ссылку.',
        reply_markup: { inline_keyboard: [[{ text:'Начать', callback_data:'start_clicked' }]] }
      });
    }

    if (cbq && cbq.data === 'start_clicked') {
      const chatId = cbq.message.chat.id;
      await q('insert into events(bot_id, chat_id, type, payload) values ($1,$2,$3,$4)', [botId, chatId, 'click', { btn:'start' }]);
      await api('answerCallbackQuery', { callback_query_id: cbq.id });
      await api('sendMessage', { chat_id: chatId, text: 'Спасибо! Вот ваша ссылка: https://example.com' });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// 4) Создать кампанию (черновик)
app.post('/admin/campaigns', auth, async (req, res) => {
  const { name, bot_id, content } = req.body; // content — JSON (см. ниже)
  if (!content) return res.status(400).json({ ok:false, error:'content required' });
  const r = await q('insert into campaigns(name, bot_id, content, status) values ($1,$2,$3,$4) returning *', [name||null, bot_id||null, content, 'draft']);
  res.json({ ok:true, campaign:r.rows[0] });
});

// 5) Запуск кампании (создание job’ов)
app.post('/admin/campaigns/:id/run', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows:campR } = await q('select * from campaigns where id=$1', [id]);
  if (!campR.length) return res.status(404).json({ ok:false, error:'not found' });
  const camp = campR[0];

  // Получаем подписчиков
  const subsQuery = camp.bot_id
    ? `select s.chat_id, s.bot_id from subscribers s where s.bot_id=$1`
    : `select s.chat_id, s.bot_id from subscribers s`;
  const params = camp.bot_id ? [camp.bot_id] : [];
  const { rows:subs } = await q(subsQuery, params);

  // Создаём задания
  for (const s of subs) {
    await q('insert into campaign_jobs(campaign_id, bot_id, chat_id) values ($1,$2,$3)', [id, s.bot_id, s.chat_id]);
  }
  await q('update campaigns set status=$2, started_at=now() where id=$1', [id, 'running']);
  res.json({ ok:true, total: subs.length });
});

// 6) Воркёр отправки (упрощённый, вызывается кроном или ручным запросом)
app.post('/admin/worker/tick', auth, async (req, res) => {
  // Берём до 100 задач в очереди
  const { rows:jobs } = await q(`
    select j.id, j.campaign_id, j.bot_id, j.chat_id, c.content, b.token
    from campaign_jobs j
    join campaigns c on c.id=j.campaign_id
    join bots b on b.id=j.bot_id
    where j.status='queued'
    limit 100
  `);

  let sent = 0, errors = 0;
  for (const j of jobs) {
    try {
      const api = (m,p) => fetch(`https://api.telegram.org/bot${j.token}/${m}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(p) }).then(r=>r.json());
      const content = j.content; // JSON из кампании

      if (content.type === 'text') {
        await api('sendMessage', { chat_id: j.chat_id, text: content.text, parse_mode: content.parse_mode||undefined, reply_markup: content.buttons ? { inline_keyboard: content.buttons } : undefined });
      } else if (content.type === 'photo') {
        await api('sendPhoto', { chat_id: j.chat_id, photo: content.photo_url, caption: content.caption||undefined, parse_mode: content.parse_mode||undefined, reply_markup: content.buttons ? { inline_keyboard: content.buttons } : undefined });
      } else {
        // fallback — текст
        await api('sendMessage', { chat_id: j.chat_id, text: content.fallback_text || 'Hello!', reply_markup: content.buttons ? { inline_keyboard: content.buttons } : undefined });
      }

      await q('update campaign_jobs set status=$2, sent_at=now() where id=$1', [j.id, 'sent']);
      sent++;
    } catch (e) {
      await q('update campaign_jobs set status=$2, error_text=$3 where id=$1', [j.id, 'error',
