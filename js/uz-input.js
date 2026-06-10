/**
 * uz-input.js — 売上・コスト入力フォーム（正本・全項目並列＋積層スタッキング・単一系統）
 * ==================================================================
 * 02_画面仕様.md §5-10。入力フォームの唯一の正本エンジン。
 * スマホモーダル・iPad月次管理(history)右カラムの全面で .uzf-host に描画する。
 *
 * 設計（§5-10 / §5-9）：
 *   ・発生日／区分・科目／金額の全項目を最初から並べる（選択しなくてもラインナップ）。
 *   ・選択しても高さは変わらない（要素の出現/消滅で積み上がらない・インクリメンタル更新）。
 *   ・スクロールで各項目を確認・入力でき、確定見出し（ヘッダー）は上部に到達すると
 *     固定され積み下がる（sticky スタッキング）。テンキー入力中も上部に確定項目が見える。
 *   ・発生日は常時編集可能（カレンダーが常設のため「変更」が常に効く）。
 *   ・OSキーボード/OSカレンダーを一切呼ばない。配色はモノトーン濃淡（uz-input.css）。
 *
 * 依存（全てグローバル）：getServiceMaster / getDivisionItems / getCostMaster /
 *   loadCostMasterFromGAS / calcTax / callGAS / todayStr / formatYen / showToast。
 *
 * 公開：UzInput.mount(hostEl, kind, { onSubmitted, autoClose }) / UzInput.openModal(kind, opts)
 */
'use strict';

