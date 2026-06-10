/**
 * ウルトラZAIMUくん LEO版 PWA — cost.js
 * コスト入力画面ロジック（科目マスタ連携版）
 */

'use strict';

/* ── 状態 ────────────────────────────────────────────────── */
let costMaster           = [];  // getCostMaster()（app.js）から読み込む
let selectedDivisionCode = '1';
let selectedItemCode     = null;
let _costCurrentTaxRate       = 10;
let _costIsSubmitting         = false;

/* ── 区分ごとの選択可能科目リスト ────────────────────────── */
/**
 * 指定区分の科目リストを返す（空のcustom除外）
 *
 * 科目の出所は区分で2系統に分かれる（02_画面仕様.md §2-1 / 03_データ仕様.md §1-2・§1-3）：
 *  - divCode '1'（仕入原価）：purchaseMasterList（settings.B5・id:'p001'〜）全件。
 *    登録＝表示固定のため smartphoneVisible フィルタは適用しない。
 *  - divCode '2'（販管費）：costMasterList（settings.B4・code:8〜31）。
 *    smartphoneVisible=false の科目はスマホ/iPadで非表示。
 *
 * @param {string} divCode
 * @param {Object} [options]
 * @param {boolean} [options.filterBySmartphoneVisible=false]
 *   true の場合、販管費のみ smartphoneVisible:false の科目を除外する。
 *   仕入原価は登録＝表示固定のため本オプションの影響を受けない。
 * @returns {Array}
 */
function getDivisionItems(divCode, options) {
  const opts = options || {};
  const filterSm = opts.filterBySmartphoneVisible === true;

  let items;
  if (divCode === '1') {
    // 仕入原価：purchaseMasterList（B5）を正本とする。
    // GAS応答 {id:'p001', name, defaultTaxRate} を内部統一形へマップする。
    const purchase = (typeof getPurchaseMaster === 'function') ? getPurchaseMaster() : [];
    items = purchase
      .filter(p => p && p.name && String(p.name).trim() !== '')
      .map(p => ({
        code:         p.id,                              // F列に格納（'p001'〜）
        taxRow:       null,                              // 仕入原価は青色申告行番号を持たない
        name:         p.name,
        taxRate:      (p.defaultTaxRate != null && !isNaN(Number(p.defaultTaxRate)))
                        ? Number(p.defaultTaxRate)
                        : (p.taxRate != null ? Number(p.taxRate) : 10),
        type:         'purchase',
        divisionCode: '1',
      }));
  } else {
    // 販管費：costMasterList（B4）を正本とする。
    items = costMaster
      .filter(i => i.divisionCode === divCode)
      .filter(i => i.name && i.name.trim() !== '')
      .filter(i => {
        if (!filterSm) return true;
        // smartphoneVisible キーが存在しない既存データは true（表示）として扱う（後方互換性）
        return i.smartphoneVisible !== false;
      });
  }

  return items;
}

function divisionLabel(code) {
  return code === '1' ? '仕入原価' : '販管費';
}

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page !== 'cost') return; // cost.html 専用（他ページは各JSが起動／history は右カラム注入で流用）
  // 起動時 localStorage 値も正規化を通す（divisionCode/type 欠落の旧データ矯正・03§1-2）。
  // これをしないと getDivisionItems の divisionCode 厳密一致で販管費が諸口のみになる。
  costMaster = (typeof normalizeCostMasterList === 'function')
    ? normalizeCostMasterList(getCostMaster())
    : getCostMaster();
  loadCostMasterFromGAS();        // バックグラウンドで最新取得

  costInitDate();
  bindDivisionButtons();
  costBindAmountInput();
  costBindTaxButtons();
  bindUnpaidToggle();
  costBindSubmit();
  selectDivision('1');
  if (document.body.classList.contains('is-ipad')) initIpadCostPanel();
});

/* ── GASから最新マスタを取得（バックグラウンド） ─────────── */
async function loadCostMasterFromGAS() {
  try {
    const res = await callGAS('getCostMaster', {});
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      // GAS生データは type/divisionCode が欠落しうるため正規化してから保存・使用（→ app.js）
      const normalized = (typeof normalizeCostMasterList === 'function')
        ? normalizeCostMasterList(res.data)
        : res.data;
      saveCostMasterToStorage(normalized);
      costMaster = normalized;
      renderItemCards(selectedDivisionCode);
    }
  } catch { /* サイレントフェイル */ }
}

/* ── 日付初期化 ──────────────────────────────────────────── */
function costInitDate() {
  const el = document.getElementById('date-input');
  if (el) {
    el.value = todayStr();
    el.addEventListener('change', updateSubmitBtnDate);
  }
  costUpdateSubmitBtnDate();
}

