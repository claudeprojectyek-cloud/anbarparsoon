/**
 * offline-api.js
 * جایگزین کامل بخش سرور (api/*.php + MySQL) — همه‌ی درخواست‌های fetch به
 * "api/xxx.php" داخل خود گوشی و روی IndexedDB پاسخ داده می‌شود؛ هیچ اینترنتی لازم نیست.
 * پاسخ‌ها دقیقاً همان قالب JSON سرور قبلی را دارند تا بقیه‌ی برنامه بدون تغییر کار کند.
 */
(function () {
    'use strict';

    var APP_PASSWORD_HASH = '$2b$10$sxaAf7CNRT9zpKJk8mWy1uVO1Ba7aQXUr33xBBiEUNHmQFTFTQVmW';
    var LOW_STOCK_THRESHOLD = 2;
    var LOGIN_MAX_ATTEMPTS = 5, LOGIN_LOCKOUT_SECONDS = 300;
    var RECOVERY_MAX_ATTEMPTS = 5, RECOVERY_LOCKOUT_SECONDS = 300;
    var AUTH_KEY = 'anbar_auth_ok';
    var DB_NAME = 'anbar-parsoon-offline', DB_VERSION = 1;

    var FIXED_PROFILES = [
        { id: 1, display_name: 'آقای سوری' },
        { id: 2, display_name: 'خانم اصفهانیان' },
        { id: 3, display_name: 'آقای راد' }
    ];

    // ---------------------------------------------------------------- state
    var db = null;
    var S = { items: [], txs: [], kv: {} };
    var nextItemId = 1, nextTxId = 1;

    function openDb() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var d = req.result;
                if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('txs')) d.createObjectStore('txs', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function getAll(store) {
        return new Promise(function (resolve, reject) {
            var r = db.transaction(store, 'readonly').objectStore(store).getAll();
            r.onsuccess = function () { resolve(r.result || []); };
            r.onerror = function () { reject(r.error); };
        });
    }

    /** ops: [{store, put|del}] — همه در یک تراکنش IndexedDB (اتمیک) */
    function flush(ops) {
        if (!ops.length) return Promise.resolve();
        return new Promise(function (resolve, reject) {
            var stores = {};
            ops.forEach(function (o) { stores[o.store] = 1; });
            var tx = db.transaction(Object.keys(stores), 'readwrite');
            ops.forEach(function (o) {
                var st = tx.objectStore(o.store);
                if (o.del !== undefined) st.delete(o.del); else if (o.clear) st.clear(); else st.put(o.put);
            });
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('abort')); };
        });
    }

    function kvSet(ops, key, value) {
        S.kv[key] = value;
        ops.push({ store: 'kv', put: { key: key, value: value } });
    }

    function randomHex(bytes) {
        var a = new Uint8Array(bytes);
        (window.crypto || window.msCrypto).getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function nowStr(d) {
        d = d || new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function recomputeIds() {
        nextItemId = S.items.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
        nextTxId = S.txs.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
    }

    var readyPromise = (async function init() {
        db = await openDb();
        S.items = await getAll('items');
        S.txs = await getAll('txs');
        (await getAll('kv')).forEach(function (r) { S.kv[r.key] = r.value; });
        var ops = [];
        if (!S.kv.profiles) {
            kvSet(ops, 'profiles', FIXED_PROFILES.map(function (p) {
                return { id: p.id, display_name: p.display_name, recovery_password_hash: null, email: null, claimed_at: null };
            }));
        }
        if (!S.kv.links) kvSet(ops, 'links', []);
        if (!S.kv.device_token) kvSet(ops, 'device_token', randomHex(32));
        if (typeof S.kv.data_version !== 'number') kvSet(ops, 'data_version', 0);
        if (!S.kv.seeded) {
            var seed = window.ANBAR_SEED || [];
            var ts = nowStr();
            seed.forEach(function (r) {
                var it = { id: nextItemId++, category: r.category, name: r.name, brand: r.brand || null,
                    quantity: Number(r.quantity) || 0, unit: r.unit || 'عدد', notes: r.notes || null,
                    created_at: ts, updated_at: ts };
                S.items.push(it);
                ops.push({ store: 'items', put: it });
            });
            kvSet(ops, 'seeded', true);
        }
        recomputeIds();
        await flush(ops);
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    })();

    // ---------------------------------------------------------------- helpers
    function ok(status, data, message, headers) { return { status: status, success: true, data: data, message: message, headers: headers }; }
    function fail(status, message, data) { return { status: status, success: false, data: data, message: message }; }

    function normalizeFa(v) {
        v = String(v == null ? '' : v).replace(/‌/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
        var fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
        v = v.replace(/[۰-۹]/g, function (c) { return fa.indexOf(c); }).replace(/[٠-٩]/g, function (c) { return ar.indexOf(c); });
        return v.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function sanitize(v) {
        if (v === null || v === undefined) return null;
        v = String(v).trim();
        return v === '' ? null : v;
    }

    var collator = (function () { try { return new Intl.Collator('fa'); } catch (e) { return null; } })();
    function cmpText(a, b) {
        a = a == null ? '' : String(a); b = b == null ? '' : String(b);
        return collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);
    }

    function isAuthed() { try { return localStorage.getItem(AUTH_KEY) === '1'; } catch (e) { return false; } }

    function bumpVersion(ops) { kvSet(ops, 'data_version', (S.kv.data_version || 0) + 1); }

    function logTx(ops, itemId, name, category, type, change, recipient, note, by) {
        var t = { id: nextTxId++, item_id: itemId, item_name: name, item_category: category, type: type,
            quantity_change: Number(change) || 0, recipient: sanitize(recipient), note: sanitize(note),
            performed_by: sanitize(by), created_at: nowStr() };
        S.txs.push(t);
        ops.push({ store: 'txs', put: t });
    }

    function linkedProfile() {
        var token = S.kv.device_token;
        var link = (S.kv.links || []).filter(function (l) { return l.device_token === token; })[0];
        if (!link) return null;
        var p = S.kv.profiles.filter(function (x) { return x.id === link.profile_id; })[0];
        return p ? { id: p.id, display_name: p.display_name } : null;
    }

    function requireProfile() {
        var p = linkedProfile();
        if (!p) return { err: fail(403, 'شما فقط بازدیدکننده‌اید و امکان ثبت تغییر ندارید.', { visitor: true }) };
        return { profile: p };
    }

    function categoriesData() {
        var map = {};
        S.items.forEach(function (it) {
            var c = map[it.category] || (map[it.category] = { category: it.category, item_count: 0, total_quantity: 0 });
            c.item_count++; c.total_quantity += Number(it.quantity);
        });
        return Object.keys(map).map(function (k) { return map[k]; })
            .sort(function (a, b) { return cmpText(a.category, b.category); });
    }

    function statsData(threshold) {
        var cats = categoriesData();
        var low = S.items.filter(function (it) { return Number(it.quantity) <= threshold; })
            .sort(function (a, b) { return (a.quantity - b.quantity) || cmpText(a.name, b.name); })
            .map(function (it) { return { id: it.id, category: it.category, name: it.name, brand: it.brand, quantity: it.quantity, unit: it.unit }; });
        return {
            total_items: S.items.length,
            total_categories: cats.length,
            total_quantity: S.items.reduce(function (s, it) { return s + Number(it.quantity); }, 0),
            low_stock_threshold: threshold,
            low_stock_count: low.length,
            low_stock_items: low,
            by_category: cats.slice().sort(function (a, b) { return b.total_quantity - a.total_quantity; })
        };
    }

    function profileStatus() {
        var profs = S.kv.profiles;
        return {
            linked: linkedProfile() !== null,
            profile: linkedProfile(),
            unclaimed: profs.filter(function (p) { return !p.recovery_password_hash; })
                .map(function (p) { return { id: p.id, display_name: p.display_name }; }),
            all_profiles: profs.map(function (p) {
                return { id: p.id, display_name: p.display_name, email: p.email, claimed_at: p.claimed_at,
                    is_claimed: p.recovery_password_hash ? 1 : 0 };
            })
        };
    }

    function validateItem(b) {
        var category = sanitize(b.category), name = sanitize(b.name), brand = sanitize(b.brand);
        var unit = sanitize(b.unit) || 'عدد', notes = sanitize(b.notes), q = b.quantity;
        var errors = [];
        if (category === null) errors.push('دسته‌بندی نباید خالی باشد.');
        if (name === null) errors.push('نام کالا نباید خالی باشد.');
        if (q === null || q === undefined || q === '' || isNaN(Number(q)) || Number(q) < 0) errors.push('تعداد باید یک عدد مثبت (یا صفر) باشد.');
        if (errors.length) return { err: fail(400, errors.join(' ')) };
        return { data: { category: category, name: name, brand: brand, quantity: Number(q), unit: unit, notes: notes } };
    }

    function bcryptLib() { return window.dcodeIO && window.dcodeIO.bcrypt ? window.dcodeIO.bcrypt : window.bcrypt; }
    function bcryptCompare(pw, hash) {
        return new Promise(function (res) { bcryptLib().compare(pw, hash, function (e, r) { res(!e && r); }); });
    }
    function bcryptHash(pw) {
        return new Promise(function (res, rej) { bcryptLib().hash(pw, 10, function (e, h) { e ? rej(e) : res(h); }); });
    }

    // ---------------------------------------------------------------- endpoints
    var H = {};

    H.auth = async function (method, q, body) {
        if (method === 'GET') return ok(200, { authenticated: isAuthed() });
        var action = (body && body.action) || 'login';
        if (action === 'logout') {
            try { localStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
            return ok(200, null, 'با موفقیت خارج شدید.');
        }
        if (action !== 'login') return fail(400, 'عملیات نامعتبر است.');
        var att = S.kv.login_attempts || { attempts: 0, locked_until: 0 };
        if (att.locked_until && att.locked_until > Date.now()) {
            return fail(429, 'به دلیل تلاش‌های ناموفق زیاد، ورود موقتاً قفل شده است. لطفاً چند دقیقه دیگر دوباره تلاش کنید.',
                { seconds_left: Math.ceil((att.locked_until - Date.now()) / 1000) });
        }
        var pw = String((body && body.password) || '');
        var good = pw !== '' && await bcryptCompare(pw, APP_PASSWORD_HASH);
        var ops = [];
        if (!good) {
            var n = (att.attempts || 0) + 1;
            kvSet(ops, 'login_attempts', { attempts: n, locked_until: n >= LOGIN_MAX_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_SECONDS * 1000 : 0 });
            await flush(ops);
            return fail(401, 'رمز عبور نادرست است.');
        }
        kvSet(ops, 'login_attempts', { attempts: 0, locked_until: 0 });
        await flush(ops);
        try { localStorage.setItem(AUTH_KEY, '1'); } catch (e) { /* ignore */ }
        return ok(200, null, 'ورود با موفقیت انجام شد.');
    };

    H.items = async function (method, q, body) {
        var ops = [];
        if (method === 'GET') {
            var hdr = { 'X-Data-Version': String(S.kv.data_version || 0) };
            if (q.id !== undefined) {
                var one = S.items.filter(function (i) { return i.id === Number(q.id); })[0];
                return one ? ok(200, one, null, hdr) : fail(404, 'کالای مورد نظر یافت نشد.');
            }
            var list = S.items.slice();
            if (q.q) {
                var needle = normalizeFa(q.q);
                list = list.filter(function (it) {
                    return [it.name, it.brand, it.category, it.notes].some(function (f) { return normalizeFa(f).indexOf(needle) !== -1; });
                });
            }
            if (q.category) list = list.filter(function (it) { return it.category === q.category; });
            if (q.unit) list = list.filter(function (it) { return it.unit === q.unit; });
            if (q.min_qty !== undefined && q.min_qty !== '') list = list.filter(function (it) { return it.quantity >= Number(q.min_qty); });
            if (q.max_qty !== undefined && q.max_qty !== '') list = list.filter(function (it) { return it.quantity <= Number(q.max_qty); });
            var sort = ['id', 'name', 'quantity', 'category', 'updated_at'].indexOf(q.sort) >= 0 ? q.sort : 'id';
            var dir = String(q.dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
            list.sort(function (a, b) {
                var r;
                if (sort === 'name' || sort === 'category') r = cmpText(a[sort], b[sort]);
                else if (sort === 'updated_at') r = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
                else r = a[sort] - b[sort];
                return (r || (a.id - b.id)) * dir;
            });
            return ok(200, list, null, hdr);
        }

        if (method === 'POST' || method === 'PUT') {
            var v = validateItem(body || {});
            if (v.err) return v.err;
            var pr = requireProfile();
            if (pr.err) return pr.err;
            var ts = nowStr();
            if (method === 'POST') {
                var it = Object.assign({ id: nextItemId++, created_at: ts, updated_at: ts }, v.data);
                S.items.push(it);
                ops.push({ store: 'items', put: it });
                logTx(ops, it.id, it.name, it.category, 'created', it.quantity, null, 'کالای جدید افزوده شد.', pr.profile.display_name);
                bumpVersion(ops);
                await flush(ops);
                return ok(201, it, 'کالا با موفقیت اضافه شد.');
            }
            var id = Number(q.id);
            if (!id) return fail(400, 'شناسه‌ی کالا نامعتبر است.');
            var ex = S.items.filter(function (i) { return i.id === id; })[0];
            if (!ex) return fail(404, 'کالای مورد نظر یافت نشد.');
            var change = v.data.quantity - Number(ex.quantity);
            Object.assign(ex, v.data, { updated_at: ts });
            ops.push({ store: 'items', put: ex });
            logTx(ops, id, ex.name, ex.category, 'edited', change, null, 'اطلاعات کالا ویرایش شد.', pr.profile.display_name);
            bumpVersion(ops);
            await flush(ops);
            return ok(200, ex, 'کالا با موفقیت ویرایش شد.');
        }

        if (method === 'DELETE') {
            var did = Number(q.id);
            if (!did) return fail(400, 'شناسه‌ی کالا نامعتبر است.');
            var dex = S.items.filter(function (i) { return i.id === did; })[0];
            if (!dex) return fail(404, 'کالای مورد نظر یافت نشد یا قبلاً حذف شده است.');
            var dp = requireProfile();
            if (dp.err) return dp.err;
            S.items = S.items.filter(function (i) { return i.id !== did; });
            ops.push({ store: 'items', del: did });
            // مثل ON DELETE SET NULL: تاریخچه می‌ماند ولی item_id خالی می‌شود
            S.txs.forEach(function (t) { if (t.item_id === did) { t.item_id = null; ops.push({ store: 'txs', put: t }); } });
            logTx(ops, null, dex.name, dex.category, 'deleted', -Number(dex.quantity), null, 'کالا حذف شد.', dp.profile.display_name);
            bumpVersion(ops);
            await flush(ops);
            return ok(200, null, 'کالا با موفقیت حذف شد.');
        }
        return fail(405, 'متد درخواست مجاز نیست.');
    };

    H.transactions = async function (method, q, body) {
        if (method === 'GET') {
            var list = S.txs.slice();
            if (q.item_id) list = list.filter(function (t) { return t.item_id === Number(q.item_id); });
            if (q.category) list = list.filter(function (t) { return t.item_category === q.category; });
            if (q.type && ['in', 'out', 'created', 'edited', 'deleted'].indexOf(q.type) >= 0) list = list.filter(function (t) { return t.type === q.type; });
            if (q.date_from) list = list.filter(function (t) { return t.created_at >= q.date_from + ' 00:00:00'; });
            if (q.date_to) list = list.filter(function (t) { return t.created_at <= q.date_to + ' 23:59:59'; });
            list.sort(function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id; });
            var page = Math.max(1, parseInt(q.page, 10) || 1);
            var per = parseInt(q.per_page, 10) || 25;
            per = per > 0 && per <= 100 ? per : 25;
            var total = list.length;
            return ok(200, {
                items: list.slice((page - 1) * per, page * per),
                pagination: { page: page, per_page: per, total: total, total_pages: Math.ceil(total / per) }
            });
        }
        if (method !== 'POST') return fail(405, 'متد درخواست مجاز نیست.');
        body = body || {};
        var itemId = parseInt(body.item_id, 10), type = body.type, qty = body.quantity;
        var errors = [];
        if (!itemId) errors.push('کالا مشخص نشده است.');
        if (type !== 'in' && type !== 'out') errors.push('نوع تراکنش باید ورود یا خروج باشد.');
        if (qty === null || qty === undefined || qty === '' || isNaN(Number(qty)) || Number(qty) <= 0) errors.push('تعداد باید عددی مثبت باشد.');
        if (errors.length) return fail(400, errors.join(' '));
        qty = Number(qty);
        var pr = requireProfile();
        if (pr.err) return pr.err;
        var item = S.items.filter(function (i) { return i.id === itemId; })[0];
        if (!item) return fail(404, 'کالای مورد نظر یافت نشد.');
        var delta = type === 'in' ? qty : -qty;
        var nq = Math.round((Number(item.quantity) + delta) * 100) / 100;
        if (nq < 0) return fail(400, 'موجودی کافی نیست. موجودی فعلی ' + item.quantity + ' است و نمی‌توان ' + qty + ' واحد خروج ثبت کرد.');
        var ops = [];
        item.quantity = nq; item.updated_at = nowStr();
        ops.push({ store: 'items', put: item });
        logTx(ops, itemId, item.name, item.category, type, delta, body.recipient, body.note, pr.profile.display_name);
        bumpVersion(ops);
        await flush(ops);
        return ok(201, item, type === 'in' ? 'ورود کالا با موفقیت ثبت شد.' : 'خروج کالا با موفقیت ثبت شد.');
    };

    H.categories = async function () { return ok(200, categoriesData()); };

    H.stats = async function (method, q) {
        var th = q.threshold !== undefined && q.threshold !== '' && !isNaN(Number(q.threshold)) ? Number(q.threshold) : LOW_STOCK_THRESHOLD;
        return ok(200, statsData(th));
    };

    H.bootstrap = async function (method, q) {
        var th = q.threshold !== undefined && q.threshold !== '' && !isNaN(Number(q.threshold)) ? Number(q.threshold) : LOW_STOCK_THRESHOLD;
        return ok(200, { profile: profileStatus(), stats: statsData(th), categories: categoriesData() });
    };

    H.profile = async function (method, q, body) {
        if (method === 'GET') return ok(200, profileStatus());
        body = body || {};
        var profs = S.kv.profiles, ops = [];
        var pid = parseInt(body.profile_id, 10);
        var prof = profs.filter(function (p) { return p.id === pid; })[0];

        function link() {
            var links = (S.kv.links || []).filter(function (l) { return l.device_token !== S.kv.device_token; });
            links.push({ profile_id: pid, device_token: S.kv.device_token });
            kvSet(ops, 'links', links);
        }

        if (body.action === 'claim') {
            if (!pid) return fail(400, 'پروفایل مشخص نشده است.');
            if (!prof) return fail(404, 'پروفایل مورد نظر یافت نشد.');
            if (prof.recovery_password_hash) return fail(409, 'این پروفایل قبلاً توسط شخص دیگری انتخاب شده است.');
            var pw = String(body.password || ''), conf = String(body.password_confirm || ''), email = sanitize(body.email);
            var errs = [];
            if (pw.length < 8) errs.push('رمز بازیابی باید حداقل ۸ کاراکتر باشد.');
            if (pw !== conf) errs.push('تکرار رمز با رمز وارد‌شده یکسان نیست.');
            if (email === null) errs.push('ایمیل نباید خالی باشد.');
            else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push('ایمیل وارد شده معتبر نیست.');
            if (errs.length) return fail(400, errs.join(' '));
            prof.recovery_password_hash = await bcryptHash(pw);
            prof.email = email;
            prof.claimed_at = nowStr();
            kvSet(ops, 'profiles', profs);
            link();
            await flush(ops);
            return ok(200, { linked: true, profile: { id: pid, display_name: prof.display_name } }, 'پروفایل با موفقیت انتخاب شد.');
        }

        if (body.action === 'recover') {
            if (!pid) return fail(400, 'پروفایل مشخص نشده است.');
            if (!prof) return fail(404, 'پروفایل مورد نظر یافت نشد.');
            var rec = (S.kv.recovery_attempts || {})[pid] || { attempts: 0, locked_until: 0 };
            if (rec.locked_until && rec.locked_until > Date.now()) {
                return fail(429, 'به دلیل تلاش‌های ناموفق زیاد، بازیابی این پروفایل موقتاً قفل شده است. لطفاً چند دقیقه دیگر دوباره تلاش کنید.',
                    { seconds_left: Math.ceil((rec.locked_until - Date.now()) / 1000) });
            }
            var rpw = String(body.password || '');
            var good = prof.recovery_password_hash && rpw !== '' && await bcryptCompare(rpw, prof.recovery_password_hash);
            var all = Object.assign({}, S.kv.recovery_attempts || {});
            if (!good) {
                var n = rec.attempts + 1;
                all[pid] = { attempts: n, locked_until: n >= RECOVERY_MAX_ATTEMPTS ? Date.now() + RECOVERY_LOCKOUT_SECONDS * 1000 : 0 };
                kvSet(ops, 'recovery_attempts', all);
                await flush(ops);
                return fail(401, 'رمز بازیابی نادرست است.');
            }
            delete all[pid];
            kvSet(ops, 'recovery_attempts', all);
            link();
            await flush(ops);
            return ok(200, { linked: true, profile: { id: pid, display_name: prof.display_name } }, 'این دستگاه با موفقیت به پروفایل شما وصل شد.');
        }

        if (body.action === 'unlink') {
            kvSet(ops, 'links', (S.kv.links || []).filter(function (l) { return l.device_token !== S.kv.device_token; }));
            await flush(ops);
            return ok(200, { linked: false }, 'این دستگاه از پروفایل جدا شد.');
        }
        return fail(400, 'عملیات نامعتبر است.');
    };

    // کش سراسری خروجی (روی سرور بود) در نسخه‌ی آفلاین لازم نیست: همیشه فایل روی همان گوشی ساخته می‌شود
    H['export-cache'] = async function (method) {
        if (method === 'GET') return fail(404, 'کش سراسری در نسخه‌ی آفلاین استفاده نمی‌شود.');
        return ok(200, null, 'نادیده گرفته شد.');
    };

    // ---------------------------------------------------------------- fetch shim
    var realFetch = window.fetch ? window.fetch.bind(window) : null;
    var ROUTE = /(?:^|\/)api\/([a-z-]+)\.php(?:\?(.*))?$/;

    function parseQuery(qs) {
        var out = {};
        if (!qs) return out;
        qs.split('&').forEach(function (kv) {
            if (!kv) return;
            var i = kv.indexOf('=');
            var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
            var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
            out[k] = v;
        });
        return out;
    }

    async function dispatch(name, method, query, body) {
        await readyPromise;
        var h = H[name];
        if (!h) return fail(404, 'یافت نشد.');
        if (name !== 'auth' && !isAuthed()) return fail(401, 'ورود شما منقضی شده یا نامعتبر است. لطفاً دوباره وارد شوید.');
        try {
            return await h(method, query, body);
        } catch (e) {
            console.error('offline-api error', name, e);
            return fail(500, 'خطای داخلی برنامه: ' + (e && e.message ? e.message : e));
        }
    }

    function toResponse(r) {
        var payload = { success: r.success };
        if (r.message != null) payload.message = r.message;
        if (r.data !== null && r.data !== undefined) payload.data = r.data;
        var headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, r.headers || {});
        return new Response(JSON.stringify(payload), { status: r.status, headers: headers });
    }

    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var m = ROUTE.exec(url);
        if (!m) return realFetch ? realFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var body = null;
        if (init && init.body && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch (e) { body = null; } }
        return dispatch(m[1], method, parseQuery(m[2]), body).then(toResponse);
    };

    // خروج از سامانه با sendBeacon انجام می‌شد
    var realBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
    navigator.sendBeacon = function (url, data) {
        var m = ROUTE.exec(String(url));
        if (!m) return realBeacon ? realBeacon(url, data) : false;
        var go = function (txt) {
            var b = null; try { b = JSON.parse(txt); } catch (e) { /* ignore */ }
            dispatch(m[1], 'POST', {}, b);
        };
        if (data && typeof data.text === 'function') data.text().then(go); else go(String(data || ''));
        return true;
    };

    // ---------------------------------------------------------------- public API (پشتیبان‌گیری / بازیابی / ورود از اکسل)
    window.AnbarOffline = {
        ready: readyPromise,
        isAuthed: isAuthed,
        version: '3.0.0',

        exportAll: async function () {
            await readyPromise;
            return {
                app: 'anbar-parsoon', format: 1, exported_at: nowStr(),
                items: S.items, transactions: S.txs,
                profiles: S.kv.profiles, links: S.kv.links, data_version: S.kv.data_version
            };
        },

        /** بازیابی کامل از فایل پشتیبان (همه‌ی داده‌های فعلی جایگزین می‌شود) */
        importAll: async function (obj) {
            await readyPromise;
            if (!obj || obj.app !== 'anbar-parsoon' || !Array.isArray(obj.items) || !Array.isArray(obj.transactions)) {
                throw new Error('این فایل، پشتیبان معتبر انبار پرسون نیست.');
            }
            var ops = [{ store: 'items', clear: true }, { store: 'txs', clear: true }];
            S.items = obj.items; S.txs = obj.transactions;
            S.items.forEach(function (x) { ops.push({ store: 'items', put: x }); });
            S.txs.forEach(function (x) { ops.push({ store: 'txs', put: x }); });
            if (Array.isArray(obj.profiles) && obj.profiles.length) kvSet(ops, 'profiles', obj.profiles);
            if (Array.isArray(obj.links)) {
                // دستگاه فعلی هویت خودش را (device_token) نگه می‌دارد؛ اتصال پروفایل‌ها طبق فایل پشتیبان بازسازی می‌شود
                var tok = S.kv.device_token;
                var old = obj.links[0];
                kvSet(ops, 'links', old ? [{ profile_id: old.profile_id, device_token: tok }] : []);
            }
            kvSet(ops, 'data_version', (S.kv.data_version || 0) + 1);
            kvSet(ops, 'seeded', true);
            recomputeIds();
            await flush(ops);
            return { items: S.items.length, transactions: S.txs.length };
        },

        /**
         * ورود از اکسل (ستون‌ها مثل خروجی اکسل برنامه): دسته‌بندی، نام کالا، برند، تعداد، واحد، توضیحات
         * mode: 'replace' = همه‌ی کالاهای فعلی پاک و جایگزین شود | 'add' = به کالاهای فعلی اضافه شود
         */
        importItems: async function (rows, mode) {
            await readyPromise;
            var pr = requireProfile();
            if (pr.err) throw new Error(pr.err.message);
            var ops = [], ts = nowStr(), added = 0;
            if (mode === 'replace') {
                S.items = [];
                ops.push({ store: 'items', clear: true });
            }
            rows.forEach(function (r) {
                var it = { id: nextItemId++, category: r.category, name: r.name, brand: r.brand || null,
                    quantity: Number(r.quantity) || 0, unit: r.unit || 'عدد', notes: r.notes || null,
                    created_at: ts, updated_at: ts };
                S.items.push(it); ops.push({ store: 'items', put: it }); added++;
                logTx(ops, it.id, it.name, it.category, 'created', it.quantity, null,
                    mode === 'replace' ? 'ورود از فایل اکسل (جایگزینی)' : 'ورود از فایل اکسل', pr.profile.display_name);
            });
            bumpVersion(ops);
            await flush(ops);
            return { added: added };
        },

        /** حذف همه‌ی کالاها و تاریخچه (برای شروع از صفر) */
        wipeAll: async function () {
            await readyPromise;
            var ops = [{ store: 'items', clear: true }, { store: 'txs', clear: true }];
            S.items = []; S.txs = [];
            kvSet(ops, 'seeded', true);
            bumpVersion(ops);
            recomputeIds();
            await flush(ops);
        },

        counts: function () { return { items: S.items.length, transactions: S.txs.length }; }
    };
})();
