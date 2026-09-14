// Ссылки на маркетплейсы. Правило одно: ссылка отдаётся ТОЛЬКО если товар нашего бренда
// найден и реально в наличии. Не уверены — ссылки нет.
//
// Приоритет источников — от самого надёжного к самому шаткому:
//
// WB:   1) официальный Content API + Statistics API (нужен WB_API_TOKEN) — точно, без лимитов
//          на частоту публичного поиска, и без риска спутать с чужим брендом: Content API
//          отдаёт ТОЛЬКО карточки самого продавца.
//       2) запасной путь — разбор публичного поиска WB (как было раньше), если токена нет
//          или официальный запрос не удался.
//
// OZON: 1) официальный Seller API (нужны OZON_CLIENT_ID + OZON_API_KEY) — так же надёжно.
//       2) запасной путь — разбор публичного поиска Ozon; если Ozon нас туда не пускает
//          (частая история с серверов не в РФ) — кнопки просто не будет, а не ссылка
//          на чужой товар.
//
// Отладка (открыть в браузере):
//   GET /api/mp?debug=1               — прогон по трём типовым товарам
//   GET /api/mp?debug=1&name=Креатин  — прогон по конкретному названию

export const config = { maxDuration: 30 };

const cache = new Map();
const TTL_LINK = 30 * 60 * 1000;

