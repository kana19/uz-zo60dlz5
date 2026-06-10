/**
 * ウルトラZAIMUくん LEO版 PWA — sales.js
 * 売上入力画面ロジック
 */

'use strict';

/* ── マスタキー ──────────────────────────────────────────── */
// SERVICE_MASTER_KEY / STAFF_MASTER_KEY は app.js 冒頭で集約定義済み（SSOT）。

// 実データフォールバックは空（生成店舗は getSettings 同期で serviceList が入るまで
// 諸口のみ表示が正。複製元デモは app.js の UZ_DEMO_DATA が serviceList を供給する）。
// サンプル値を持たせると店舗分離パージ直後の同期前に偽サービスが一瞬描画される。
const DEFAULT_SERVICES = [];

/**
 * 売上品目マスタを返す。
 * 正本は localStorage の serviceList（settings.B3・app.js が同期）。
 * GAS応答は {id:'sv001', name, taxRate} 形式のため、UI内部で使う code に
 * id を写像して正規化する（id 欠落時のみ既存 code を尊重）。
 * これにより selectService(code) の照合と税率自動選択が成立する。
 */
function getServiceMaster() {
  try {
    const saved = localStorage.getItem(SERVICE_MASTER_KEY);
    const parsed = saved ? JSON.parse(saved) : null;
    const list = Array.isArray(parsed) ? parsed : DEFAULT_SERVICES;
    const normalized = list.map(s => ({
      code:    s.code != null ? s.code : s.id,   // GAS は id:'sv001'〜
      name:    s.name,
      taxRate: (s.taxRate != null && !isNaN(Number(s.taxRate))) ? Number(s.taxRate) : 10,
    }));
    return normalized;
  } catch {
    return [...DEFAULT_SERVICES];
  }
}

