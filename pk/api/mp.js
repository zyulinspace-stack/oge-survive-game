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

async function findOnWb(name, dbg) {
  const key = 'wbq:' + name;
  const hit = dbg ? null : cached(key); if (hit !== null) return hit;
  try {
    const q = encodeURIComponent('Prime Kraft ' + String(name).replace(/со\s+вкусом[^,]*/gi, '').slice(0, 60));
    const url = `https://search.wb.ru/exactmatch/ru/common/v13/search?appType=1&curr=rub&dest=-1257786&query=${q}&resultset=catalog&limit=20`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (dbg) dbg.httpStatus = r.status;
    if (!r.ok) { if (dbg) dbg.stage = 'http-error'; return put(key, null); }
    const raw = await r.text();
    if (dbg) { dbg.bodyLen = raw.length; dbg.bodyHead = raw.slice(0, 160); }
    let j = null; try { j = JSON.parse(raw); } catch (e) { if (dbg) dbg.stage = 'not-json'; return put(key, null); }
    const products = (j && j.data && j.data.products) || j.products || [];
    if (dbg) { dbg.found = products.length; dbg.brands = [...new Set(products.map(p => p.brand))].slice(0, 6); }

    const ours = products
      .filter(p => BRAND.test(p.brand || ''))
      .map(p => {
        const stock = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
        return { id: p.id, name: p.name, stock, sc: score(name, p.name) };
      })
      .filter(p => p.stock > 0 && p.sc >= 0.5)         // наш бренд, в наличии, похож по названию
      .sort((a, b) => b.sc - a.sc || b.stock - a.stock);

    if (dbg) dbg.ours = ours.slice(0, 3);
    if (!ours.length) { if (dbg) dbg.stage = dbg.found ? 'no-match' : 'empty'; return put(key, null); }
    return put(key, `https://www.wildberries.ru/catalog/${ours[0].id}/detail.aspx`);
  } catch (e) { return put(key, null); }
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
