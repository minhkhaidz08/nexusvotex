/**
 * End-to-end smoke test of the NexusVotex API using an in-memory mock Supabase.
 * Run: node test/smoke.js
 */
process.env.SUPABASE_URL = 'http://mock';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock';
process.env.SUPABASE_ANON_KEY = 'mock';
process.env.JWT_SECRET = 'test-secret-key';
process.env.BASE_URL = 'http://localhost:5000';
process.env.THESIEURE_PARTNER_ID = 'test-partner';
process.env.THESIEURE_PARTNER_KEY = 'test-key';
process.env.PAYOS_CLIENT_ID = 'test-client';
process.env.PAYOS_API_KEY = 'test-api';
process.env.PAYOS_CHECKSUM_KEY = 'test-checksum';

require('./mockSupabase');
const { __mockDB: DB } = require('./mockSupabase');
const bcrypt = require('bcryptjs');

// Seed minimal data directly into mock DB
async function seed() {
  const admin = {
    id: newId(), email: 'admin@nexusvotex.vn', password_hash: await bcrypt.hash('Admin@123456', 4),
    name: 'Admin', role: 'admin', is_banned: false, created_at: new Date().toISOString(),
  };
  DB.users.push(admin);
  DB.wallets.push({ id: newId(), user_id: admin.id, balance: 0, total_deposited: 0, total_spent: 0 });

  const category = {
    id: newId(), name: 'Tool', slug: 'tool', icon: '🧰', description: 'Công cụ game',
    sort_order: 1, is_active: true, created_at: new Date().toISOString(),
  };
  DB.categories.push(category);

  const product = {
    id: newId(), name: 'Tool Auto Bắn FF VIP', slug: 'tool-auto-ban-ff',
    price: 30000, original_price: 50000, category: 'Tool', category_id: category.id, type: 'instant',
    badge: 'HOT', is_active: true, is_featured: true, stock_override: null,
    short_description: 'Auto headshot', description: 'Full tool', created_at: new Date().toISOString(),
  };
  DB.products.push(product);

  const productVariant = {
    id: newId(), product_id: product.id, name: 'Bản 1 ngày', price: 30000, seller_price: null, sort_order: 0,
    created_at: new Date().toISOString(),
  };
  DB.product_variants.push(productVariant);

  for (let i = 0; i < 3; i++) {
    DB.inventory_keys.push({
      id: newId(), product_id: product.id, variant_id: productVariant.id, key_value: `KEY-FF-00${i}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      is_sold: false, created_at: new Date().toISOString(),
    });
  }

  // Product with a stale manual override of 0 but real unsold keys: the API must
  // still report the real key count instead of forcing 0 (shows "hết hàng").
  const productOverrideZero = {
    id: newId(), name: 'Tool Override Zero', slug: 'tool-override-zero',
    price: 10000, category: 'Tool', category_id: category.id, type: 'instant',
    badge: null, is_active: true, is_featured: false, stock_override: 0,
    short_description: '', description: '', created_at: new Date().toISOString(),
  };
  DB.products.push(productOverrideZero);
  const zeroVariant = {
    id: newId(), product_id: productOverrideZero.id, name: 'Mặc định', price: 10000, seller_price: null, sort_order: 0,
    created_at: new Date().toISOString(),
  };
  DB.product_variants.push(zeroVariant);
  for (let i = 0; i < 2; i++) {
    DB.inventory_keys.push({
      id: newId(), product_id: productOverrideZero.id, variant_id: zeroVariant.id, key_value: `KEY-ZERO-${i}`,
      is_sold: false, created_at: new Date().toISOString(),
    });
  }

  DB.settings.push({ id: newId(), key: 'shop_name', value: 'NexusVotex', created_at: new Date().toISOString() });
  DB.discount_codes.push({ id: newId(), code: 'GIAM10', discount_type: 'percent', value: 10, used_count: 0, max_uses: null, min_amount: null, is_active: true, created_at: new Date().toISOString() });

  return { admin, product, category };
}

function newId() {
  DB.__c = (DB.__c || 0) + 1;
  return `test-${DB.__c}`;
}

async function main() {
  const { admin, product, category } = await seed();
  const base = 'http://localhost:5000';
  const app = require('../src/server');

  const get = async (path, token) => {
    const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  const post = async (path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const put = async (path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const del = async (path, token) => {
    const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };

  let pass = 0, fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${extra}`); }
  };

  console.log('\n--- Auth ---');
  const reg = await post('/api/auth/register', { email: 'demo@test.com', password: 'secret123', name: 'Demo' });
  check('register', reg.status === 200 && reg.body.data.token, JSON.stringify(reg.body));

  const login = await post('/api/auth/login', { email: 'demo@test.com', password: 'secret123' });
  check('login', login.status === 200 && !!login.body.data.token);
  const userToken = login.body.data.token;

  // Credit the demo user with 500.000đ for purchase testing
  const demoUser = DB.users.find((u) => u.email === 'demo@test.com');
  const demoWallet = DB.wallets.find((w) => w.user_id === demoUser.id);
  demoWallet.balance = 500000;

  const badLogin = await post('/api/auth/login', { email: 'demo@test.com', password: 'wrong' });
  check('login wrong password rejected', badLogin.status === 401);

  const me = await get('/api/auth/me', userToken);
  check('me', me.status === 200 && me.body.data.balance !== undefined, JSON.stringify(me.body));
  check('me returns user.balance for header', me.body.data.user.balance !== undefined, JSON.stringify(me.body));

  console.log('\n--- Products ---');
  const products = await get('/api/products');
  check('list products', products.status === 200 && products.body.data.length === 2);
  const pMain = products.body.data.find((p) => p.slug === 'tool-auto-ban-ff');
  check('product stock computed', pMain && pMain.stock === 3, JSON.stringify(pMain));

  const overrideZero = products.body.data.find((p) => p.name === 'Tool Override Zero');
  check('stock_override=0 still counts real keys (2)', overrideZero && overrideZero.stock === 2, JSON.stringify(products.body.data));

  const featured = await get('/api/products/featured');
  check('featured', featured.body.data.length === 1);

  const detail = await get(`/api/products/${product.slug}`);
  check('detail', detail.status === 200 && detail.body.data.name === product.name, JSON.stringify(detail.body));

  console.log('\n--- Categories ---');
  const publicCats = await get('/api/categories');
  check('public categories list', publicCats.status === 200 && publicCats.body.data.length === 1, JSON.stringify(publicCats.body));
  check('category has product_count', publicCats.body.data[0].product_count === 2, JSON.stringify(publicCats.body.data[0]));

  const byCatId = await get(`/api/products?category_id=${category.id}`);
  check('filter products by category_id', byCatId.status === 200 && byCatId.body.data.length === 2 && byCatId.body.data[0].category_id === category.id, JSON.stringify(byCatId.body));

  // Admin CRUD
  const adminLogin2 = await post('/api/auth/login', { email: 'admin@nexusvotex.vn', password: 'Admin@123456' });
  const adminToken2 = adminLogin2.body.data.token;

  const createCat = await post('/api/admin/categories', { name: 'Acc Liên Quân', icon: '🎮', sort_order: 2 }, adminToken2);
  check('admin create category', createCat.status === 200 && createCat.body.data.slug === 'acc-lien-quan', JSON.stringify(createCat.body));

  const dupSlugCat = await post('/api/admin/categories', { name: 'ACC LIÊN QUÂN' }, adminToken2);
  check('duplicate slug auto-uniquified', dupSlugCat.status === 200 && dupSlugCat.body.data.slug !== 'acc-lien-quan', JSON.stringify(dupSlugCat.body));

  const createProdCat = await post('/api/admin/products', {
    name: 'Acc Liên Quân Sư Tử', price: 40000, type: 'instant', category_id: createCat.body.data.id,
    variants: [{ name: 'Mặc định', price: 40000 }],
  }, adminToken2);
  check('create product with category_id', createProdCat.status === 200 && createProdCat.body.data.category_id === createCat.body.data.id && createProdCat.body.data.category === 'Acc Liên Quân', JSON.stringify(createProdCat.body));

  const adminCats = await get('/api/admin/categories', adminToken2);
  check('admin category list has 3 cats', adminCats.status === 200 && adminCats.body.data.length === 3, JSON.stringify(adminCats.body));
  check('admin list shows product_count', adminCats.body.data.find((c) => c.slug === 'acc-lien-quan').product_count === 1, JSON.stringify(adminCats.body));

  const renamed = await put(`/api/admin/categories/${createCat.body.data.id}`, { name: 'Acc LQ' }, adminToken2);
  check('rename category syncs product text', renamed.status === 200 && DB.products.find((p) => p.id === createProdCat.body.data.id).category === 'Acc LQ', JSON.stringify(renamed.body));

  const delCat = await del(`/api/admin/categories/${createCat.body.data.id}`, adminToken2);
  check('delete category', delCat.status === 200, JSON.stringify(delCat.body));
  const orphaned = DB.products.find((p) => p.id === createProdCat.body.data.id);
  check('deleted category orphans product safely (null + Khác)', orphaned.category_id === null && orphaned.category === 'Khác', JSON.stringify(orphaned));
  const delCatAgain = await del(`/api/admin/categories/${createCat.body.data.id}`, adminToken2);
  check('delete missing category rejected (404)', delCatAgain.status === 404, JSON.stringify(delCatAgain.body));

  const badCatCreate = await post('/api/admin/products', { name: 'X', price: 10000, type: 'instant', category_id: 'nonexistent' }, adminToken2);
  check('create product with bad category_id rejected (400)', badCatCreate.status === 400, JSON.stringify(badCatCreate.body));


  console.log('\n--- Wallet + Card deposit (mock webhook) ---');
  // Directly call the confirmCard service to simulate TheSieuRe webhook
  const { confirmCard } = require('../src/services/thesieure.service');
  await confirmCard({ paymentCode: 'TSRXXXX', cardType: 'VIETTEL', serial: 'S1', amount: 50000, status: 1, transId: 'T1' });
  // payment doesn't exist -> should return false gracefully
  check('confirmCard unknown code no-crash', true);

  console.log('\n--- TheSieuRe webhook signature verification ---');
  const crypto = require('crypto');
  // Create a pending TheSieuRe payment for the demo user
  DB.payments.push({
    id: newId(), payment_code: 'TSR-TEST-1', user_id: demoUser.id, amount: 50000,
    method: 'thesieure', status: 'pending', provider: 'thesieure',
    detail: { card_type: 'VIETTEL', serial: 'SERIAL-1' }, created_at: new Date().toISOString(),
  });
  const cardCode = 'CARD-CODE-1';
  const sign = (code, serial) => crypto.createHash('md5').update(`${process.env.THESIEURE_PARTNER_KEY}${code}${serial}`).digest('hex');

  const badWh = await post('/api/webhook/thesieure', {
    request_id: 'TSR-TEST-1', serial: 'SERIAL-1', code: cardCode, status: 1,
    amount: 50000, telco: 'VIETTEL', trans_id: 'T1', callback_sign: 'deadbeef',
  });
  check('webhook bad signature rejected (400)', badWh.status === 400, JSON.stringify(badWh.body));

  const beforeBalance = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const goodWh = await post('/api/webhook/thesieure', {
    request_id: 'TSR-TEST-1', serial: 'SERIAL-1', code: cardCode, status: 1,
    amount: 50000, telco: 'VIETTEL', trans_id: 'T1', callback_sign: sign(cardCode, 'SERIAL-1'),
  });
  check('webhook valid signature accepted (200)', goodWh.status === 200, JSON.stringify(goodWh.body));
  check('wallet credited via webhook', DB.wallets.find((w) => w.user_id === demoUser.id).balance === beforeBalance + 50000);

  // webhook without sign must be rejected
  const noSignWh = await post('/api/webhook/thesieure', { request_id: 'TSR-TEST-1', status: 1, serial: 'SERIAL-1', code: cardCode });
  check('webhook missing sign rejected (400)', noSignWh.status === 400, JSON.stringify(noSignWh.body));

  // DOUBLE webhook: replaying the same valid callback must NOT credit twice
  const balBeforeReplay = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const replayWh = await post('/api/webhook/thesieure', {
    request_id: 'TSR-TEST-1', serial: 'SERIAL-1', code: cardCode, status: 1,
    amount: 50000, telco: 'VIETTEL', trans_id: 'T1', callback_sign: sign(cardCode, 'SERIAL-1'),
  });
  check('replayed webhook accepted but idempotent (200)', replayWh.status === 200, JSON.stringify(replayWh.body));
  check('no double credit on replay', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeReplay, `before=${balBeforeReplay}`);

  // Concurrent-style replay: two rapid confirmCard calls (simulating 2 webhooks)
  const balBeforeRace = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  DB.payments.push({
    id: newId(), payment_code: 'TSR-TEST-2', user_id: demoUser.id, amount: 20000,
    method: 'thesieure', status: 'pending', provider: 'thesieure',
    detail: { card_type: 'VINAPHONE', serial: 'SERIAL-2' }, created_at: new Date().toISOString(),
  });
  const cardCode2 = 'CARD-CODE-2';
  const cb2 = sign(cardCode2, 'SERIAL-2');
  const [r1, r2] = await Promise.all([
    confirmCard({ paymentCode: 'TSR-TEST-2', cardType: 'VINAPHONE', serial: 'SERIAL-2', code: cardCode2, amount: 20000, status: 1, transId: 'T2', callbackSign: cb2 }),
    confirmCard({ paymentCode: 'TSR-TEST-2', cardType: 'VINAPHONE', serial: 'SERIAL-2', code: cardCode2, amount: 20000, status: 1, transId: 'T2', callbackSign: cb2 }),
  ]);
  check('two concurrent confirmCard calls (one wins, one loses)', r1 && r2);
  check('credit applied exactly once under concurrency', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeRace + 20000, `before=${balBeforeRace} after=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);

  // EXPIRED payment (cron set status=failed) can still be credited by a late webhook
  DB.payments.push({
    id: newId(), payment_code: 'TSR-TEST-3', user_id: demoUser.id, amount: 15000,
    method: 'thesieure', status: 'failed', provider: 'thesieure', provider_message: 'Expired',
    detail: { card_type: 'MOBIFONE', serial: 'SERIAL-3' }, created_at: new Date().toISOString(),
  });
  const balBeforeLate = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const lateWh = await post('/api/webhook/thesieure', {
    request_id: 'TSR-TEST-3', serial: 'SERIAL-3', code: 'CARD-CODE-3', status: 1,
    amount: 15000, telco: 'MOBIFONE', trans_id: 'T3', callback_sign: sign('CARD-CODE-3', 'SERIAL-3'),
  });
  check('late webhook on expired payment accepted', lateWh.status === 200, JSON.stringify(lateWh.body));
  check('late webhook credits wallet once', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeLate + 15000, `before=${balBeforeLate} after=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  check('expired payment marked success', DB.payments.find((p) => p.payment_code === 'TSR-TEST-3').status === 'success');

  console.log('\n--- Checkout (instant keys + discount) ---');
  const checkout = await post('/api/orders/checkout', {
    items: [{ product_id: product.id, qty: 2 }],
    discount_code: 'GIAM10',
  }, userToken);
  check('checkout success', checkout.status === 200 && checkout.body.data.orders.length === 2, JSON.stringify(checkout.body));
  check('keys auto-assigned', checkout.body.data.orders.every((o) => o.key_value), JSON.stringify(checkout.body.data.orders));
  check('discount applied (30k -> 27k x2 = 54k)', checkout.body.data.total === 54000, JSON.stringify(checkout.body.data));
  check('stock decreased', DB.inventory_keys.filter((k) => k.product_id === product.id && !k.is_sold).length === 1);
  check('key marked sold', DB.inventory_keys.filter((k) => k.is_sold).length === 2);

  const me2 = await get('/api/auth/me', userToken);
  check('wallet debited 54000', me2.body.data.balance === 585000 - 54000, JSON.stringify(me2.body.data));

  // Revenue must reflect the DISCOUNTED amount (sum of wallet debits), not the
  // undiscounted orders.total. Today's purchases so far: 54000 (this checkout).
  const dashRev = await get('/api/admin/dashboard', adminToken2);
  check('dashboard revenue = discounted 54000', dashRev.body.data.revenue_today === 54000, JSON.stringify(dashRev.body.data));

  const preview = await post('/api/orders/cart/preview', { items: [{ product_id: product.id, qty: 1 }], discount_code: 'GIAM10' }, userToken);
  check('preview', preview.status === 200 && preview.body.data.total === 27000);

  console.log('\n--- Free order (100% discount) ---');
  DB.discount_codes.push({ id: newId(), code: 'FREE100', discount_type: 'percent', value: 100, used_count: 0, max_uses: 10, min_amount: null, is_active: true, created_at: new Date().toISOString() });
  const balBeforeFree = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const freeOrder = await post('/api/orders/checkout', { items: [{ product_id: product.id, qty: 1 }], discount_code: 'FREE100' }, userToken);
  check('free order (0 total) succeeds', freeOrder.status === 200 && freeOrder.body.data.total === 0 && freeOrder.body.data.orders.length === 1, JSON.stringify(freeOrder.body));
  check('free order did not debit wallet', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeFree);
  check('free order delivered a key', !!freeOrder.body.data.orders[0].key_value, JSON.stringify(freeOrder.body));

  console.log('\n--- Insufficient balance ---');
  const big = await post('/api/orders/checkout', { items: [{ product_id: product.id, qty: 50 }] }, userToken);
  check('insufficient balance rejected', big.status === 400, JSON.stringify(big.body));
  // Discount reservation must be released when checkout fails before debit
  const dcAfterFail = DB.discount_codes.find((d) => d.code === 'GIAM10');
  check('discount usage released on failed checkout', dcAfterFail.used_count === 1, JSON.stringify(dcAfterFail));

  console.log('\n--- Out of stock ---');
  const oos = await post('/api/orders/checkout', { items: [{ product_id: product.id, qty: 5 }] }, userToken);
  check('out of stock rejected before debit', oos.status === 400, JSON.stringify(oos.body));
  const me3 = await get('/api/auth/me', userToken);
  check('wallet untouched on out-of-stock (531000)', me3.body.data.balance === 531000, JSON.stringify(me3.body.data));

  console.log('\n--- Variants (loại key) ---');
  // Create a multi-variant product via the admin API and verify variant pricing,
  // per-variant stock, and that the variant must be chosen on checkout.
  const variantBuyerReg = await post('/api/auth/register', { email: 'variant@test.com', password: 'secret123', name: 'Variant' });
  const variantBuyerToken = variantBuyerReg.body.data.token;
  const variantBuyer = DB.users.find((u) => u.email === 'variant@test.com');
  const variantBuyerWallet = DB.wallets.find((w) => w.user_id === variantBuyer.id);
  variantBuyerWallet.balance = 500000;

  const variantProd = await post('/api/admin/products', {
    name: 'Key Đa Biến Thể', price: 30000, type: 'instant',
    variants: [
      { name: '1 ngày', price: 30000 },
      { name: '1 tuần', price: 120000 },
      { name: 'VIP', price: 200000, seller_price: 150000 },
    ],
  }, adminToken2);
  check('create multi-variant product (200)', variantProd.status === 200 && variantProd.body.data.variants.length === 3, JSON.stringify(variantProd.body));

  const varList = variantProd.body.data.variants;
  const dayVariant = varList.find((v) => v.name === '1 ngày');
  const weekVariant = varList.find((v) => v.name === '1 tuần');
  for (let i = 0; i < 2; i++) {
    DB.inventory_keys.push({
      id: newId(), product_id: variantProd.body.data.id, variant_id: dayVariant.id, key_value: `VAR-DAY-${i}`,
      is_sold: false, created_at: new Date().toISOString(),
    });
  }
  DB.inventory_keys.push({
    id: newId(), product_id: variantProd.body.data.id, variant_id: weekVariant.id, key_value: 'VAR-WEEK-1',
    is_sold: false, created_at: new Date().toISOString(),
  });

  const publicVariants = await get('/api/products');
  const pubVar = (publicVariants.body.data || []).find((p) => p.id === variantProd.body.data.id);
  check('public API exposes variants with per-variant stock',
    !!pubVar && pubVar.variants.length === 3 &&
    pubVar.variants.find((v) => v.name === '1 ngày').stock === 2 &&
    pubVar.variants.find((v) => v.name === '1 tuần').stock === 1,
    JSON.stringify(pubVar && pubVar.variants));

  const varPreview = await post('/api/orders/cart/preview', { items: [{ product_id: variantProd.body.data.id, variant_id: weekVariant.id, qty: 1 }] }, variantBuyerToken);
  check('preview charges chosen variant price (120k)', varPreview.status === 200 && varPreview.body.data.total === 120000, JSON.stringify(varPreview.body));

  const varNoVariant = await post('/api/orders/cart/preview', { items: [{ product_id: variantProd.body.data.id, qty: 1 }] }, variantBuyerToken);
  check('multi-variant product requires variant selection (400)', varNoVariant.status === 400, JSON.stringify(varNoVariant.body));

  const varBadVariant = await post('/api/orders/cart/preview', { items: [{ product_id: variantProd.body.data.id, variant_id: 'nope', qty: 1 }] }, variantBuyerToken);
  check('invalid variant_id rejected (400)', varBadVariant.status === 400, JSON.stringify(varBadVariant.body));

  const varCheckout = await post('/api/orders/checkout', { items: [{ product_id: variantProd.body.data.id, variant_id: weekVariant.id, qty: 1 }] }, variantBuyerToken);
  check('checkout with variant succeeds (120k)', varCheckout.status === 200 && varCheckout.body.data.total === 120000, JSON.stringify(varCheckout.body));
  check('order snapshot variant_name', varCheckout.body.data.orders[0].variant_name === '1 tuần', JSON.stringify(varCheckout.body.data.orders[0]));
  check('per-variant stock consumed (week 0, day 2)', DB.inventory_keys.filter((k) => k.variant_id === weekVariant.id && !k.is_sold).length === 0 && DB.inventory_keys.filter((k) => k.variant_id === dayVariant.id && !k.is_sold).length === 2);

  const varSellerPreview = await post('/api/orders/cart/preview', { items: [{ product_id: variantProd.body.data.id, variant_id: varList.find((v) => v.name === 'VIP').id, qty: 1 }] }, userToken);
  check('buyer pays variant price (VIP 200k)', varSellerPreview.status === 200 && varSellerPreview.body.data.total === 200000, JSON.stringify(varSellerPreview.body));

  console.log('\n--- Custom order ---');
  // create a custom product
  const customP = {
    id: newId(), name: 'Nạp hộ xu', slug: 'nap-ho-xu', price: 100000, category: 'Dịch vụ',
    type: 'custom', is_active: true, is_featured: false, stock_override: null,
    short_description: '', description: '', created_at: new Date().toISOString(),
  };
  DB.products.push(customP);
  DB.product_variants.push({
    id: newId(), product_id: customP.id, name: 'Chuẩn', price: 100000, seller_price: null, sort_order: 0,
    created_at: new Date().toISOString(),
  });

  const co = await post('/api/orders/custom', { product_id: customP.id, uid: '123456', character_name: 'Gamer', server: 'Vietnam', note: 'nhanh giup' }, userToken);
  check('custom order created', co.status === 200 && co.body.data.status === 'pending', JSON.stringify(co.body));

  const history = await get('/api/orders', userToken);
  check('history has custom order', history.body.data.customOrders.length === 1);

  console.log('\n--- Admin ---');
  const adminLogin = await post('/api/auth/login', { email: 'admin@nexusvotex.vn', password: 'Admin@123456' });
  const adminToken = adminLogin.body.data.token;

  const dash = await get('/api/admin/dashboard', adminToken);
  check('dashboard', dash.status === 200 && dash.body.data.order_count === 4, JSON.stringify(dash.body));

  const complete = await post(`/api/admin/custom-orders/${co.body.data.id}/complete`, { key_value: 'ACC-USER:PASS' }, adminToken);
  check('complete custom order', complete.status === 200 && complete.body.data.status === 'completed', JSON.stringify(complete.body));
  check('notification sent to buyer', DB.notifications.some((n) => n.user_id && n.title.includes('đã có key')));

  const co2 = await post('/api/orders/custom', { product_id: customP.id, uid: '999', character_name: 'X', server: 'Vietnam' }, userToken);
  const cancel = await post(`/api/admin/custom-orders/${co2.body.data.id}/cancel`, { reason: 'test' }, adminToken);
  check('cancel + refund', cancel.status === 200);
  const balAfterCancel = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  // Double cancel (admin double-click) must NOT refund twice
  const cancel2 = await post(`/api/admin/custom-orders/${co2.body.data.id}/cancel`, { reason: 'again' }, adminToken);
  check('double cancel rejected', cancel2.status === 400, JSON.stringify(cancel2.body));
  check('no double refund on double cancel', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balAfterCancel, `bal=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  const me4 = await get('/api/auth/me', userToken);
  check('refund after cancel (balance back to 431000)', me4.body.data.balance === 431000, JSON.stringify(me4.body.data));

  const addKey = await post('/api/admin/inventory', { product_id: product.id, variant_id: DB.product_variants.find((v) => v.product_id === product.id).id, key_value: 'NEW-KEY-1\nNEW-KEY-2' }, adminToken);
  check('admin add key', addKey.status === 200 && addKey.body.data.length === 2, JSON.stringify(addKey.body));

  const addKeyNoVariant = await post('/api/admin/inventory', { product_id: product.id, key_value: 'NO-VAR-KEY' }, adminToken);
  check('admin add key without variant rejected (400)', addKeyNoVariant.status === 400, JSON.stringify(addKeyNoVariant.body));

  const importKeys = await post('/api/admin/inventory/import', { product_id: product.id, variant_id: DB.product_variants.find((v) => v.product_id === product.id).id, format: 'csv', content: 'K1,C1\nK2,C2\nK3,C3' }, adminToken);
  check('admin import csv', importKeys.status === 200 && importKeys.body.data.imported === 3, JSON.stringify(importKeys.body));

  // Insufficient balance at the WALLET level (stock is fine here): a user with
  // zero balance must get a clean 400 and NO order must be created.
  const poorReg = await post('/api/auth/register', { email: 'poor@test.com', password: 'secret123', name: 'Poor' });
  const poorBuy = await post('/api/orders/checkout', { items: [{ product_id: product.id, qty: 1 }] }, poorReg.body.data.token);
  check('wallet insufficient balance rejected (400)', poorBuy.status === 400, JSON.stringify(poorBuy.body));
  const poorOrders = DB.orders.filter((o) => o.user_id === DB.users.find((u) => u.email === 'poor@test.com').id);
  check('no order created on failed debit', poorOrders.length === 0);

  const users = await get('/api/admin/users', adminToken);
  check('admin list users', users.status === 200 && users.body.data.length >= 2);

  const deposits = await get('/api/admin/deposits', adminToken);
  check('admin list deposits', deposits.status === 200 && Array.isArray(deposits.body.data), JSON.stringify(deposits.body));

  const adjust = await post(`/api/admin/users/${me.body.data.user.id}/adjust-balance`, { amount: 20000, note: 'bonus' }, adminToken);
  check('admin adjust balance', adjust.status === 200 && adjust.body.data.new_balance === 451000, JSON.stringify(adjust.body));

  const overDebit = await post(`/api/admin/users/${me.body.data.user.id}/adjust-balance`, { amount: -999999999, note: 'x' }, adminToken);
  check('admin adjust cannot drive balance negative (400)', overDebit.status === 400, JSON.stringify(overDebit.body));

  const settingsGet = await get('/api/admin/settings', adminToken);
  const settingsPut = await put('/api/admin/settings', { shop_name: 'NexusVotex Pro', main_color: '#ff0000' }, adminToken);
  check('settings update', settingsPut.status === 200);
  const pub = await get('/api/settings/public');
  check('public settings updated', pub.body.data.shop_name === 'NexusVotex Pro', JSON.stringify(pub.body));

  console.log('\n--- Notifications ---');
  const notifs = await get('/api/notifications', userToken);
  check('notification list', notifs.status === 200 && notifs.body.data.length > 0);
  const unread = await get('/api/notifications/unread-count', userToken);
  check('unread count', unread.status === 200 && unread.body.data.count > 0, JSON.stringify(unread.body));
  const markAll = await put('/api/notifications/read-all', {}, userToken);
  check('mark all read', markAll.status === 200);
  const unread2 = await get('/api/notifications/unread-count', userToken);
  check('unread now 0', unread2.body.data.count === 0);

  console.log('\n--- Last key race (1 key, 2 buyers) ---');
  // A fresh product with exactly ONE key; two buyers race to buy it.
  const raceProduct = {
    id: newId(), name: 'Key Hiếm', slug: 'key-hiem', price: 50000, category: 'Tool',
    type: 'instant', is_active: true, is_featured: false, stock_override: null,
    short_description: '', description: '', created_at: new Date().toISOString(),
  };
  DB.products.push(raceProduct);
  const raceVariant = {
    id: newId(), product_id: raceProduct.id, name: 'Mặc định', price: 50000, seller_price: null, sort_order: 0,
    created_at: new Date().toISOString(),
  };
  DB.product_variants.push(raceVariant);
  DB.inventory_keys.push({
    id: newId(), product_id: raceProduct.id, variant_id: raceVariant.id, key_value: 'RACE-KEY-1',
    is_sold: false, created_at: new Date().toISOString(),
  });

  const buyer2reg = await post('/api/auth/register', { email: 'buyer2@test.com', password: 'secret123', name: 'Buyer2' });
  const buyer2Token = buyer2reg.body.data.token;
  const buyer2 = DB.users.find((u) => u.email === 'buyer2@test.com');
  const buyer2Wallet = DB.wallets.find((w) => w.user_id === buyer2.id);
  buyer2Wallet.balance = 500000;
  const buyer1Bal = DB.wallets.find((w) => w.user_id === demoUser.id).balance;

  const [raceA, raceB] = await Promise.all([
    post('/api/orders/checkout', { items: [{ product_id: raceProduct.id, qty: 1 }] }, userToken),
    post('/api/orders/checkout', { items: [{ product_id: raceProduct.id, qty: 1 }] }, buyer2Token),
  ]);
  const raceResults = [raceA, raceB].map((r) => r.status);
  check('exactly one buyer wins the last key', raceResults.filter((s) => s === 200).length === 1 && raceResults.filter((s) => s === 400).length === 1, JSON.stringify({ a: raceA.body, b: raceB.body }));
  check('race winner paid 50000', raceA.status === 200 ? raceA.body.data.total === 50000 : raceB.body.data.total === 50000, JSON.stringify(raceA.body));
  check('all keys accounted (0 unsold)', DB.inventory_keys.filter((k) => k.product_id === raceProduct.id && !k.is_sold).length === 0);
  // The loser must have lost NO money.
  const b1After = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const b2After = DB.wallets.find((w) => w.user_id === buyer2.id).balance;
  const winnerWas1 = raceA.status === 200;
  check('loser balance untouched (no double charge)',
    (winnerWas1 ? b2After === 500000 : b1After === buyer1Bal),
    `b1=${b1After} b2=${b2After} winner1=${winnerWas1}`);

  console.log('\n--- Access control ---');
  const banned = await get('/api/admin/dashboard', userToken);
  check('user cannot access admin', banned.status === 403 || banned.status === 401);
  const noAuth = await get('/api/orders');
  check('no token rejected', noAuth.status === 401);

  console.log('\n--- PayOS webhook signature verification ---');
  // PayOS signs ONLY the `data` object (query-string format, sorted keys).
  const payosSign = (data, key) => {
    const sortKeys = (o) => Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {});
    const sorted = sortKeys(data);
    const qs = Object.keys(sorted).filter((k) => sorted[k] !== undefined).map((k) => {
      let v = sorted[k];
      if (Array.isArray(v)) v = JSON.stringify(v.map((it) => (it && typeof it === 'object' ? sortKeys(it) : it)));
      if ([null, undefined, 'null', 'undefined'].includes(v)) v = '';
      return `${k}=${v}`;
    }).join('&');
    return crypto.createHmac('sha256', key).update(qs).digest('hex');
  };
  const demoBalBeforePayos = DB.wallets.find((w) => w.user_id === demoUser.id).balance;

  DB.payments.push({
    id: newId(), payment_code: 'POS-TEST-1', user_id: demoUser.id, amount: 60000,
    method: 'payos', status: 'pending', provider: 'payos', provider_code: 'payos-pay-1',
    detail: { order_code: '12345678' }, created_at: new Date().toISOString(),
  });
  const payosData = { orderCode: 12345678, amount: 60000, description: 'Nap tien NexusVotex', paymentLinkId: 'payos-pay-1', code: '00', desc: 'Thành công', status: 'PAID' };

  const payosBad = await post('/api/webhook/payos', { code: '00', desc: 'success', success: true, data: payosData, signature: 'deadbeef' });
  check('payos bad signature rejected (400)', payosBad.status === 400, JSON.stringify(payosBad.body));

  const payosGood = await post('/api/webhook/payos', { code: '00', desc: 'success', success: true, data: payosData, signature: payosSign(payosData, 'test-checksum') });
  check('payos valid signature accepted (200)', payosGood.status === 200, JSON.stringify(payosGood.body));
  check('payos wallet credited', DB.wallets.find((w) => w.user_id === demoUser.id).balance === demoBalBeforePayos + 60000);

  const payosReplay = await post('/api/webhook/payos', { code: '00', desc: 'success', success: true, data: payosData, signature: payosSign(payosData, 'test-checksum') });
  check('payos replay accepted but idempotent (200)', payosReplay.status === 200, JSON.stringify(payosReplay.body));
  check('payos no double credit on replay', DB.wallets.find((w) => w.user_id === demoUser.id).balance === demoBalBeforePayos + 60000);

  console.log('\n--- Concurrent deposits (lost-update regression) ---');
  // Two DIFFERENT payments for the SAME wallet confirmed concurrently must
  // both land (CAS credit). Mock is sequential, so this guards the refactor.
  const balBeforeConc = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  DB.payments.push(
    { id: newId(), payment_code: 'TSR-TEST-4', user_id: demoUser.id, amount: 50000, method: 'thesieure', status: 'pending', provider: 'thesieure', detail: { card_type: 'VIETTEL', serial: 'SERIAL-4' }, created_at: new Date().toISOString() },
    { id: newId(), payment_code: 'TSR-TEST-5', user_id: demoUser.id, amount: 30000, method: 'thesieure', status: 'pending', provider: 'thesieure', detail: { card_type: 'MOBIFONE', serial: 'SERIAL-5' }, created_at: new Date().toISOString() },
  );
  await Promise.all([
    confirmCard({ paymentCode: 'TSR-TEST-4', cardType: 'VIETTEL', serial: 'SERIAL-4', code: 'CARD-CODE-4', amount: 50000, status: 1, transId: 'T4', internal: true }),
    confirmCard({ paymentCode: 'TSR-TEST-5', cardType: 'MOBIFONE', serial: 'SERIAL-5', code: 'CARD-CODE-5', amount: 30000, status: 1, transId: 'T5', internal: true }),
  ]);
  check('both concurrent deposits credited (sum)', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeConc + 80000, `bal=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  check('both payments marked success', DB.payments.filter((p) => p.payment_code === 'TSR-TEST-4' || p.payment_code === 'TSR-TEST-5').every((p) => p.status === 'success'));

  console.log('\n--- Deposit reconciliation (crash-window recovery) ---');
  const { reconcileCredits } = require('../src/services/cron');
  const { admin: adminClient } = require('../src/config/supabase');
  // Simulate a payment flipped to success whose credit crashed before landing:
  // status=success + processed_at set, but NO wallet_transactions row.
  const orphanPay = {
    id: newId(), payment_code: 'POS-ORPHAN-1', user_id: demoUser.id, amount: 70000,
    method: 'payos', status: 'success', provider: 'payos', processed_at: new Date().toISOString(),
    detail: {}, created_at: new Date().toISOString(),
  };
  DB.payments.push(orphanPay);
  const balBeforeReconcile = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  await reconcileCredits(adminClient);
  check('reconciliation credits orphaned success payment', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeReconcile + 70000, `bal=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  check('reconciliation records deposit tx with ref', DB.wallet_transactions.some((t) => t.ref_type === 'payment' && t.ref_id === orphanPay.id && t.type === 'deposit'));
  const balAfterReconcile = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  await reconcileCredits(adminClient);
  check('reconciliation is idempotent (no double credit)', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balAfterReconcile);

  // Wallet mutations are atomic in the DB: credit with the same ref_id is
  // idempotent even under concurrency (webhook replay vs reconciliation race).
  const { creditWallet } = require('../src/services/wallet.service');
  const idemRef = 'IDEMP-REF-1';
  const balBeforeIdem = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const [x1, x2] = await Promise.all([
    creditWallet({ userId: demoUser.id, amount: 12000, type: 'deposit', refType: 'payment', refId: idemRef }),
    creditWallet({ userId: demoUser.id, amount: 12000, type: 'deposit', refType: 'payment', refId: idemRef }),
  ]);
  check('concurrent same-ref credits credit exactly once', x1 === x2 && DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeIdem + 12000, `x1=${x1} x2=${x2} bal=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  check('single deposit tx recorded for the ref', DB.wallet_transactions.filter((t) => t.ref_id === idemRef).length === 1);

  console.log('\n--- Purchase reconciliation (orphaned debit recovery) ---');
  const { reconcileOrphanedPurchases } = require('../src/services/cron');
  // Simulate a checkout that debited the wallet but died before the order was
  // created: purchase tx with ref_id=order_code, no order row, no refund.
  DB.wallet_transactions.push({
    id: newId(), user_id: demoUser.id, amount: -50000, type: 'purchase', balance_after: DB.wallets.find((w) => w.user_id === demoUser.id).balance - 50000,
    description: 'Thanh toán đơn ORPHAN-ORD-1', ref_type: 'order', ref_id: 'ORPHAN-ORD-1', created_at: new Date().toISOString(),
  });
  DB.wallets.find((w) => w.user_id === demoUser.id).balance -= 50000;
  const balBeforeOrphan = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  await reconcileOrphanedPurchases(adminClient);
  check('orphaned debit auto-refunded', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeOrphan + 50000, `bal=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);
  check('refund tx recorded for the orphan', DB.wallet_transactions.some((t) => t.ref_type === 'refund' && t.ref_id === 'ORPHAN-ORD-1' && t.type === 'refund'));
  const balAfterOrphan = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  await reconcileOrphanedPurchases(adminClient);
  check('orphaned-debit reconciliation is idempotent', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balAfterOrphan);
  const leftovers = DB.wallet_transactions.filter(
    (t) => t.type === 'purchase' && (t.ref_type === 'order' || t.ref_type === 'custom_order') && t.ref_id &&
      !DB.orders.some((o) => o.group_code === t.ref_id) &&
      !DB.custom_orders.some((o) => o.order_code === t.ref_id) &&
      !DB.wallet_transactions.some((r) => r.type === 'refund' && r.ref_id === t.ref_id)
  );
  check('no unrefunded orphaned debits remain', leftovers.length === 0, JSON.stringify(leftovers.map((l) => l.ref_id)));
  const wronglyRefunded = DB.wallet_transactions.filter(
    (t) => t.type === 'refund' &&
      (DB.orders.some((o) => o.group_code === t.ref_id) || DB.custom_orders.some((o) => o.order_code === t.ref_id))
  );
  check('completed checkout debits NOT refunded', wronglyRefunded.length === 0, JSON.stringify(wronglyRefunded.map((r) => r.ref_id)));

  console.log('\n--- Input sanitization & data guards ---');
  const badLimit = await get('/api/products?limit=abc');
  check('limit=abc sanitized (200)', badLimit.status === 200, JSON.stringify(badLimit.body));
  const badInv = await get('/api/admin/inventory?page=abc&pageSize=999999', adminToken);
  check('admin pagination sanitized (200)', badInv.status === 200, JSON.stringify(badInv.body));

  const soldKey = DB.inventory_keys.find((k) => k.is_sold);
  const delSold = await fetch(`${base}/api/admin/inventory/${soldKey.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  check('delete sold key rejected (400)', delSold.status === 400);

  const overDiscount = await post('/api/admin/discounts', { code: 'OVER100', discount_type: 'percent', value: 150 }, adminToken);
  check('discount percent 150 rejected', overDiscount.status === 400, JSON.stringify(overDiscount.body));

  console.log('\n--- Business-rule guards (regression) ---');
  // A cancelled custom order was already refunded -> must NOT be completable.
  const co3 = await post('/api/orders/custom', { product_id: customP.id, uid: '777', character_name: 'Y', server: 'Vietnam' }, userToken);
  await post(`/api/admin/custom-orders/${co3.body.data.id}/cancel`, { reason: 'x' }, adminToken);
  const completeCancelled = await post(`/api/admin/custom-orders/${co3.body.data.id}/complete`, { key_value: 'ACC' }, adminToken);
  check('complete cancelled order rejected (400)', completeCancelled.status === 400, JSON.stringify(completeCancelled.body));

  // Double-complete must be rejected too.
  const completeAgain = await post(`/api/admin/custom-orders/${co.body.data.id}/complete`, { key_value: 'ACC-2' }, adminToken);
  check('complete completed order rejected (400)', completeAgain.status === 400, JSON.stringify(completeAgain.body));

  // Negative price must be rejected (would corrupt cart totals).
  const negPrice = await post('/api/admin/products', { name: 'Neg', price: -5000, type: 'instant' }, adminToken);
  check('negative price rejected (400)', negPrice.status === 400, JSON.stringify(negPrice.body));

  // Hard-delete product: allowed only when there is no purchase history.
  const delClean = await post('/api/admin/products', { name: 'Del Me', price: 5000, type: 'instant', variants: [{ name: 'Mặc định', price: 5000 }] }, adminToken);
  check('create product for delete test (200)', delClean.status === 200, JSON.stringify(delClean.body));
  const delOk = await del(`/api/admin/products/${delClean.body.data.id}`, adminToken);
  check('delete product without orders (200)', delOk.status === 200 && !DB.products.some((p) => p.id === delClean.body.data.id), JSON.stringify(delOk.body));

  const delWithOrder = await del(`/api/admin/products/${variantProd.body.data.id}`, adminToken);
  check('delete product with orders rejected (400)', delWithOrder.status === 400, JSON.stringify(delWithOrder.body));
  check('product with orders still exists', !!DB.products.find((p) => p.id === variantProd.body.data.id));

  const delMissing = await del('/api/admin/products/does-not-exist', adminToken);
  check('delete missing product rejected (404)', delMissing.status === 404, JSON.stringify(delMissing.body));

  // Admin must not be able to demote themselves (self lockout).
  const adminUser = DB.users.find((u) => u.role === 'admin');
  const selfDemote = await put(`/api/admin/users/${adminUser.id}`, { role: 'user' }, adminToken);
  check('self-demote rejected (400)', selfDemote.status === 400, JSON.stringify(selfDemote.body));

  // Seller role: an admin can promote a normal user to seller, and a product
  // can carry a separate seller_price that is served to the shop API.
  const plainUser = DB.users.find((u) => u.role === 'user');
  const promote = await put(`/api/admin/users/${plainUser.id}`, { role: 'seller' }, adminToken);
  check('promote user to seller (200)', promote.status === 200 && promote.body.data.role === 'seller', JSON.stringify(promote.body));
  const sellerProd = await post('/api/admin/products', { name: 'SellerKey', price: 20000, seller_price: 15000, type: 'instant', variants: [{ name: 'Mặc định', price: 20000 }] }, adminToken);
  check('create product with seller_price (200)', sellerProd.status === 200 && Number(sellerProd.body.data.seller_price) === 15000, JSON.stringify(sellerProd.body));
  const publicProd = await get('/api/products?limit=100');
  const publicSeller = (publicProd.body.data || []).find((p) => p.name === 'SellerKey');
  check('shop API exposes seller_price', !!publicSeller && Number(publicSeller.seller_price) === 15000, JSON.stringify(publicSeller));

  // Search with PostgREST-special chars must not break or inject the filter.
  const badSearch = await get(`/api/admin/users?search=${encodeURIComponent('x,id.eq.aaa);--')}`, adminToken);
  check('user search sanitized (200)', badSearch.status === 200, JSON.stringify(badSearch.body));

  console.log('\n--- TheSieuRe callback delivery & amount (regression) ---');
  // GET callback: TheSieuRe can deliver the result via GET query string too.
  DB.payments.push({
    id: newId(), payment_code: 'TSR-GET-1', user_id: demoUser.id, amount: 50000,
    method: 'thesieure', status: 'pending', provider: 'thesieure',
    detail: { card_type: 'VIETTEL', serial: 'SERIAL-GET' }, created_at: new Date().toISOString(),
  });
  const balBeforeGet = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const getQs = new URLSearchParams({
    status: 1, request_id: 'TSR-GET-1', serial: 'SERIAL-GET', code: 'CARD-GET-1',
    amount: 25000, telco: 'VIETTEL', trans_id: 'T-GET', callback_sign: sign('CARD-GET-1', 'SERIAL-GET'),
  }).toString();
  const getWh = await get(`/api/webhook/thesieure?${getQs}`);
  check('GET webhook accepted (200)', getWh.status === 200, JSON.stringify(getWh.body));
  check('GET webhook credits wallet', DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeGet + 25000, `before=${balBeforeGet} after=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);

  // Discounted amount: the webhook `amount` (after TheSieuRe fee) is what gets
  // credited - NOT the declared face value (payment.amount = 50000).
  DB.payments.push({
    id: newId(), payment_code: 'TSR-DISC-1', user_id: demoUser.id, amount: 50000,
    method: 'thesieure', status: 'pending', provider: 'thesieure',
    detail: { card_type: 'MOBIFONE', serial: 'SERIAL-DISC' }, created_at: new Date().toISOString(),
  });
  const balBeforeDisc = DB.wallets.find((w) => w.user_id === demoUser.id).balance;
  const discWh = await post('/api/webhook/thesieure', {
    request_id: 'TSR-DISC-1', serial: 'SERIAL-DISC', code: 'CARD-DISC-1', status: 1,
    amount: 25000, declared_value: 50000, value: 50000, telco: 'MOBIFONE', trans_id: 'T-DISC',
    callback_sign: sign('CARD-DISC-1', 'SERIAL-DISC'),
  });
  check('webhook with discounted amount accepted', discWh.status === 200, JSON.stringify(discWh.body));
  check('wallet credited discounted amount (25k, not 50k declared)',
    DB.wallets.find((w) => w.user_id === demoUser.id).balance === balBeforeDisc + 25000,
    `before=${balBeforeDisc} after=${DB.wallets.find((w) => w.user_id === demoUser.id).balance}`);

  console.log(`\n======== RESULT: ${pass} passed, ${fail} failed ========\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