function getStaffMaster() {
  try {
    const saved = localStorage.getItem(STAFF_MASTER_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

/* ── 状態 ────────────────────────────────────────────────── */
let selectedServiceCode = null;
let currentTaxRate      = 10;
let isSubmitting        = false;
let accordionOpen       = false;
let nextRowId           = 1;
let _salesInModal       = false;   // SheetModal 経由で開いているか

/* ── SheetModal 版 売上入力 state（S3g-3f） ────────────── */
let _smSelectedServiceCode = null;
let _smSelectedTaxRate     = null;

/* ── 初期化（sales.html ページ専用） ─────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page !== 'sales') return;
  initDate();
  renderServiceCards();
  bindAmountInput();
  bindTaxButtons();
  bindSubmit();
  selectService(getServiceMaster()[0].code);
  if (document.body.classList.contains('is-ipad')) initIpadSalesPanel();
});

/* ── 日付初期化 ──────────────────────────────────────────── */
function initDate() {
  const el = document.getElementById('date-input');
  if (el) {
    el.value = todayStr();
    el.addEventListener('change', updateSubmitBtnDate);
  }
  updateSubmitBtnDate();
}

function buildSubmitBtnText() {
  const dateVal = document.getElementById('date-input')?.value || todayStr();
  return `発生日 ${dateVal.replace(/-/g, '/')}　登録する`;
}

function updateSubmitBtnDate() {
  const btn = document.getElementById('submit-btn');
  if (!btn || btn.disabled) return;
  btn.innerHTML = buildSubmitBtnText();
}

/* ── サービスカード描画 ───────────────────────────────────── */
function renderServiceCards() {
  const container = document.getElementById('service-cards');
  if (!container) return;
  container.innerHTML = getServiceMaster().map(svc => `
    <div class="radio-card"
         data-code="${svc.code}"
         role="radio"
         aria-checked="false"
         tabindex="0"
         onclick="selectService('${svc.code}')"
         onkeydown="if(event.key==='Enter'||event.key===' ')selectService('${svc.code}')">
      <div class="radio-card__label">${uzEscHtml(svc.name)}</div>
      <div class="radio-card__sub">税率 ${svc.taxRate}%</div>
    </div>
  `).join('');
}

/* ── サービス選択 ────────────────────────────────────────── */
function selectService(code) {
  const svc = getServiceMaster().find(s => s.code === code);
  if (!svc) return;
  selectedServiceCode = code;

  document.querySelectorAll('#service-cards .radio-card').forEach(card => {
    const checked = card.dataset.code === code;
    card.classList.toggle('radio-card--checked-blue', checked);
    card.setAttribute('aria-checked', String(checked));
  });

  setTaxRate(svc.taxRate);

}

/* ── 税率セット ──────────────────────────────────────────── */
function setTaxRate(rate) {
  currentTaxRate = rate;
  document.querySelectorAll('.tax-btn').forEach(btn => {
    btn.classList.toggle('tax-btn--active-blue', parseInt(btn.dataset.rate) === rate);
  });
  recalcTax();
}

/* ── 税計算・表示更新 ────────────────────────────────────── */
function recalcTax() {
  const raw = (document.getElementById('amount-input')?.value || '0').replace(/,/g, '');
  const taxIncluded = parseInt(raw) || 0;
  const { taxExcluded, tax } = calcTax(taxIncluded, currentTaxRate);
  const exEl  = document.getElementById('tax-excluded');
  const taxEl = document.getElementById('tax-amount');
  if (exEl)  exEl.textContent  = taxIncluded > 0 ? formatYen(taxExcluded) : '¥—';
  if (taxEl) taxEl.textContent = taxIncluded > 0 ? formatYen(tax)         : '¥—';
}

/* ── 金額入力バインド ────────────────────────────────────── */
function bindAmountInput() {
  const el = document.getElementById('amount-input');
  if (!el) return;
  el.addEventListener('input', () => {
    el.value = el.value.replace(/[^0-9]/g, '');
    recalcTax();
    updateAccordionHint();
  });
}

/* ── アコーディオン注釈のリアルタイム更新 ───────────────── */
function updateAccordionHint() {
  const el = document.getElementById('indiv-accordion-hint');
  if (!el) return;
  const amount = parseInt(
    (document.getElementById('amount-input')?.value || '0').replace(/,/g, '')
  ) || 0;
  if (amount === 0) {
    el.textContent = '💡 売上金額が0円です。個別管理のみで登録できます。損益集計には個別管理分のみが反映されます。';
  } else {
    el.textContent = '⚠ 個別管理分は売上入力とは別に追加登録されます。売上入力時に個別分を差し引いて入力してください。';
  }
}

/* ── 税率ボタンバインド ──────────────────────────────────── */
function bindTaxButtons() {
  document.querySelectorAll('.tax-btn').forEach(btn => {
    btn.addEventListener('click', () => setTaxRate(parseInt(btn.dataset.rate)));
  });
}

/* ════════════════════════════════════════════════════════════
   個別管理アコーディオン
   ════════════════════════════════════════════════════════════ */

/* ── アコーディオン開閉 ──────────────────────────────────── */
function toggleAccordion() {
  accordionOpen = !accordionOpen;

  const body = document.getElementById('indiv-accordion-body');
  const btn  = document.getElementById('indiv-accordion-btn');
  if (body) body.hidden = !accordionOpen;
  if (btn)  btn.setAttribute('aria-expanded', String(accordionOpen));

  // 初回展開時に1行追加
  if (accordionOpen && !document.querySelector('.indiv-row')) {
    addIndividualRow();
  }
  if (accordionOpen) updateAccordionHint();
}

/* ── 顧客オプションHTML ──────────────────────────────────── */
function buildCustomerOptions() {
  const staffList = getStaffMaster();
  const opts = staffList.map(s =>
    `<option value="${uzEscHtml(s.name)}">${uzEscHtml(s.name)}</option>`
  ).join('');
  return `<option value="">顧客を選択</option>` +
         opts +
         `<option value="__misc__">諸口</option>` +
         `<option value="__manual__">手入力...</option>`;
}

/* ── 個別行追加 ──────────────────────────────────────────── */
function addIndividualRow() {
  const container = document.getElementById('indiv-rows');
  if (!container) return;
  const id  = nextRowId++;
  const div = document.createElement('div');
  div.className  = 'indiv-row';
  div.dataset.id = id;
  div.innerHTML  = `
    <div class="indiv-row-header">
      <select class="form-select indiv-customer-select"
              onchange="onCustomerSelectChange(${id})"
              aria-label="顧客選択">
        ${buildCustomerOptions()}
      </select>
      <button class="indiv-remove-btn" type="button"
              onclick="removeIndividualRow(${id})"
              aria-label="行を削除">✕</button>
    </div>
    <input type="text"
           id="indiv-manual-${id}"
           class="text-input indiv-manual-input"
           placeholder="顧客名を入力"
           maxlength="30"
           autocomplete="off"
           hidden>
    <div class="indiv-row-body">
      <div class="amount-wrap amount-wrap--blue indiv-amount-wrap">
        <span class="amount-prefix" aria-hidden="true">¥</span>
        <input type="text"
               id="indiv-amount-${id}"
               class="amount-input indiv-amount-input"
               inputmode="numeric"
               pattern="[0-9]*"
               placeholder="0"
               maxlength="10"
               oninput="this.value=this.value.replace(/[^0-9]/g,'')"
               aria-label="金額">
      </div>
      <div class="indiv-uncollected-label">
        <span class="indiv-uncollected-text">売掛</span>
        <label class="switch switch--small">
          <input type="checkbox" id="indiv-uc-${id}" class="indiv-uncollected-chk">
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <input type="text"
           id="indiv-memo-${id}"
           class="text-input indiv-memo-input"
           placeholder="メモ（任意）"
           maxlength="100"
           autocomplete="off"
           aria-label="メモ">
  `;
  container.appendChild(div);
}

/* ── 顧客プルダウン変更 ──────────────────────────────────── */
function onCustomerSelectChange(id) {
  const sel    = document.querySelector(`.indiv-row[data-id="${id}"] .indiv-customer-select`);
  const manual = document.getElementById(`indiv-manual-${id}`);
  if (!sel || !manual) return;
  manual.hidden = sel.value !== '__manual__';
  if (manual.hidden) manual.value = '';
}

/* ── 個別行削除 ──────────────────────────────────────────── */
function removeIndividualRow(id) {
  document.querySelector(`.indiv-row[data-id="${id}"]`)?.remove();
}

/* ── 個別行データ収集 ────────────────────────────────────── */
function collectIndividualRows() {
  const rows = [];
  document.querySelectorAll('.indiv-row').forEach(row => {
    const id      = row.dataset.id;
    const sel     = row.querySelector('.indiv-customer-select');
    const manual  = document.getElementById(`indiv-manual-${id}`);
    const amtEl   = document.getElementById(`indiv-amount-${id}`);
    const ucEl    = document.getElementById(`indiv-uc-${id}`);
    const memoEl  = document.getElementById(`indiv-memo-${id}`);

    let customerName = sel?.value || '';
    if (customerName === '__misc__')   customerName = '諸口';
    if (customerName === '__manual__') customerName = manual?.value.trim() || '';

    rows.push({
      customerName,
      amount:      parseInt((amtEl?.value || '0').replace(/[^0-9]/g, '')) || 0,
      uncollected: ucEl?.checked ?? false,
      memo:        memoEl?.value.trim() || '',
    });
  });
  return rows;
}

/* ════════════════════════════════════════════════════════════
   送信処理
   ════════════════════════════════════════════════════════════ */

function bindSubmit() {
  document.getElementById('submit-btn')?.addEventListener('click', handleSubmit);
}

async function handleSubmit() {
  if (isSubmitting) return;

  const date     = document.getElementById('date-input')?.value || '';
  const rawAmt   = (document.getElementById('amount-input')?.value || '0').replace(/,/g, '');
  const amount   = parseInt(rawAmt) || 0;
  const memo     = document.getElementById('memo-input')?.value.trim() || '';
  const svc      = getServiceMaster().find(s => s.code === selectedServiceCode);
  const mainUC   = document.getElementById('uncollected-toggle')?.checked ?? false;

  if (!date) return showToast('日付を入力してください', 'error');
  if (!svc)  return showToast('サービスを選択してください', 'error');

  // amount=0かつアコーディオンが開いている場合は個別行のみ登録モード
  const indivOnlyMode = (amount === 0 && accordionOpen);

  if (!indivOnlyMode) {
    if (amount <= 0) return showToast('金額を入力してください', 'error');
  }

  // アコーディオンが開いている場合のみ個別行を処理
  let indivRows = [];
  if (accordionOpen) {
    indivRows = collectIndividualRows();
    for (const r of indivRows) {
      if (!r.customerName) return showToast('顧客名を選択または入力してください', 'error');
      if (r.amount <= 0)   return showToast('個別行の金額を入力してください', 'error');
    }
    if (indivOnlyMode && indivRows.length === 0) {
      return showToast('個別行を1件以上入力してください', 'error');
    }
  }

  const finalUC = mainUC;
  const { taxExcluded, tax } = calcTax(amount, currentTaxRate);

  isSubmitting = true;
  setSubmitLoading(true);

  try {
    // 売上金額が0の個別管理モードは本体を送信しない
    if (!indivOnlyMode) {
      const mainRes = await callGAS('addSales', {
        date,
        serviceCode:  svc.code,
        serviceName:  svc.name,
        miscItemName: '',
        amountExTax:  taxExcluded,
        taxRate:      currentTaxRate,
        tax,
        amountInTax:  amount,
        memo,
        uncollected:  finalUC ? 1 : 0,
      });
      if (mainRes.status !== 'ok') throw new Error(mainRes.message || '売上登録エラー');
    }

    // 個別行を並列登録（アコーディオンが開いている場合のみ）
    if (accordionOpen && indivRows.length > 0) {
      const results = await Promise.all(
        indivRows.map(r => {
          const { taxExcluded: rEx, tax: rTax } = calcTax(r.amount, currentTaxRate);
          return callGAS('addSales', {
            date,
            serviceCode:  svc.code,
            serviceName:  svc.name,
            miscItemName: '',
            amountExTax:  rEx,
            taxRate:      currentTaxRate,
            tax:          rTax,
            amountInTax:  r.amount,
            memo:         [r.customerName, r.memo].filter(Boolean).join('　'),
            uncollected:  r.uncollected ? 1 : 0,
          });
        })
      );
      if (results.some(r => r.status !== 'ok')) throw new Error('個別行の登録中にエラーが発生しました');
    }

    setSubmitLoading(false);
    showToast('売上を登録しました ✓', 'success');
    setTimeout(() => navigate('index.html'), 1200);

  } catch (e) {
    setSubmitLoading(false);
    showToast('登録に失敗しました：' + e.message, 'error');
  } finally {
    isSubmitting = false;
  }
}

/* ── ヘルパー ────────────────────────────────────────────── */
function setSubmitLoading(loading) {
  const btn = document.getElementById('submit-btn');
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span class="spinner" style="width:20px;height:20px;border-top-color:var(--uz-on-accent);"></span>'
    : buildSubmitBtnText();
}

// escHtml は app.js の uzEscHtml に委譲（重複定義を解消）

/* ════════════════════════════════════════════════════════════
   SheetModal 版 売上入力（S3g-3 D案）
   ════════════════════════════════════════════════════════════ */

function _buildSalesFormBodyHTML() {
  return `
    <!-- sticky固定エリア：発生日のみ1行 -->
    <div class="sm-sticky-header">
      <div class="sm-sticky-row sm-sticky-row--single">
        <span class="sm-sticky-label">発生日</span>
        <input type="date" id="sm-sales-date" class="sm-sticky-date-input">
      </div>
    </div>

    <div class="sales-sm-body">

      <div class="sales-sm-section">
        <label class="sales-sm-label">サービスを選択</label>
        <div id="sm-sales-cards" class="sales-sm-cards"></div>
        <div class="sm-taxrate-chips" id="sm-sales-taxrate-chips" role="group" aria-label="税率選択">
          <button type="button" class="sm-taxrate-chip" data-rate="10">10%</button>
          <button type="button" class="sm-taxrate-chip" data-rate="8">8%</button>
          <button type="button" class="sm-taxrate-chip" data-rate="0">非課税</button>
        </div>
      </div>

      <div class="sales-sm-section">
        <label class="sales-sm-label">金額（税込）</label>
        <div class="sales-sm-amount-wrap">
          <input type="text" id="sm-sales-amount" class="sales-sm-amount-input"
                 inputmode="numeric" placeholder="0" maxlength="12" autocomplete="off">
          <span class="sales-sm-yen">円</span>
        </div>
        <div id="sm-sales-tax-display" class="sm-tax-memo">内消費税 0 円</div>
      </div>

      <div class="sales-sm-section">
        <label class="uncollected-check-row">
          <input type="checkbox" id="uncollected-toggle" class="uncollected-check">
          <span class="uncollected-check-label">売掛（未入金）として登録</span>
        </label>
      </div>

      <div class="sales-sm-section">
        <label class="sales-sm-label">メモ<span class="sales-sm-optional">任意</span></label>
        <textarea id="sm-sales-memo" class="sales-sm-memo" rows="2"></textarea>
      </div>

      <div id="sm-sales-toast" class="sales-sm-toast"></div>

      <div class="sales-sm-footer">
        <button type="button" id="sm-sales-submit" class="sales-sm-submit-btn">
          登録する
        </button>
      </div>

    </div>`;
}

async function _initSalesFormInModal() {
  // state を完全初期化（次回オープン時の保証）
  _smSelectedServiceCode = null;
  _smSelectedTaxRate     = null;

  document.getElementById('sm-sales-date').value = todayStr();

  await _renderSalesCards();

  _bindSalesAmountFormatting();
  _bindTaxRateChips();
  _bindSalesAmountTaxRecalc();

  document.getElementById('sm-sales-submit')
    ?.addEventListener('click', _smHandleSalesSubmit);

  document.getElementById('sm-sales-cards')
    ?.addEventListener('click', _smHandleCardTap);

  _smUpdateTaxChipUI();
  _smRefreshTaxDisplay();
}

function _bindTaxRateChips() {
  document.querySelectorAll('#sm-sales-taxrate-chips .sm-taxrate-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const rate = parseInt(btn.dataset.rate, 10);
      if (!Number.isFinite(rate)) return;
      _smSelectedTaxRate = rate;
      _smUpdateTaxChipUI();
      _smRefreshTaxDisplay();
      document.getElementById('sm-sales-taxrate-chips')
        ?.classList.remove('sales-sm-field-error');
    });
  });
}

