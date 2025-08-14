import fetch from 'node-fetch';
import { q } from '../db.js';

(async () => {
  const base = process.env.PUBLIC_BASE_URL;
  const { rows:bots } = await q('select * from bots where is_active = true');
  for (const b of bots) {
    const wh = `${base}/tg/${b.id}/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${b.token}/setWebhook`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url: wh })
    }).then(r=>r.json());
    console.log(b.username || b.id, r);
  }
  process.exit(0);
})().catch(e=>{ console.error(e); process.exit(1); });