(function () {
  const ESC = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtAmt = v => {
    const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
    return '¥' + (isNaN(n) ? 0 : n).toLocaleString('ja-JP');
  };
  const fmtDate = s => (s ? String(s).replace(/-/g, '/') : '');
  const today = () => (typeof todayStr === 'function') ? todayStr() : new Date().toISOString().slice(0, 10);
  const isMisc = code => /MISC/i.test(String(code || ''));
  const divLabel = code => (code === '1' ? '仕入原価' : '販管費');

  function newState(kind) {
    const base = {
      kind, date: today(), taxRate: null, miscName: '',
      amount: '', memo: '', unpaid: false, calView: null, opts: {},
    };
    if (kind === 'sales') Object.assign(base, { svcCode: '', svcName: '' });
    else Object.assign(base, { divCode: '2', itemCode: '', itemName: '' });
    return base;
  }
  function itemResolved(s) {
    if (s.editId) return s.kind === 'sales' ? !!(s.svcCode || s.svcName) : !!(s.itemCode || s.itemName);
    return s.kind === 'sales' ? !!s.svcCode : !!s.itemCode;
  }
  function getItems(s) {
    try {
      if (s.kind === 'sales') return (typeof getServiceMaster === 'function') ? getServiceMaster() : [];
      return (typeof getDivisionItems === 'function') ? getDivisionItems(s.divCode, { filterBySmartphoneVisible: true }) : [];
    } catch (_) { return []; }
  }

  /* ── 値（見出し用） ───────────────────────────────────── */
  function itemHeadValue(s) {
    let label;
    if (s.kind === 'sales') label = s.svcName ? s.svcName + (s.miscName ? `（${s.miscName}）` : '') : '';
    else label = s.itemName ? `${divLabel(s.divCode)}／${s.itemName}` + (s.miscName ? `（${s.miscName}）` : '') : '';
    return label || '未選択';
  }
  function itemTaxLabel(s) {
    return (s.taxRate == null) ? '' : (s.taxRate === 0 ? '非課税' : s.taxRate + '%');
  }
  function amountHeadValue(s) {
    return (s.amount && parseInt(s.amount, 10) > 0) ? fmtAmt(s.amount) : '¥0';
  }
  function amountTaxLabel(s) {
    const tax = (s.taxRate != null && s.amount && typeof calcTax === 'function')
      ? calcTax(parseInt(s.amount, 10), s.taxRate).tax : 0;
    return `内消費税 ${tax.toLocaleString('ja-JP')} 円`;
  }
  function colsCls(s) {
    return (s.kind === 'cost' && s.divCode === '2') ? 'uzf-cards--3' : 'uzf-cards--2';
  }

  /* ── 部分HTML ─────────────────────────────────────────── */
  function cardsHTML(s) {
    const items = getItems(s);
    const sel = s.kind === 'sales' ? s.svcCode : s.itemCode;
    return items.map(it => `
      <button type="button" class="uzf-card ${it.code === sel ? 'is-active' : ''}" data-code="${ESC(it.code)}" data-name="${ESC(it.name)}" data-tax="${it.taxRate ?? 10}">
        ${ESC(it.name)}
      </button>`).join('') || '<div class="uzf-cards-empty">科目がありません</div>';
  }
  function taxchipsHTML(s) {
    return [10, 8, 0].map(r =>
      `<button type="button" class="uzf-taxchip ${s.taxRate === r ? 'is-active' : ''}" data-rate="${r}">${r === 0 ? '非課税' : r + '%'}</button>`).join('');
  }
  function keypadHTML() {
    const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', 'del'];
    return keys.map(k => k === 'del'
      ? `<button type="button" class="uzf-key uzf-key--del" data-key="del">←</button>`
      : `<button type="button" class="uzf-key" data-key="${k}">${k}</button>`).join('');
  }
  function calInnerHTML(s) {
    const base = s.calView || (s.date ? new Date(s.date) : new Date());
    s.calView = base;
    const y = base.getFullYear(), m = base.getMonth();
    const startDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const sel = s.date ? new Date(s.date) : null;
    const dows = ['日', '月', '火', '水', '木', '金', '土'];
    let cells = dows.map(d => `<div class="uzf-cal-dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) cells += `<div class="uzf-cal-cell uzf-cal-empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const isSel = sel && sel.getFullYear() === y && sel.getMonth() === m && sel.getDate() === d;
      cells += `<button type="button" class="uzf-cal-cell ${isSel ? 'is-sel' : ''}" data-day="${d}">${d}</button>`;
    }
    return `<div class="uzf-cal-bar">
        <button type="button" class="uzf-cal-nav" data-nav="-1">‹</button>
        <span class="uzf-cal-title">${y}年${m + 1}月</span>
        <button type="button" class="uzf-cal-nav" data-nav="1">›</button>
      </div><div class="uzf-cal-grid">${cells}</div>`;
  }

  /* ── スケルトン（全項目を一度だけ描画・以降はインクリメンタル更新） ── */
  function buildSkeleton(host) {
    const s = host.__uzf;
    const stateLabel = s.kind === 'sales' ? '売掛（未入金）' : '買掛（未払い）';
    const editLabel = s.editId ? '保存する' : '登録する';
    host.innerHTML =
      `<div class="uzf-head" data-stick="0" data-go="date">
         <span class="uzf-sh-k">発生日</span><span class="uzf-sh-v" data-v="date">${fmtDate(s.date)}</span>
       </div>
       <div class="uzf-body"><div class="uzf-cal">${calInnerHTML(s)}</div></div>

       <div class="uzf-head" data-stick="1" data-go="item">
         <span class="uzf-sh-k">${s.kind === 'sales' ? '区分' : '科目'}</span><span class="uzf-sh-v" data-v="item">未選択</span><span class="uzf-sh-tax" data-v="itemtax"></span>
       </div>
       <div class="uzf-body">
         ${s.kind === 'cost' ? `<div class="uzf-divtabs">
           <button type="button" class="uzf-divtab ${s.divCode === '1' ? 'is-active' : ''}" data-div="1">仕入原価</button>
           <button type="button" class="uzf-divtab ${s.divCode === '2' ? 'is-active' : ''}" data-div="2">販管費</button>
         </div>` : ''}
         <div class="uzf-cards ${colsCls(s)}" data-cards>${cardsHTML(s)}</div>
         <div class="uzf-misc" data-misc hidden>
           <input type="text" class="uzf-misc-input" maxlength="50" placeholder="品目名（任意）">
         </div>
         <div class="uzf-ed-sub">税率</div>
         <div class="uzf-taxchips" data-tax-chips>${taxchipsHTML(s)}</div>
       </div>

       <div class="uzf-head" data-stick="2" data-go="amount">
         <span class="uzf-sh-k">金額</span><span class="uzf-sh-v" data-v="amount">¥0</span><span class="uzf-sh-tax" data-v="amounttax">内消費税 0 円</span>
       </div>
       <div class="uzf-body">
         <div class="uzf-amount-disp" data-amt>¥0<span class="uzf-amount-yen">円</span></div>
         <div class="uzf-keypad">${keypadHTML()}</div>
         <div class="uzf-keypad-last">
           <button type="button" class="uzf-key uzf-key--clear" data-key="clear">クリア</button>
         </div>
         <textarea class="uzf-memo" rows="1" placeholder="メモ（任意）"></textarea>
       </div>

       <div class="uzf-tail">
         <label class="uzf-toggle"><input type="checkbox" class="uzf-unpaid"><span>${stateLabel}</span></label>
         <button type="button" class="uzf-submit" disabled>${editLabel}</button>
         ${(s.opts && s.opts.onDelete) ? `<button type="button" class="uzf-delete">削除する</button>` : ''}
         ${(s.opts && s.opts.onCancel) ? `<button type="button" class="uzf-cancel">取消（新規登録に戻る）</button>` : ''}
       </div>`;
  }

  /* ── 部分更新 ─────────────────────────────────────────── */
  const $ = (host, sel) => host.querySelector(sel);
  function setHead(host, key, val) { const el = $(host, `[data-v="${key}"]`); if (el) el.textContent = val; }
  function updateAmountUI(host) {
    const s = host.__uzf;
    const amt = $(host, '[data-amt]');
    if (amt) amt.innerHTML = (s.amount ? fmtAmt(s.amount) : '¥0') + '<span class="uzf-amount-yen">円</span>';
    setHead(host, 'amount', amountHeadValue(s));
    setHead(host, 'amounttax', amountTaxLabel(s));
  }
  function updateReady(host) {
    const s = host.__uzf;
    const ok = itemResolved(s) && s.amount && parseInt(s.amount, 10) > 0 && s.taxRate != null;
    const btn = $(host, '.uzf-submit'); if (btn) btn.disabled = !ok;
  }
  function updateTaxActive(host) {
    const s = host.__uzf;
    host.querySelectorAll('.uzf-taxchip').forEach(c => c.classList.toggle('is-active', parseInt(c.dataset.rate, 10) === s.taxRate));
  }
  function updateMiscBox(host) {
    const s = host.__uzf;
    const box = $(host, '[data-misc]');
    if (!box) return;
    const sel = s.kind === 'sales' ? s.svcCode : s.itemCode;
    const show = sel && isMisc(sel);
    box.hidden = !show;
    const inp = box.querySelector('.uzf-misc-input');
    if (inp && !show) inp.value = '';
    if (inp && show) inp.value = s.miscName || '';
  }
  function rebuildCards(host) {
    const s = host.__uzf;
    const box = $(host, '[data-cards]');
    if (!box) return;
    box.className = 'uzf-cards ' + colsCls(s);
    box.innerHTML = cardsHTML(s);
  }

  /* ── 操作（インクリメンタル：scrollを保ったまま該当部のみ更新） ── */
  function selectItem(host, card) {
    const s = host.__uzf;
    if (s.kind === 'sales') { s.svcCode = card.dataset.code; s.svcName = card.dataset.name; }
    else { s.itemCode = card.dataset.code; s.itemName = card.dataset.name; }
    s.taxRate = parseInt(card.dataset.tax, 10);
    if (!isMisc(card.dataset.code)) s.miscName = '';
    host.querySelectorAll('.uzf-card').forEach(c => c.classList.toggle('is-active', c === card));
    updateMiscBox(host);
    updateTaxActive(host);
    setHead(host, 'item', itemHeadValue(s));
    setHead(host, 'itemtax', itemTaxLabel(s));
    updateAmountUI(host);
    updateReady(host);
  }
  function selectTax(host, chip) {
    const s = host.__uzf;
    s.taxRate = parseInt(chip.dataset.rate, 10);
    updateTaxActive(host);
    setHead(host, 'itemtax', itemTaxLabel(s));
    updateAmountUI(host);
    updateReady(host);
  }
  function selectDiv(host, tab) {
    const s = host.__uzf;
    s.divCode = tab.dataset.div;
    s.itemCode = ''; s.itemName = ''; s.taxRate = null; s.miscName = '';
    host.querySelectorAll('.uzf-divtab').forEach(t => t.classList.toggle('is-active', t === tab));
    rebuildCards(host);
    updateMiscBox(host);
    updateTaxActive(host);
    setHead(host, 'item', itemHeadValue(s));
    setHead(host, 'itemtax', itemTaxLabel(s));
    updateAmountUI(host);
    updateReady(host);
  }
  function pressKey(host, key) {
    const s = host.__uzf;
    const k = key.dataset.key;
    let cur = String(s.amount || '');
    if (k === 'clear') cur = '';
    else if (k === 'del') cur = cur.slice(0, -1);
    else cur = (cur + k).replace(/^0+(?=\d)/, '');
    if (cur.length > 12) cur = cur.slice(0, 12);
    s.amount = cur;
    updateAmountUI(host);
    updateReady(host);
  }
  function selectDay(host, cell) {
    const s = host.__uzf;
    const base = s.calView || new Date();
    const y = base.getFullYear(), m = base.getMonth();
    const dd = parseInt(cell.dataset.day, 10);
    s.date = `${y}-${String(m + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    host.querySelectorAll('.uzf-cal-cell.is-sel').forEach(c => c.classList.remove('is-sel'));
    cell.classList.add('is-sel');
    setHead(host, 'date', fmtDate(s.date));
  }
  function navCal(host, nav) {
    const s = host.__uzf;
    const base = s.calView || new Date();
    s.calView = new Date(base.getFullYear(), base.getMonth() + parseInt(nav.dataset.nav, 10), 1);
    const cal = $(host, '.uzf-cal'); if (cal) cal.innerHTML = calInnerHTML(s);
  }
  function resetForm(host) {
    const opts = host.__uzf.opts;
    host.__uzf = newState(host.__uzf.kind);
    host.__uzf.opts = opts;
    buildSkeleton(host);
  }

  /* ── 登録後・修正の詳細表示①（§5-10）─────────────────────
     全項目を入力順に読み取り専用で並べ、同寸の「編集」「閉じる（新規登録）」を持つ。
     「編集」は直前登録行の黒帯積層編集へ／「閉じる」は新規入力に戻る。 */
  function buildDetailHTML(s) {
    const itemKey  = s.kind === 'sales' ? '区分' : '科目';
    const memoRow  = s.memo
      ? `<div class="uzf-head uzf-head--ro"><span class="uzf-sh-k">メモ</span><span class="uzf-sh-v">${escapeHtmlUzf(s.memo)}</span></div>`
      : '';
    const stateRow = s.unpaid
      ? `<div class="uzf-head uzf-head--ro"><span class="uzf-sh-k">状態</span><span class="uzf-sh-v">${s.kind === 'sales' ? '売掛（未入金）' : '買掛（未払い）'}</span></div>`
      : '';
    return `<div class="uzf-detail">
      <div class="uzf-head uzf-head--ro"><span class="uzf-sh-k">発生日</span><span class="uzf-sh-v">${fmtDate(s.date)}</span></div>
      <div class="uzf-head uzf-head--ro"><span class="uzf-sh-k">${itemKey}</span><span class="uzf-sh-v">${escapeHtmlUzf(itemHeadValue(s))}</span><span class="uzf-sh-tax">${itemTaxLabel(s)}</span></div>
      <div class="uzf-head uzf-head--ro"><span class="uzf-sh-k">金額</span><span class="uzf-sh-v">${amountHeadValue(s)}</span><span class="uzf-sh-tax">${amountTaxLabel(s)}</span></div>
      ${memoRow}
      ${stateRow}
      <div class="uzf-det-actions">
        <button type="button" class="uzf-detbtn uzf-det-edit">編集</button>
        <button type="button" class="uzf-detbtn uzf-det-close">閉じる（新規登録）</button>
      </div>
    </div>`;
  }
  function escapeHtmlUzf(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function showDetail(host, savedRecord) {
    host.__uzfSaved = savedRecord || null;
    host.innerHTML = buildDetailHTML(host.__uzf);
  }
  function _detailEdit(host) {
    const rec  = host.__uzfSaved;
    const opts = (host.__uzf && host.__uzf.opts) || {};
    if (!rec) { resetForm(host); return; }
    if (!rec.rowIndex) {
      // rowIndex 不明（旧GAS等）：新規入力へフォールバック
      toast('編集できる行が特定できませんでした。新規入力に戻ります');
      mount(host, rec.type === 'cost' ? 'cost' : 'sales', opts);
      return;
    }
    mountEdit(host, rec, opts);
  }
  function _detailClose(host) {
    const kind = (host.__uzf && host.__uzf.kind) || 'sales';
    const opts = (host.__uzf && host.__uzf.opts) || {};
    mount(host, kind, opts);
  }

  /* ── 登録 ─────────────────────────────────────────────── */
  async function submitForm(host) {
    const s = host.__uzf;
    const amount = parseInt(s.amount || '0', 10);
    if (!itemResolved(s)) { toast('科目を選択してください'); return; }
    if (!amount || amount <= 0) { toast('金額を入力してください'); return; }
    if (s.taxRate == null) { toast('税率を選択してください'); return; }

    const { taxExcluded, tax } = calcTax(amount, s.taxRate);
    const btn = $(host, '.uzf-submit');
    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = s.editId ? '保存中...' : '登録中...'; }
    try {
      let result;
      if (s.editId) {
        // ── 修正（更新）：GAS updateSales / updateCost（契約は従来の saveEdit と同一） ──
        if (s.kind === 'sales') {
          result = await callGAS('updateSales', {
            rowIndex: s.editId, date: s.date,
            serviceName: s.svcName, serviceCode: s.svcCode || '',
            amountExTax: taxExcluded, taxRate: s.taxRate, tax, amountInTax: amount,
            memo: s.memo, uncollected: s.unpaid ? 1 : 0,
          });
        } else {
          result = await callGAS('updateCost', {
            rowIndex: s.editId, date: s.date,
            divisionCode: s.divCode, divisionName: divLabel(s.divCode),
            itemCode: s.itemCode || '', itemName: s.itemName,
            taxExcluded, taxRate: s.taxRate, tax, taxIncluded: amount,
            memo: s.memo, unpaid: s.unpaid ? 1 : 0,
          });
        }
        if (result?.status !== 'ok') throw new Error(result?.message || '更新エラー');
        toast('修正を保存しました ✓');
        try { s.opts.onSubmitted && s.opts.onSubmitted(); } catch (_) {}
        return;
      }
      if (s.kind === 'sales') {
        result = await callGAS('addSales', {
          date: s.date, serviceCode: s.svcCode, serviceName: s.svcName,
          miscItemName: isMisc(s.svcCode) ? s.miscName : '',
          amountExTax: taxExcluded, taxRate: s.taxRate, tax, amountInTax: amount,
          memo: s.memo, uncollected: s.unpaid ? 1 : 0,
        });
      } else {
        result = await callGAS('addCost', {
          date: s.date, divisionCode: s.divCode, divisionName: divLabel(s.divCode),
          itemCode: s.itemCode, itemName: s.itemName,
          miscItemName: isMisc(s.itemCode) ? s.miscName : '',
          taxExcluded, taxRate: s.taxRate, tax, taxIncluded: amount,
          memo: s.memo, unpaid: s.unpaid ? 1 : 0, staffId: '', staffName: '', clientId: '',
        });
      }
      if (result?.status !== 'ok') throw new Error(result?.message || '登録エラー');
      toast(s.kind === 'sales' ? '売上を登録しました ✓' : 'コストを登録しました ✓');
      try { s.opts.onSubmitted && s.opts.onSubmitted(); } catch (_) {}
      // §5-10 登録後の表示フロー：全項目（入力順）を読み取り専用で並べた詳細表示①へ切替。
      // 「編集」＝直前登録行の編集状態／「閉じる（新規登録）」＝新規入力に戻る。
      const _rowIndex = (result && result.rowIndex) ? result.rowIndex : null;
      const saved = (s.kind === 'sales')
        ? { type: 'sales', rowIndex: _rowIndex, date: s.date,
            serviceCode: s.svcCode, serviceName: s.svcName, itemName: s.svcName,
            taxRate: s.taxRate, amount: String(amount), memo: s.memo,
            uncollected: s.unpaid ? 1 : 0 }
        : { type: 'cost', rowIndex: _rowIndex, date: s.date,
            divisionCode: s.divCode, itemCode: s.itemCode, itemName: s.itemName,
            taxRate: s.taxRate, amount: String(amount), memo: s.memo,
            unpaid: s.unpaid ? 1 : 0 };
      showDetail(host, saved);
    } catch (e) {
      toast('登録に失敗しました：' + (e?.message || '通信エラー'));
      if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.textContent = s.editId ? '保存する' : '登録する'; }
    }
  }

  function toast(msg) {
    if (typeof showToast === 'function') { showToast(msg, 'info'); return; }
    let t = document.getElementById('uzf-toast');
    if (!t) { t = document.createElement('div'); t.id = 'uzf-toast'; t.className = 'uzf-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ── 結線（イベント委譲：部分更新後も再バインド不要） ── */
  function bindAll(host) {
    if (host.__uzfBound) return;
    host.__uzfBound = true;
    host.addEventListener('click', e => {
      let el;
      if ((el = e.target.closest('.uzf-card'))) return selectItem(host, el);
      if ((el = e.target.closest('.uzf-taxchip'))) return selectTax(host, el);
      if ((el = e.target.closest('.uzf-divtab'))) return selectDiv(host, el);
      if ((el = e.target.closest('.uzf-key'))) return pressKey(host, el);
      if ((el = e.target.closest('.uzf-cal-cell[data-day]'))) return selectDay(host, el);
      if ((el = e.target.closest('.uzf-cal-nav'))) return navCal(host, el);
      if ((el = e.target.closest('.uzf-det-edit'))) return _detailEdit(host);
      if ((el = e.target.closest('.uzf-det-close'))) return _detailClose(host);
      if ((el = e.target.closest('.uzf-submit'))) return submitForm(host);
      if ((el = e.target.closest('.uzf-delete'))) { try { host.__uzf.opts.onDelete && host.__uzf.opts.onDelete(); } catch (_) {} return; }
      if ((el = e.target.closest('.uzf-cancel'))) { try { host.__uzf.opts.onCancel && host.__uzf.opts.onCancel(); } catch (_) {} return; }
      if ((el = e.target.closest('.uzf-head[data-go]'))) {
        const body = el.nextElementSibling;
        if (body) body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    host.addEventListener('input', e => {
      const s = host.__uzf;
      if (e.target.classList.contains('uzf-misc-input')) { s.miscName = e.target.value; setHead(host, 'item', itemHeadValue(s)); }
      else if (e.target.classList.contains('uzf-memo')) s.memo = e.target.value;
    });
    host.addEventListener('change', e => {
      if (e.target.classList.contains('uzf-unpaid')) host.__uzf.unpaid = e.target.checked;
    });
  }

  /* ── 販管費マスタ（costMaster）ロード保証＋ロード後にカード再構築 ── */
  const _hosts = new Set();
  function _ensureCostMaster() {
    try { if (typeof getCostMaster === 'function') costMaster = getCostMaster(); } catch (_) {}
    if (typeof loadCostMasterFromGAS === 'function') {
      try {
        const p = loadCostMasterFromGAS();
        if (p && typeof p.then === 'function') p.then(() => {
          _hosts.forEach(h => { if (h.isConnected && h.__uzf && h.__uzf.kind === 'cost') rebuildCards(h); });
        }).catch(() => {});
      } catch (_) {}
    }
  }

  /* ── 公開 API ─────────────────────────────────────────── */
  function mount(host, kind, opts = {}) {
    if (!host) return;
    host.classList.add('uzf-host');
    host.__uzf = newState(kind);
    host.__uzf.opts = opts || {};
    _hosts.add(host);
    buildSkeleton(host);
    bindAll(host);
    if (kind === 'cost') _ensureCostMaster();
  }

  /* 修正（編集）モード：既存レコードでプリフィルして同一エンジンで描画。
     送信は updateSales / updateCost（契約は従来 saveEdit と同一）。
     カードはコード一致で自動ハイライト。旧・自由入力名（コードなし）も保持して保存可。 */
  function mountEdit(host, record, opts = {}) {
    if (!host || !record) return;
    const kind = record.type === 'cost' ? 'cost' : 'sales';
    host.classList.add('uzf-host');
    const s = newState(kind);
    s.opts = opts || {};
    s.editId = record.rowIndex;
    s.date = record.date || s.date;
    s.calView = s.date ? new Date(s.date) : null;
    s.taxRate = (record.taxRate != null && record.taxRate !== '') ? Number(record.taxRate) : null;
    s.amount = String(parseInt(record.amount, 10) || '');
    s.memo = record.memo || '';
    if (kind === 'sales') {
      s.svcCode = record.serviceCode || '';
      s.svcName = record.itemName || record.serviceName || '';
      s.unpaid = Number(record.uncollected) === 1;
    } else {
      s.divCode = String(record.divisionCode || '2') === '1' ? '1' : '2';
      s.itemCode = record.itemCode || '';
      s.itemName = record.itemName || '';
      s.unpaid = Number(record.unpaid) === 1;
    }
    host.__uzf = s;
    _hosts.add(host);
    buildSkeleton(host);
    bindAll(host);
    if (kind === 'cost') _ensureCostMaster();
    // プリフィル値をヘッド・金額・税率・活性に反映
    setHead(host, 'item', itemHeadValue(s));
    setHead(host, 'itemtax', itemTaxLabel(s));
    updateTaxActive(host);
    updateAmountUI(host);
    updateReady(host);
    const memo = $(host, '.uzf-memo'); if (memo) memo.value = s.memo;
    const unp = $(host, '.uzf-unpaid'); if (unp) unp.checked = !!s.unpaid;
  }

  function openModal(kind, opts = {}) {
    if (!window.SheetModal) return;
    SheetModal.open({
      title: kind === 'sales' ? '売上登録' : 'コスト登録',
      bodyHtml: '<div class="uzf-host" data-uzf-modal="1"></div>',
      onRender: () => {
        const sheet = document.querySelector('.sm-sheet');
        if (sheet) sheet.classList.add('sm-sheet--tall');
        const host = document.querySelector('.uzf-host[data-uzf-modal="1"]');
        if (host) mount(host, kind, Object.assign({ autoClose: true }, opts));
      },
    });
  }

  window.UzInput = { mount, mountEdit, openModal };

  function afterEntry(kind) {
    if (kind === 'sales' && typeof window._loadIpadSalesData === 'function') window._loadIpadSalesData();
    else if (kind === 'cost' && typeof window._loadIpadCostData === 'function') window._loadIpadCostData();
  }
  window.openSalesModal = () => openModal('sales', { onSubmitted: () => afterEntry('sales') });
  window.openCostModal  = () => openModal('cost',  { onSubmitted: () => afterEntry('cost') });

  function _mountPending(kind) {
    document.querySelectorAll(`.uzf-host[data-uzf-pending="${kind}"]`).forEach(h => {
      h.removeAttribute('data-uzf-pending');
      mount(h, kind, { onSubmitted: () => afterEntry(kind) });
    });
  }
  window._buildSalesFormBodyHTML  = () => '<div class="uzf-host" data-uzf-pending="sales"></div>';
  window._smCostBuildFormBodyHTML = () => '<div class="uzf-host" data-uzf-pending="cost"></div>';
  window._initSalesFormInModal    = () => _mountPending('sales');
  window._smCostInitFormInModal   = () => _mountPending('cost');
})();