function _bindSalesAmountTaxRecalc() {
  const el = document.getElementById('sm-sales-amount');
  if (!el) return;
  el.addEventListener('input', _smRefreshTaxDisplay);
}

function _smUpdateTaxChipUI() {
  document.querySelectorAll('#sm-sales-taxrate-chips .sm-taxrate-chip').forEach(btn => {
    const rate = parseInt(btn.dataset.rate, 10);
    btn.classList.toggle('is-active', _smSelectedTaxRate != null && rate === _smSelectedTaxRate);
  });
}

function _smRefreshTaxDisplay() {
  const el = document.getElementById('sm-sales-tax-display');
  if (!el) return;
  const raw = (document.getElementById('sm-sales-amount')?.value || '').replace(/[^0-9]/g, '');
  const amt = parseInt(raw, 10) || 0;
  let tax = 0;
  if (_smSelectedTaxRate != null && _smSelectedTaxRate > 0 && amt > 0) {
    tax = calcTax(amt, _smSelectedTaxRate).tax;
  }
  el.textContent = `内消費税 ${Number(tax).toLocaleString()} 円`;
}

async function _renderSalesCards() {
  const container = document.getElementById('sm-sales-cards');
  if (!container) return;

  let ranking = [];
  try {
    ranking = await _getSalesRanking();
  } catch (e) {
    // ランキング取得失敗時はデフォルト順で表示
  }

  const services = _getServiceMasterSorted(ranking);

  container.innerHTML = services.map(svc => `
    <div class="radio-card" data-code="${uzEscHtml(svc.code)}">
      <div class="radio-card__label">${uzEscHtml(svc.name)}</div>
    </div>
  `).join('');
}

