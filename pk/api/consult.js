// Консультант Prime Kraft: отвечает ТОЛЬКО по переданному каталогу.
// Ключ берётся из переменной окружения, в коде его нет.

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYS = [
  'Ты — консультант интернет-магазина спортивного питания Prime Kraft. Общаешься с клиентом, который только что прошёл подбор.',
  'ЖЁСТКОЕ ПРАВИЛО: ты можешь рекомендовать ТОЛЬКО те товары, которые есть в списке catalog из входных данных.',
  'Никогда не упоминай и не советуй товары, которых нет в catalog, — ни других брендов, ни продуктов Prime Kraft, отсутствующих в списке.',
  'Если клиент спрашивает про то, чего в catalog нет, честно скажи: у Prime Kraft такого сейчас нет в наличии, и предложи ближайшую подходящую позицию ИЗ catalog либо признай, что подходящего нет.',
  'Не выдумывай состав, дозировки, характеристики и цены — используй только то, что передано.',
  'Не ставь диагнозов, не назначай лечение, не обещай конкретных килограммов, процентов и сроков.',
  'Если вопрос про здоровье, болезни, лекарства или беременность — коротко порекомендуй обратиться к врачу и не давай медицинских советов.',
  'Отвечай кратко и по-человечески: 2–4 предложения, без канцелярита и без списков, если клиент сам не просит список.',
  'Верни СТРОГО JSON: {"answer":"текст ответа","items":["id товара из catalog", "..."]}.',
  'В items клади только id из catalog, максимум 3 штуки, и только если они реально уместны в ответе. Если товары не нужны — пустой массив.'
].join(' ');

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const question = String(b.question || '').slice(0, 500);
    if (!question.trim()) return res.status(400).json({ error: 'empty question' });

    const catalog = (Array.isArray(b.catalog) ? b.catalog : []).slice(0, 200).map(x => ({
      id: String(x.id || '').slice(0, 40),
      name: String(x.name || '').slice(0, 90),
      price: x.price,
      type: String(x.type || '').slice(0, 20)
    }));
    if (!catalog.length) return res.status(400).json({ error: 'empty catalog' });

    const history = (Array.isArray(b.history) ? b.history : []).slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 700)
    }));

    const payload = {
      model: MODEL,
      temperature: 0.5,
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: JSON.stringify({ profile: b.profile || {}, currentSet: b.currentSet || [], catalog }) },
        ...history,
        { role: 'user', content: question }
      ]
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: (j.error && j.error.message) || 'openai error' });

    let out = {};
    try { out = JSON.parse(j.choices[0].message.content); } catch (e) { out = { answer: j.choices[0].message.content, items: [] }; }

    // страховка: оставляем только id, реально присутствующие в каталоге
    const ids = new Set(catalog.map(c => c.id));
    out.items = (Array.isArray(out.items) ? out.items : []).filter(id => ids.has(String(id))).slice(0, 3);
    out.answer = String(out.answer || '').slice(0, 1200);

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