const cached = k => { const c = cache.get(k); return c && Date.now() - c.t < TTL_LINK ? c.v : null; };
const put = (k, v) => { cache.set(k, { t: Date.now(), v }); return v; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BRAND = /prime\s*kraft|primekraft|праймкрафт|прайм\s*крафт/i;

/* ---------------- общие текстовые утилиты ---------------- */

const HOMO = { a:'а', c:'с', e:'е', o:'о', p:'р', x:'х', y:'у', k:'к', m:'м', t:'т', b:'в', h:'н' };
// «Mагний» с латинской M -> «магний»: если в слове есть кириллица, латинские двойники приводим к ней
const fixMixed = w => /[а-яё]/.test(w) ? w.replace(/[aceopxykmtbh]/g, ch => HOMO[ch]) : w;
const CYR2LAT = { а:'a', в:'b', с:'c', д:'d', е:'e', о:'o', р:'p', х:'x', у:'y', к:'k', м:'m', т:'t', н:'h' };
// «В6» кириллицей и «B6» латиницей — одно и то же: токены с цифрой приводим к латинице
const fixDigitTok = w => /\d/.test(w) ? w.replace(/[авсдеорхукмтн]/g, ch => CYR2LAT[ch]) : w;
function keyWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/["«»""]/g, ' ')
    .replace(/со\s+вкусом[^,]*/g, ' ')
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .map(fixMixed).map(fixDigitTok)
    .filter(w => (w.length > 2 || /\d/.test(w)) && !/^\d+$/.test(w) && !['для', 'без', 'при', 'grams', 'гр', 'мг', 'банка', 'пакет', 'капсул', 'капсулы', 'таблеток', 'таблетки', 'шт', 'вкусом', 'вкуса', 'primekraft', 'prime', 'kraft', 'праймкрафт'].includes(w))
    .slice(0, 6);
}

// Тип товара по названию — как в catalog.js. Кандидат обязан быть того же типа:
// «казеин» не может совпасть с «витамином С» из-за общего «900».
const TYPE_RULES = [
  ['cookie',     /печень|cookie/],
  ['plant',      /(растительн|plant[\s-]*based|веган|vegan)/],
  ['bar',        /батончик|primebar/],
  ['casein',     /казеин|casein/],
  ['whey',       /сыворот|whey|изолят|isolate/],
  ['gainer',     /гейнер|gainer/],
  ['creatine',   /креатин|creatine/],
  ['lcarnitine', /карнитин|carnitine/],
  ['zma',        /(^|[^a-z])zma([^a-z]|$)|зма|цинк|zinc/],
  ['magnesium',  /магни|magnesium/],
  ['ltheanine',  /теанин|theanine/],
  ['omega369',   /(омега|omega)[\s-]*3[\s-]*6[\s-]*9|3-6-9/],
  ['omega3',     /омега|omega|рыбий жир|fish oil/],
  ['vitc',       /(витамин|vitamin)\s*[cс]([^а-яёa-z]|$)|аскорбин|ascorb/],
  ['bcaa',       /bcaa|всаа/],
  ['citrulline', /цитруллин|citrullin/],
  ['preworkout', /pre-?\s*workout|предтрен/],
  ['isotonic',   /изотоник|isotonic|electrolyt|электролит/],
  ['chrome',     /хром|chrom/],
  ['collagen',   /коллаген|collagen/],
  ['protein',    /протеин|protein/]
];
const HOMOGLYPH = { a:'а', c:'с', e:'е', o:'о', p:'р', x:'х', y:'у', k:'к', m:'м', t:'т' };
function typeOf(name) {
  const n = String(name || '').toLowerCase();
  const nCyr = n.replace(/[aceopxykmt]/g, ch => HOMOGLYPH[ch]);
  for (const [k, re] of TYPE_RULES) if (re.test(n) || re.test(nCyr)) return k;
  return '';
}
// protein — общий тип; сывороточный/казеин/растительный — его подтипы. Совпадение строгое,
// кроме случая, когда запрос — просто «протеин» без уточнения.
function sameType(q, c) {
  const a = typeOf(q), b = typeOf(c);
  if (!a) return true;
  if (a === b) return true;
  if (a === 'protein' && ['whey', 'casein', 'plant'].includes(b)) return true;
  return false;
}
function score(query, candidate) {
  const a = new Set(keyWords(query)), b = new Set(keyWords(candidate));
  let hit = 0; b.forEach(w => { if (a.has(w)) hit++; });
  return a.size ? hit / a.size : 0;
}
const cleanName = n => String(n || '').replace(/со\s+вкусом[^,]*/gi, '').replace(/["«»""]/g, ' ').trim();
// Фасовка: числа перед единицей измерения. Совпала — небольшой бонус, чтобы среди одинаковых
// по словам «гейнер 1000 г» и «гейнер 3000 г» первым шёл нужный.
function sizeNums(name) {
  const out = new Set();
  const re = /(\d+(?:[.,]\d+)?)\s*(кг|г|гр|мл|л|капс|капсул|таб|таблет|шт|mg|мг|g|ml)(?![а-яёa-z])/gi;
  let m; const n = String(name || '').toLowerCase();
  while ((m = re.exec(n))) out.add(m[1].replace(',', '.'));
  return out;
}
// Производные формы (шипучие, жевательные, коктейли, наборы стиков) идут после базовой,
// если пользователь не просил именно их.
const DERIV = /шипуч|жеват|мармелад|стик|саше|пробник|коктейл|shake|functional/i;
function derivPenalty(query, candidate) {
  let p = (!DERIV.test(query) && DERIV.test(candidate)) ? 0.2 : 0;
  if (!/plantago|плантаго/i.test(query) && /plantago|плантаго/i.test(candidate)) p += 0.1; // другая линейка
  return p;
}
function sizeBonus(query, candidate) {
  const q = sizeNums(query); if (!q.size) return 0;
  const c = sizeNums(candidate);
  for (const v of q) if (c.has(v)) return 0.15;
  return 0;
}

// Не больше N запросов одновременно — иначе внешние поисковики отвечают всем 429 разом.
async function mapLimit(arr, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]); }
  }));
}

/* ========================================================================
   WILDBERRIES — официальный путь (Content API + Statistics API)
   ======================================================================== */

const wbToken = () => process.env.WB_API_TOKEN || '';

