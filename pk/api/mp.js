// Ссылки на маркетплейсы. Правило одно: ссылка отдаётся ТОЛЬКО если товар нашего бренда
// найден и реально в наличии. Не уверены — ссылки нет.
//
// WB:   публичный поиск Wildberries. Ищем по названию, фильтруем по бренду Prime Kraft,
//       проверяем остатки. Артикулы от клиента не нужны.
// OZON: 1) если заданы OZON_CLIENT_ID + OZON_API_KEY — официальный Seller API (точные остатки);
//       2) иначе — разбор публичного поиска Ozon (костыль): ищем так же, как покупатель,
//          и отдаём ссылку, только если карточка Prime Kraft есть в выдаче и её можно купить.
//       Если Ozon закрылся от нас (капча/челлендж) — говорим об этом честно полем ozonMode,
//       и страница показывает обычную ссылку на поиск, а не прячет кнопку.
//
// Отладка: GET /api/mp?debug=1              — прогон по трём типовым товарам
//          GET /api/mp?debug=1&name=Креатин — прогон по конкретному названию

const cache = new Map();
const TTL = 30 * 60 * 1000;

const cached = k => { const c = cache.get(k); return c && Date.now() - c.t < TTL ? c.v : null; };
const put = (k, v) => { cache.set(k, { t: Date.now(), v }); return v; };

const BRAND = /prime\s*kraft|primekraft|праймкрафт|прайм\s*крафт/i;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