function costBuildSubmitBtnText() {
  const dateVal = document.getElementById('date-input')?.value || todayStr();
  return `発生日 ${dateVal.replace(/-/g, '/')}　登録する`;
}

function costUpdateSubmitBtnDate() {
  const btn = document.getElementById('submit-btn');
  if (!btn || btn.disabled) return;
  btn.innerHTML = costBuildSubmitBtnText();
}

/* ── 区分ボタン ──────────────────────────────────────────── */
function bindDivisionButtons() {
  document.querySelectorAll('.division-btn').forEach(btn => {
    btn.addEventListener('click', () => selectDivision(btn.dataset.div));
  });
}

function selectDivision(code) {
  selectedDivisionCode = code;
  selectedItemCode     = null;

  document.querySelectorAll('.division-btn').forEach(btn => {
    btn.classList.toggle('division-btn--active', btn.dataset.div === code);
  });

  renderItemCards(code);
  costRecalcTax();
}

/* ── 科目カード描画 ──────────────────────────────────────── */
function renderItemCards(divCode) {
  const container = document.getElementById('item-cards');
  if (!container) return;

  const items = getDivisionItems(divCode, { filterBySmartphoneVisible: true });

  container.innerHTML = items.map(item => `
    <div class="radio-card"
         data-code="${uzEscHtml(item.code)}"
         role="radio"
         aria-checked="false"
         tabindex="0"
         onclick="selectItem('${uzEscHtml(item.code)}')"
         onkeydown="if(event.key==='Enter'||event.key===' ')selectItem('${uzEscHtml(item.code)}')">
      <div class="radio-card__label">${uzEscHtml(item.name)}</div>
      <div class="radio-card__sub">${item.taxRow ? `行${item.taxRow}　` : ''}税率 ${item.taxRate}%</div>
    </div>
  `).join('');
}

/* ── 科目選択 ────────────────────────────────────────────── */
function selectItem(code) {
  const items = getDivisionItems(selectedDivisionCode, { filterBySmartphoneVisible: true });
  const item  = items.find(i => i.code === code);
  if (!item) return;

  selectedItemCode = code;

  document.querySelectorAll('#item-cards .radio-card').forEach(card => {
    const checked = card.dataset.code === code;
    card.classList.toggle('radio-card--checked-red', checked);
    card.setAttribute('aria-checked', String(checked));
  });

  costSetTaxRate(item.taxRate);

}

/* ── 税率セット ──────────────────────────────────────────── */
function costSetTaxRate(rate) {
  _costCurrentTaxRate = rate;

  document.querySelectorAll('.tax-btn').forEach(btn => {
    const active = parseInt(btn.dataset.rate) === rate;
    btn.classList.toggle('tax-btn--active-red', active);
  });

  costRecalcTax();
}

/* ── 税計算・表示更新 ────────────────────────────────────── */
function costRecalcTax() {
  const amountInput = document.getElementById('amount-input');
  const raw         = amountInput ? amountInput.value.replace(/,/g, '') : '0';
  const taxIncluded = parseInt(raw) || 0;
  const { taxExcluded, tax } = calcTax(taxIncluded, _costCurrentTaxRate);

  const exEl  = document.getElementById('tax-excluded');
  const taxEl = document.getElementById('tax-amount');
  if (exEl)  exEl.textContent  = taxIncluded > 0 ? formatYen(taxExcluded) : '¥—';
  if (taxEl) taxEl.textContent = taxIncluded > 0 ? formatYen(tax)         : '¥—';
}

/* ── 金額入力バインド ────────────────────────────────────── */
function costBindAmountInput() {
  const el = document.getElementById('amount-input');
  if (!el) return;
  el.addEventListener('input', () => {
    el.value = el.value.replace(/[^0-9]/g, '');
    costRecalcTax();
  });
}

/* ── 税率ボタンバインド ──────────────────────────────────── */
function costBindTaxButtons() {
  document.querySelectorAll('.tax-btn').forEach(btn => {
    btn.addEventListener('click', () => costSetTaxRate(parseInt(btn.dataset.rate)));
  });
}

/* ── 未払トグル ──────────────────────────────────────────── */
function bindUnpaidToggle() { /* submit時に読み取り */ }

/* ── 送信処理 ────────────────────────────────────────────── */
function costBindSubmit() {
  document.getElementById('submit-btn')?.addEventListener('click', handleSubmit);
}