// Полный список СВОИХ карточек — кэшируем надолго (каталог продавца меняется редко).
// Всё, что вернёт этот метод, УЖЕ принадлежит продавцу: фильтр по бренду не нужен.
let wbCardsCache = null; // { t, cards: [{nmID, name}] }
async function wbOwnCards(dbg) {
  if (wbCardsCache && Date.now() - wbCardsCache.t < 20 * 60 * 1000) return wbCardsCache.cards;
  const token = wbToken();
  if (!token) return null;
  const cards = [];
  let cursor = { limit: 100 };
  try {
    for (let page = 0; page < 10; page++) { // защита от бесконечной пагинации
      const r = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { sort: { ascending: true }, filter: { withPhoto: -1 }, cursor } })
      });
      if (dbg) dbg.push('content:' + r.status);
      if (!r.ok) { if (dbg) dbg.push('content-body:' + (await r.text()).slice(0, 150)); break; }
      const j = await r.json().catch(() => null);
      const list = (j && j.cards) || [];
      for (const c of list) if (c && c.nmID) cards.push({ nmID: c.nmID, name: c.title || c.vendorCode || '' });
      const total = j && j.cursor && j.cursor.total;
      if (!total || total < cursor.limit) break;
      cursor = { limit: 100, updatedAt: j.cursor.updatedAt, nmID: j.cursor.nmID };
    }
  } catch (e) { if (dbg) dbg.push('content-err:' + String(e.message || e).slice(0, 60)); return null; }
  if (!cards.length) return null;
  wbCardsCache = { t: Date.now(), cards };
  return cards;
}

// Остатки. Метод Statistics API /supplier/stocks WB закрыл (deprecated), а замена —
// отчёт warehouse_remains — требует категорию токена «Аналитика». Поэтому остаток
// по конкретным нашим артикулам спрашиваем у публичной карточки WB: один запрос на пачку
// nmID, кэш 5 минут. Артикулы при этом — из официального Content API, то есть точно наши.
const wbQtyCache = new Map(); // nmID -> { t, qty }
async function wbStockByNm(nmIds, dbg) {
  const out = new Map();
  const need = [];
  for (const nm of nmIds) {
    const c = wbQtyCache.get(nm);
    if (c && Date.now() - c.t < 5 * 60 * 1000) out.set(nm, c.qty); else need.push(nm);
  }
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const u = 'https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=' + chunk.join(';');
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'ru-RU,ru;q=0.9', 'Origin': 'https://www.wildberries.ru', 'Referer': 'https://www.wildberries.ru/' } });
      const raw = await r.text();
      if (dbg) dbg.push('card:' + r.status + ':' + raw.length);
      if (r.status !== 200) return null;                       // нас не пустили — остаток НЕИЗВЕСТЕН
      const j = parseLoose(raw);
      const products = (j && j.data && j.data.products) || (j && j.products) || [];
      if (!products.length) return null;
      for (const p of products) {
        const bySizes = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
        const qty = (typeof p.totalQuantity === 'number' && p.totalQuantity > 0) ? p.totalQuantity : bySizes;
        wbQtyCache.set(p.id, { t: Date.now(), qty });
        out.set(p.id, qty);
      }
      for (const nm of chunk) if (!out.has(nm)) { wbQtyCache.set(nm, { t: Date.now(), qty: 0 }); out.set(nm, 0); }
    } catch (e) { if (dbg) dbg.push('card-err:' + String(e.message || e).slice(0, 60)); return null; }
  }
  return out;
}

