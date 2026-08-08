/**
 * Minimal in-memory mock of @supabase/supabase-js for smoke testing.
 * Supports the subset of the API used by NexusVotex backend.
 */
const Module = require('module');
const originalLoad = Module._load;

const DB = {
  users: [],
  categories: [],
  products: [],
  product_variants: [],
  inventory_keys: [],
  orders: [],
  custom_orders: [],
  wallets: [],
  wallet_transactions: [],
  payments: [],
  notifications: [],
  discount_codes: [],
  news: [],
  settings: [],
  activity_logs: [],
};

let idCounter = 1;
const newId = () => `id-${idCounter++}`;
const now = () => new Date().toISOString();

const resolvePath = (row, col) => {
  const idx = col.indexOf('->>');
  if (idx === -1) return row[col];
  const base = col.slice(0, idx);
  const key = col.slice(idx + 3);
  const obj = row[base];
  return obj && typeof obj === 'object' ? obj[key] : undefined;
};

// Columns per table, mirrors backend/supabase/schema.sql.
const SCHEMA = {
  users: ['id', 'email', 'password_hash', 'name', 'avatar_url', 'role', 'is_banned', 'reset_token', 'reset_expires_at', 'created_at', 'updated_at'],
  categories: ['id', 'name', 'slug', 'icon', 'description', 'sort_order', 'is_active', 'created_at', 'updated_at'],
  products: ['id', 'name', 'slug', 'description', 'short_description', 'price', 'seller_price', 'original_price', 'image_url', 'category', 'category_id', 'type', 'badge', 'discount', 'is_active', 'is_featured', 'is_hot', 'is_sale', 'stock_override', 'sort_order', 'created_at', 'updated_at'],
  product_variants: ['id', 'product_id', 'name', 'price', 'seller_price', 'sort_order', 'created_at'],
  inventory_keys: ['id', 'product_id', 'variant_id', 'key_value', 'is_sold', 'order_id', 'sold_at', 'created_at'],
  orders: ['id', 'order_code', 'group_code', 'user_id', 'product_id', 'product_name', 'variant_id', 'variant_name', 'key_id', 'key_value', 'price', 'discount_amount', 'total', 'status', 'payment_method', 'created_at'],
  custom_orders: ['id', 'order_code', 'user_id', 'product_id', 'product_name', 'variant_id', 'variant_name', 'qty', 'uid', 'character_name', 'server', 'note', 'paid_amount', 'status', 'admin_key', 'admin_message', 'account_info', 'file_url', 'completed_at', 'created_at'],
  wallets: ['id', 'user_id', 'balance', 'total_deposited', 'total_spent', 'updated_at'],
  wallet_transactions: ['id', 'user_id', 'amount', 'type', 'balance_after', 'description', 'ref_type', 'ref_id', 'created_at'],
  payments: ['id', 'payment_code', 'user_id', 'amount', 'method', 'status', 'provider', 'provider_code', 'provider_message', 'detail', 'processed_at', 'created_at'],
  notifications: ['id', 'user_id', 'title', 'content', 'type', 'is_read', 'created_at'],
  discount_codes: ['id', 'code', 'discount_type', 'value', 'max_uses', 'used_count', 'min_amount', 'expires_at', 'is_active', 'created_at'],
  news: ['id', 'title', 'content', 'image_url', 'is_published', 'created_at', 'updated_at'],
  settings: ['id', 'key', 'value', 'description', 'updated_at'],
  activity_logs: ['id', 'user_id', 'action', 'detail', 'ip', 'created_at'],
};

const assertColumns = (table, keys, where) => {
  const allowed = SCHEMA[table];
  if (!allowed) return;
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length) {
    throw new Error(`[mock] ${table}.${where} references unknown column(s): ${bad.join(', ')}`);
  }
};

