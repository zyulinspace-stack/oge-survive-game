// Vercel serverless (CommonJS): тянет YML-фид Prime Kraft, парсит, классифицирует
// товары по внутренним типам (whey, creatine, magnesium, ...), отдаёт byType.
//
// v3 (2026-08-05): byType[тип] = МАССИВ товаров (было — один товар на тип).
// Сортировка: сначала в наличии, потом по цене. Плюс авто-разметка вкуса,
// фасовки и провизорных тегов (без сахара / лактоза / веган / стимулятор).
// Теги помечены как auto — их подтверждает нутрициолог клиента, это не финал.
//
// Кэш: s-maxage=3600 — фид дёргается не чаще раза в час.
const FEED = 'https://primekraft.ru/bitrix/catalog_export/yandex.php';

// сколько товаров одного типа отдаём фронту (защита от раздувания ответа)
const MAX_PER_TYPE = 40;

function decodeEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// --- классификация по типу продукта -------------------------------------
// ВАЖНО: порядок значим — первое совпавшее правило забирает товар.
// В фиде названия бывают и кириллицей, и латиницей — держим оба варианта.
const TYPE_RULES = [
  ['cookie',     n => /печень|cookie/.test(n)],                    // до bar: «PRIMEBAR COOKIE»
  ['plant',      n => /(растительн|plant[\s-]*based)/.test(n) && /(протеин|protein)/.test(n)],
  ['bar',        n => /батончик|primebar|plantago/.test(n)],
  ['casein',     n => /казеин|casein/.test(n)],
  ['whey',       n => /(сыворот|whey|изолят|isolate)/.test(n)],
  ['gainer',     n => /(гейнер|gainer)/.test(n)],
  ['creatine',   n => /креатин|creatine/.test(n)],
  ['lcarnitine', n => /карнитин|carnitine/.test(n)],
  ['magnesium',  n => /магни|magnesium/.test(n)],
  ['ltheanine',  n => /теанин|theanine/.test(n)],
  ['omega3',     n => /омега|omega|рыбий жир|fish oil/.test(n)],
  ['vitc',       n => /(витамин|vitamin)\s*[cс]([^а-яёa-z]|$)|аскорбин|ascorb/.test(n)],
  ['vitd',       n => /(витамин|vitamin)\s*d|холекальциферол|cholecalciferol/.test(n)],
  ['bcaa',       n => /bcaa|всаа/.test(n)],
  ['citrulline', n => /цитруллин|citrullin/.test(n)],
  ['preworkout', n => /(pre-?\s*workout|предтрен)/.test(n)],
  ['isotonic',   n => /изотоник|isotonic|electrolyt|электролит/.test(n)],
  ['collagen',   n => /коллаген|collagen/.test(n)],
  ['glutamine',  n => /глютамин|glutamine/.test(n)],
  ['arginine',   n => /аргинин|arginine|аакг|aakg/.test(n)],
  ['joints',     n => /глюкозамин|хондроитин|glucosamine|chondroitin|\bмсм\b|\bmsm\b/.test(n)],
  ['bundle',     n => /(стартовый|готовый)\s+набор|\bкомплект\b/.test(n)],
  ['zma',        n => /\bzma\b|цинк|zinc/.test(n)],
  ['multivit',   n => /мультивитамин|multivitamin|витаминно-минеральн/.test(n)],
  ['protein',    n => /протеин|protein/.test(n)] // общий протеин — последним
];

// --- вкус ----------------------------------------------------------------
const FLAV_RULES = [
  ['choco',   /шоколад|кофе|капучино|какао|брауни|мокко|кокос-шокол/, 'Шоколад / кофе'],
  ['vanilla', /ванил|карамел|крем-брюле|сгущ|печенье|молочн|пломбир|тирамису/, 'Ваниль / карамель'],
  ['berry',   /клубни|малин|вишн|ягод|черни|ежевик|банан|яблок|персик|апельсин|цитрус|манго|лесн|фрукт|груш/, 'Ягоды / фрукты'],
  ['neutral', /нейтрал|натурал|без вкуса|unflavor|без добавок/, 'Нейтральный']
];