const cleanName = n => String(n || '').replace(/со\s+вкусом[^,]*/gi, '').replace(/["«»""]/g, ' ').trim();

/* ---------------- WILDBERRIES ---------------- */

const WB_ENDPOINTS = [
  'https://search.wb.ru/exactmatch/ru/common/v14/search',
  'https://search.wb.ru/exactmatch/ru/common/v13/search',
  'https://search.wb.ru/exactmatch/ru/common/v9/search',
  'https://search.wb.ru/exactmatch/ru/common/v5/search',
  'https://search.wb.ru/exactmatch/ru/common/v4/search'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Один запрос к конкретной версии поиска WB. 429 (нас притормаживают) — одна повторная попытка.
async function wbFetch(base, query, dbg) {
  const ver = base.split('/common/')[1];
  const qs = `appType=1&curr=rub&dest=-1257786&spp=30&suppressSpellcheck=false&resultset=catalog&sort=popular&limit=30&query=${encodeURIComponent(query)}`;
  const note = t => { if (dbg) dbg.tried = (dbg.tried || []).concat(ver + ':' + t); };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${base}?${qs}`, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Origin': 'https://www.wildberries.ru',
          'Referer': 'https://www.wildberries.ru/'
        }
      });
      const raw = await r.text();
      if (r.status === 429) { note('429' + (attempt ? ':retry' : '')); await sleep(400 + attempt * 500); continue; }
      let j = null; try { j = JSON.parse(raw); } catch (e) { note(r.status + ':not-json'); return []; }
      const products = (j && j.data && j.data.products) || (j && j.products) || [];
      note(r.status + ':' + products.length);
      return products;
    } catch (e) { note('err:' + String(e.message || e).slice(0, 30)); return []; }
  }
  return [];
}

// Перебираем версии поиска, пока не найдём выдачу, где ЕСТЬ товары нашего бренда.
// Раньше брали первую непустую выдачу — и на мусорном ответе (один чужой товар) поиск обрывался.
async function wbSearch(query, dbg) {
  let best = [];
  for (const base of WB_ENDPOINTS) {
    const products = await wbFetch(base, query, dbg);
    if (products.some(p => BRAND.test(p.brand || ''))) return products;
    if (products.length > best.length) best = products;
  }
  if (dbg && best.length) dbg.noBrandAnywhere = true;
  return best;
}

async function findOnWb(name, dbg) {
  const key = 'wbq:' + name;
  const hit = dbg ? null : cached(key); if (hit !== null) return hit;
  try {
    const clean = cleanName(name);
    let products = await wbSearch('Prime Kraft ' + clean.slice(0, 60), dbg);
    if (!products.length) products = await wbSearch('Primekraft ' + clean.slice(0, 50), dbg);
    if (dbg) { dbg.found = products.length; dbg.brands = [...new Set(products.map(p => p.brand))].slice(0, 8); }
    if (!products.length) { if (dbg) dbg.stage = 'empty'; return put(key, null); }

    const ours = products
      .filter(p => BRAND.test(p.brand || ''))
      .map(p => {
        const bySizes = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
        const stock = (typeof p.totalQuantity === 'number' && p.totalQuantity > 0) ? p.totalQuantity : bySizes;
        return { id: p.id, name: p.name, stock, sc: score(name, p.name) };
      })
      .filter(p => p.stock > 0 && p.sc >= 0.4)
      .sort((a, b) => b.sc - a.sc || b.stock - a.stock);

    if (dbg) {
      dbg.ours = ours.slice(0, 3);
      dbg.brandAll = products.filter(p => BRAND.test(p.brand || '')).slice(0, 5).map(p => ({
        n: String(p.name).slice(0, 40),
        q: p.totalQuantity,
        sizesQ: (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).length), 0),
        sc: Math.round(score(name, p.name) * 100)
      }));
    }
    if (!ours.length) { if (dbg) dbg.stage = 'no-match'; return put(key, null); }
    if (dbg) dbg.stage = 'ok';
    return put(key, `https://www.wildberries.ru/catalog/${ours[0].id}/detail.aspx`);
  } catch (e) { if (dbg) dbg.stage = 'error:' + e.message; return put(key, null); }
}

/* ---------------- OZON: официальный путь (Seller API) ---------------- */

const ozonKeysSet = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);

async function ozonBySeller(offerId) {
  const id = process.env.OZON_CLIENT_ID, key = process.env.OZON_API_KEY;
  if (!id || !key || !offerId) return null;
  const ck = 'ozs:' + offerId;
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

/* ---------------- OZON: костыль (разбор публичного поиска) ---------------- */

// Собираем все строки из произвольного куска JSON — так надёжнее, чем угадывать схему,
// которую Ozon периодически меняет.
function collectText(node, out, depth) {
  if (depth > 8 || out.length > 60) return out;
  if (typeof node === 'string') { if (node.length > 3 && node.length < 300) out.push(node); return out; }
  if (Array.isArray(node)) { for (const v of node) collectText(v, out, depth + 1); return out; }
  if (node && typeof node === 'object') { for (const k of Object.keys(node)) collectText(node[k], out, depth + 1); }
  return out;
}

const OZ_OUT_OF_STOCK = /закончил|нет в наличии|распродан|товар недоступен|скоро в продаже/i;
const OZ_BUYABLE = /ADD_TO_CART|addToCart|в корзину|Купить сейчас/i;

async function ozonPublicSearch(name, dbg) {
  const query = 'Prime Kraft ' + cleanName(name);
  const inner = '/search/?text=' + encodeURIComponent(query) + '&from_global=true';
  const urls = [
    'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(inner),
    'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(inner)
  ];

  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Referer': 'https://www.ozon.ru/',
          'x-o3-app-name': 'dweb_client'
        }
      });
      const raw = await r.text();
      if (dbg) dbg.tried = (dbg.tried || []).concat(u.split('/api/')[1].split('/')[0] + ':' + r.status + ':' + raw.length);

      let j = null; try { j = JSON.parse(raw); } catch (e) {
        if (dbg) dbg.head = raw.slice(0, 120);
        continue;                       // отдали HTML/челлендж вместо JSON
      }
      const ws = j && j.widgetStates;
      if (!ws || !Object.keys(ws).length) { if (dbg) dbg.stage = 'no-widgets'; continue; }

      const found = [];
      for (const k of Object.keys(ws)) {
        if (!/searchResultsV2|tileGrid|skuGrid/i.test(k)) continue;
        let v = null; try { v = JSON.parse(ws[k]); } catch (e) { continue; }
        for (const it of (v.items || [])) {
          const blob = JSON.stringify(it);
          const link = it.link || (it.action && it.action.link) || (blob.match(/"\/product\/[^"]+"/) || [''])[0].replace(/"/g, '');
          if (!link) continue;
          const texts = collectText(it, [], 0);
          const title = texts.find(t => BRAND.test(t) && t.length > 10) ||
                        texts.sort((a, b) => b.length - a.length)[0] || '';
          found.push({
            link, title,
            brand: BRAND.test(blob),
            buyable: OZ_BUYABLE.test(blob) && !OZ_OUT_OF_STOCK.test(blob),
            sc: score(name, title)
          });
        }
      }

      if (dbg) { dbg.total = found.length; dbg.sample = found.slice(0, 4).map(f => ({ t: f.title.slice(0, 45), b: f.brand, buy: f.buyable, sc: Math.round(f.sc * 100) })); }
      if (!found.length) { if (dbg) dbg.stage = 'no-items'; continue; }

      const ours = found
        .filter(f => f.brand && f.buyable && f.sc >= 0.4)
        .sort((a, b) => b.sc - a.sc);

      if (!ours.length) { if (dbg) dbg.stage = 'no-match'; return { mode: 'verified', link: null }; }

      let link = ours[0].link.split('?')[0];
      if (!/^https?:/.test(link)) link = 'https://www.ozon.ru' + (link.startsWith('/') ? '' : '/') + link;
      if (dbg) dbg.stage = 'ok';
      return { mode: 'verified', link };
    } catch (e) {
      if (dbg) dbg.tried = (dbg.tried || []).concat('err:' + String(e.message || e).slice(0, 40));
    }
  }
  if (dbg) dbg.stage = dbg.stage || 'blocked';
  return { mode: 'blocked', link: null };   // Ozon нас не пустил — решает страница
}