async function _getSalesRanking() {
  const CACHE_KEY = 'salesRankingCache';
  const CACHE_TTL = 24 * 60 * 60 * 1000;

  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const { timestamp, data } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_TTL) {
        _refreshSalesRankingInBackground();
        return data;
      }
    } catch (e) {}
  }

  const result = await callGAS('getSalesCategoryRanking', { months: 1 });
  const data = Array.isArray(result) ? result : (result?.data || []);
  localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
  return data;
}

async function _refreshSalesRankingInBackground() {
  try {
    const result = await callGAS('getSalesCategoryRanking', { months: 1 });
    const data = Array.isArray(result) ? result : (result?.data || []);
    localStorage.setItem('salesRankingCache', JSON.stringify({ timestamp: Date.now(), data }));
  } catch (e) {}
}

function _getServiceMasterSorted(ranking) {
  const rankingMap = new Map((ranking || []).map(r => [r.code, r.count]));
  return getServiceMaster().slice().sort((a, b) => {
    const countA = rankingMap.get(a.code) || 0;
    const countB = rankingMap.get(b.code) || 0;
    return countB - countA;
  });
}

function _bindSalesAmountFormatting() {
  const el = document.getElementById('sm-sales-amount');
  if (!el) return;
  el.addEventListener('input', () => {
    const raw = el.value.replace(/[^0-9]/g, '');
    const pos = el.selectionStart;
    const prevLen = el.value.length;
    el.value = raw ? Number(raw).toLocaleString() : '';
    // カーソル位置補正
    const diff = el.value.length - prevLen;
    try { el.setSelectionRange(pos + diff, pos + diff); } catch (e) {}
  });
}