async function costHandleSubmit() {
  if (_costIsSubmitting) return;

  const date     = document.getElementById('date-input')?.value || '';
  const rawAmt   = (document.getElementById('amount-input')?.value || '0').replace(/,/g, '');
  const amount   = parseInt(rawAmt) || 0;
  const memo     = document.getElementById('memo-input')?.value.trim() || '';
  const unpaid   = document.getElementById('unpaid-toggle')?.checked ?? false;

  const items = getDivisionItems(selectedDivisionCode, { filterBySmartphoneVisible: true });
  const item  = items.find(i => i.code === selectedItemCode);

  if (!date)       return showToast('日付を入力してください', 'error');
  if (!item)       return showToast('科目を選択してください', 'error');
  if (amount <= 0) return showToast('金額を入力してください', 'error');

  const { taxExcluded, tax } = calcTax(amount, _costCurrentTaxRate);

  const payload = {
    date,
    divisionCode: selectedDivisionCode,
    divisionName: divisionLabel(selectedDivisionCode),
    itemCode:     item.code,
    itemName:     item.name,
    taxRow:       item.taxRow ?? null,
    miscItemName: '',
    taxExcluded,
    taxRate:      _costCurrentTaxRate,
    tax,
    taxIncluded:  amount,
    memo,
    unpaid:       unpaid ? 1 : 0,
  };

  _costIsSubmitting = true;
  costSetSubmitLoading(true);

  try {
    const result = await callGAS('addCost', payload);
    if (result.status !== 'ok') throw new Error(result.message || '登録エラー');
    costSetSubmitLoading(false);
    showToast('コストを登録しました ✓', 'success');
    setTimeout(() => navigate('index.html'), 1200);
  } catch (e) {
    costSetSubmitLoading(false);
    showToast('登録に失敗しました：' + e.message, 'error');
  } finally {
    _costIsSubmitting = false;
  }
}

/* ── ヘルパー ────────────────────────────────────────────── */
function costSetSubmitLoading(loading) {
  const btn = document.getElementById('submit-btn');
  if (!btn) return;
  btn.disabled  = loading;
  btn.innerHTML = loading
    ? '<span class="spinner" style="width:20px;height:20px;border-top-color:var(--uz-gold);"></span>'
    : costBuildSubmitBtnText();
}

// escHtml は app.js の uzEscHtml に委譲（重複定義を解消）

/* ── iPad コスト入力パネル ─────────────────────────────────── */
let _ipadCostHistory = [];

async function initIpadCostPanel() {
  const wrap = document.getElementById('ipad-sc-wrap');
  if (!wrap) return;

  // iPad は静的 form-body を使わず、スマホ実装（モーダル版フォーム）を
  // ipad-tab-add に注入してロジックを共有する（MD §6-3-B 入力正本1本化）。
  const tabAdd = document.getElementById('ipad-tab-add');
  if (tabAdd) {
    tabAdd.innerHTML = _smCostBuildFormBodyHTML();
    _smCostInitFormInModal();
  }

  // タブ切替バインド
  document.querySelectorAll('.ipad-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchIpadCostTab(btn.dataset.tab));
  });

  const now          = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  _initIpadCostFilterMonth(currentMonth);
  await _loadIpadCostData(currentMonth);
}

function _initIpadCostFilterMonth(currentMonth) {
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
  sel.addEventListener('change', () => _loadIpadCostData(sel.value));
  document.getElementById('ipad-filter-state')
    ?.addEventListener('change', () => _renderIpadCostList());
}

async function _loadIpadCostData(month) {
  const listEl = document.getElementById('ipad-cost-list');
  if (listEl) listEl.innerHTML = '<div class="ipad-list-empty">読み込み中...</div>';

  try {
    const histRes = await callGAS('getHistory', { type: 'cost', month }).catch(() => null);

    _ipadCostHistory = (histRes?.status === 'ok' && Array.isArray(histRes.data))
      ? histRes.data : [];

    const total      = _ipadCostHistory.reduce((s, r) => s + (r.taxIncluded ?? r.amount ?? 0), 0);
    const unpaidList = _ipadCostHistory.filter(r => r.unpaid || r.uncollected);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ipad-month-total',  formatYen(total));
    set('ipad-unpaid-count', unpaidList.length + '件');
    set('ipad-entry-count',  _ipadCostHistory.length + '件');

    _renderIpadCostList();
    _renderIpadPayableTab(unpaidList);
  } catch {
    if (listEl) listEl.innerHTML = '<div class="ipad-list-empty">読み込みエラー</div>';
  }
}