// Официальные остатки: Analytics API, отчёт «Остатки на складах». Асинхронный: создать задачу,
// дождаться, скачать. Нужна категория токена «Аналитика» — без неё будет 401/403, и мы
// просто идём дальше. Кэш 10 минут (лимит WB: 1 запрос/мин).
let wbRemainsCache = null; // { t, byNm: Map }
let wbRemainsDenied = 0;   // время последнего отказа по правам — не долбим каждые 5 секунд
async function wbRemains(dbg) {
  if (wbRemainsCache && Date.now() - wbRemainsCache.t < 10 * 60 * 1000) return wbRemainsCache.byNm;
  if (wbRemainsDenied && Date.now() - wbRemainsDenied < 30 * 60 * 1000) { if (dbg) dbg.push('remains:skip(no-scope)'); return null; }
  const token = wbToken(); if (!token) return null;
  const H = { 'Authorization': token, 'Content-Type': 'application/json' };
  const base = 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains';
  try {
    const r = await fetch(base + '?groupByNm=true&groupByBarcode=false&groupBySize=false', { headers: H });
    if (dbg) dbg.push('remains-create:' + r.status);
    if (r.status === 401 || r.status === 403) { wbRemainsDenied = Date.now(); return null; }
    if (!r.ok) return wbRemainsCache ? wbRemainsCache.byNm : null;
    const j = await r.json().catch(() => null);
    const taskId = j && ((j.data && j.data.taskId) || j.taskId);
    if (!taskId) { if (dbg) dbg.push('remains:no-task'); return null; }
    let ready = false;
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      const st = await fetch(`${base}/tasks/${taskId}/status`, { headers: H });
      const sj = await st.json().catch(() => null);
      const status = String((sj && ((sj.data && sj.data.status) || sj.status)) || '').toLowerCase();
      if (dbg && i === 0) dbg.push('remains-status:' + st.status + ':' + status);
      if (status === 'done' || status === 'success' || status === 'ready') { ready = true; break; }
      if (status === 'error' || status === 'failed' || status === 'canceled') break;
    }
    if (!ready) { if (dbg) dbg.push('remains:not-ready'); return wbRemainsCache ? wbRemainsCache.byNm : null; }
    const d = await fetch(`${base}/tasks/${taskId}/download`, { headers: H });
    if (dbg) dbg.push('remains-download:' + d.status);
    if (!d.ok) return wbRemainsCache ? wbRemainsCache.byNm : null;
    const rows = await d.json().catch(() => null);
    const list = Array.isArray(rows) ? rows : (rows && rows.data) || [];
    const byNm = new Map();
    for (const row of list) {
      const nm = row.nmId || row.nmID; if (!nm) continue;
      let q = Number(row.quantityWarehousesFull);
      if (!Number.isFinite(q)) q = (row.warehouses || []).reduce((a, w) => a + (Number(w.quantity) || 0), 0);
      byNm.set(nm, (byNm.get(nm) || 0) + (q || 0));
    }
    if (dbg) dbg.push('remains-rows:' + list.length);
    wbRemainsCache = { t: Date.now(), byNm };
    return byNm;
  } catch (e) { if (dbg) dbg.push('remains-err:' + String(e.message || e).slice(0, 60)); return wbRemainsCache ? wbRemainsCache.byNm : null; }
}

// null — нет токена/не удалось; {link} — нашли и есть в наличии; {} — проверили, нет в наличии.
async function wbOfficial(name, dbg) {
  const cards = await wbOwnCards(dbg);
  if (!cards) return null;
  // Все подходящие по названию карточки (вкусы/фасовки), лучшие — первыми.
  const BUNDLE = /(^|[^а-яё])набор([^а-яё]|$)|комплект|\+|бандл|bundle|(^|[^a-z])x\s*\d|\d\s*шт/i;
  const wantBundle = BUNDLE.test(name);
  const t = typeOf(name);
  const scored = cards
    .filter(c => sameType(name, c.name))
    .map(c => ({ c, sc: score(name, c.name) + sizeBonus(name, c.name) - derivPenalty(name, c.name) - ((!wantBundle && BUNDLE.test(c.name)) ? 0.25 : 0) }))
    .sort((a, b) => b.sc - a.sc);
  let cands = scored.filter(x => x.sc >= 0.4).slice(0, 12);
  // тип совпал строго (не общий «protein») — этого достаточно, даже если слова разошлись
  if (!cands.length && t && t !== 'protein') cands = scored.slice(0, 12);
  if (dbg) dbg.push('type:' + (t || '?'));
  if (dbg) dbg.push('cands:' + cands.length + (cands[0] ? ' best=' + cands[0].c.nmID + ' sc=' + Math.round(cands[0].sc * 100) + ' «' + String(cands[0].c.name).slice(0, 50) + '»' : ''));
  if (!cands.length) return {};
  let stock = await wbRemains(dbg);
  if (stock) { if (dbg) dbg.push('stock-src:analytics'); }
  else { stock = await wbStockByNm(cands.map(x => x.c.nmID), dbg); if (stock && dbg) dbg.push('stock-src:card'); }
  if (!stock) return null;   // остаток узнать не удалось — пусть решает запасной путь
  const hit = cands.find(x => (stock.get(x.c.nmID) || 0) > 0);
  if (dbg) dbg.push(hit ? 'in-stock:' + hit.c.nmID + ' qty=' + stock.get(hit.c.nmID) + ' «' + String(hit.c.name).slice(0, 45) + '»' : 'none-in-stock');
  if (!hit) return {};
  return { link: 'https://www.wildberries.ru/catalog/' + hit.c.nmID + '/detail.aspx' };
}