function detectFlavor(n) {
  for (const [key, re, label] of FLAV_RULES) if (re.test(n)) return { flav: key, flavName: label };
  return { flav: '', flavName: '' };
}

// --- провизорные теги (подтверждает нутрициолог) -------------------------
function autoTags(n) {
  const t = [];
  if (/без сахара|sugar\s*free|плантаго|plantago/.test(n)) t.push('sugarfree');
  if (/растительн|веган|vegan|plantago|плантаго|горох|рисов/.test(n)) t.push('vegan');
  if (/изолят|без лактозы|lactose\s*free/.test(n)) t.push('lowlactose');
  if (/предтрен|pre-?\s*workout|кофеин|гуаран|энерг|guarana|caffeine/.test(n)) t.push('stim');
  return t;
}

// --- фасовка -------------------------------------------------------------
function detectSize(n) {
  const m = n.match(/(\d+\s*шт\s*[*х×]\s*\d+\s*(?:гр?|г)\b)|(\d+[.,]?\d*\s*(?:кг|гр|г|мл|л|капс|таб)\b)/i);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

// В фиде встречаются названия со смешанной раскладкой: «Mагний+B6» —
// латинская m, дальше кириллица. Такой товар не ловится ни латинским,
// ни кириллическим правилом. Поэтому каждое имя проверяем дважды:
// как есть и с латинскими двойниками, заменёнными на кириллицу.
const HOMOGLYPH = { a:'а', c:'с', e:'е', o:'о', p:'р', x:'х', y:'у', k:'к', m:'м', t:'т' };
function toCyr(n) { return n.replace(/[aceopxykmt]/g, ch => HOMOGLYPH[ch]); }

function classify(items) {
  const out = {};
  const matchedIds = new Set();
  for (const it of items) {
    const raw = it.name || '';
    const n = raw.toLowerCase();
    const nCyr = toCyr(n);
    for (const [key, test] of TYPE_RULES) {
      if (!test(n) && !test(nCyr)) continue;
      const f = detectFlavor(n).flav ? detectFlavor(n) : detectFlavor(nCyr);
      out[key] = out[key] || [];
      matchedIds.add(it.id);
      out[key].push({
        id: it.id,
        name: raw,
        price: +it.price || 0,
        oldprice: +it.oldprice || 0,
        img: it.picture,
        url: it.url,
        available: it.available,
        flav: f.flav,
        flavName: f.flavName,
        size: detectSize(raw),
        tags: Array.from(new Set(autoTags(n).concat(autoTags(nCyr))))
      });
      break; // один товар — один тип
    }
  }
  // в наличии вперёд, дальше — по цене вверх
  for (const k in out) {
    out[k].sort((a, b) => (b.available - a.available) || (a.price - b.price));
    if (out[k].length > MAX_PER_TYPE) out[k] = out[k].slice(0, MAX_PER_TYPE);
  }
  return { byType: out, matchedIds };
}

module.exports = async (req, res) => {
  try {
    const r = await fetch(FEED);
    const buf = Buffer.from(await r.arrayBuffer());
    const head0 = buf.slice(0, 120).toString('latin1').toLowerCase();
    let xml;
    if (/1251/.test(head0)) {
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

    const { byType, matchedIds } = classify(items);

    // диагностика: что правила не разложили вообще.
    // Считается ДО обрезки MAX_PER_TYPE, иначе обрезанные товары
    // выглядели бы как нераспознанные.
    const unmatched = items.filter(i => !matchedIds.has(i.id)).map(i => i.name);

    const stats = {};
    for (const k in byType) stats[k] = byType[k].length;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({
      count: items.length,
      matched: matchedIds.size,
      stats,
      byType,
      unmatchedCount: unmatched.length,
      unmatchedSample: unmatched.slice(0, 60)
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