function _renderIpadCostList() {
  const listEl   = document.getElementById('ipad-cost-list');
  const stateVal = document.getElementById('ipad-filter-state')?.value || 'all';
  if (!listEl) return;

  let rows = _ipadCostHistory;
  if (stateVal === 'unpaid') rows = rows.filter(r => r.unpaid || r.uncollected);
  if (stateVal === 'locked') rows = rows.filter(r => r.locked);

  if (rows.length === 0) {
    listEl.innerHTML = '<div class="ipad-list-empty">データなし</div>';
    return;
  }

  listEl.innerHTML = rows.map((r, idx) => {
    const date     = String(r.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
    const name     = _costScEsc(r.itemName || r.item || r.service || '—');
    const amount   = formatYen(r.taxIncluded ?? r.amount ?? 0);
    const isUnpaid = !!(r.unpaid || r.uncollected);
    const isLocked = !!r.locked;
    let cls = 'ipad-list-row';
    if (isUnpaid) cls += ' ipad-list-row--unpaid';
    if (isLocked) cls += ' ipad-list-row--locked';
    const badge = isUnpaid
      ? `<span class="ipad-list-badge ipad-list-badge--unpaid">未払</span>`
      : isLocked
      ? `<span class="ipad-list-badge ipad-list-badge--locked">🔒</span>`
      : '';
    return `<div class="${cls}" data-idx="${idx}" onclick="_onIpadCostRowClick(${idx})">
      <span class="ipad-list-row__date">${date}</span>
      <span class="ipad-list-row__name">${name}</span>
      <span class="ipad-list-row__amount">${amount}</span>
      ${badge}
    </div>`;
  }).join('');
}

function _onIpadCostRowClick(idx) {
  document.querySelectorAll('#ipad-cost-list .ipad-list-row').forEach(el => {
    el.classList.toggle('ipad-list-row--selected', parseInt(el.dataset.idx) === idx);
  });
  const row = _ipadCostHistory[idx];
  if (row?.locked) showToast('この行はロックされています', 'info');
}

function _renderIpadPayableTab(unpaidList) {
  const listEl = document.getElementById('ipad-payable-list');
  if (!listEl) return;

  if (unpaidList.length === 0) {
    listEl.innerHTML = '<div class="ipad-list-empty">買掛データなし</div>';
    return;
  }

  listEl.innerHTML = unpaidList.map((r, idx) => {
    const date   = String(r.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
    const name   = _costScEsc(r.itemName || r.item || r.service || '—');
    const amount = formatYen(r.taxIncluded ?? r.amount ?? 0);
    return `<div class="ipad-unpaid-row" data-idx="${idx}">
      <div class="ipad-unpaid-row__info">
        <div class="ipad-unpaid-row__date">${date}</div>
        <div class="ipad-unpaid-row__name">${name}</div>
      </div>
      <span class="ipad-unpaid-row__amount">${amount}</span>
      <button class="ipad-clear-btn" type="button"
              onclick="_ipadClearCost(${idx}, this)">消込</button>
    </div>`;
  }).join('');
}

async function _ipadClearCost(idx, btn) {
  const unpaidList = _ipadCostHistory.filter(r => r.unpaid || r.uncollected);
  const row = unpaidList[idx];
  if (!row) return;

  btn.disabled = true;
  btn.textContent = '...';

  try {
    const result = await callGAS('reconcile', {
      sheetName:  'cost',
      rowIndex:   row.rowIndex ?? row.row ?? null,
      paidAmount: row.taxIncluded ?? row.amount ?? 0,
      paidDate:   todayStr(),
    });
    if (result.status !== 'ok') throw new Error(result.message || '消込エラー');
    btn.closest('.ipad-unpaid-row').remove();
    showToast('消込しました', 'success');
    const month = document.getElementById('ipad-filter-month')?.value;
    if (month) _loadIpadCostData(month);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '消込';
    showToast('消込に失敗しました：' + e.message, 'error');
  }
}

function _switchIpadCostTab(tab) {
  document.querySelectorAll('.ipad-tab').forEach(btn => {
    btn.classList.toggle('ipad-tab--active', btn.dataset.tab === tab);
  });
  const addEl     = document.getElementById('ipad-tab-add');
  const payableEl = document.getElementById('ipad-tab-payable');
  if (addEl)     addEl.style.display     = tab === 'add' ? '' : 'none';
  if (payableEl) payableEl.style.display = tab === 'add' ? 'none' : '';
}

function _costScEsc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════════
   SheetModal 版 コスト入力（D案ハイブリッド）
   3デバイス統合仕様.md §6-3 準拠
   既存フルページ版（L1〜L457）とは完全独立・DOM / state / 関数名すべて別系統
   入力時統一ルール：全科目で総額（税込）入力
   販管費タブは smartphoneVisible=true の科目のみ表示する（現場入力の簡潔化）
   人件費は勤怠管理→PC出勤管理で算出・確定する（→ 02§5-9 / 03§5-2）
   ══════════════════════════════════════════════════════════════ */

// ── state ─────────────────────────────────────────────
let _smCostSelectedDivisionCode = '2';   // 初期値 = 販管費
let _smCostSelectedItemCode     = null;
let _smCostSelectedTaxRate      = null;
let _smCostUnpaid               = false;

// ── モーダル起動 ───────────────────────
/**
 * コスト入力シートモーダルを開く。
 * index.html の「コストを入れる」ボタンから呼ぶ。
 * window.openCostModal として露出し、DevTools Console からの手動起動も可能。
 */
function openCostModal() {
  // 1. state をリセット（前回入力の残留防止・防御的）
  _smCostResetState();

  // 2. HTML 生成
  const bodyHtml = _smCostBuildFormBodyHTML();

  // 3. SheetModal 基盤の存在確認（sales 側と同 API）
  if (typeof SheetModal === 'undefined' || typeof SheetModal.open !== 'function') {
    console.error('[cost SheetModal] SheetModal is not available');
    return;
  }

  // 4. モーダルを開く
  SheetModal.open({
    title:    'コスト登録',
    bodyHtml: bodyHtml,
    onRender: _smCostInitFormInModal,
    onClose:  _smCostResetState,
  });
}

// ── 状態リセット ───────────────────────────────────────
function _smCostResetState() {
  _smCostSelectedDivisionCode = '2';   // 初期値 = 販管費
  _smCostSelectedItemCode     = null;
  _smCostSelectedTaxRate      = null;
  _smCostUnpaid               = false;
}

// ── モーダル HTML 生成 ───────────────────────────────
function _smCostBuildFormBodyHTML() {
  const today = todayStr();
  return `
    <!-- sticky固定エリア：発生日（1行目）+ 区分（2行目） -->
    <div class="sm-sticky-header">
      <div class="sm-sticky-row">
        <span class="sm-sticky-label">発生日</span>
        <input type="date" id="sm-cost-date" class="sm-sticky-date-input" value="${today}">
      </div>
      <div class="sm-sticky-row">
        <span class="sm-sticky-label">区分</span>
        <div class="cost-sm-division-tabs" role="group" aria-label="区分選択">
          <button type="button" class="cost-sm-division-tab" data-division-code="1">仕入原価</button>
          <button type="button" class="cost-sm-division-tab cost-sm-division-tab--active" data-division-code="2">販管費</button>
        </div>
      </div>
    </div>

    <div class="cost-sm-body">

      <section class="cost-sm-section">
        <label class="cost-sm-label">科目を選択</label>
        <div id="sm-cost-item-cards" class="cost-sm-cards"></div>
      </section>

      <section class="cost-sm-section">
        <div class="sm-taxrate-chips" role="group" aria-label="税率選択">
          <button type="button" class="sm-taxrate-chip" data-tax-rate="10">10%</button>
          <button type="button" class="sm-taxrate-chip" data-tax-rate="8">8%</button>
          <button type="button" class="sm-taxrate-chip" data-tax-rate="0">非課税</button>
        </div>
      </section>

      <section class="cost-sm-section">
        <label class="cost-sm-label" for="sm-cost-amount">金額(税込)</label>
        <div class="cost-sm-amount-wrap">
          <input type="text"
                 id="sm-cost-amount"
                 class="cost-sm-amount-input"
                 inputmode="numeric"
                 placeholder="0"
                 maxlength="12"
                 autocomplete="off">
          <span class="cost-sm-yen">円</span>
        </div>
        <div id="sm-cost-tax-memo" class="sm-tax-memo">内消費税 0 円</div>
      </section>

      <!-- 買掛トグル -->
      <section class="cost-sm-section">
        <label class="cost-sm-unpaid-toggle">
          <input type="checkbox" id="sm-cost-unpaid">
          <span>買掛（未払い）として登録する</span>
        </label>
      </section>

      <section class="cost-sm-section">
        <label class="cost-sm-label" for="sm-cost-memo">メモ<span class="cost-sm-optional">(任意)</span></label>
        <input type="text"
               id="sm-cost-memo"
               class="cost-sm-memo"
               maxlength="200"
               autocomplete="off">
      </section>

      <div class="cost-sm-footer">
        <button type="button" id="sm-cost-submit" class="cost-sm-submit-btn">登録する</button>
      </div>

    </div>`;
}

// ── モーダル初期化 ─────────────────────
/**
 * SheetModal.open の onRender コールバックから引数なしで呼ばれる。
 * この時点でモーダル DOM は document に挿入済みのため、
 * document.getElementById / document.querySelectorAll が利用可能。
 */
function _smCostInitFormInModal() {
  // 0. costMaster を初期化（home 等 data-page≠cost のページでモーダルを開くと
  //    cost.js の DOMContentLoaded 初期化が走らず costMaster が空のままになり、
  //    販管費が諸口のみになるため、モーダル起動時に必ず読み直す）。
  costMaster = (typeof normalizeCostMasterList === 'function')
    ? normalizeCostMasterList(getCostMaster())
    : getCostMaster();

  // 1. 状態を初期化（次回オープン時の確実なリセットを保証）
  _smCostSelectedDivisionCode = '2';
  _smCostSelectedItemCode     = null;
  _smCostSelectedTaxRate      = null;
  _smCostUnpaid               = false;

  // 2. 科目カードの初期レンダリング（販管費＝divisionCode:'2'）
  _smCostRenderItemCards('2');

  // 3. 各要素のイベントバインド
  _smCostBindDivisionTabs();
  _smCostBindTaxChips();
  _smCostBindAmountInput();
  _smCostBindSubmit();
  _smCostBindMemoInput();
  _smCostBindDateInput();
  _smCostBindUnpaidToggle();

  // 4. 内消費税メモを初期表示（税率未選択なので 0円 表示）
  _smCostRecalcTaxMemo();
}

// ── 区分タブ関連 ───────────────────────
function _smCostBindDivisionTabs() {
  document.querySelectorAll('.cost-sm-division-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const divisionCode = tab.dataset.divisionCode;
      if (!divisionCode) return;
      if (divisionCode === _smCostSelectedDivisionCode) return; // 同一タブなら何もしない
      _smCostSelectDivision(divisionCode);
    });
  });
}