/* ---------------- WB — запасной путь: публичный поиск ---------------- */

const WB_ENDPOINTS = [
  'https://search.wb.ru/exactmatch/ru/common/v14/search',
  'https://search.wb.ru/exactmatch/ru/common/v13/search',
  'https://search.wb.ru/exactmatch/ru/common/v9/search',
  'https://search.wb.ru/exactmatch/ru/common/v5/search',
  'https://search.wb.ru/exactmatch/ru/common/v4/search'
];

function parseLoose(raw) {
  if (!raw || raw.charAt(0) !== '{') return null;
  try { return JSON.parse(raw); } catch (e) {}
  try { return JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')); } catch (e) {}
  const i = raw.indexOf('"products"');
  if (i > 0) {
    const start = raw.indexOf('[', i);
    if (start > 0) {
      let depth = 0;
      for (let k = start; k < raw.length; k++) {
        const c = raw[k];
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (!depth) { try { return { data: { products: JSON.parse(raw.slice(start, k + 1)) } }; } catch (e) { return null; } } }
      }
    }
  }
  return null;
}

async function wbFetch(base, query, dbg) {
  const ver = base.split('/common/')[1];
  const qs = `appType=1&curr=rub&dest=-1257786&spp=30&suppressSpellcheck=true&resultset=catalog&sort=popular&limit=30&query=${encodeURIComponent(query)}`;
  const note = t => { if (dbg) dbg.tried = (dbg.tried || []).concat(ver + ':' + t); };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${base}?${qs}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru-RU,ru;q=0.9', 'Origin': 'https://www.wildberries.ru', 'Referer': 'https://www.wildberries.ru/' }
      });
      const raw = await r.text();
      if (r.status === 429) { note('429' + (attempt ? ':retry' : '')); await sleep(700 + attempt * 800); continue; }
      const j = parseLoose(raw);
      if (!j) { note(r.status + ':not-json'); return []; }
      const products = (j.data && j.data.products) || j.products || [];
      note(r.status + ':' + products.length);
      return products;
    } catch (e) { note('err:' + String(e.message || e).slice(0, 30)); return []; }
  }
  return [];
}
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
function wbPick(products, name) {
  return products.filter(p => BRAND.test(p.brand || ''))
    .map(p => {
      const bySizes = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
      const stock = (typeof p.totalQuantity === 'number' && p.totalQuantity > 0) ? p.totalQuantity : bySizes;
      return { id: p.id, stock, sc: score(name, p.name) };
    })
    .filter(p => p.stock > 0 && p.sc >= 0.4)
    .sort((a, b) => b.sc - a.sc || b.stock - a.stock)[0] || null;
}
async function wbPublicFallback(name, dbg) {
  const key = 'wbq:' + name;
  const hit = dbg ? null : cached(key); if (hit !== null) return hit;
  const clean = cleanName(name);
  const short = keyWords(name).slice(0, 3).join(' ');
  const ourBrand = ps => ps.some(p => BRAND.test(p.brand || ''));
  let products = await wbSearch('Prime Kraft ' + clean.slice(0, 60), dbg);
  if (!ourBrand(products) && short) products = await wbSearch('Prime Kraft ' + short, dbg);
  if (!products.length) return put(key, null);
  const best = wbPick(products, name);
  return put(key, best ? 'https://www.wildberries.ru/catalog/' + best.id + '/detail.aspx' : null);
}