function _smHandleCardTap(e) {
  const card = e.target.closest('.radio-card');
  if (!card) return;

  document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('radio-card--checked-blue'));
  card.classList.add('radio-card--checked-blue');

  const code = card.dataset.code;
  _smSelectedServiceCode = code;

  // サービスはマスタ値（10/8/0）をデフォルト選択
  const svc = getServiceMaster().find(s => s.code === code);
  if (svc && (svc.taxRate === 10 || svc.taxRate === 8 || svc.taxRate === 0)) {
    _smSelectedTaxRate = svc.taxRate;
  } else {
    _smSelectedTaxRate = null;
  }
  _smUpdateTaxChipUI();
  _smRefreshTaxDisplay();

  document.getElementById('sm-sales-amount')?.focus();

  document.getElementById('sm-sales-cards')?.classList.remove('sales-sm-field-error');
}

async function _smHandleSalesSubmit() {
  const btn = document.getElementById('sm-sales-submit');
  if (!btn || btn.disabled) return;

  const date         = document.getElementById('sm-sales-date')?.value || '';
  const selectedCard = document.querySelector('.radio-card.radio-card--checked-blue');
  const rawAmt       = (document.getElementById('sm-sales-amount')?.value || '').replace(/,/g, '');
  const amount       = parseInt(rawAmt, 10);
  const memo         = document.getElementById('sm-sales-memo')?.value.trim() || '';

  if (!date) {
    _smShowSalesError('sm-sales-date', '日付を入力してください');
    return;
  }
  if (!selectedCard) {
    _smShowSalesError('sm-sales-cards', 'サービスを選択してください');
    return;
  }
  if (_smSelectedTaxRate == null) {
    _smShowSalesError('sm-sales-taxrate-chips', '税率を選択してください');
    return;
  }
  if (!amount || amount <= 0) {
    _smShowSalesError('sm-sales-amount', '金額を入力してください');
    return;
  }

  const svc = getServiceMaster().find(s => s.code === selectedCard.dataset.code);
  const taxRate = _smSelectedTaxRate;
  const { taxExcluded, tax } = calcTax(amount, taxRate);


  btn.disabled = true;
  btn.textContent = '送信中...';
  try {
    const result = await callGAS('addSales', {
      date,
      serviceCode:  selectedCard.dataset.code,
      serviceName:  svc ? svc.name : '',
      miscItemName: '',
      amountExTax:  taxExcluded,
      taxRate,
      tax,
      amountInTax:  amount,
      memo,
      uncollected:  document.getElementById('uncollected-toggle')?.checked ? 1 : 0,
    });

    if (result?.status !== 'ok') throw new Error(result?.message || '登録エラー');

    showToast('売上を登録しました ✓', 'success');

    if (document.body.classList.contains('is-ipad')) {
      // iPad：パネルを保持したままフォームをリセットし、左の一覧を再描画
      await _initSalesFormInModal();
      const m = document.getElementById('ipad-filter-month')?.value;
      if (typeof _loadIpadSalesData === 'function') await _loadIpadSalesData(m);
    } else {
      SheetModal.close();
      if (typeof loadAll === 'function') loadAll();
    }

    _refreshSalesRankingInBackground();

  } catch (e) {
    _smShowSalesError(null, '登録に失敗しました：' + e.message);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '登録する';
    }
  }
}