function _smCostSelectDivision(divisionCode) {
  // 1. state 更新
  _smCostSelectedDivisionCode = divisionCode;

  // 2. 区分タブの --active 付け替え
  document.querySelectorAll('.cost-sm-division-tab').forEach(tab => {
    tab.classList.toggle(
      'cost-sm-division-tab--active',
      tab.dataset.divisionCode === divisionCode
    );
  });

  // 3. 科目選択と税率選択をリセット（区分切替で選択を持ち越さない）
  _smCostSelectedItemCode = null;
  _smCostSelectedTaxRate  = null;

  // 4. 科目カードを再描画
  _smCostRenderItemCards(divisionCode);

  // 5. 税率チップの is-active を全て解除
  document.querySelectorAll('.sm-taxrate-chip').forEach(chip => {
    chip.classList.remove('is-active');
  });

  // 7. 内消費税メモを再計算（税率 null → 0円表示）
  _smCostRecalcTaxMemo();

  // 8. エラー枠解除
  document.querySelectorAll('.cost-sm-field-error').forEach(el => {
    el.classList.remove('cost-sm-field-error');
  });
}

function _smCostRenderItemCards(divisionCode) {
  const container = document.getElementById('sm-cost-item-cards');
  if (!container) return;

  const items = getDivisionItems(divisionCode, { filterBySmartphoneVisible: true });

  /* 仕入原価=2列 / 販管費=3列 */
  container.style.gridTemplateColumns = divisionCode === '1' ? '1fr 1fr' : '1fr 1fr 1fr';

  container.innerHTML = items.map(item => {
    const isActive = item.code === _smCostSelectedItemCode;
    return `
      <button type="button"
              class="cost-sm-card${isActive ? ' cost-sm-card--active' : ''}"
              data-item-code="${uzEscHtml(item.code)}">
        <span class="cost-sm-card__label">${uzEscHtml(item.name)}</span>
      </button>
    `;
  }).join('');

  container.querySelectorAll('.cost-sm-card').forEach(card => {
    card.addEventListener('click', () => {
      const itemCode = card.dataset.itemCode;
      if (itemCode) _smCostSelectItem(itemCode);
    });
  });
}