/** Split a select list on commas that are NOT inside parentheses. */
function splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      const t = cur.trim();
      if (t) parts.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) parts.push(t);
  return parts;
}

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this._filters = [];
    this._orders = [];
    this._select = '*';
    this._limit = null;
    this._range = null;
    this._single = false;
    this._head = false;
    this._op = null;      // 'insert' | 'update' | 'delete' | null
    this._opPayload = null;
  }

  select(cols, opts = {}) {
    this._select = cols;
    this._head = !!opts.head;
    this._count = opts.count;
    if (typeof cols === 'string' && !cols.includes('*')) {
      const parts = splitTopLevel(cols);
      for (const part of parts) {
        const m = part.match(/^(\w+)\((.+)\)$/);
        if (m) {
          // relation embed: table(cols...) -> validate inner columns against related table
          const [, rel, inner] = m;
          const nested = splitTopLevel(inner);
          for (const n of nested) {
            const nm = n.match(/^(\w+)\((.+)\)$/);
            if (nm) assertColumns(rel, [nm[1]], 'select relation'); // skip deeper nesting
            else if (!n.includes('.')) assertColumns(rel, [n], 'select relation');
          }
          continue;
        }
        if (!part.includes('.')) assertColumns(this.table, [part], 'select');
      }
    }
    return this;
  }

  eq(col, value) {
    assertColumns(this.table, col.includes('->>') ? [col.split('->>')[0]] : [col], 'eq');
    this._filters.push((r) => resolvePath(r, col) === value);
    return this;
  }
  neq(col, value) {
    assertColumns(this.table, col.includes('->>') ? [col.split('->>')[0]] : [col], 'neq');
    this._filters.push((r) => resolvePath(r, col) !== value);
    return this;
  }
  in(col, values) { assertColumns(this.table, [col], 'in'); this._filters.push((r) => (values || []).includes(r[col])); return this; }
  is(col, value) { assertColumns(this.table, [col], 'is'); this._filters.push((r) => (r[col] === null || r[col] === undefined) === (value === null)); return this; }
  ilike(col, pattern) {
    assertColumns(this.table, [col], 'ilike');
    const p = String(pattern).replace(/%/g, '.*').replace(/\*/g, '.*');
    const re = new RegExp(`^${p}$`, 'i');
    this._filters.push((r) => re.test(String(r[col] || '')));
    return this;
  }
  or(str) {
    const parts = str.split(',').map((s) => s.trim());
    this._filters.push((r) =>
      parts.some((part) => {
        const m = part.match(/(\w+)\.(ilike|eq)\.(.*)/);
        if (!m) return false;
        const [, col, op, val] = m;
        const v = val.replace(/\./g, '');
        const pattern = String(v).replace(/%/g, '.*');
        if (op === 'ilike') return new RegExp(`^${pattern}$`, 'i').test(String(r[col] || ''));
        return r[col] === v;
      })
    );
    return this;
  }
  gte(col, value) { assertColumns(this.table, [col], 'gte'); this._filters.push((r) => r[col] >= value); return this; }
  gt(col, value) { assertColumns(this.table, [col], 'gt'); this._filters.push((r) => r[col] > value); return this; }
  lt(col, value) { assertColumns(this.table, [col], 'lt'); this._filters.push((r) => r[col] < value); return this; }
  order(col, opts = {}) { assertColumns(this.table, [col], 'order'); this._orders.push([col, opts.ascending === false ? -1 : 1]); return this; }
  limit(n) { this._limit = n; return this; }
  range(a, b) { this._range = [a, b]; return this; }

  maybeSingle() { this._single = 'maybe'; return this; }
  single() { this._single = 'yes'; return this; }

  insert(rows) { this._op = 'insert'; this._opPayload = rows; return this; }
  update(patch) {
    assertColumns(this.table, Object.keys(patch || {}), 'update');
    this._op = 'update';
    this._opPayload = patch;
    return this;
  }
  delete() { this._op = 'delete'; return this; }

  _resolve(mode) {
    let rows = DB[this.table].filter((r) => this._filters.every((f) => f(r)));

    if (mode === 'insert') {
      const list = Array.isArray(this._opPayload) ? this._opPayload : [this._opPayload];
      list.forEach((r) => assertColumns(this.table, Object.keys(r || {}), 'insert'));
      const defaults = {
        notifications: { is_read: false },
        inventory_keys: { is_sold: false },
        orders: { status: 'success', discount_amount: 0 },
        custom_orders: { status: 'pending' },
        payments: { status: 'pending' },
        wallets: { balance: 0, total_deposited: 0, total_spent: 0 },
        discount_codes: { used_count: 0 },
        products: { is_active: true, is_featured: false },
      }[this.table];
      const inserted = list.map((r) => ({
        id: newId(),
        created_at: now(),
        updated_at: now(),
        ...(defaults || {}),
        ...r,
      }));
      DB[this.table].push(...inserted);
      if (this._single === 'yes') return { data: this._applySelect([inserted[0]])[0], error: null };
      return { data: this._applySelect(inserted), error: null };
    }

    if (mode === 'update') {
      const matched = rows.slice();
      if (matched.length === 0) {
        if (this._single === 'maybe') return { data: null, error: null };
        if (this._single === 'yes') return { data: null, error: { message: 'row not found' } };
        return { data: [], error: null };
      }
      matched.forEach((r) => Object.assign(r, this._opPayload, { updated_at: now() }));
      if (this._single === 'maybe') return { data: this._applySelect([matched[0]])[0] || null, error: null };
      if (this._single === 'yes') return { data: this._applySelect([matched[0]])[0], error: null };
      return { data: this._applySelect(matched), error: null };
    }

    if (mode === 'delete') {
      DB[this.table] = DB[this.table].filter((r) => !this._filters.every((f) => f(r)));
      return { data: null, error: null };
    }

    // select mode
    if (this._head) {
      return { count: rows.length, error: null, data: null };
    }

    // attach relations
    rows = rows.map((row) => {
      const out = { ...row };
      if (row.product_id) {
        const p = DB.products.find((x) => x.id === row.product_id);
        if (p) out.products = { name: p.name, image_url: p.image_url };
      }
      if (row.id && this.table === 'products') {
        out.product_variants = DB.product_variants
          .filter((v) => v.product_id === row.id)
          .map((v) => ({ ...v }));
      }
      if (row.variant_id) {
        const v = DB.product_variants.find((x) => x.id === row.variant_id);
        if (v) out.product_variants = { name: v.name };
      }
      if (row.user_id) {
        const u = DB.users.find((x) => x.id === row.user_id);
        if (u) out.users = { email: u.email, name: u.name };
        const w = DB.wallets.find((x) => x.user_id === row.user_id);
        if (w) out.wallets = { balance: w.balance };
      }
      if (row.order_id) {
        const o = DB.orders.find((x) => x.id === row.order_id);
        if (o) {
          const u = DB.users.find((x) => x.id === o.user_id);
          out.orders = { ...o, users: u ? { email: u.email, name: u.name } : null };
        }
      }
      if (row.key_id) {
        const k = DB.inventory_keys.find((x) => x.id === row.key_id);
        if (k) out.inventory_keys = k;
      }
      return out;
    });

    this._orders.forEach(([col, dir]) => {
      rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * dir);
    });
    if (this._limit) rows = rows.slice(0, this._limit);
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);

    if (this._single === 'maybe') {
      return { data: rows[0] || null, error: rows.length > 1 ? { message: 'multiple rows' } : null };
    }
    if (this._single === 'yes') {
      if (rows.length === 0) return { data: null, error: { message: 'row not found' } };
      return { data: this._applySelect([rows[0]])[0], error: null };
    }
    return { data: this._applySelect(rows), error: null };
  }

  then(resolve, reject) {
    try {
      const mode = this._op || 'select';
      return resolve(this._resolve(mode));
    } catch (err) {
      return reject(err);
    }
  }

  _applySelect(rows) {
    if (this._select === '*' || this._select === 'id' || this._select.includes('*')) return rows;
    const cols = splitTopLevel(this._select).map((c) => c.trim().replace(/\(.*\)/, ''));
    const res = [];
    for (const row of rows) {
      const o = {};
      for (const c of cols) {
        if (c.includes('.') || c === 'id') {
          const [a, b] = c.split('.');
          if (a && b && row[a]) o[`${a}_${b}`] = row[a][b];
          continue;
        }
        if (row[c] !== undefined) o[c] = row[c];
      }
      o.id = row.id;
      res.push(o);
    }
    return res;
  }
}