function _smShowSalesError(fieldId, message) {
  if (fieldId) {
    const el   = document.getElementById(fieldId);
    const wrap = (fieldId === 'sm-sales-cards' || fieldId === 'sm-sales-taxrate-chips')
      ? el
      : el?.closest('.sales-sm-section');

    wrap?.classList.add('sales-sm-field-error');

    const removeErr = () => {
      wrap?.classList.remove('sales-sm-field-error');
      el?.removeEventListener('change', removeErr);
      el?.removeEventListener('input',  removeErr);
      el?.removeEventListener('focus',  removeErr);
      el?.removeEventListener('click',  removeErr);
    };
    el?.addEventListener('change', removeErr);
    el?.addEventListener('input',  removeErr);
    el?.addEventListener('focus',  removeErr);
    el?.addEventListener('click',  removeErr);
  }

  const toast = document.getElementById('sm-sales-toast');
  if (toast) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

function openSalesModal() {
  SheetModal.open({
    title:    '売上登録',
    bodyHtml: _buildSalesFormBodyHTML(),
    onRender: _initSalesFormInModal,
    onClose:  _resetSalesModalState,
  });
}

function _resetSalesModalState() {
  _smSelectedServiceCode = null;
  _smSelectedTaxRate     = null;
}

/* ── iPad 売上入力パネル ─────────────────────────────────── */
let _ipadSalesHistory = [];

async function initIpadSalesPanel() {
  const wrap = document.getElementById('ipad-sc-wrap');
  if (!wrap) return;

  // iPad は静的 form-body を使わず、スマホ実装（モーダル版フォーム）を
  // ipad-tab-add に注入してロジックを共有する（MD §6-3-B 入力正本1本化）。
  // 個別管理アコーディオンは含まれない＝PC集約。
  const tabAdd = document.getElementById('ipad-tab-add');
  if (tabAdd) {
    tabAdd.innerHTML = _buildSalesFormBodyHTML();
    await _initSalesFormInModal();
  }

  // タブ切替バインド
  document.querySelectorAll('.ipad-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchIpadTab(btn.dataset.tab, 'sales'));
  });

  const now          = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  _initIpadFilterMonth(currentMonth, () => _loadIpadSalesData(
    document.getElementById('ipad-filter-month')?.value || currentMonth
  ));

  await _loadIpadSalesData(currentMonth);
}