// ── 科目カード・税率チップ ─────────────
function _smCostSelectItem(itemCode) {
  // 1. state 更新
  _smCostSelectedItemCode = itemCode;

  // 2. カードの --active 付け替え
  document.querySelectorAll('.cost-sm-card').forEach(card => {
    card.classList.toggle(
      'cost-sm-card--active',
      card.dataset.itemCode === itemCode
    );
  });

  // 3. 選択された科目オブジェクトを取得（スマホ版なのでsmartphoneVisibleフィルタ適用）
  const items = getDivisionItems(_smCostSelectedDivisionCode, { filterBySmartphoneVisible: true });
  const selectedItem = items.find(it => it.code === itemCode);
  if (!selectedItem) return;

  // 科目のマスタ taxRate を自動選択
  _smCostSetTaxRate(selectedItem.taxRate);

  // 5. 内消費税メモを再計算
  _smCostRecalcTaxMemo();

  // 6. エラー枠解除
  const cardsContainer = document.getElementById('sm-cost-item-cards');
  if (cardsContainer) cardsContainer.classList.remove('cost-sm-field-error');
}

function _smCostSetTaxRate(taxRate) {
  _smCostSelectedTaxRate = taxRate;

  // 税率チップの is-active 付け替え(sales 側と共通 CSS を流用)
  document.querySelectorAll('.sm-taxrate-chip').forEach(chip => {
    const chipRate = Number(chip.dataset.taxRate);
    chip.classList.toggle('is-active', chipRate === taxRate);
  });

  _smCostRecalcTaxMemo();

  // 税率チップ群のエラー枠解除
  const chipsContainer = document.querySelector('.sm-taxrate-chips');
  if (chipsContainer) chipsContainer.classList.remove('cost-sm-field-error');
}

