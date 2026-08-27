// Ссылки на маркетплейсы. Правило одно: ссылка отдаётся ТОЛЬКО если товар нашего бренда
// найден и реально в наличии. Не уверены — ссылки нет.
//
// WB: полностью автоматически. Ищем в публичном поиске по названию, фильтруем по бренду
// Prime Kraft, проверяем остатки. Артикулы от клиента не нужны.
// OZON: без ключей продавца достоверно проверить наличие нельзя, поэтому кнопки нет.

const cache = new Map();
const TTL = 30 * 60 * 1000;

const cached = k => { const c = cache.get(k); return c && Date.now() - c.t < TTL ? c.v : null; };
const put = (k, v) => { cache.set(k, { t: Date.now(), v }); return v; };

const BRAND = /prime\s*kraft|праймкрафт|прайм\s*крафт/i;

// «Сывороточный протеин WHEY со вкусом "Молочный шоколад", 500 г» -> «сывороточный протеин whey 500»
function keyWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/["«»""]/g, ' ')
    .replace(/со\s+вкусом[^,]*/g, ' ')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['для', 'без', 'при', 'grams', 'гр'].includes(w))
    .slice(0, 6);
}

function score(query, candidate) {
  const a = new Set(keyWords(query)), b = keyWords(candidate);
  let hit = 0; b.forEach(w => { if (a.has(w)) hit++; });
  return a.size ? hit / a.size : 0;
}

const WB_ENDPOINTS = [
  'https://search.wb.ru/exactmatch/ru/common/v14/search',
  'https://search.wb.ru/exactmatch/ru/common/v13/search',
  'https://search.wb.ru/exactmatch/ru/common/v9/search',
  'https://search.wb.ru/exactmatch/ru/common/v5/search',
  'https://search.wb.ru/exactmatch/ru/common/v4/search'
];

async function wbSearch(query, dbg) {
  const qs = `appType=1&curr=rub&dest=-1257786&spp=30&suppressSpellcheck=false&resultset=catalog&sort=popular&limit=30&query=${encodeURIComponent(query)}`;
  for (const base of WB_ENDPOINTS) {
    try {
      const r = await fetch(`${base}?${qs}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Origin': 'https://www.wildberries.ru',
          'Referer': 'https://www.wildberries.ru/'
        }
      });
      const raw = await r.text();
      let j = null; try { j = JSON.parse(raw); } catch (e) { continue; }
      const products = (j && j.data && j.data.products) || (j && j.products) || [];
      if (dbg) { dbg.tried = (dbg.tried || []).concat(base.split('/common/')[1] + ':' + r.status + ':' + products.length); }
      if (products.length) return products;
    } catch (e) { /* пробуем следующий */ }
  }
  return [];
}

async function findOnWb(name, dbg) {
  const key = 'wbq:' + name;
  const hit = dbg ? null : cached(key); if (hit !== null) return hit;
  try {
    const clean = String(name).replace(/со\s+вкусом[^,]*/gi, '').replace(/["«»""]/g, ' ').trim();
    let products = await wbSearch('Prime Kraft ' + clean.slice(0, 60), dbg);
    if (!products.length) products = await wbSearch('Primekraft ' + clean.slice(0, 50), dbg);
    if (dbg) { dbg.found = products.length; dbg.brands = [...new Set(products.map(p => p.brand))].slice(0, 8); }
    if (!products.length) { if (dbg) dbg.stage = 'empty'; return put(key, null); }

    const ours = products
      .filter(p => BRAND.test(p.brand || ''))
      .map(p => {
        const stock = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
        return { id: p.id, name: p.name, stock, sc: score(name, p.name) };
      })
      .filter(p => p.stock > 0 && p.sc >= 0.4)
      .sort((a, b) => b.sc - a.sc || b.stock - a.stock);

    if (dbg) dbg.ours = ours.slice(0, 3);
    if (!ours.length) { if (dbg) dbg.stage = 'no-match'; return put(key, null); }
    return put(key, `https://www.wildberries.ru/catalog/${ours[0].id}/detail.aspx`);
  } catch (e) { if (dbg) dbg.stage = 'error:' + e.message; return put(key, null); }
}

// Ozon: только при наличии ключей Seller API
async function findOnOzon(offerId) {
  const id = process.env.OZON_CLIENT_ID, key = process.env.OZON_API_KEY;
  if (!id || !key || !offerId) return null;
  const ck = 'oz:' + offerId;
  const hit = cached(ck); if (hit !== null) return hit;
  try {
    const r = await fetch('https://api-seller.ozon.ru/v4/product/info/stocks', {
      method: 'POST',
      headers: { 'Client-Id': id, 'Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { offer_id: [String(offerId)], visibility: 'ALL' }, limit: 10 })
    });
    if (!r.ok) return put(ck, null);
    const j = await r.json();
    const items = (j && j.result && j.result.items) || [];
    const free = items.reduce((a, it) => a + ((it.stocks || []).reduce((b, s) => b + (s.present || 0) - (s.reserved || 0), 0)), 0);
    if (free <= 0) return put(ck, null);
    const sku = items[0] && (items[0].product_id || items[0].sku);
    return put(ck, sku ? `https://www.ozon.ru/product/${sku}/` : null);
  } catch (e) { return put(ck, null); }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 8);
    const links = {};
    const debug = b.debug ? {} : null;

    await Promise.all(items.map(async it => {
      const id = String(it.id || ''); if (!id) return;
      const r = {};
      const dbg = debug ? (debug[id] = {}) : null;
      const wb = await findOnWb(it.name || '', dbg);
      if (wb) r.wb = wb;
      const oz = await findOnOzon(it.ozonOffer);
      if (oz) r.ozon = oz;
      if (Object.keys(r).length) links[id] = r;
    }));

    return res.status(200).json({ ok: true, links, debug, ozonReady: !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