function _initIpadFilterMonth(currentMonth, onchange) {
  const sel = document.getElementById('ipad-filter-month');
  if (!sel) return;
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `${d.getFullYear()}年${d.getMonth()+1}月`;
    sel.appendChild(opt);
  }
  sel.value = currentMonth;
  sel.addEventListener('change', onchange);
  document.getElementById('ipad-filter-state')
    ?.addEventListener('change', () => _renderIpadSalesList());
}

async function _loadIpadSalesData(month) {
  const listEl = document.getElementById('ipad-sales-list');
  if (listEl) listEl.innerHTML = '<div class="ipad-list-empty">読み込み中...</div>';

  try {
    const histRes = await callGAS('getHistory', { type: 'sales', month }).catch(() => null);

    _ipadSalesHistory = (histRes?.status === 'ok' && Array.isArray(histRes.data))
      ? histRes.data : [];

    const total      = _ipadSalesHistory.reduce((s, r) => s + (r.taxIncluded ?? r.amount ?? 0), 0);
    const unpaidList = _ipadSalesHistory.filter(r => r.uncollected || r.unpaid);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ipad-month-total',  formatYen(total));
    set('ipad-unpaid-count', unpaidList.length + '件');
    set('ipad-entry-count',  _ipadSalesHistory.length + '件');

    _renderIpadSalesList();
    _renderIpadUnpaidTab(unpaidList, 'uncollected');
  } catch {
    if (listEl) listEl.innerHTML = '<div class="ipad-list-empty">読み込みエラー</div>';
  }
}