function _smCostBindTaxChips() {
  document.querySelectorAll('.sm-taxrate-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const taxRate = Number(chip.dataset.taxRate);
      if (!Number.isFinite(taxRate)) return;
      _smCostSetTaxRate(taxRate);
    });
  });
}

// ── 金額・内消費税 ─────────────────────
function _smCostBindAmountInput() {
  const input = document.getElementById('sm-cost-amount');
  if (!input) return;

  input.addEventListener('input', () => {
    // 1. 数字以外を除去
    const raw = input.value.replace(/[^\d]/g, '');
    // 2. 千円区切りフォーマット
    const formatted = raw ? Number(raw).toLocaleString('ja-JP') : '';
    if (input.value !== formatted) {
      input.value = formatted;
    }
    // 3. 内消費税メモ再計算
    _smCostRecalcTaxMemo();
    // 4. エラー枠解除
    input.classList.remove('cost-sm-field-error');
  });
}

function _smCostRecalcTaxMemo() {
  const input = document.getElementById('sm-cost-amount');
  const memo  = document.getElementById('sm-cost-tax-memo');
  if (!input || !memo) return;

  const raw = input.value.replace(/[^\d]/g, '');
  const amountInTax = raw ? Number(raw) : 0;

  let taxAmount = 0;
  if (amountInTax > 0 && _smCostSelectedTaxRate !== null) {
    // calcTax は js/app.js の既存ヘルパー（税込→税抜逆算）
    // 3デバイス統合仕様§6-4 準拠：税抜 = floor(税込 / (1 + 税率/100))、内消費税 = 税込 − 税抜
    const result = calcTax(amountInTax, _smCostSelectedTaxRate);
    taxAmount = result.tax;
  }

  memo.textContent = `内消費税 ${taxAmount.toLocaleString('ja-JP')} 円`;
}

// ── バリデーション・送信 ───────────────
/**
 * バリデーション順序：日付→区分→科目→税率→金額
 * 返り値：{ ok: true } or { ok: false, errorTarget: Element|null, errorMsg: string }
 */
function _smCostValidate() {
  const dateEl  = document.getElementById('sm-cost-date');
  const dateVal = dateEl ? dateEl.value : '';
  if (!dateVal) {
    return { ok: false, errorTarget: dateEl, errorMsg: '日付を入力してください' };
  }

  if (!_smCostSelectedDivisionCode) {
    const tabs = document.querySelector('.cost-sm-division-tabs');
    return { ok: false, errorTarget: tabs, errorMsg: '区分を選択してください' };
  }

  if (!_smCostSelectedItemCode) {
    const cards = document.getElementById('sm-cost-item-cards');
    return { ok: false, errorTarget: cards, errorMsg: '科目を選択してください' };
  }

  if (_smCostSelectedTaxRate === null) {
    const chips = document.querySelector('.sm-taxrate-chips');
    return { ok: false, errorTarget: chips, errorMsg: '税率を選択してください' };
  }

  const amountEl  = document.getElementById('sm-cost-amount');
  const amountRaw = amountEl ? amountEl.value.replace(/[^\d]/g, '') : '';
  const amount    = amountRaw ? Number(amountRaw) : 0;
  if (amount <= 0) {
    return { ok: false, errorTarget: amountEl, errorMsg: '金額を入力してください' };
  }

  return { ok: true };
}

