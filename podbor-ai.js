// Vercel serverless-функция (CommonJS): прокси к OpenAI.
// Ключ берётся из ENV Vercel (OPENAI_API_KEY) — в коде его нет.
// Vercel → проект → Settings → Environment Variables → OPENAI_API_KEY = sk-...
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const profile = body.profile || {};
    const items = body.items || [];

    const sys = [
      'Ты — консультант-нутрициолог бренда Prime Kraft.',
      'На входе: профиль клиента (ответы опроса) и УЖЕ готовый список продуктов с причинами выбора (reason).',
      'Задача: (1) короткий персональный разбор сверху — 2–3 предложения, опирайся на конкретные ответы (цель, вес, сон, стресс, срывы, тренировки);',
      '(2) под каждый продукт — «почему именно вам» в 1–2 предложениях со ссылкой на ответы клиента.',
      'Строгие правила: упоминай ТОЛЬКО переданные продукты, ничего не добавляй и не выдумывай; не ставь диагнозов и не давай мед. назначений; не приводи цифр, которых нет во входных данных; тон поддерживающий, без давления.',
      'Верни СТРОГО JSON: {"analysis":"...","whys":{"<id>":"...", ...}}, где ключи whys — id переданных продуктов.'
    ].join(' ');

    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify({ profile, items }) }
      ]
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '{}';
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(content);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