function _renderIpadSalesList() {
  const listEl   = document.getElementById('ipad-sales-list');
  const stateVal = document.getElementById('ipad-filter-state')?.value || 'all';
  if (!listEl) return;

  let rows = _ipadSalesHistory;
  if (stateVal === 'unpaid') rows = rows.filter(r => r.uncollected || r.unpaid);
  if (stateVal === 'locked') rows = rows.filter(r => r.locked);

  if (rows.length === 0) {
    listEl.innerHTML = '<div class="ipad-list-empty">データなし</div>';
    return;
  }

  listEl.innerHTML = rows.map((r, idx) => {
    const date      = String(r.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
    const name      = _scEsc(r.service || r.serviceName || r.item || r.itemName || '—');
    const amount    = formatYen(r.taxIncluded ?? r.amount ?? 0);
    const isUnpaid  = !!(r.uncollected || r.unpaid);
    const isLocked  = !!r.locked;
    let cls = 'ipad-list-row';
    if (isUnpaid) cls += ' ipad-list-row--unpaid';
    if (isLocked) cls += ' ipad-list-row--locked';
    const badge = isUnpaid
      ? `<span class="ipad-list-badge ipad-list-badge--unpaid">未収</span>`
      : isLocked
      ? `<span class="ipad-list-badge ipad-list-badge--locked">🔒</span>`
      : '';
    return `<div class="${cls}" data-idx="${idx}" onclick="_onIpadSalesRowClick(${idx})">
      <span class="ipad-list-row__date">${date}</span>
      <span class="ipad-list-row__name">${name}</span>
      <span class="ipad-list-row__amount">${amount}</span>
      ${badge}
    </div>`;
  }).join('');
}

function _onIpadSalesRowClick(idx) {
  document.querySelectorAll('#ipad-sales-list .ipad-list-row').forEach(el => {
    el.classList.toggle('ipad-list-row--selected', parseInt(el.dataset.idx) === idx);
  });
  const row = _ipadSalesHistory[idx];
  if (row?.locked) showToast('この行はロックされています', 'info');
}

function _renderIpadUnpaidTab(unpaidList, tabId) {
  const listEl = document.getElementById(`ipad-${tabId === 'uncollected' ? 'unpaid' : 'payable'}-list`);
  if (!listEl) return;

  if (unpaidList.length === 0) {
    listEl.innerHTML = '<div class="ipad-list-empty">未収データなし</div>';
    return;
  }

  listEl.innerHTML = unpaidList.map((r, idx) => {
    const date   = String(r.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
    const name   = _scEsc(r.service || r.serviceName || r.item || r.itemName || '—');
    const amount = formatYen(r.taxIncluded ?? r.amount ?? 0);
    return `<div class="ipad-unpaid-row" data-idx="${idx}">
      <div class="ipad-unpaid-row__info">
        <div class="ipad-unpaid-row__date">${date}</div>
        <div class="ipad-unpaid-row__name">${name}</div>
      </div>
      <span class="ipad-unpaid-row__amount">${amount}</span>
      <button class="ipad-clear-btn" type="button"
              onclick="_ipadClearSales(${idx}, this)">消込</button>
    </div>`;
  }).join('');
}

async function _ipadClearSales(idx, btn) {
  const unpaidList = _ipadSalesHistory.filter(r => r.uncollected || r.unpaid);
  const row = unpaidList[idx];
  if (!row) return;

  btn.disabled = true;
  btn.textContent = '...';

  try {
    const result = await callGAS('reconcile', {
      sheetName:  'sales',
      rowIndex:   row.rowIndex ?? row.row ?? null,
      paidAmount: row.taxIncluded ?? row.amount ?? 0,
      paidDate:   todayStr(),
    });
    if (result.status !== 'ok') throw new Error(result.message || '消込エラー');
    btn.closest('.ipad-unpaid-row').remove();
    showToast('消込しました', 'success');
    const month = document.getElementById('ipad-filter-month')?.value;
    if (month) _loadIpadSalesData(month);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '消込';
    showToast('消込に失敗しました：' + e.message, 'error');
  }
}

function _switchIpadTab(tab, page) {
  document.querySelectorAll('.ipad-tab').forEach(btn => {
    btn.classList.toggle('ipad-tab--active', btn.dataset.tab === tab);
  });
  const ids = page === 'sales'
    ? { add: 'ipad-tab-add', other: 'ipad-tab-uncollected' }
    : { add: 'ipad-tab-add', other: 'ipad-tab-payable' };
  const addEl   = document.getElementById(ids.add);
  const otherEl = document.getElementById(ids.other);
  if (addEl)   addEl.style.display   = tab === 'add' ? '' : 'none';
  if (otherEl) otherEl.style.display = tab === 'add' ? 'none' : '';
}

function _scEsc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