// ---- rpc(): mirrors the atomic wallet functions in schema.sql ----
// The mock is single-threaded, so each rpc call runs to completion without
// yielding — which reproduces the "serialize on the wallet row lock" behavior
// of the real plpgsql functions when calls are fired concurrently.
const rpcError = (message) => ({ data: null, error: { code: 'P0001', message, details: '', hint: '' } });

function findWalletRow(userId) {
  return DB.wallets.find((w) => w.user_id === userId);
}

function findCreditedTx(refType, refId) {
  return DB.wallet_transactions.find((t) => t.ref_type === refType && t.ref_id === refId && t.balance_after != null);
}

function mockRpc(name, params = {}) {
  if (name === 'credit_wallet') {
    const amt = Number(params.p_amount);
    if (!(amt > 0)) return rpcError('invalid amount');
    const wallet = findWalletRow(params.p_user_id);
    if (!wallet) return rpcError('wallet not found');
    if (params.p_ref_id) {
      const ex = findCreditedTx(params.p_ref_type, params.p_ref_id);
      if (ex) return { data: ex.balance_after, error: null };
    }
    const newBalance = Number(wallet.balance) + amt;
    wallet.balance = newBalance;
    if (params.p_type === 'deposit') wallet.total_deposited = Number(wallet.total_deposited) + amt;
    DB.wallet_transactions.push({
      id: newId(),
      user_id: params.p_user_id,
      amount: amt,
      type: params.p_type || 'deposit',
      balance_after: newBalance,
      description: params.p_description || '',
      ref_type: params.p_ref_type || null,
      ref_id: params.p_ref_id || null,
      created_at: now(),
    });
    return { data: newBalance, error: null };
  }
  if (name === 'debit_wallet') {
    const amt = Number(params.p_amount);
    if (!(amt > 0)) return rpcError('invalid amount');
    const wallet = findWalletRow(params.p_user_id);
    if (!wallet) return rpcError('wallet not found');
    if (params.p_ref_id) {
      const ex = findCreditedTx(params.p_ref_type, params.p_ref_id);
      if (ex) return { data: ex.balance_after, error: null };
    }
    if (Number(wallet.balance) < amt) return rpcError('insufficient balance');
    const newBalance = Number(wallet.balance) - amt;
    wallet.balance = newBalance;
    wallet.total_spent = Number(wallet.total_spent) + amt;
    DB.wallet_transactions.push({
      id: newId(),
      user_id: params.p_user_id,
      amount: -amt,
      type: 'purchase',
      balance_after: newBalance,
      description: params.p_description || '',
      ref_type: params.p_ref_type || null,
      ref_id: params.p_ref_id || null,
      created_at: now(),
    });
    return { data: newBalance, error: null };
  }
  if (name === 'adjust_wallet') {
    const amt = Number(params.p_amount);
    if (!amt) return rpcError('amount must not be zero');
    const wallet = findWalletRow(params.p_user_id);
    if (!wallet) return rpcError('wallet not found');
    const newBalance = Number(wallet.balance) + amt;
    if (newBalance < 0) return rpcError('insufficient balance');
    wallet.balance = newBalance;
    if (amt > 0) wallet.total_deposited = Number(wallet.total_deposited) + amt;
    else wallet.total_spent = Number(wallet.total_spent) + -amt;
    DB.wallet_transactions.push({
      id: newId(),
      user_id: params.p_user_id,
      amount: amt,
      type: amt > 0 ? 'adjust_credit' : 'adjust_debit',
      balance_after: newBalance,
      description: params.p_description || '',
      ref_type: 'wallet',
      ref_id: null,
      created_at: now(),
    });
    return { data: newBalance, error: null };
  }
  return rpcError(`rpc not implemented: ${name}`);
}

const mockCreateClient = () => ({
  from: (table) => new QueryBuilder(table),
  rpc: (name, params) => mockRpc(name, params),
  auth: {},
});

Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: mockCreateClient };
  }
  return originalLoad.apply(this, arguments);
};

module.exports = { __mockDB: DB };
