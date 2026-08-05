// Vercel serverless (CommonJS): тянет YML-фид Prime Kraft, парсит, классифицирует
// товары по нашим внутренним типам (whey, creatine, magnesium, ...), отдаёт byType.
// Кэшируется на 1 час (s-maxage) — фид дёргается не чаще раза в час.
const FEED = 'https://primekraft.ru/bitrix/catalog_export/yandex.php';

function decodeEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function classify(items) {
  const rules = [
    ['plant',      n => /растительн/.test(n) && /протеин/.test(n)],
    ['casein',     n => /казеин/.test(n)],
    ['whey',       n => /(сыворот|whey)/.test(n)],
    ['gainer',     n => /(гейнер|gainer)/.test(n)],
    ['creatine',   n => /креатин/.test(n)],
    ['lcarnitine', n => /карнитин/.test(n)],
    ['magnesium',  n => /магни/.test(n)],
    ['ltheanine',  n => /теанин/.test(n)],
    ['omega3',     n => /омега/.test(n)],
    ['vitc',       n => /витамин\s*[cс]\b/.test(n)],
    ['bcaa',       n => /bcaa/.test(n)],
    ['citrulline', n => /цитруллин/.test(n)],
    ['preworkout', n => /(pre-?\s*workout|предтрен)/.test(n)],
    ['bar',        n => /батончик/.test(n)],
    ['cookie',     n => /печенье/.test(n)],
    ['isotonic',   n => /изотоник/.test(n)]
  ];
  const out = {};
  for (const it of items) {
    const n = (it.name || '').toLowerCase();
    for (const [key, test] of rules) {
      if (test(n)) {
        const p = { id: it.id, name: it.name, price: +it.price || 0, oldprice: +it.oldprice || 0, img: it.picture, url: it.url, available: it.available };
        if (!out[key] || (!out[key].available && p.available)) out[key] = p;
        break; // один товар — один тип
      }
    }
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const r = await fetch(FEED);
    const buf = Buffer.from(await r.arrayBuffer());
    const head = buf.slice(0, 120).toString('latin1').toLowerCase();
    let xml;
    if (/1251/.test(head)) {
      try { xml = new TextDecoder('windows-1251').decode(buf); }
      catch (e) { xml = buf.toString('utf8'); }
    } else {
      xml = buf.toString('utf8');
    }

    const get = (s, tag) => { const m = s.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')); return m ? m[1].trim() : ''; };
    const offers = xml.split('<offer').slice(1);
    const items = offers.map(s => {
      const head = s.slice(0, s.indexOf('>'));
      const idm = head.match(/id="([^"]*)"/);
      return {
        id: idm ? idm[1] : '',
        available: /available="true"/.test(head),
        name: decodeEntities(get(s, 'name')),
        price: get(s, 'price'),
        oldprice: get(s, 'oldprice'),
        picture: get(s, 'picture'),
        url: get(s, 'url'),
        categoryId: get(s, 'categoryId')
      };
    });

    const byType = classify(items);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ count: items.length, byType });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
