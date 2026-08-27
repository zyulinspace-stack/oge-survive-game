// Проверка наличия товаров на маркетплейсах.
// Ссылка на карточку отдаётся ТОЛЬКО если товар реально в наличии.
// WB — публичный API карточек. Ozon — Seller API (нужны OZON_CLIENT_ID и OZON_API_KEY).

const cache = new Map();           // key -> {t, v}
const TTL = 10 * 60 * 1000;        // 10 минут

function cached(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.v;
  return null;
}
function put(key, v) { cache.set(key, { t: Date.now(), v }); return v; }

// --- WILDBERRIES: есть ли остатки хотя бы на одном складе ---
async function checkWb(nm) {
  const key = 'wb:' + nm;
  const hit = cached(key); if (hit !== null) return hit;
  try {
    const url = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${encodeURIComponent(nm)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return put(key, false);
    const j = await r.json();
    const p = j && j.data && Array.isArray(j.data.products) ? j.data.products[0] : null;
    if (!p) return put(key, false);
    const stock = (p.sizes || []).reduce((a, s) => a + ((s.stocks || []).reduce((b, x) => b + (x.qty || 0), 0)), 0);
    return put(key, stock > 0);
  } catch (e) { return put(key, false); }
}

// --- OZON ---
// 1) Seller API, если есть ключи. 2) ручная отметка в marketplace.json. 3) осторожный парсинг.
// Во всех случаях действует правило fail-closed: не уверены — ссылку не отдаём.
async function checkOzonApi(offerId) {
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
    if (!r.ok) return put(ck, false);
    const j = await r.json();
    const items = (j && j.result && j.result.items) || [];
    const free = items.reduce((a, it) => a + ((it.stocks || []).reduce((b, s) => b + (s.present || 0) - (s.reserved || 0), 0)), 0);
    return put(ck, free > 0);
  } catch (e) { return put(ck, false); }
}

// ручная отметка: {"ozonInStock": true, "ozonCheckedAt": "2026-08-27"} — живёт 14 дней
function checkOzonManual(it) {
  if (it.ozonInStock !== true) return null;
  const d = Date.parse(it.ozonCheckedAt || '');
  if (!d) return null;
  const days = (Date.now() - d) / 86400000;
  return days <= 14 ? true : null;   // протухла — считаем, что не знаем
}

// осторожный парсинг карточки: капча/ошибка -> null (не показываем)
async function checkOzonPage(url) {
  if (!url) return null;
  const ck = 'ozp:' + url;
  const hit = cached(ck); if (hit !== null) return hit;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9'
      }
    });
    if (!r.ok) return put(ck, null);
    const html = (await r.text()).toLowerCase();
    if (html.includes('доступ ограничен') || html.includes('challenge') || html.includes('captcha') || html.length < 5000) return put(ck, null);
    const gone = ['этот товар закончился', 'товар закончился', 'нет в наличии', 'товар распродан'].some(m => html.includes(m));
    if (gone) return put(ck, false);
    const alive = html.includes('добавить в корзину') || html.includes('в корзину');
    return put(ck, alive ? true : null);
  } catch (e) { return put(ck, null); }
}

async function checkOzon(it) {
  const api = await checkOzonApi(it.ozonOffer);
  if (api !== null) return api;
  const man = checkOzonManual(it);
  if (man !== null) return man;
  return await checkOzonPage(it.ozonUrl);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 12);
    const out = {};

    await Promise.all(items.map(async it => {
      const id = String(it.id || '');
      if (!id) return;
      const r = {};
      if (it.wb) {
        const ok = await checkWb(it.wb);
        if (ok) r.wb = `https://www.wildberries.ru/catalog/${encodeURIComponent(it.wb)}/detail.aspx`;
      }
      if (it.ozonUrl) {
        const ok = await checkOzon(it);      // null = не уверены -> ссылку не показываем
        if (ok === true) r.ozon = it.ozonUrl;
      }
      if (Object.keys(r).length) out[id] = r;
    }));

    return res.status(200).json({ ok: true, links: out, checkedOzon: !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