async function _smCostHandleSubmit() {
  const btn = document.getElementById('sm-cost-submit');
  if (!btn || btn.disabled) return;

  // 1. バリデーション
  const validation = _smCostValidate();
  if (!validation.ok) {
    if (validation.errorTarget) {
      validation.errorTarget.classList.add('cost-sm-field-error');
    }
    _smCostShowToast(validation.errorMsg);
    return;
  }

  // 2. 送信値取得
  const dateVal     = document.getElementById('sm-cost-date').value;
  const amountRaw   = document.getElementById('sm-cost-amount').value.replace(/[^\d]/g, '');
  const amountInTax = Number(amountRaw);
  const memoEl      = document.getElementById('sm-cost-memo');
  const memoVal     = memoEl ? memoEl.value : '';
  const unpaidEl    = document.getElementById('sm-cost-unpaid');
  const unpaidVal   = unpaidEl ? (unpaidEl.checked ? 1 : 0) : 0;

  const items        = getDivisionItems(_smCostSelectedDivisionCode, { filterBySmartphoneVisible: true });
  const selectedItem = items.find(it => it.code === _smCostSelectedItemCode);
  if (!selectedItem) {
    _smCostShowToast('科目が不正です');
    return;
  }

  // 3. 税額計算
  const { taxExcluded, tax } = calcTax(amountInTax, _smCostSelectedTaxRate);

  // 4. payload 組立（clientId は箱だけ用意・現フェーズでは空文字固定）
  //   全科目で総額（税込）入力に統一する。
  //   人件費系科目（20/21/25）も科目選択して金額入力できるが、スタッフ紐付けは持たない。
  //   人件費の算出・確定は勤怠管理→PC出勤管理で行う（→ 02§5-9 / 03§5-2）。
  const payload = {
    date:              dateVal,
    divisionCode:      _smCostSelectedDivisionCode,
    divisionName:      divisionLabel(_smCostSelectedDivisionCode),
    itemCode:          selectedItem.code,
    itemName:          selectedItem.name,
    miscItemName:      '',
    taxExcluded:       taxExcluded,
    taxRate:           _smCostSelectedTaxRate,
    tax:               tax,
    taxIncluded:       amountInTax,
    memo:              memoVal,
    unpaid:            unpaidVal,
    clientId:          '',   // 管理ポータル実装時に実値を入れる・現時点は空
  };

  // 5. GAS 送信
  _smCostSetSubmitLoading(true);
  try {
    const result = await callGAS('addCost', payload);
    if (result?.status !== 'ok') {
      throw new Error(result?.message || '登録エラー');
    }

    if (typeof showToast === 'function') {
      showToast('コストを登録しました ✓', 'success');
    }

    if (document.body.classList.contains('is-ipad')) {
      // iPad：パネルを保持したままフォームをリセットし、左の一覧を再描画
      _smCostInitFormInModal();
      const m = document.getElementById('ipad-filter-month')?.value;
      if (typeof _loadIpadCostData === 'function') await _loadIpadCostData(m);
    } else {
      SheetModal.close();
      if (typeof loadAll === 'function') loadAll();
    }

  } catch (err) {
    console.error('[cost SheetModal] addCost error:', err);
    _smCostShowToast('登録に失敗しました：' + (err?.message || '通信エラー'));
  } finally {
    _smCostSetSubmitLoading(false);
  }
}

function _smCostSetSubmitLoading(loading) {
  const btn = document.getElementById('sm-cost-submit');
  if (!btn) return;  // モーダルクローズ後は要素が消えているため null ガード
  btn.disabled    = loading;
  btn.textContent = loading ? '送信中...' : '登録する';
}

/**
 * コスト専用トースト（B-1 準拠・独立実装）
 * モーダル内下部に赤系バナーを fixed 表示・3秒で自動消去
 */
function _smCostShowToast(message) {
  // 既存のコストトーストを削除（連続表示でのスタック防止）
  document.querySelectorAll('.cost-sm-toast').forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className   = 'cost-sm-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

function _smCostBindSubmit() {
  const btn = document.getElementById('sm-cost-submit');
  if (!btn) return;
  btn.addEventListener('click', () => _smCostHandleSubmit());
}

function _smCostBindMemoInput() {
  const memo = document.getElementById('sm-cost-memo');
  if (!memo) return;
  memo.addEventListener('input', () => {
    memo.classList.remove('cost-sm-field-error');
  });
}

function _smCostBindDateInput() {
  const date = document.getElementById('sm-cost-date');
  if (!date) return;
  const removeErr = () => date.classList.remove('cost-sm-field-error');
  date.addEventListener('change', removeErr);
  date.addEventListener('input',  removeErr);
}

// ── 買掛トグルのバインド ─────────────────────────────
function _smCostBindUnpaidToggle() {
  const el = document.getElementById('sm-cost-unpaid');
  if (!el) return;
  el.addEventListener('change', () => {
    _smCostUnpaid = el.checked;
  });
}

// ── グローバル露出 ───────────────
// index.html からの onclick="openCostModal()" 呼び出しに対応するため window に露出
window.openCostModal = openCostModal;
