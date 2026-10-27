/**
 * native-extras.js
 *  ۱) ذخیره‌ی فایل‌های خروجی (Excel / PDF / Word / پشتیبان) روی گوشی اندروید + دکمه‌ی باز کردن/ارسال
 *  ۲) خروجی Word (.docx) — به‌صورت آفلاین و کنار دکمه‌های اکسل و PDF
 *  ۳) پشتیبان‌گیری، بازیابی و ورود از اکسل
 */
(function () {
    'use strict';

    var FOLDER = 'AnbarParsoon';
    var cap = window.Capacitor;
    var isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    var Filesystem = null, Share = null;
    if (isNative && cap.registerPlugin) {
        try { Filesystem = cap.registerPlugin('Filesystem'); } catch (e) { /* ignore */ }
        try { Share = cap.registerPlugin('Share'); } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------ ابزارهای عمومی
    function $(sel, root) { return (root || document).querySelector(sel); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function toast(msg, type) {
        var stack = $('#toastStack');
        if (!stack) { alert(msg); return; }
        var d = document.createElement('div');
        d.className = 'toast ' + (type || 'info');
        d.innerHTML = '<span>' + esc(msg) + '</span>';
        stack.appendChild(d);
        setTimeout(function () {
            d.style.opacity = '0'; d.style.transition = 'opacity .2s ease';
            setTimeout(function () { d.remove(); }, 220);
        }, 3600);
    }

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { var s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
            fr.onerror = function () { reject(fr.error); };
            fr.readAsDataURL(blob);
        });
    }

    function safeName(n) { return String(n).replace(/[\\/:*?"<>|]+/g, '-'); }

    function loadScript(src) {
        loadScript.cache = loadScript.cache || {};
        if (!loadScript.cache[src]) {
            loadScript.cache[src] = new Promise(function (res, rej) {
                var s = document.createElement('script');
                s.src = src; s.onload = function () { res(); };
                s.onerror = function () { delete loadScript.cache[src]; rej(new Error('بارگذاری کتابخانه ناموفق بود.')); };
                document.head.appendChild(s);
            });
        }
        return loadScript.cache[src];
    }

    // ------------------------------------------------------------ دیالوگ «ذخیره شد»
    function ensureModal(id, inner) {
        var old = document.getElementById(id);
        if (old) old.remove();
        var ov = document.createElement('div');
        ov.className = 'modal-overlay open';
        ov.id = id;
        ov.innerHTML = '<div class="modal" style="max-width:460px">' + inner + '</div>';
        ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
        return ov;
    }

    function showSavedDialog(info) {
        var ov = ensureModal('fileSavedOverlay',
            '<div class="modal-header"><h3>فایل آماده است</h3><button class="modal-close" type="button" data-x aria-label="بستن">✕</button></div>' +
            '<div class="modal-body"><p style="margin:0 0 8px;font-weight:700;word-break:break-all">' + esc(info.name) + '</p>' +
            '<p style="margin:0;color:var(--color-text-muted,#5b7185);font-size:13px;line-height:1.9">' +
            (info.savedPath ? 'ذخیره شد در پوشه‌ی: <b dir="ltr">' + esc(info.savedPath) + '</b><br>' : '') +
            'برای باز کردن با برنامه‌ی دیگر، یا فرستادن (واتساپ، ایمیل، ...) دکمه‌ی زیر را بزنید.</p></div>' +
            '<div class="modal-footer"><button class="btn btn-ghost" type="button" data-x>بستن</button>' +
            (info.shareUri ? '<button class="btn btn-primary" type="button" data-share>باز کردن / ارسال</button>' : '') + '</div>');
        ov.querySelectorAll('[data-x]').forEach(function (b) { b.addEventListener('click', function () { ov.remove(); }); });
        var sb = ov.querySelector('[data-share]');
        if (sb) sb.addEventListener('click', function () {
            Share.share({ title: info.name, url: info.shareUri, dialogTitle: 'باز کردن یا ارسال فایل' })
                .catch(function (e) { if (!e || !/cancel/i.test(String(e.message || e))) toast('ارسال فایل ممکن نشد.', 'error'); });
        });
    }

    /** ذخیره‌ی Blob: روی اندروید → پوشه‌ی Documents + منوی ارسال؛ روی مرورگر → دانلود عادی */
    async function saveBlob(blob, filename) {
        filename = safeName(filename);
        if (!isNative || !Filesystem) { return browserDownload(blob, filename); }
        var b64 = await blobToBase64(blob);
        var savedPath = null, shareUri = null;
        try {
            var r = await Filesystem.writeFile({ path: FOLDER + '/' + filename, data: b64, directory: 'DOCUMENTS', recursive: true });
            savedPath = 'Documents/' + FOLDER;
            shareUri = r && r.uri;
        } catch (e) {
            console.warn('Documents write failed, using cache', e);
        }
        if (!shareUri) {
            try {
                var c = await Filesystem.writeFile({ path: filename, data: b64, directory: 'CACHE', recursive: true });
                shareUri = c && c.uri;
            } catch (e2) {
                toast('ذخیره‌ی فایل ممکن نشد: ' + (e2 && e2.message ? e2.message : e2), 'error');
                return;
            }
        }
        showSavedDialog({ name: filename, savedPath: savedPath, shareUri: Share ? shareUri : null });
    }

    function browserDownload(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.setAttribute('data-offline-skip', '1');
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    // همه‌ی دانلودهای برنامه (اکسل/PDF که با <a download> ساخته می‌شوند) را روی اندروید به saveBlob هدایت کن
    if (isNative) {
        document.addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
            if (!a || a.getAttribute('data-offline-skip') || !/^blob:/.test(a.href)) return;
            e.preventDefault(); e.stopPropagation();
            var name = a.getAttribute('download') || 'file';
            fetch(a.href).then(function (r) { return r.blob(); }).then(function (b) { return saveBlob(b, name); })
                .catch(function (err) { toast('ذخیره‌ی فایل ناموفق بود: ' + (err && err.message || err), 'error'); });
        }, true);
    }

    // ------------------------------------------------------------ خروجی Word
    function currentFilterQuery() {
        var p = new URLSearchParams();
        var q = ($('#searchInput') || {}).value, cat = ($('#filterCategory') || {}).value, un = ($('#filterUnit') || {}).value;
        var mn = ($('#filterMinQty') || {}).value, mx = ($('#filterMaxQty') || {}).value;
        if (q && q.trim()) p.set('q', q.trim());
        if (cat) p.set('category', cat);
        if (un) p.set('unit', un);
        if (mn !== undefined && mn !== '') p.set('min_qty', mn);
        if (mx !== undefined && mx !== '') p.set('max_qty', mx);
        p.set('sort', 'category'); p.set('dir', 'asc');
        return { qs: p.toString(), category: cat || null };
    }

    async function buildDocx(items, category) {
        await loadScript('assets/js/vendor/docx.iife.js');
        var d = window.docx;
        var FONT = 'Tahoma';
        function run(text, o) {
            o = o || {};
            return new d.TextRun({ text: String(text == null ? '' : text), rightToLeft: true, font: FONT, size: o.size || 20, bold: !!o.bold, color: o.color });
        }
        function para(text, o) {
            o = o || {};
            return new d.Paragraph({ bidirectional: true, alignment: o.center ? d.AlignmentType.CENTER : d.AlignmentType.START,
                spacing: { after: o.after == null ? 80 : o.after }, children: [run(text, o)] });
        }
        function cell(text, o) {
            o = o || {};
            return new d.TableCell({
                width: o.w ? { size: o.w, type: d.WidthType.DXA } : undefined,
                shading: o.head ? { type: d.ShadingType.CLEAR, fill: 'E3EAF0', color: 'auto' } : undefined,
                margins: { top: 60, bottom: 60, left: 80, right: 80 },
                verticalAlign: d.VerticalAlign.CENTER,
                children: [new d.Paragraph({ bidirectional: true, alignment: o.center ? d.AlignmentType.CENTER : d.AlignmentType.START,
                    children: [run(text, { bold: o.head, size: o.head ? 19 : 18 })] })]
            });
        }
        var cols = [
            ['ردیف', 700, true], ['دسته‌بندی', 2300], ['نام کالا', 2600], ['برند / مشخصات', 2300],
            ['تعداد', 900, true], ['واحد', 900, true], ['توضیحات', 3300]
        ]; // مجموع ≈ ۱۳٬۰۰۰ (عرض A4 افقی)
        var now = new Date();
        var rows = [new d.TableRow({ tableHeader: true, children: cols.map(function (c) { return cell(c[0], { head: true, center: true, w: c[1] }); }) })];
        items.forEach(function (it, i) {
            rows.push(new d.TableRow({ cantSplit: true, children: [
                cell(String(i + 1).replace(/\d/g, function (x) { return '۰۱۲۳۴۵۶۷۸۹'[x]; }), { center: true, w: cols[0][1] }),
                cell(it.category, { w: cols[1][1] }),
                cell(it.name, { w: cols[2][1] }),
                cell(it.brand || '—', { w: cols[3][1] }),
                cell(Number(it.quantity).toLocaleString('fa-IR'), { center: true, w: cols[4][1] }),
                cell(it.unit, { center: true, w: cols[5][1] }),
                cell(it.notes || '—', { w: cols[6][1] })
            ] }));
        });
        var table = new d.Table({
            visuallyRightToLeft: true, width: { size: 13000, type: d.WidthType.DXA },
            columnWidths: cols.map(function (c) { return c[1]; }), rows: rows
        });
        var doc = new d.Document({
            creator: 'انبار پرسون بام بین‌الملل', title: 'گزارش موجودی انبار',
            styles: { default: { document: { run: { font: FONT, rightToLeft: true } } } },
            sections: [{
                properties: { page: { size: { orientation: d.PageOrientation.LANDSCAPE, width: 11906, height: 16838 }, margin: { top: 900, bottom: 900, left: 900, right: 900 } } },
                children: [
                    para('شرکت پرسون بام بین‌الملل', { bold: true, size: 34, color: '16324F', after: 40 }),
                    para('گزارش موجودی انبار — ' + (category ? 'دسته‌بندی: ' + category : 'همه‌ی دسته‌بندی‌ها'), { size: 22, color: '5B7185', after: 40 }),
                    para('تاریخ تهیه: ' + now.toLocaleDateString('fa-IR') + '   |   تعداد ردیف: ' + items.length.toLocaleString('fa-IR'), { size: 20, color: '5B7185', after: 200 }),
                    table,
                    para(' ', { after: 120 }),
                    para('این گزارش به‌صورت خودکار از سامانه مدیریت انبار پرسون بام بین‌الملل تهیه شده است.', { size: 16, color: '8A97A2' })
                ]
            }]
        });
        return d.Packer.toBlob(doc);
    }

    async function exportWord(btn) {
        btn.disabled = true;
        try {
            var f = currentFilterQuery();
            var res = await fetch('api/items.php?' + f.qs);
            var j = await res.json();
            if (!j.success) throw new Error(j.message || 'خطا در خواندن اطلاعات.');
            if (!j.data.length) { toast('داده‌ای برای خروجی گرفتن وجود ندارد.', 'error'); return; }
            toast('در حال ساخت فایل Word...', 'info');
            var blob = await buildDocx(j.data, f.category);
            var name = (f.category ? 'گزارش-انبار-' + f.category : 'گزارش-انبار-پرسون-بام-بین‌الملل') + '-' + new Date().toISOString().slice(0, 10) + '.docx';
            await saveBlob(blob, name);
            toast('فایل Word با موفقیت ساخته شد.', 'success');
        } catch (e) {
            toast('ساخت فایل Word ناموفق بود: ' + (e && e.message ? e.message : e), 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ------------------------------------------------------------ پشتیبان‌گیری / بازیابی / اکسل
    async function doBackup() {
        var data = await window.AnbarOffline.exportAll();
        var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        var d = new Date();
        var stamp = d.toISOString().slice(0, 10) + '_' + ('0' + d.getHours()).slice(-2) + '-' + ('0' + d.getMinutes()).slice(-2);
        await saveBlob(blob, 'پشتیبان-انبار-پرسون-' + stamp + '.json');
    }

    function pickFile(accept) {
        return new Promise(function (resolve) {
            var inp = document.createElement('input');
            inp.type = 'file'; inp.accept = accept || '*/*'; inp.style.display = 'none';
            inp.addEventListener('change', function () { resolve(inp.files && inp.files[0] || null); inp.remove(); });
            document.body.appendChild(inp);
            inp.click();
        });
    }

    function readText(file) {
        return new Promise(function (res, rej) {
            var fr = new FileReader(); fr.onload = function () { res(String(fr.result)); }; fr.onerror = function () { rej(fr.error); }; fr.readAsText(file);
        });
    }

    async function doRestore() {
        var f = await pickFile('.json,application/json');
        if (!f) return;
        if (!confirm('همه‌ی اطلاعات فعلی برنامه با محتوای این فایل پشتیبان جایگزین می‌شود. ادامه می‌دهید؟')) return;
        try {
            var obj = JSON.parse(await readText(f));
            var r = await window.AnbarOffline.importAll(obj);
            toast('بازیابی انجام شد: ' + r.items.toLocaleString('fa-IR') + ' کالا و ' + r.transactions.toLocaleString('fa-IR') + ' رکورد تاریخچه.', 'success');
            setTimeout(function () { location.reload(); }, 900);
        } catch (e) {
            toast(e && e.message ? e.message : 'فایل پشتیبان نامعتبر است.', 'error');
        }
    }

    function headerIndex(headers, names) {
        for (var i = 0; i < headers.length; i++) {
            var h = String(headers[i] || '').replace(/‌/g, '').replace(/\s+/g, ' ').trim();
            for (var k = 0; k < names.length; k++) if (h.indexOf(names[k]) === 0) return i;
        }
        return -1;
    }

    async function doImportExcel(mode) {
        var f = await pickFile('.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (!f) return;
        if (mode === 'replace' && !confirm('همه‌ی کالاهای فعلی پاک و با محتوای فایل اکسل جایگزین می‌شوند (تاریخچه حفظ می‌شود). ادامه می‌دهید؟')) return;
        try {
            await loadScript('assets/js/vendor/xlsx.full.min.js');
            var buf = await f.arrayBuffer();
            var wb = XLSX.read(buf, { type: 'array' });
            var aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
            var hr = -1;
            for (var i = 0; i < Math.min(aoa.length, 15); i++) {
                if (headerIndex(aoa[i], ['نام کالا']) >= 0 && headerIndex(aoa[i], ['دسته']) >= 0) { hr = i; break; }
            }
            if (hr < 0) throw new Error('ستون‌های «دسته‌بندی» و «نام کالا» در فایل پیدا نشد. از خروجی اکسل خود برنامه استفاده کنید.');
            var H = aoa[hr];
            var ci = { cat: headerIndex(H, ['دسته']), name: headerIndex(H, ['نام کالا']), brand: headerIndex(H, ['برند']),
                qty: headerIndex(H, ['تعداد']), unit: headerIndex(H, ['واحد']), notes: headerIndex(H, ['توضیحات']) };
            function clean(v) { v = String(v == null ? '' : v).trim(); return (v === '' || v === '-' || v === '—') ? null : v; }
            var faDigits = { '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
            var rows = [];
            for (var r = hr + 1; r < aoa.length; r++) {
                var row = aoa[r];
                var cat = clean(row[ci.cat]), name = clean(row[ci.name]);
                if (!cat || !name) continue;
                var q = ci.qty >= 0 ? String(row[ci.qty]).replace(/[۰-۹]/g, function (x) { return faDigits[x]; }).replace(/[,٬]/g, '') : '0';
                rows.push({ category: cat, name: name, brand: ci.brand >= 0 ? clean(row[ci.brand]) : null,
                    quantity: parseFloat(q) || 0, unit: (ci.unit >= 0 && clean(row[ci.unit])) || 'عدد', notes: ci.notes >= 0 ? clean(row[ci.notes]) : null });
            }
            if (!rows.length) throw new Error('هیچ ردیف معتبری در فایل پیدا نشد.');
            var res = await window.AnbarOffline.importItems(rows, mode);
            toast(res.added.toLocaleString('fa-IR') + ' کالا از اکسل وارد شد.', 'success');
            setTimeout(function () { location.reload(); }, 900);
        } catch (e) {
            toast(e && e.message ? e.message : 'ورود از اکسل ناموفق بود.', 'error');
        }
    }

    function showDataModal() {
        var c = window.AnbarOffline.counts();
        var ov = ensureModal('dataToolsOverlay',
            '<div class="modal-header"><h3>داده‌ها و پشتیبان‌گیری</h3><button class="modal-close" type="button" data-x aria-label="بستن">✕</button></div>' +
            '<div class="modal-body" style="display:grid;gap:10px">' +
            '<p style="margin:0;font-size:13px;line-height:1.9;color:var(--color-text-muted,#5b7185)">اطلاعات این برنامه فقط روی همین گوشی ذخیره می‌شود (' +
            c.items.toLocaleString('fa-IR') + ' کالا، ' + c.transactions.toLocaleString('fa-IR') + ' رکورد تاریخچه). ' +
            'پیشنهاد می‌شود هر چند وقت یک‌بار پشتیبان بگیرید؛ با حذف برنامه از گوشی، اطلاعات پاک می‌شود.</p>' +
            '<button class="btn btn-primary" type="button" data-act="backup">دریافت فایل پشتیبان (JSON)</button>' +
            '<button class="btn btn-outline" type="button" data-act="restore">بازیابی از فایل پشتیبان</button>' +
            '<hr style="border:none;border-top:1px solid var(--color-border,#dde3e8);margin:4px 0">' +
            '<button class="btn btn-outline" type="button" data-act="xl-add">ورود کالاها از اکسل (اضافه به لیست فعلی)</button>' +
            '<button class="btn btn-outline" type="button" data-act="xl-replace">ورود کالاها از اکسل (جایگزین لیست فعلی)</button>' +
            '</div><div class="modal-footer"><button class="btn btn-ghost" type="button" data-x>بستن</button></div>');
        ov.querySelectorAll('[data-x]').forEach(function (b) { b.addEventListener('click', function () { ov.remove(); }); });
        ov.querySelectorAll('[data-act]').forEach(function (b) {
            b.addEventListener('click', function () {
                var a = b.getAttribute('data-act');
                if (a === 'backup') { ov.remove(); doBackup().catch(function (e) { toast('پشتیبان‌گیری ناموفق بود: ' + (e && e.message || e), 'error'); }); }
                else if (a === 'restore') { ov.remove(); doRestore(); }
                else if (a === 'xl-add') { ov.remove(); doImportExcel('add'); }
                else if (a === 'xl-replace') { ov.remove(); doImportExcel('replace'); }
            });
        });
    }

    // ------------------------------------------------------------ نصب دکمه‌ها در صفحه‌ی اصلی
    function installUi() {
        var pdf = $('#exportPdfBtn');
        if (pdf && !$('#exportWordBtn')) {
            var w = document.createElement('button');
            w.type = 'button'; w.id = 'exportWordBtn'; w.className = pdf.className;
            w.innerHTML = pdf.innerHTML.replace(/خروجی PDF/, 'خروجی Word');
            pdf.parentNode.insertBefore(w, pdf.nextSibling);
            w.addEventListener('click', function () { exportWord(w); });
        }
        var logout = $('#logoutBtn');
        if (logout && !$('#dataToolsBtn')) {
            var b = document.createElement('button');
            b.type = 'button'; b.id = 'dataToolsBtn'; b.className = logout.className;
            b.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg> داده‌ها و پشتیبان‌گیری';
            logout.parentNode.insertBefore(b, logout);
            b.addEventListener('click', showDataModal);
        }
    }

    window.AnbarNative = { saveBlob: saveBlob, isNative: isNative, toast: toast };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUi); else installUi();
})();
