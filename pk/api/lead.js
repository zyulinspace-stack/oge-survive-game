// Приём заявки из подборщика: подписка контакта в Unisender + письмо с набором.
// Ключи берутся ТОЛЬКО из переменных окружения Vercel, в коде их нет.

const API = 'https://api.unisender.com/ru/api';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function call(method, params) {
  const body = new URLSearchParams({ format: 'json', api_key: process.env.UNISENDER_API_KEY, ...params });
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const j = await r.json().catch(() => ({}));
  if (j && j.error) throw new Error(`${method}: ${j.error}`);
  return j && j.result;
}

function buildLetter({ name, items, plan, analysis, math }) {
  const hi = name ? `${esc(name)}, ваш` : 'Ваш';
  const rows = (items || []).map(it => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e4e6e9">
        <div style="font:700 15px/1.3 Arial,sans-serif;color:#141414">${esc(it.name)}</div>
        ${it.why ? `<div style="font:400 13px/1.5 Arial,sans-serif;color:#5b6470;margin-top:4px">${esc(it.why)}</div>` : ''}
        ${it.dose ? `<div style="font:600 12px/1.4 Arial,sans-serif;color:#a8790a;margin-top:4px">${esc(it.dose)}</div>` : ''}
      </td>
      <td style="padding:12px 0 12px 14px;border-bottom:1px solid #e4e6e9;text-align:right;white-space:nowrap;font:700 15px Arial,sans-serif">${esc(it.price)} ₽</td>
    </tr>`).join('');

  const planRows = (plan || []).map(p => `
    <div style="font:400 13px/1.6 Arial,sans-serif;color:#333;margin-bottom:6px">
      <b style="color:#141414">${esc(p.when)}:</b> ${esc(p.items)}
    </div>`).join('');

  const nums = math ? `
    <table width="100%" style="margin:0 0 18px"><tr>
      ${[['ккал в день', math.kcal], ['белки', math.norm + ' г'], ['жиры', math.fat + ' г'], ['углеводы', math.carb + ' г']]
        .map(([l, v]) => `<td style="text-align:left"><div style="font:900 19px Arial,sans-serif;color:#141414">${esc(v)}</div><div style="font:400 11px Arial,sans-serif;color:#7a828c">${l}</div></td>`).join('')}
    </tr></table>` : '';

  return `<!doctype html><html><body style="margin:0;background:#f1f1f1;padding:24px 12px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
      <tr><td style="background:#141414;padding:20px 24px">
        <div style="font:900 18px Arial,sans-serif;color:#fff;letter-spacing:1px">PRIMEKRAFT</div>
        <div style="font:400 12px Arial,sans-serif;color:#ffcd00;margin-top:3px">Персональный подбор</div>
      </td></tr>
      <tr><td style="padding:24px">
        <h1 style="font:900 22px/1.2 Arial,sans-serif;color:#141414;margin:0 0 14px">${hi} комплекс</h1>
        ${analysis ? `<div style="font:400 14px/1.6 Arial,sans-serif;color:#333;background:#faf8ef;border-left:3px solid #ffcd00;padding:12px 14px;margin:0 0 18px">${esc(analysis)}</div>` : ''}
        ${nums}
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        ${planRows ? `<h2 style="font:900 15px Arial,sans-serif;color:#141414;margin:22px 0 10px">Как принимать</h2>${planRows}` : ''}
        <p style="margin:24px 0 0"><a href="https://primekraft.ru/catalog/" style="display:inline-block;background:#ffcd00;color:#141414;font:900 15px Arial,sans-serif;text-decoration:none;padding:14px 26px;border-radius:6px">Открыть каталог</a></p>
        <p style="font:400 11px/1.5 Arial,sans-serif;color:#9aa0a8;margin:22px 0 0">Не является медицинским назначением. При заболеваниях проконсультируйтесь со специалистом.</p>
      </td></tr>
    </table></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!process.env.UNISENDER_API_KEY) return res.status(500).json({ error: 'UNISENDER_API_KEY not set' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = String(b.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: 'bad email' });

    const name = String(b.name || '').slice(0, 40);
    const listId = process.env.UNISENDER_LIST_ID;
    const from = process.env.MAIL_FROM;
    const fromName = process.env.MAIL_FROM_NAME || 'Prime Kraft';

    const out = { subscribed: false, sent: false };

    if (listId) {
      await call('subscribe', {
        list_ids: listId,
        'fields[email]': email,
        'fields[Name]': name,
        double_optin: '3',
        overwrite: '0'
      });
      out.subscribed = true;
    }

    if (from) {
      await call('sendEmail', {
        email,
        sender_name: fromName,
        sender_email: from,
        subject: name ? `${name}, ваш персональный комплекс Prime Kraft` : 'Ваш персональный комплекс Prime Kraft',
        body: buildLetter(b),
        list_id: listId || '',
        lang: 'ru'
      });
      out.sent = true;
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