async function findOnWb(item, dbg) {
  if (wbToken()) {
    const off = await wbOfficial(item.name || '', dbg ? (dbg.official = []) : null);
    if (off) return { via: 'official', link: off.link || null };
    if (dbg) dbg.officialFailed = true;
  }
  const link = await wbPublicFallback(item.name || '', dbg ? (dbg.fallback = {}) : null);
  return { via: 'public-search', link };
}

/* ========================================================================
   OZON — официальный путь (Seller API)
   ======================================================================== */

const ozonKeysSet = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);
const ozonHeaders = () => ({ 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' });

// Свой список товаров (offer_id -> название) — enumерируем один раз, кэшируем надолго.
// Версия метода у Ozon менялась (v1/v2/v3); пробуем по очереди, первая рабочая — используется.
const OZ_LIST_VERSIONS = ['v3', 'v2', 'v1'];
let ozonListCache = null; // { t, items: [{offer_id, product_id, name}] }
async function ozonOwnList(dbg) {
  if (ozonListCache && Date.now() - ozonListCache.t < 20 * 60 * 1000) return ozonListCache.items;
  if (!ozonKeysSet()) return null;
  for (const v of OZ_LIST_VERSIONS) {
    try {
      const items = [];
      let last_id = '';
      for (let page = 0; page < 10; page++) {
        const r = await fetch(`https://api-seller.ozon.ru/${v}/product/list`, {
          method: 'POST', headers: ozonHeaders(),
          body: JSON.stringify({ filter: { visibility: 'ALL' }, last_id, limit: 100 })
        });
        if (dbg) dbg.push('list-' + v + ':' + r.status);
        if (!r.ok) break;
        const j = await r.json().catch(() => null);
        const res = (j && (j.result || j)) || {};
        const rows = res.items || res.rows || [];
        if (!rows.length) break;
        for (const row of rows) items.push({ offer_id: row.offer_id, product_id: row.product_id });
        last_id = res.last_id || '';
        if (!last_id || rows.length < 100) break;
      }
      if (items.length) {
        // имена товаров этот метод не отдаёт — довьём их через info/list по product_id, пачками
        await ozonFillNames(items, v, dbg);
        ozonListCache = { t: Date.now(), items };
        return items;
      }
    } catch (e) { if (dbg) dbg.push('list-' + v + '-err:' + String(e.message || e).slice(0, 60)); }
  }
  return null;
}
async function ozonFillNames(items, listVer, dbg) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 100) chunks.push(items.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const r = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
        method: 'POST', headers: ozonHeaders(),
        body: JSON.stringify({ product_id: chunk.map(c => c.product_id).filter(Boolean) })
      });
      if (dbg) dbg.push('names:' + r.status);
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const rows = (j && (j.result || j.items)) || [];
      const byId = new Map(rows.map(row => [row.id || row.product_id, row.name || '']));
      chunk.forEach(c => { c.name = byId.get(c.product_id) || ''; });
    } catch (e) { if (dbg) dbg.push('names-err:' + String(e.message || e).slice(0, 60)); }
  }
}

