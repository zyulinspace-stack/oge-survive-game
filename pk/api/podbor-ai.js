// Vercel serverless (CommonJS): прокси к OpenAI. Ключ — из ENV Vercel (OPENAI_API_KEY).
// Роутер по body.action: 'enrich' (разбор+план) | 'replace' (замена) | 'next' (адаптивный вопрос).
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY not set' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || 'enrich';
    let sys, user;

    if (action === 'next') {
      sys = [
        'Ты ведёшь опрос-консультацию для подбора спортпита Prime Kraft.',
        'Тебе дают список ДОСТУПНЫХ вопросов (id — короткое описание) и уже собранные ответы.',
        'Выбери самый полезный СЛЕДУЮЩИЙ вопрос, которого ещё нет в ответах, адаптируясь к ним:',
        'пропускай нерелевантное (например, не спрашивай формат тренировок при freq="0"; не углубляйся в сон при sleep="good").',
        'Цель — собрать профиль, достаточный для подбора добавок; обычно хватает 8–13 вопросов.',
        'Верни СТРОГО JSON: {"nextId":"<id из списка, которого ещё нет в ответах>"} либо {"done":true}, когда данных достаточно.',
        'Только id из предоставленного списка, ничего не выдумывай.'
      ].join(' ');
      user = JSON.stringify({ answers: body.answers || {}, available: body.available || [], asked: body.asked || [] });

    } else if (action === 'replace') {
      sys = [
        'Ты — нутрициолог Prime Kraft. Клиент хочет заменить один продукт в наборе.',
        'Тебе дают: профиль, текущий продукт, текущий набор и СПИСОК допустимых альтернатив (candidates).',
        'Выбирай ТОЛЬКО из candidates: осмысленную замену (та же роль/категория или логичная под профиль).',
        'Верни СТРОГО JSON: {"id":"<id строго из candidates>","why":"1–2 предложения, почему эта замена подходит именно этому клиенту"}.',
        'Не выдумывай товары, без медицинских диагнозов и обещаний.'
      ].join(' ');
      user = JSON.stringify({ profile: body.profile || {}, current: body.current || {}, set: body.set || [], candidates: body.candidates || [] });

    } else { // enrich
      sys = [
        'Ты — консультант-нутрициолог Prime Kraft. На входе: профиль клиента (включая имя) и готовый список продуктов с причинами (reason).',
        'Верни СТРОГО JSON: {"sections":[{"title":"...","text":"..."}],"whys":{"<id>":"..."},"plan":[{"when":"когда принимать","items":"названия продуктов из набора"}]}.',
        'sections — персональный разбор из РОВНО четырёх блоков в таком порядке и с такими title:',
        '1) title "Что мы поняли" — что видно из ответов: цель, нагрузка, режим питания, сон. Обращайся по имени, если оно есть. 2–3 предложения.',
        '2) title "Где узкое место" — главная проблема именно этого клиента, одна, названная прямо. 2–3 предложения.',
        '3) title "Почему такой набор" — как продукты закрывают это узкое место, по одному предложению на продукт.',
        '4) title "С чего начать" — что делать в первую неделю и когда ждать изменений: первые сдвиги обычно через 2–3 недели регулярного приёма, устойчивый результат — через 2–3 месяца. 2–3 предложения.',
        'Пиши человеческим языком, без терминов вроде «нутриенты», «оптимизация» и «метаболизм», без канцелярита.',
        'whys — по каждому id 1–2 предложения со ссылкой на конкретные ответы клиента.',
        'plan — простая схема приёма по времени суток (утро / до тренировки / после / день / на ночь), распределяя ТОЛЬКО переданные продукты; 3–5 строк.',
        'Правила: упоминай только переданные продукты; не ставь диагнозов; не обещай конкретных килограммов и процентов; не выдумывай цифры, которых нет во входных данных.'
      ].join(' ');
      user = JSON.stringify({ profile: body.profile || {}, items: body.items || [] });
    }

    const payload = {
      model: 'gpt-4o-mini',
      temperature: action === 'next' ? 0.3 : 0.6,
      response_format: { type: 'json_object' },
      messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ]
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