async function findOnOzon(item, dbg) {
  if (ozonKeysSet()) {
    const l = await ozonBySeller(item.ozonOffer);
    if (dbg) dbg.via = 'seller-api';
    return { mode: 'verified', link: l };
  }
  const key = 'ozp:' + item.name;
  const hit = dbg ? null : cached(key); if (hit !== null) return hit;
  if (dbg) dbg.via = 'public-search';
  const r = await ozonPublicSearch(item.name || '', dbg);
  return dbg ? r : put(key, r);
}

/* ---------------- HANDLER ---------------- */

// Не больше N запросов одновременно — иначе WB отвечает 429 всем сразу.
async function mapLimit(arr, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]); }
  });
  await Promise.all(workers);
}

const DEFAULT_PROBE = [
  { id: 'creatine', name: 'Креатин моногидрат, 200 г' },
  { id: 'whey', name: 'Сывороточный протеин Whey, 900 г' },
  { id: 'magnesium', name: 'Магний B6, 120 таблеток' }
];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // --- отладка через браузер: GET /api/mp?debug=1[&name=...] ---
  if (req.method === 'GET') {
    let q = req.query || {};
    if (!q.debug) {                       // на случай, если хелперы Vercel не подставили query
      try { const u = new URL(req.url, 'http://x'); q = Object.fromEntries(u.searchParams); } catch (e) {}
    }
    if (!q.debug) return res.status(405).json({ error: 'method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    const items = q.name ? [{ id: 'probe', name: String(q.name) }] : DEFAULT_PROBE;
    const out = {};
    for (const it of items) {
      const wbDbg = {}, ozDbg = {};
      const wb = await findOnWb(it.name, wbDbg);
      const oz = await findOnOzon(it, ozDbg);
      out[it.name] = { wb, wbDbg, ozon: oz.link, ozonMode: oz.mode, ozDbg };
    }
    return res.status(200).json({ ok: true, ozonKeys: ozonKeysSet(), result: out });
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 8);
    const links = {};
    const debug = b.debug ? {} : null;
    let ozonMode = 'verified';

    await mapLimit(items, 2, async it => {
      const id = String(it.id || ''); if (!id) return;
      const r = {};
      const dbg = debug ? (debug[id] = {}) : null;

      const wb = await findOnWb(it.name || '', dbg ? (dbg.wb = {}) : null);
      if (wb) r.wb = wb;

      const oz = await findOnOzon(it, dbg ? (dbg.oz = {}) : null);
      if (oz.mode === 'blocked') ozonMode = 'blocked';
      if (oz.link) r.ozon = oz.link;

      if (Object.keys(r).length) links[id] = r;
    });

    return res.status(200).json({ ok: true, links, ozonMode, debug, ozonReady: ozonKeysSet() });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