// Остатки сразу по пачке offer_id одним запросом -> Map(offer_id -> qty)
async function ozonStockByOffers(offerIds, dbg) {
  const out = new Map();
  const ids = offerIds.filter(Boolean).map(String);
  if (!ids.length) return out;
  try {
    const r = await fetch('https://api-seller.ozon.ru/v4/product/info/stocks', {
      method: 'POST', headers: ozonHeaders(),
      body: JSON.stringify({ filter: { offer_id: ids, visibility: 'ALL' }, limit: 100 })
    });
    if (dbg) dbg.push('stocks:' + r.status);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const items = (j && j.result && j.result.items) || (j && j.items) || [];
    for (const it of items) {
      const qty = (it.stocks || []).reduce((b, st) => b + (Number(st.present) || 0) - (Number(st.reserved) || 0), 0);
      out.set(String(it.offer_id), qty);
    }
    for (const id of ids) if (!out.has(id)) out.set(id, 0);
    if (dbg) dbg.push('qty:' + ids.map(id => id + '=' + out.get(id)).join(','));
    return out;
  } catch (e) { if (dbg) dbg.push('stocks-err:' + String(e.message || e).slice(0, 60)); return null; }
}

// null — нет ключей/не удалось; {link} — нашли и в наличии; {} — проверили, нет в наличии.
async function ozonOfficial(item, dbg) {
  if (item.ozonOffer) {
    const st = await ozonStockByOffers([item.ozonOffer], dbg);
    if (!st) return null;
    return (st.get(String(item.ozonOffer)) || 0) > 0 ? { link: 'https://www.ozon.ru/product/' + item.ozonOffer + '/' } : {};
  }
  const list = await ozonOwnList(dbg);
  if (!list) return null;
  const name = item.name || '';
  const t = typeOf(name);
  const BUNDLE_OZ = /(^|[^а-яё])набор([^а-яё]|$)|комплект|\+|бандл|bundle|(^|[^a-z])x\s*\d|\d\s*шт/i;
  const wantBundle = BUNDLE_OZ.test(name);
  const scored = list
    .filter(it => it.name && sameType(name, it.name))
    .map(it => ({ it, sc: score(name, it.name) + sizeBonus(name, it.name) - derivPenalty(name, it.name) - ((!wantBundle && BUNDLE_OZ.test(it.name)) ? 0.25 : 0) }))
    .sort((a, b) => b.sc - a.sc);
  let cands = scored.filter(x => x.sc >= 0.4).slice(0, 8);
  if (!cands.length && t && t !== 'protein') cands = scored.slice(0, 8);
  if (dbg) dbg.push('type:' + (t || '?') + ' cands:' + cands.length + (cands[0] ? ' best=' + cands[0].it.offer_id + ' sc=' + Math.round(cands[0].sc * 100) + ' «' + String(cands[0].it.name).slice(0, 50) + '»' : ''));
  if (!cands.length) return {};
  const st = await ozonStockByOffers(cands.map(x => x.it.offer_id), dbg);
  if (!st) return null;
  const hit = cands.find(x => (st.get(String(x.it.offer_id)) || 0) > 0);
  if (dbg) dbg.push(hit ? 'in-stock:' + hit.it.offer_id + ' «' + String(hit.it.name).slice(0, 40) + '»' : 'none-in-stock');
  if (!hit) return {};
  return { link: 'https://www.ozon.ru/product/' + (hit.it.product_id || hit.it.offer_id) + '/' };
}

/* ---------------- Ozon — запасной путь: разбор публичного поиска ---------------- */

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
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'ru-RU,ru;q=0.9', 'Referer': 'https://www.ozon.ru/', 'x-o3-app-name': 'dweb_client' } });
      const raw = await r.text();
      if (dbg) dbg.tried = (dbg.tried || []).concat(u.split('/api/')[1].split('/')[0] + ':' + r.status + ':' + raw.length);
      let j = null; try { j = JSON.parse(raw); } catch (e) { if (dbg) dbg.head = raw.slice(0, 120); continue; }
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
          const title = texts.find(t => BRAND.test(t) && t.length > 10) || texts.sort((a, b) => b.length - a.length)[0] || '';
          found.push({ link, title, brand: BRAND.test(blob), buyable: OZ_BUYABLE.test(blob) && !OZ_OUT_OF_STOCK.test(blob), sc: score(name, title) });
        }
      }
      if (dbg) { dbg.total = found.length; dbg.sample = found.slice(0, 4).map(f => ({ t: f.title.slice(0, 45), b: f.brand, buy: f.buyable, sc: Math.round(f.sc * 100) })); }
      if (!found.length) { if (dbg) dbg.stage = 'no-items'; continue; }
      const ours = found.filter(f => f.brand && f.buyable && f.sc >= 0.4).sort((a, b) => b.sc - a.sc);
      if (!ours.length) { if (dbg) dbg.stage = 'no-match'; return { mode: 'verified', link: null }; }
      let link = ours[0].link.split('?')[0];
      if (!/^https?:/.test(link)) link = 'https://www.ozon.ru' + (link.startsWith('/') ? '' : '/') + link;
      if (dbg) dbg.stage = 'ok';
      return { mode: 'verified', link };
    } catch (e) { if (dbg) dbg.tried = (dbg.tried || []).concat('err:' + String(e.message || e).slice(0, 40)); }
  }
  if (dbg) dbg.stage = dbg.stage || 'blocked';
  return { mode: 'blocked', link: null };
}

async function findOnOzon(item, dbg) {
  if (ozonKeysSet()) {
    const off = await ozonOfficial(item, dbg ? (dbg.official = []) : null);
    if (off) return { via: 'official', mode: 'verified', link: off.link || null };
    if (dbg) dbg.officialFailed = true;
  }
  const key = 'ozp:' + item.name;
  const hit = dbg ? null : cached(key); if (hit !== null) return { via: 'public-search', ...hit };
  const r = await ozonPublicSearch(item.name || '', dbg ? (dbg.fallback = {}) : null);
  if (!dbg) put(key, r);
  return { via: 'public-search', ...r };
}

/* ---------------- HANDLER ---------------- */

const DEFAULT_PROBE = [
  { id: 'creatine', name: 'Креатин моногидрат, 200 г' },
  { id: 'whey', name: 'Сывороточный протеин Whey, 900 г' },
  { id: 'magnesium', name: 'Магний B6, 120 таблеток' }
];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'GET') {
    let q = req.query || {};
    if (!q.debug) { try { const u = new URL(req.url, 'http://x'); q = Object.fromEntries(u.searchParams); } catch (e) {} }
    if (!q.debug) return res.status(405).json({ error: 'method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    const items = q.name ? [{ id: 'probe', name: String(q.name) }] : DEFAULT_PROBE;
    const out = {};
    for (const it of items) {
      const wbDbg = {}, ozDbg = {};
      const wb = await findOnWb(it, wbDbg);
      const oz = await findOnOzon(it, ozDbg);
      out[it.name] = { wb: wb.link, wbVia: wb.via, wbDbg, ozon: oz.link, ozonVia: oz.via, ozonMode: oz.mode, ozDbg };
    }
    return res.status(200).json({ ok: true, wbTokenSet: !!wbToken(), ozonKeysSet: ozonKeysSet(), result: out });
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 8);
    const links = {};
    const debug = b.debug ? {} : null;
    let ozonMode = 'verified';

    await mapLimit(items, 3, async it => {
      const id = String(it.id || ''); if (!id) return;
      const r = {};
      const dbg = debug ? (debug[id] = {}) : null;

      const wb = await findOnWb(it, dbg);
      if (wb.link) r.wb = wb.link;

      const oz = await findOnOzon(it, dbg);
      if (oz.mode === 'blocked') ozonMode = 'blocked';
      if (oz.link) r.ozon = oz.link;

      if (Object.keys(r).length) links[id] = r;
    });

    return res.status(200).json({ ok: true, links, ozonMode, debug, wbTokenSet: !!wbToken(), ozonKeysSet: ozonKeysSet() });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
