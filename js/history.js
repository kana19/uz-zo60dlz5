/**
 * ウルトラZAIMUくん LEO版 PWA — history.js
 * 月次管理（取引・勤怠タブ統合）画面ロジック
 *
 * タブ1：売上・コスト（getHistory）
 *   ※ GAS側で以下のフィールドを含めてください：
 *   { type, rowIndex, date, serviceCode?, divisionCode?, divisionName?, itemCode?,
 *     itemName, taxRate, amount(=taxIncluded), memo, uncollected?(売上) / unpaid?(コスト) }
 *
 * タブ2：入店履歴（getAttendanceByMonth）
 *   ※ GAS側で rowIndex を含めてください：
 *   { rowIndex, date, staffId, staffName, clockIn, clockOut }
 *
 * 業態テンプレート連動：
 *   動的生成するテキスト（ボタン・履歴行・トースト・モーダル等）は
 *   app.js の deriveUILabels() からラベルを取得して書き換える。
 */

'use strict';

/* ── 定数 ────────────────────────────────────────────────── */
const _now       = new Date();
const THIS_YEAR  = _now.getFullYear();
const THIS_MONTH = _now.getMonth() + 1;
const MIN_YEAR   = 2025;

/* ── 状態 ────────────────────────────────────────────────── */
let currentYear  = THIS_YEAR;
let currentMonth = THIS_MONTH;
let activeTab    = 'salescost';

// 修正フォーム用キャッシュ（renderのたびに再構築）
let editableItems = []; // 売上・コスト行
let attendItems   = []; // 入店履歴行

// 修正フォームの状態
let currentEditItem = null;
let isEditSaving    = false;

// 新規入店登録フォーム
let _ciStaffList = []; // localStorage から読み込み
let _ciInline    = false; // CI登録フォームを iPad 右カラムに埋め込み表示中か（true）／モーダル表示（false）

// iPad 右カラムの既定入力タブ（売上を追加／コストを追加）
let _histInputTab = 'sales';

/* ── 新規入店登録：時刻セレクト（0〜29h / 5分刻み） ─────── */
const _CI_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const _CI_MINS  = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

function buildCITimeSelectHTML(idPrefix) {
  const blank = '<option value="">--</option>';
  const optsH = blank + _CI_HOURS.map(v => `<option value="${v}">${v}</option>`).join('');
  const optsM = blank + _CI_MINS.map(v  => `<option value="${v}">${v}</option>`).join('');
  return `<div style="display:flex;align-items:center;gap:6px;">` +
    `<select id="${idPrefix}-h" class="date-input" style="width:72px;">${optsH}</select>` +
    `<span style="color:var(--uz-text);font-weight:600;font-size:16px;">:</span>` +
    `<select id="${idPrefix}-m" class="date-input" style="width:72px;">${optsM}</select>` +
    `</div>`;
}

/** 退店時刻の「時」option HTMLを入店時刻基準で生成 */
function buildClockOutHourOptionsHTML(ciH) {
  const ciHInt = parseInt(ciH, 10);
  let html = '<option value="">--</option>';
  if (isNaN(ciHInt) || ciHInt === 0) {
    for (let h = 0; h <= 23; h++) {
      html += `<option value="${String(h).padStart(2, '0')}">${String(h).padStart(2, '0')}</option>`;
    }
    return html;
  }
  for (let h = ciHInt; h <= 23; h++) {
    html += `<option value="${String(h).padStart(2, '0')}">${String(h).padStart(2, '0')}</option>`;
  }
  html += '<option value="" disabled>── 翌日 ──</option>';
  for (let h = 0; h < ciHInt; h++) {
    html += `<option value="${String(h).padStart(2, '0')}">${String(h).padStart(2, '0')}</option>`;
  }
  return html;
}

/** 退店時刻の「時」セレクトを入店時刻基準で再生成（既存値保持） */
function _refreshClockOutHourSelect(ciHId, coHId) {
  const coHSel = document.getElementById(coHId);
  if (!coHSel) return;
  const prevValue = coHSel.value;
  const ciH = document.getElementById(ciHId)?.value || '';
  coHSel.innerHTML = buildClockOutHourOptionsHTML(ciH);
  if (prevValue && !isNaN(parseInt(prevValue, 10))) {
    const match = Array.from(coHSel.options).find(o => o.value === prevValue && !o.disabled);
    if (match) coHSel.value = prevValue;
  }
}

function _getStaffFromStorage() {
  try {
    const saved = localStorage.getItem(STAFF_MASTER_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindNav();
  bindEditPanel();
  bindListClicks();
  bindFilterBtns();
  document.getElementById('ci-open-btn')?.addEventListener('click', openCIModal);
  document.getElementById('attend-staff-filter')?.addEventListener('change', (e) => {
    _attendStaffFilter = e.target.value;
    _renderAttendanceFiltered();
  });
  document.getElementById('attend-emp-filter')?.addEventListener('change', (e) => {
    _attendEmpFilter = e.target.value;
    _renderAttendanceFiltered();
  });
  document.getElementById('attend-month-filter')?.addEventListener('change', (e) => {
    const [y, m] = String(e.target.value).split('-').map(Number);
    if (y && m) { currentYear = y; currentMonth = m; loadAll(); }
  });

  // iPad：右カラムに sales.js / cost.js のフォームを注入して入力正本を流用する（MD §6-3-B）。
  // 各フォーム submit 後フック（_loadIpadSalesData / _loadIpadCostData）を history の
  // loadAll に差し替え、登録後に当月の一覧・集計を再描画する（sales.js / cost.js は無改修）。
  if (document.body.classList.contains('is-ipad')) {
    window._loadIpadSalesData = function () { return loadAll(); };
    window._loadIpadCostData  = function () { return loadAll(); };
  }

  // A-9：初期表示時に必ず switchTab を呼び、上段固定エリア内のフィルタバー/新規登録ボタンの
  // 表示状態を確定させる（呼ばないと出勤履歴タブでもフィルタバーが見えてしまうバグの修正）
  const initialTab = (location.hash === '#attendance') ? 'attendance' : 'salescost';
  switchTab(initialTab);
  loadAll();
  updateIpadApprovalBanner();
});

/* ── タブ切り替え ────────────────────────────────────────── */
function bindTabs() {
  document.getElementById('tab-salescost')?.addEventListener('click',  () => switchTab('salescost'));
  document.getElementById('tab-attendance')?.addEventListener('click', () => switchTab('attendance'));
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.hist-tab').forEach(btn => {
    const on = btn.id === `tab-${tab}`;
    btn.classList.toggle('hist-tab--active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.hist-tab-content').forEach(panel => {
    panel.classList.toggle('hist-tab-content--active', panel.id === `panel-${tab}`);
  });
  // A-9：上段固定エリア内のフィルタバー/新規登録ボタンをタブ連動で表示切替
  const filterBar  = document.getElementById('fixed-filter-bar');
  const scAdd      = document.getElementById('fixed-salescost-add');
  const attendBar  = document.getElementById('fixed-attend-bar');
  if (filterBar) filterBar.hidden = (tab !== 'salescost');
  if (scAdd)     scAdd.hidden     = (tab !== 'salescost');
  if (attendBar) attendBar.hidden = (tab !== 'attendance');
  // サイドバー（iPad）：history.html は常に月次管理をアクティブ（勤怠は同画面の勤怠タブ）
  _syncSidebarActive(tab);
  // iPad：右カラムを当該タブの既定入力に戻す（行選択前の状態）
  if (document.body.classList.contains('is-ipad')) _renderHistRightDefault();
}

/* サイドバー（iPad）の active 同期。
   勤怠は月次管理の勤怠タブに統合済み（独立ナビなし）のため、history.html では
   タブに依らず常に「月次管理」をアクティブにする（02_画面仕様.md §2-2）。 */
function _syncSidebarActive(_tab) {
  document.querySelectorAll('#nav-sidebar .sidebar-item').forEach(a => {
    const on = (a.getAttribute('href') || '') === 'history.html';
    a.classList.toggle('sidebar-item--active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else    a.removeAttribute('aria-current');
  });
}

/* ── 月ナビゲーション ────────────────────────────────────── */
function bindNav() {
  document.getElementById('hist-prev')?.addEventListener('click', () => moveMonth(-1));
  document.getElementById('hist-next')?.addEventListener('click', () => moveMonth(+1));
}

function moveMonth(dir) {
  let m = currentMonth + dir;
  let y = currentYear;
  if (m < 1)  { y--; m = 12; }
  if (m > 12) { y++; m = 1;  }
  if (y < MIN_YEAR) return;
  if (y > THIS_YEAR || (y === THIS_YEAR && m > THIS_MONTH)) return;
  currentYear  = y;
  currentMonth = m;
  loadAll();
}

function updateNavUI() {
  const labelEl = document.getElementById('hist-label');
  if (labelEl) labelEl.textContent = `${currentYear}年${currentMonth}月`;
  const isMin = currentYear === MIN_YEAR  && currentMonth === 1;
  const isMax = currentYear === THIS_YEAR && currentMonth === THIS_MONTH;
  if (document.getElementById('hist-prev')) document.getElementById('hist-prev').disabled = isMin;
  if (document.getElementById('hist-next')) document.getElementById('hist-next').disabled = isMax;
}

/* ── GASからデータ取得 ───────────────────────────────────── */
async function loadAll() {
  updateNavUI();
  showLoading();
  editableItems = [];
  attendItems   = [];

  const monthParam = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

  try {
    const [histResult, attendResult] = await Promise.allSettled([
      uzFetchHistory(monthParam),
      callGAS('getAttendanceByMonth', { month: monthParam }),
    ]);

    if (histResult.status === 'fulfilled' && Array.isArray(histResult.value)) {
      renderSalesCost(histResult.value);
    } else {
      renderSalesCostError();
    }

    if (attendResult.status === 'fulfilled' &&
        attendResult.value?.status === 'ok' &&
        Array.isArray(attendResult.value.data)) {
      renderAttendance(attendResult.value.data);
    } else {
      renderAttendanceError();
    }

  } catch (e) {
    renderSalesCostError();
    renderAttendanceError();
    showToast('GAS接続エラー：' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

/* ── 修正ボタン（全期間・全データ修正可能） ──────────────── */
/* getLockStatus：常にロックなしを返す（ロック廃止・互換性維持） */
function getLockStatus(_dateStr) {
  return { locked: false, grace: false, daysLeft: null };
}

function buildLockWidget(ls, idx, scope) {
  // A-9でロック機能廃止。修正ボタンは `.attend-edit-btn`（出勤履歴）／
  // 売上コスト履歴側の `.hist-edit-btn` 描画箇所に一本化したため、
  // 本関数は後方互換のため残置するが空文字を返す。
  // ※ 売上コスト履歴の修正ボタンは別途 _renderFilteredList 内で `.hist-edit-btn` を直接描画している
  return '';
}

/* ── リストのクリック委譲（1回だけ登録） ────────────────── */
function bindListClicks() {
  document.getElementById('history-list')?.addEventListener('click', e => {
    // 削除ボタン（最優先・行クリック委譲より先に処理）
    const delBtn = e.target.closest('.hist-del-btn[data-scope="sc"]');
    if (delBtn) {
      _histDeleteSalesCost(parseInt(delBtn.dataset.idx, 10));
      return;
    }

    // iPad：テーブル行クリック
    const row = e.target.closest('.ipad-hist-row[data-scope="sc"]');
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      if (!isNaN(idx) && editableItems[idx]) {
        document.querySelectorAll('.ipad-hist-row--selected').forEach(r => r.classList.remove('ipad-hist-row--selected'));
        row.classList.add('ipad-hist-row--selected');
        renderIpadRightPanel(editableItems[idx]);
      }
      return;
    }

    // スマホ：修正ボタンクリック
    const btn = e.target.closest('.hist-edit-btn[data-scope="sc"]');
    if (!btn) return;
    const idx2 = parseInt(btn.dataset.idx, 10);
    if (!isNaN(idx2) && editableItems[idx2]) {
      if (document.body.classList.contains('is-ipad')) {
        renderIpadRightPanel(editableItems[idx2]);
      } else {
        openEditForm(editableItems[idx2]);
      }
    }
  });

  document.getElementById('attendance-list')?.addEventListener('click', e => {
    // 削除ボタン（最優先）
    const delBtn = e.target.closest('.hist-del-btn[data-scope="at"]');
    if (delBtn) {
      _histDeleteAttendance(parseInt(delBtn.dataset.idx, 10));
      return;
    }

    // iPad：テーブル行クリック
    const row = e.target.closest('.ipad-hist-row[data-scope="at"]');
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      if (!isNaN(idx) && attendItems[idx]) {
        document.querySelectorAll('.ipad-hist-row--selected').forEach(r => r.classList.remove('ipad-hist-row--selected'));
        row.classList.add('ipad-hist-row--selected');
        renderIpadRightPanel(attendItems[idx]);
      }
      return;
    }

    const editBtn = e.target.closest('.hist-edit-btn[data-scope="at"], .attend-edit-btn[data-scope="at"]');
    if (editBtn) {
      const idx = parseInt(editBtn.dataset.idx, 10);
      if (!isNaN(idx) && attendItems[idx]) {
        if (document.body.classList.contains('is-ipad')) {
          renderIpadRightPanel(attendItems[idx]);
        } else {
          openEditForm(attendItems[idx]);
        }
      }
      return;
    }

    const coBtn = e.target.closest('.ci-clockout-btn');
    if (coBtn) {
      quickClockOut(
        parseInt(coBtn.dataset.rowIndex, 10),
        coBtn.dataset.staffId   || '',
        coBtn.dataset.staffName || ''
      );
    }
  });
}

/* ── 行削除（全デバイス・確認必須・00§3-2 確定操作の明示確認）─────
   売上削除時は GAS deleteRow が紐付け経費の V列を空欄化して経費行は残す
   （紐付けのみ解除）。経費連鎖削除はPC案件管理に残す（00§5-4）。 */
async function _histDeleteSalesCost(idx) {
  const item = editableItems[idx];
  if (!item) return;
  if (!item.rowIndex) {
    showToast('rowIndex が取得できません。GAS の getHistory に rowIndex を追加してください。', 'error', 4000);
    return;
  }
  const isSales   = item.type === 'sales';
  const sheetName = isSales ? '売上' : 'コスト';
  const name      = item.itemName || '—';
  const amount    = formatYen(item.amount);
  const date      = item.date || '';
  // 案件管理（紐付け）はPC限定機能のため、PWA側の削除では紐付け解除に関する警告は出さない（02§5-3）。
  if (!confirm(`この${isSales ? '売上' : 'コスト'}を削除しますか？\n${date} / ${name} / ${amount}\n削除すると元に戻せません。`)) return;

  showLoading();
  try {
    const result = await callGAS('deleteRow', { sheetName, rowIndex: item.rowIndex });
    if (result?.status !== 'ok') throw new Error(result?.message || '削除エラー');
    showToast('削除しました ✓', 'success');
    if (typeof uzInvalidateMonth === 'function') {
      uzInvalidateMonth(`${currentYear}-${String(currentMonth).padStart(2, '0')}`);
    }
    if (document.body.classList.contains('is-ipad')) _renderHistRightDefault();
    await loadAll();
  } catch (e) {
    showToast('削除に失敗しました：' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function _histDeleteAttendance(idx) {
  const item = attendItems[idx];
  if (!item) return;
  if (!item.rowIndex) {
    showToast('rowIndex が取得できません。GAS の getAttendanceByMonth に rowIndex を追加してください。', 'error', 4000);
    return;
  }
  const labels = deriveUILabels();
  const who  = item.staffName || '（スタッフ名なし）';
  const date = item.date || '';
  if (!confirm(`${who} の ${date} の${labels.clockin_record}を削除しますか？\n削除すると元に戻せません。`)) return;

  showLoading();
  try {
    const result = await callGAS('deleteRow', { sheetName: 'attendance', rowIndex: item.rowIndex });
    if (result?.status !== 'ok') throw new Error(result?.message || '削除エラー');
    showToast('削除しました ✓', 'success');
    if (document.body.classList.contains('is-ipad')) _renderHistRightDefault();
    await loadAttendanceOnly();
  } catch (e) {
    showToast('削除に失敗しました：' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

/* ══════════════════════════════════════════════════════════
   タブ1：売上・コスト描画
   ══════════════════════════════════════════════════════════ */

/* ── フィルター状態 ──────────────────────────────────────── */
let _currentFilter   = 'all';
let _allSalesCostItems = [];

function bindFilterBtns() {
  document.querySelectorAll('.hist-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentFilter = btn.dataset.filter;
      document.querySelectorAll('.hist-filter-btn').forEach(b =>
        b.classList.toggle('hist-filter-btn--active', b.dataset.filter === _currentFilter)
      );
      _renderFilteredList();
    });
  });
}

function _renderFilteredList() {
  const container = document.getElementById('history-list');
  const totalEl   = document.getElementById('hist-filter-total');
  if (!container) return;

  editableItems = [];

  let filtered = _allSalesCostItems;
  if (_currentFilter === 'uncollected') {
    filtered = _allSalesCostItems.filter(r => r.type === 'sales' && Number(r.uncollected) === 1);
  } else if (_currentFilter === 'payable') {
    filtered = _allSalesCostItems.filter(r => r.type === 'cost' && Number(r.unpaid) === 1);
  }

  /* フィルター時の合計金額表示 */
  if (totalEl) {
    if (_currentFilter !== 'all' && filtered.length > 0) {
      const total = filtered.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      totalEl.textContent = `合計 ${formatYen(total)}`;
      totalEl.style.display = '';
    } else {
      totalEl.style.display = 'none';
    }
  }

  if (filtered.length === 0) {
    container.innerHTML = `<p style="text-align:center;padding:40px 20px;font-size:13px;color:var(--uz-text3);">該当するデータがありません</p>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));

  /* iPad：フラットテーブル表示 */
  if (document.body.classList.contains('is-ipad')) {
    let html = `<table class="ipad-hist-flat-table">
      <thead><tr>
        <th>発生日</th><th>区分</th><th>適用</th><th>メモ</th><th class="ipad-td-r">金額</th><th></th>
      </tr></thead><tbody>`;

    sorted.forEach(item => {
      const idx     = editableItems.push(item) - 1;
      const isSales = item.type === 'sales';
      // 発生日：MM/DD（曜日）。曜日は WEEKDAYS（app.js）を流用。
      const _dp = (item.date || '').split('-').map(Number);
      let md = (item.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
      if (_dp.length === 3 && _dp[0]) {
        md += `(${WEEKDAYS[new Date(_dp[0], _dp[1] - 1, _dp[2]).getDay()]})`;
      }
      const dot = buildTimerDotHTML(item);
      const rowBg = isSales ? '' : 'background:var(--uz-surface);';

      html += `<tr class="ipad-hist-row" data-idx="${idx}" data-scope="sc" style="${rowBg}">
        <td class="ipad-td-date">${md}</td>
        <td class="ipad-td-div">${_divisionBadgeHTML(item)}</td>
        <td class="ipad-td-applic">${escHtml((item.itemName || '').substring(0, 40))}</td>
        <td class="ipad-td-memo" style="font-size:12px;color:var(--uz-text3);">${escHtml((item.memo || '').substring(0, 30))}</td>
        <td class="ipad-td-r" style="font-weight:600;">${formatYen(item.amount)}</td>
        <td class="ipad-td-timer">${dot}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
    return;
  }

  /* スマホ：行型表示 */
  const groups = {};
  sorted.forEach(item => {
    if (!groups[item.date]) groups[item.date] = [];
    groups[item.date].push(item);
  });

  let html = '';
  Object.keys(groups).forEach(date => {
    html += buildDateHeader(date);
    groups[date].forEach(item => {
      const idx = editableItems.push(item) - 1;
      html += buildSalesCostItemHTML(item, idx);
    });
  });

  container.innerHTML = html;
}

function renderSalesCost(items) {
  _allSalesCostItems = items || [];
  _currentFilter     = 'all';
  _renderHistBreakdown();
  document.querySelectorAll('.hist-filter-btn').forEach(b =>
    b.classList.toggle('hist-filter-btn--active', b.dataset.filter === 'all')
  );
  const totalEl = document.getElementById('hist-filter-total');
  if (totalEl) totalEl.style.display = 'none';

  if (!_allSalesCostItems.length) {
    const container = document.getElementById('history-list');
    if (container) container.innerHTML = `<p style="text-align:center;padding:40px 20px;font-size:13px;color:var(--uz-text3);">この月の売上・コスト履歴はありません</p>`;
    return;
  }
  _renderFilteredList();
}

function renderSalesCostError() {
  const box = document.getElementById('hist-breakdown');
  if (box) box.innerHTML = '';
  const container = document.getElementById('history-list');
  if (container) container.innerHTML = `
    <p style="text-align:center;padding:40px 20px;font-size:13px;color:var(--uz-muted);">
      データの取得に失敗しました。<br>通信状態を確認してください。
    </p>`;
}

/* ── 科目別集計（iPad左カラム・売上/仕入原価/販管費の▼アコーディオン）─────
   データ源は _allSalesCostItems（getHistory 由来）。type='sales'→売上、
   type='cost' は divisionCode='1'→仕入原価／それ以外→販管費で判定し、
   itemName でグループ化する（諸口プレフィックスは持ち込まない）。
   フィルタ（全件/売掛/買掛）に依存せず常に全件集計を表示する。スマホは非表示。 */
function _renderHistBreakdown() {
  const box = document.getElementById('hist-breakdown');
  if (!box) return;
  if (!document.body.classList.contains('is-ipad')) { box.innerHTML = ''; return; }

  const groups = { sales: {}, purchase: {}, sga: {} };
  const totals = { sales: 0, purchase: 0, sga: 0 };
  (_allSalesCostItems || []).forEach(r => {
    const kind = (r.type === 'sales')
      ? 'sales'
      : (String(r.divisionCode) === '1' ? 'purchase' : 'sga');
    const name = r.itemName || '—';
    const amt  = Number(r.amount) || 0;
    groups[kind][name] = (groups[kind][name] || 0) + amt;
    totals[kind] += amt;
  });

  const block = (label, kind) => {
    const entries = Object.entries(groups[kind]).sort((a, b) => b[1] - a[1]);
    const hasItems = entries.length > 0;
    const rows = entries.map(([name, amt]) =>
      `<div class="hist-bd-row"><span class="hist-bd-name">${escHtml(name)}</span>` +
      `<span class="hist-bd-amt">${formatYen(amt)}</span></div>`
    ).join('');
    return `<div class="hist-bd-group">
      <button type="button" class="hist-bd-head" ${hasItems ? '' : 'disabled'} aria-expanded="false">
        <span class="hist-bd-caret" aria-hidden="true">▶</span>
        <span class="hist-bd-label">${label}</span>
        <span class="hist-bd-total">${formatYen(totals[kind])}</span>
      </button>
      <div class="hist-bd-body" hidden>${rows || '<div class="hist-bd-row hist-bd-row--empty">内訳なし</div>'}</div>
    </div>`;
  };

  box.innerHTML = block('売上', 'sales') + block('仕入原価', 'purchase') + block('販管費', 'sga');

  box.querySelectorAll('.hist-bd-head').forEach(head => {
    head.addEventListener('click', () => {
      if (head.hasAttribute('disabled')) return;
      const body = head.parentElement.querySelector('.hist-bd-body');
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
      head.querySelector('.hist-bd-caret').textContent = open ? '▶' : '▼';
      if (body) body.hidden = open;
    });
  });
}

/* ── iPad 右カラム：既定入力（行未選択時）──────────────────────
   売上コストタブ＝売上/コストの入力タブ（sales.js / cost.js のフォーム注入）。
   出勤履歴タブ＝新規登録（_buildCIFormBodyHTML を注入）。
   行選択時は renderIpadRightPanel（修正）に切り替わる。 */
function _renderHistRightDefault() {
  if (!document.body.classList.contains('is-ipad')) return;
  const panel = document.querySelector('.ipad-right-panel');
  if (!panel) return;

  _ipadSelectedRecord = null;
  currentEditItem = null;
  document.querySelectorAll('.ipad-hist-row--selected').forEach(r => r.classList.remove('ipad-hist-row--selected'));

  if (activeTab === 'attendance') {
    const labels = deriveUILabels();
    panel.className = 'ipad-right-panel hist-right--input';
    panel.innerHTML = `
      <div class="ipad-right-panel__header">${escHtml(labels.clockin_register)}</div>
      <div id="hist-ci-host"></div>`;
    const host = document.getElementById('hist-ci-host');
    if (host) {
      host.innerHTML = _buildCIFormBodyHTML();
      _ciInline = true;
      _initCIFormInModal();
    }
    return;
  }

  // 売上コストタブ：売上/コストの入力タブ
  panel.className = 'ipad-right-panel hist-right--input';
  panel.innerHTML = `
    <div class="ipad-input-tabs">
      <button class="ipad-tab${_histInputTab === 'sales' ? ' ipad-tab--active' : ''}" type="button" data-histtab="sales">売上を追加</button>
      <button class="ipad-tab${_histInputTab === 'cost'  ? ' ipad-tab--active' : ''}" type="button" data-histtab="cost">コストを追加</button>
    </div>
    <div id="hist-input-host" class="ipad-tab-content"></div>`;
  panel.querySelectorAll('.ipad-tab[data-histtab]').forEach(btn => {
    btn.addEventListener('click', () => _histSwitchInputTab(btn.dataset.histtab));
  });
  _histInjectInputForm(_histInputTab);
}

function _histSwitchInputTab(tab) {
  if (tab !== 'sales' && tab !== 'cost') return;
  _histInputTab = tab;
  document.querySelectorAll('.ipad-right-panel .ipad-tab[data-histtab]').forEach(b =>
    b.classList.toggle('ipad-tab--active', b.dataset.histtab === tab)
  );
  _histInjectInputForm(tab);
}

/* 入力フォームの注入（sales.js / cost.js の正本を流用・MD §6-3-B）。
   送信後の一覧再描画は init で差し替えた _loadIpadSalesData / _loadIpadCostData（=loadAll）。*/
function _histInjectInputForm(tab) {
  const host = document.getElementById('hist-input-host');
  if (!host) return;
  // 入力フォームの正本は uz-input.js（積層ステッパー・単一系統・02 §5-10）。
  if (window.UzInput && UzInput.mount) {
    UzInput.mount(host, tab === 'cost' ? 'cost' : 'sales', { onSubmitted: () => loadAll() });
  }
}

/* ── 区分（売上／仕入／販管費）判定とバッジ（02_画面仕様.md §2-2・§5-9） ──
   売上=type 'sales' ／ 仕入=cost かつ divisionCode '1' ／ 販管費=cost のそれ以外。 */
function _divisionOf(item) {
  if (item.type === 'sales') return 'sales';
  return String(item.divisionCode) === '1' ? 'purchase' : 'sga';
}
function _divisionBadgeHTML(item) {
  const k = _divisionOf(item);
  const label = k === 'sales' ? '売上' : (k === 'purchase' ? '仕入' : '販管費');
  return `<span class="uz-div-badge uz-div-badge--${k}">${label}</span>`;
}

/* ── カラータイマードット（売掛・買掛ありのみ表示） ──────── */
function buildTimerDotHTML(item) {
  const hasFlag = item.type === 'sales'
    ? Number(item.uncollected) === 1
    : Number(item.unpaid)      === 1;

  /* 売掛・買掛なし → 固定幅の空スペース（列揃え維持） */
  if (!hasFlag) return `<span class="hist-row__timer"></span>`;

  const state = window.uzTimer.stateAR(true, new Date(), item.date);
  return `<span class="hist-row__timer">${window.uzTimer.dotHTML(state, 'hist')}</span>`;
}

/* ── 売上・コスト行HTML（行型・列順：科目名→金額→ドット→編集） */
function buildSalesCostItemHTML(item, idx) {
  const isSales = item.type === 'sales';
  const dot     = buildTimerDotHTML(item);
  const rowCls  = isSales ? 'hist-row--sales' : 'hist-row--cost';
  const name    = escHtml((item.itemName || '').substring(0, 30));
  const memo    = item.memo ? `<div class="hist-row__memo">${escHtml((item.memo).substring(0, 20))}</div>` : '';

  return `
    <div class="hist-row ${rowCls}" data-idx="${idx}">
      ${_divisionBadgeHTML(item)}
      <div class="hist-row__name">
        ${name}
        ${memo}
      </div>
      <span class="hist-row__amount">${formatYen(item.amount)}</span>
      ${dot}
      <div class="hist-row__edit">
        <button class="hist-edit-btn" type="button" data-idx="${idx}" data-scope="sc">編集</button>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════
   タブ2：入店履歴描画
   ══════════════════════════════════════════════════════════ */

let _allAttendRecs    = [];   // 当月の勤怠レコード全件（絞り込み前）
let _attendStaffFilter = 'all'; // スタッフ別プルダウンの選択値
let _attendEmpFilter   = 'all'; // 雇用形態プルダウンの選択値（attendance D列スナップショット）

/* スタッフ別プルダウンの選択肢を当月データから生成 */
function _populateAttendStaffOptions(recs) {
  const sel = document.getElementById('attend-staff-filter');
  if (!sel) return;
  const names = [...new Set(recs.map(r => r.staffName || '不明'))]
    .sort((a, b) => a.localeCompare(b, 'ja'));
  if (_attendStaffFilter !== 'all' && !names.includes(_attendStaffFilter)) {
    _attendStaffFilter = 'all';
  }
  sel.innerHTML = '<option value="all">全スタッフ</option>'
    + names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  sel.value = _attendStaffFilter;
}

function renderAttendance(items) {
  _allAttendRecs = items || [];
  _populateAttendStaffOptions(_allAttendRecs);
  _populateAttendMonthOptions();
  _renderAttendanceFiltered();
}

/* 年月プルダウン：MIN_YEAR-01 〜 当月 を生成し currentYear/Month を選択 */
function _populateAttendMonthOptions() {
  const sel = document.getElementById('attend-month-filter');
  if (!sel) return;
  const cur = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  let html = '';
  for (let y = THIS_YEAR; y >= MIN_YEAR; y--) {
    const startM = (y === THIS_YEAR) ? THIS_MONTH : 12;
    for (let m = startM; m >= 1; m--) {
      const v = `${y}-${String(m).padStart(2, '0')}`;
      html += `<option value="${v}">${y}年${m}月</option>`;
    }
  }
  sel.innerHTML = html;
  sel.value = cur;
}

function _renderAttendanceFiltered() {
  const container = document.getElementById('attendance-list');
  if (!container) return;
  attendItems = [];

  const labels = deriveUILabels();

  // スタッフ・雇用形態の絞り込み（all＝絞り込みなし）
  let items = _allAttendRecs;
  if (_attendStaffFilter !== 'all') {
    items = items.filter(r => (r.staffName || '不明') === _attendStaffFilter);
  }
  if (_attendEmpFilter !== 'all') {
    items = items.filter(r => (r.employmentType || '') === _attendEmpFilter);
  }

  if (items.length === 0) {
    container.innerHTML = `
      <p style="text-align:center;padding:40px 20px;font-size:13px;color:var(--uz-muted);">
        この月の${escHtml(labels.clockin_history)}はありません
      </p>`;
    return;
  }

  // iPad：フラットテーブル表示
  if (document.body.classList.contains('is-ipad')) {
    const allRecs = [...items].sort((a, b) => b.date.localeCompare(a.date));

    let html = `<table class="ipad-hist-flat-table">
      <thead><tr>
        <th>出勤</th><th>曜日</th><th>スタッフ</th><th>雇用形態</th><th>出退勤</th><th>勤務時間</th><th></th>
      </tr></thead><tbody>`;

    allRecs.forEach(r => {
      const enriched = { ...r, type: 'attendance' };
      const atIdx = attendItems.push(enriched) - 1;

      const md = (r.date || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
      const _dp = (r.date || '').split(/[-\/]/).map(Number);
      const dow = (_dp.length === 3) ? WEEKDAYS[new Date(_dp[0], _dp[1] - 1, _dp[2]).getDay()] : '';
      const clockIn  = parseTimeStr(r.clockIn)  || '—';
      const clockOut = parseTimeStr(r.clockOut) || '';
      const dur = clockOut ? calcWorkDuration(clockIn, clockOut) : null;
      const wMin = r.workMinutes || dur?.minutes;
      let durLabel = '—';
      if (wMin && !dur?.isAbnormal) {
        durLabel = `${(wMin / 60).toFixed(2)}h`;
      }

      const isActive = !clockOut;
      // タイマー列は稼働時間カラータイマー（§5-4）：退勤済=枠のみ／勤務中<7h=青／7h=赤／7h57m〜=赤点滅
      const _wmin = window.uzTimer.workedMin(r.date, r.clockIn, new Date());
      const statusBadge = window.uzTimer.dotHTML(window.uzTimer.stateWork(_wmin, !isActive), 'hist');

      const pinTag = r.qrLocation ? `<span class="hist-attend-pin" title="現地証明 拠点${escHtml(r.qrLocation)}">📍${escHtml(r.qrLocation)}</span>` : '';
      html += `<tr class="ipad-hist-row" data-idx="${atIdx}" data-scope="at">
        <td class="ipad-td-date">${md}</td>
        <td class="ipad-td-dow">${dow}</td>
        <td class="ipad-td-staff">${escHtml((r.staffName || '不明').substring(0, 8))}${pinTag}</td>
        <td class="ipad-td-emp">${escHtml(_empShort(r.employmentType))}</td>
        <td class="ipad-td-times">${escHtml(clockIn)} → ${clockOut ? escHtml(clockOut) : '—'}</td>
        <td class="ipad-td-dur">${durLabel}</td>
        <td class="ipad-td-timer">${statusBadge}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
    return;
  }

  // スマホ：日付グルーピング型（売上・コスト履歴と完全同型）
  // A-9整流化：黄色●点滅マーカー・「出勤中/退勤済」バッジ・「退勤未記録」テキストを撤廃
  // 退勤空欄行は businessHours ベースで「勤務中」「打刻忘れ」を判定し、行末バッジで表現
  const dateMap = {};
  items.forEach(item => {
    const d = item.date || '';
    if (!dateMap[d]) dateMap[d] = [];
    dateMap[d].push(item);
  });

  const dateKeys = Object.keys(dateMap).sort((a, b) => b.localeCompare(a));
  const now = new Date();

  let html = '';
  dateKeys.forEach(dateKey => {
    const [y, m, d] = dateKey.split(/[-\/]/).map(Number);
    const dow       = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    const dateLabel = `${y}年${m}月${d}日(${dow})`;

    // 同日内をスタッフごとに集約 → 退勤空欄を上に
    const recsOfDay = dateMap[dateKey];
    const byStaff = {};
    recsOfDay.forEach(r => {
      const sname = r.staffName || '不明';
      if (!byStaff[sname]) byStaff[sname] = [];
      byStaff[sname].push(r);
    });

    const staffNames = Object.keys(byStaff).sort((a, b) => {
      const aOpen = byStaff[a].some(r => !parseTimeStr(r.clockOut));
      const bOpen = byStaff[b].some(r => !parseTimeStr(r.clockOut));
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return a.localeCompare(b, 'ja');
    });

    html += `<div class="hist-date-group">
      <div class="hist-date-header">${dateLabel}</div>`;

    staffNames.forEach(sname => {
      const recs = byStaff[sname];
      recs.sort((a, b) => (a.clockIn || '').localeCompare(b.clockIn || ''));

      recs.forEach((r) => {
        const enriched = { ...r, type: 'attendance' };
        const atIdx    = attendItems.push(enriched) - 1;

        const clockIn  = parseTimeStr(r.clockIn);
        const clockOut = parseTimeStr(r.clockOut);
        const isOvernightFlag = r.is_overnight === true ||
          (clockOut ? calcWorkDuration(clockIn, clockOut)?.isOvernight : false);
        const dur = clockOut ? calcWorkDuration(clockIn, clockOut) : null;

        // 時刻表示：Grid整列のため 出勤時刻 / 矢印 / 退勤時刻 を別々に持つ
        // 退勤未記録の場合は退勤時刻列を空白（「—」）にして、状態バッジを別列で表示
        let timeInStr  = escHtml(clockIn);
        let timeOutStr = '';
        let timeOutClass = 'hist-attend-time-out';
        if (clockOut) {
          if (dur?.isAbnormal) {
            timeInStr  = `<span class="attend-time-abnormal">${escHtml(clockIn)}</span>`;
            timeOutStr = `<span class="attend-time-abnormal">${escHtml(dur.clockOutDisplay)}</span>`;
          } else if (isOvernightFlag) {
            timeOutStr = `<span class="attend-time-overnight">翌</span>${escHtml(clockOut)}`;
          } else {
            timeOutStr = escHtml(clockOut);
          }
        } else {
          timeOutStr = '—';
          timeOutClass += ' hist-attend-time-out--empty';
        }

        // 勤務時間（4.50h 小数点表記・時刻と同サイズ・細字グレーで時刻と区別）
        // A-9：カッコ削除＋小文字h（freee等のSaaSタイムカード標準表記に統一）
        const wMin = r.workMinutes || dur?.minutes;
        let durLabel = '';
        if (wMin && !dur?.isAbnormal) {
          const hours10 = (wMin / 60).toFixed(2);
          durLabel = `${hours10}h`;
        }

        // 状態は文字バッジを廃し、稼働時間カラータイマー（§5-4）のドットのみで表す。
        // 勤務中<7h=青／7h=赤／7h57m〜=赤点滅／退勤済=枠のみ。未記録もドットが赤点滅で表現される。
        const _wmin = window.uzTimer.workedMin(r.date, r.clockIn, now);
        const workDot = window.uzTimer.dotHTML(window.uzTimer.stateWork(_wmin, !!clockOut), 'hist');
        const durOrState = workDot + (clockOut
          ? `<span class="hist-attend-dur">${durLabel}</span>`
          : '');

        // 雇用形態（attendance D列スナップショット・補助表示）
        const empLabel = _empShort(r.employmentType);

        // Grid 6カラム行：スタッフ名 | 出勤時刻 | → | 退勤時刻 | 勤務時間or状態 | 編集
        const pinTag = r.qrLocation ? `<span class="hist-attend-pin" title="現地証明 拠点${escHtml(r.qrLocation)}">📍${escHtml(r.qrLocation)}</span>` : '';
        html += `
          <div class="hist-attend-row">
            <div class="hist-attend-name">${escHtml(sname.length > 8 ? sname.substring(0, 8) + '…' : sname)}<span class="hist-attend-emp">${escHtml(empLabel)}</span>${pinTag}</div>
            <span class="hist-attend-time-in">${timeInStr}</span>
            <span class="hist-attend-arrow">→</span>
            <span class="${timeOutClass}">${timeOutStr}</span>
            <span class="hist-attend-state-col">${durOrState}</span>
            <span class="hist-attend-ops">
              <button class="hist-edit-btn" type="button" data-idx="${atIdx}" data-scope="at" aria-label="編集">編集</button>
            </span>
          </div>`;
      });
    });

    html += `</div>`;
  });

  container.innerHTML = html;
}

function renderAttendanceError() {
  const container = document.getElementById('attendance-list');
  const labels = deriveUILabels();
  if (container) container.innerHTML = `
    <p style="text-align:center;padding:40px 20px;font-size:13px;color:var(--uz-muted);">
      ${escHtml(labels.clockin_history)}の取得に失敗しました。<br>通信状態を確認してください。
    </p>`;
}

/* ══════════════════════════════════════════════════════════
   修正フォーム
   ══════════════════════════════════════════════════════════ */

function bindEditPanel() {
  document.getElementById('edit-cancel-btn')?.addEventListener('click', closeEditForm);
  document.getElementById('edit-backdrop')?.addEventListener('click',   closeEditForm);
  document.getElementById('edit-save-btn')?.addEventListener('click',   saveEdit);
  document.getElementById('edit-delete-btn')?.addEventListener('click', _editPanelDelete);
}

/* 編集フォーム内の削除（全デバイス可・確認は各削除関数が実施・00§3-2）。
   開いている currentEditItem を一覧配列から引き当て、既存の削除フローへ委譲する。 */
async function _editPanelDelete() {
  const item = currentEditItem;
  if (!item) return;
  const isAtt = item.type === 'attendance';
  const arr = isAtt ? attendItems : editableItems;
  const idx = arr.indexOf(item);
  if (idx < 0) return;
  closeEditForm();
  if (isAtt) await _histDeleteAttendance(idx);
  else       await _histDeleteSalesCost(idx);
}

/* iPad 右パネル修正フォーム内の削除。_ipadSelectedRecord を引き当てて委譲する。 */
async function _ipadRightDelete() {
  const rec = _ipadSelectedRecord;
  if (!rec) return;
  const isAtt = rec.type === 'attendance';
  const arr = isAtt ? attendItems : editableItems;
  const idx = arr.indexOf(rec);
  if (idx < 0) return;
  if (isAtt) await _histDeleteAttendance(idx);
  else       await _histDeleteSalesCost(idx);
}

function openEditForm(item) {
  if (!item) return;

  // rowIndex チェック（GAS未更新の場合に案内）
  if (!item.rowIndex) {
    showToast(
      'rowIndex が取得できません。GAS の getHistory / getAttendanceByMonth に rowIndex を追加してください。',
      'error', 5000
    );
    return;
  }

  currentEditItem = item;

  const titleEl = document.getElementById('edit-panel-title');
  const bodyEl  = document.getElementById('edit-form-body');
  if (!titleEl || !bodyEl) return;

  const footerEl = document.querySelector('.edit-panel__footer');

  if ((item.type === 'sales' || item.type === 'cost') && window.UzInput && UzInput.mountEdit) {
    titleEl.textContent = item.type === 'sales' ? '売上を修正' : 'コストを修正';
    bodyEl.innerHTML    = '<div id="edit-uz-host"></div>';
    if (footerEl) footerEl.style.display = 'none';   // 保存・削除は uz-input 末尾に統合
    UzInput.mountEdit(document.getElementById('edit-uz-host'), item, {
      onSubmitted: () => { closeEditForm(); loadAll(); },
      onDelete:    () => { _editPanelDelete(); },
    });
    document.getElementById('edit-backdrop')?.classList.add('edit-backdrop--show');
    document.getElementById('edit-panel')?.classList.add('edit-panel--open');
    return;
  }

  if (footerEl) footerEl.style.display = '';

  if (item.type === 'sales' || item.type === 'cost') {
    // 通常は上の uz-input 経路で return 済み。ここに来るのは入力エンジン未読込時のみ。
    showToast('入力エンジンが読み込まれていません。再読み込みしてください', 'error');
    return;
  }

  // attendance：§5-11 修正は詳細表示→編集する（詳細段では保存/削除を隠す）
  const labels = deriveUILabels();
  titleEl.textContent = `${labels.clockin_record}を修正`;
  if (footerEl) footerEl.style.display = 'none';
  bodyEl.innerHTML = _buildAttendanceDetailHTML(item) + `
    <div class="ci-row ci-row--submit" style="display:flex;gap:10px;">
      <button id="att-detail-edit"  type="button" class="edit-save-btn"   style="flex:1;">編集する</button>
      <button id="att-detail-close" type="button" class="edit-delete-btn" style="flex:1;">閉じる</button>
    </div>`;
  document.getElementById('att-detail-edit')?.addEventListener('click', () => _smAttendanceEditState(item, footerEl));
  document.getElementById('att-detail-close')?.addEventListener('click', () => closeEditForm());
  document.getElementById('edit-backdrop')?.classList.add('edit-backdrop--show');
  document.getElementById('edit-panel')?.classList.add('edit-panel--open');
}

function closeEditForm() {
  currentEditItem = null;
  document.getElementById('edit-backdrop')?.classList.remove('edit-backdrop--show');
  document.getElementById('edit-panel')?.classList.remove('edit-panel--open');
}

/* ── フォームHTML生成 ────────────────────────────────────── */

function taxToggleGroupHTML(taxRate) {
  return `<div class="tax-toggle-group" role="group" aria-label="税率">
    ${[0, 8, 10].map(r => `
      <button type="button"
              class="tax-toggle${r === taxRate ? ' tax-toggle--active' : ''}"
              data-rate="${r}">${r}%</button>
    `).join('')}
  </div>`;
}

/* 雇用形態の表示ラベル（attendance D列スナップショット・読み取り専用） */
function _empLabel(t) {
  return ({ employed_full: '常勤雇用（社員）', employed_temp: '臨時アルバイト', contractor: '委託・外注' })[t] || '—';
}
/* 雇用形態の短縮ラベル（一覧の列・補助表示用） */
function _empShort(t) {
  return ({ employed_full: '社員', employed_temp: 'アルバイト', contractor: '委託外注' })[t] || '';
}

/* 勤怠 詳細表示（§5-11／§5-10）：全項目を読み取り専用。雇用形態は保持値を表示（修正不可）。 */
function _buildAttendanceDetailHTML(item) {
  const labels = deriveUILabels();
  const ci = parseTimeStr(item.clockIn)  || '—';
  const co = parseTimeStr(item.clockOut) || labels.clockout_unrecorded;
  return `
    <div class="ci-section">
      <div class="ci-head"><span class="ci-head__k">スタッフ</span><span class="ci-head__v">${escHtml(item.staffName || '')}</span></div>
      <div class="ci-head"><span class="ci-head__k">雇用形態</span><span class="ci-head__v">${escHtml(_empLabel(item.employmentType))}</span></div>
      <div class="ci-head"><span class="ci-head__k">日付</span><span class="ci-head__v">${escHtml(item.date || '')}</span></div>
      <div class="ci-head"><span class="ci-head__k">${escHtml(labels.clockin_time)}</span><span class="ci-head__v">${escHtml(ci)}</span></div>
      <div class="ci-head"><span class="ci-head__k">${escHtml(labels.clockout_time)}</span><span class="ci-head__v">${escHtml(co)}</span></div>
    </div>`;
}

/* スマホ勤怠：詳細表示の「編集する」→黒帯フォーム編集状態へ（保存/削除フッターを表示） */
function _smAttendanceEditState(item, footerEl) {
  const bodyEl = document.getElementById('edit-form-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = buildAttendanceFormHTML(item);
  _refreshClockOutHourSelect('ef-clockin-h', 'ef-clockout-h');
  document.getElementById('ef-clockin-h')?.addEventListener('change', () => {
    _refreshClockOutHourSelect('ef-clockin-h', 'ef-clockout-h');
  });
  if (footerEl) footerEl.style.display = '';
  const sb = document.getElementById('edit-save-btn');
  if (sb) { sb.disabled = false; sb.textContent = '保存する'; }
}

function buildAttendanceFormHTML(item) {
  const labels   = deriveUILabels();
  const clockIn  = parseTimeStr(item.clockIn)  || '';
  const clockOut = parseTimeStr(item.clockOut) || '';
  return `
    <div class="ci-section">
      <div class="ci-head"><span class="ci-head__k">スタッフ</span><span class="ci-head__v">${escHtml(item.staffName || '')}</span></div>
      <div class="ci-head"><span class="ci-head__k">日付</span></div>
      <div class="ci-body"><div class="ci-row"><input type="date" id="ef-date" class="ci-date-input" value="${escHtml(item.date || '')}"></div></div>
      <div class="ci-head"><span class="ci-head__k">${escHtml(labels.clockin_time)}</span></div>
      <div class="ci-body"><div class="ci-row">${timeSelectHTML('ef-clockin', clockIn, true)}</div></div>
      <div class="ci-head"><span class="ci-head__k">${escHtml(labels.clockout_time)}</span><span class="ci-head__opt">${escHtml(labels.clockin_active)}は空欄</span></div>
      <div class="ci-body"><div class="ci-row">${timeSelectHTML('ef-clockout', clockOut, false)}</div></div>
    </div>`;
}

/* ── 税率トグル・税額リアルタイム表示 ───────────────────── */
function bindTaxCalc() {
  document.querySelectorAll('.tax-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tax-toggle').forEach(b => b.classList.remove('tax-toggle--active'));
      btn.classList.add('tax-toggle--active');
      updateTaxNote();
    });
  });
  document.getElementById('ef-amount')?.addEventListener('input', updateTaxNote);
  updateTaxNote();
}

function getSelectedTaxRate() {
  return Number(document.querySelector('.tax-toggle--active')?.dataset.rate ?? 10);
}

function updateTaxNote() {
  const el = document.getElementById('ef-tax-note');
  if (!el) return;
  const taxInc = parseInt(document.getElementById('ef-amount')?.value || '0', 10) || 0;
  const rate   = getSelectedTaxRate();
  // 全デバイス共通の §6-4 整数演算実装（calcTax）を経由する
  // 旧 floor(taxInc / (1 + rate/100)) は 55000円・10% で 5001円 になる FP誤差バグ
  const { taxExcluded: taxExc, tax } = calcTax(taxInc, rate);
  el.textContent = `税抜 ¥${taxExc.toLocaleString()}  /  消費税 ¥${tax.toLocaleString()}`;
}

/* ── 保存処理 ─────────────────────────────────────────────── */
async function saveEdit() {
  if (isEditSaving || !currentEditItem) return;

  const item = currentEditItem;
  isEditSaving = true;
  const saveBtn = document.getElementById('edit-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

  try {
    let result;

    if (item.type === 'sales') {
      const date        = document.getElementById('ef-date')?.value         || item.date;
      const serviceName = document.getElementById('ef-name')?.value?.trim() || item.itemName;
      const taxRate     = getSelectedTaxRate();
      const taxInc      = parseInt(document.getElementById('ef-amount')?.value || '0', 10) || 0;
      const { taxExcluded: taxExc, tax } = calcTax(taxInc, taxRate);
      const memo        = document.getElementById('ef-memo')?.value        || '';
      const uncollected = document.getElementById('ef-flag')?.checked      ? 1 : 0;

      result = await callGAS('updateSales', {
        rowIndex:    item.rowIndex,
        date,
        serviceName,
        serviceCode: item.serviceCode  || '',
        amountExTax: taxExc,
        taxRate,
        tax,
        amountInTax: taxInc,
        memo,
        uncollected,
      });

    } else if (item.type === 'cost') {
      const date      = document.getElementById('ef-date')?.value         || item.date;
      const itemName  = document.getElementById('ef-name')?.value?.trim() || item.itemName;
      const taxRate   = getSelectedTaxRate();
      const taxInc    = parseInt(document.getElementById('ef-amount')?.value || '0', 10) || 0;
      const { taxExcluded: taxExc, tax } = calcTax(taxInc, taxRate);
      const memo      = document.getElementById('ef-memo')?.value      || '';
      const unpaid    = document.getElementById('ef-flag')?.checked    ? 1 : 0;

      result = await callGAS('updateCost', {
        rowIndex:     item.rowIndex,
        date,
        divisionCode: item.divisionCode || '',
        divisionName: item.divisionName || '',
        itemCode:     item.itemCode     || '',
        itemName,
        taxExcluded:  taxExc,
        taxRate,
        tax,
        taxIncluded:  taxInc,
        memo,
        unpaid,
      });

    } else {
      // attendance
      const labels   = deriveUILabels();
      const date     = document.getElementById('ef-date')?.value || item.date;
      const clockIn  = getTimeSelectValue('ef-clockin');
      const clockOut = getTimeSelectValue('ef-clockout');

      if (!clockIn) {
        showToast(`${labels.clockin_time}を選択してください`, 'error');
        isEditSaving = false;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存する'; }
        return;
      }

      result = await callGAS('updateAttendance', {
        rowIndex:  item.rowIndex,
        date,
        staffId:   item.staffId   || '',
        staffName: item.staffName || '',
        clockIn,
        clockOut,
      });

      // 労働時間の異常チェック（保存はブロックしない・警告のみ）
      if (result?.status === 'ok' && clockOut) {
        const dur = calcWorkDuration(clockIn, clockOut);
        if (dur?.isAbnormal) {
          closeEditForm();
          alert(`⚠️ 労働時間が${dur.hours}時間${dur.mins}分です。\n異常値の可能性があります。\n保存されましたが確認してください。`);
          await loadAll();
          if (document.body.classList.contains('is-ipad')) _renderHistRightDefault();
          return;
        }
      }
    }

    if (result?.status !== 'ok') throw new Error(result?.message || '登録エラー');

    closeEditForm();
    showToast('修正を保存しました ✓', 'success');
    if (typeof uzInvalidateMonth === 'function') {
      uzInvalidateMonth(`${currentYear}-${String(currentMonth).padStart(2, '0')}`);
    }
    await loadAll(); // 一覧をリロード
    if (document.body.classList.contains('is-ipad')) _renderHistRightDefault();

  } catch (e) {
    showToast('保存に失敗しました：' + e.message, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存する'; }
  } finally {
    isEditSaving = false;
  }
}

/* ── 共通：日付ヘッダー ──────────────────────────────────── */
function buildDateHeader(dateStr) {
  const [y, m, d] = dateStr.split(/[-\/]/).map(Number);
  const dow = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `
    <div style="padding:12px 20px 6px;">
      <span style="font-size:12px;font-weight:700;color:var(--uz-muted);letter-spacing:0.06em;">
        ${y}年${m}月${d}日（${dow}）
      </span>
    </div>`;
}

/* ── 時刻文字列正規化（GASのシリアル日時対応） ──────────── */
function parseTimeStr(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';

  // パターン1: "HH:MM" or "HH:MM:SS" 形式（そのまま返す）
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 5);

  // パターン2: GASのシリアル日時（例: "Sat Dec 30 1899 20:21:00 GMT+0900"）
  // ブラウザ依存のnew Date()を避け、正規表現でHH:MMを直接抽出
  const serialMatch = s.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (serialMatch && /Dec 30 1899|1899\/12\/30|1899-12-30/.test(s)) {
    return `${serialMatch[1].padStart(2, '0')}:${serialMatch[2]}`;
  }

  // パターン3: ISO形式（例: "2026-04-17T10:30:00.000Z"）
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime()))
      return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  // パターン4: その他Date文字列（フォールバック）
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

  return '';
}

/* ══════════════════════════════════════════════════════════
   新規入店登録フォーム
   ══════════════════════════════════════════════════════════ */

/** シートモーダルに差し込むフォーム HTML を生成 */
function _buildCIFormBodyHTML() {
  const labels = deriveUILabels();
  return `
    <div class="ci-section" aria-label="${escHtml(labels.clockin_register)}">
      <div class="ci-head" data-stick="0"><span class="ci-head__k">スタッフ</span><span class="ci-head__v" id="ci-hv-staff"></span></div>
      <div class="ci-body">
        <div class="ci-row ci-row--radio">
          <label class="ci-radio-label">
            <input type="radio" name="ci-mode" id="ci-mode-registered" value="registered" checked>
            <span>登録済みから選ぶ</span>
          </label>
          <label class="ci-radio-label">
            <input type="radio" name="ci-mode" id="ci-mode-manual" value="manual">
            <span>未登録を手入力</span>
          </label>
        </div>
        <div id="ci-registered-wrap" class="ci-row">
          <select id="ci-staff-select" class="ci-select" aria-label="スタッフを選択">
            <option value="">スタッフを選択...</option>
          </select>
        </div>
        <div id="ci-manual-wrap" class="ci-row" style="display:none;">
          <input type="text" id="ci-staff-name" class="ci-input"
                 placeholder="スタッフ名を入力" maxlength="20" autocomplete="off"
                 aria-label="スタッフ名">
        </div>
        <div class="ci-row">
          <label class="ci-field-label" for="ci-emp-type">雇用形態</label>
          <select id="ci-emp-type" class="ci-select" aria-label="雇用形態">
            <option value="">選択してください</option>
            <option value="employed_full">常勤雇用（社員）</option>
            <option value="employed_temp">臨時アルバイト</option>
            <option value="contractor">委託・外注</option>
          </select>
        </div>
      </div>

      <div class="ci-head" data-stick="1"><span class="ci-head__k">日付</span><span class="ci-head__v" id="ci-hv-date"></span></div>
      <div class="ci-body">
        <div class="ci-row"><input type="date" id="ci-date" class="ci-date-input" aria-label="日付"></div>
      </div>

      <div class="ci-head" data-stick="2"><span class="ci-head__k">${escHtml(labels.clockin_time)}</span><span class="ci-head__v" id="ci-hv-in"></span></div>
      <div class="ci-body">
        <div class="ci-row"><div id="ci-clockin-wrap"></div></div>
      </div>

      <div class="ci-head" data-stick="3"><span class="ci-head__k">${escHtml(labels.clockout_time)}<span class="ci-head__opt">${escHtml(labels.clockin_active)}は空欄</span></span><span class="ci-head__v" id="ci-hv-out"></span></div>
      <div class="ci-body">
        <div class="ci-row" style="gap:8px;flex-wrap:wrap;">
          <div id="ci-clockout-wrap"></div>
          <span id="ci-next-day-badge" class="ci-badge-nextday" style="display:none;">翌日</span>
        </div>
      </div>

      <div id="ci-error-toast"></div>
      <div class="ci-row ci-row--submit">
        <button id="ci-submit-btn" type="button" class="ci-submit-btn">登録する</button>
      </div>
    </div>`;
}

/** SheetModal の onRender で呼ぶ：フォーム初期化＋イベントバインド */
function _initCIFormInModal() {
  // スタッフリスト更新してプルダウンに反映
  _ciStaffList = _getStaffFromStorage();
  const sel = document.getElementById('ci-staff-select');
  if (sel) {
    sel.innerHTML = '<option value="">スタッフを選択...</option>';
    _ciStaffList.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value       = String(i);
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  }

  // 今日の日付
  const dateInput = document.getElementById('ci-date');
  if (dateInput) dateInput.value = todayStr();

  // 時刻セレクト描画
  const ciWrap = document.getElementById('ci-clockin-wrap');
  if (ciWrap) ciWrap.innerHTML = buildCITimeSelectHTML('ci-clockin');
  const coWrap = document.getElementById('ci-clockout-wrap');
  if (coWrap) coWrap.innerHTML = buildCITimeSelectHTML('ci-clockout');

  // ラジオ切り替え
  document.querySelectorAll('input[name="ci-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isRegistered = radio.value === 'registered';
      document.getElementById('ci-registered-wrap').style.display = isRegistered ? '' : 'none';
      document.getElementById('ci-manual-wrap').style.display     = isRegistered ? 'none' : '';
      if (isRegistered) {
        _applyStaffEmpType();
      } else {
        const empSel = document.getElementById('ci-emp-type');
        if (empSel) empSel.value = '';
      }
    });
  });

  // スタッフ変更 → 雇用形態自動反映
  document.getElementById('ci-staff-select')?.addEventListener('change', _applyStaffEmpType);

  // ボタンラベル動的更新（分・退店時刻・日付）
  ['ci-date', 'ci-clockin-m', 'ci-clockout-h', 'ci-clockout-m'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', updateCIBtnLabel);
  });
  // 入店時刻「時」変更 → 退店プルダウン再生成
  document.getElementById('ci-clockin-h')?.addEventListener('change', () => {
    _refreshClockOutHourSelect('ci-clockin-h', 'ci-clockout-h');
    updateCIBtnLabel();
  });

  // 登録ボタン
  document.getElementById('ci-submit-btn')?.addEventListener('click', submitClockIn);

  // バリデーションエラー赤枠の解除
  document.getElementById('ci-emp-type')?.addEventListener('change', e => {
    e.target.classList.remove('ci-field-error');
  });
  document.getElementById('ci-clockin-wrap')?.addEventListener('change', () => {
    document.getElementById('ci-clockin-wrap')?.classList.remove('ci-field-error');
  });

  // 入店時刻を現在時刻（5分刻み）でセット
  const { hour, min } = getCurrentTimeRounded();
  const ciH = document.getElementById('ci-clockin-h');
  const ciM = document.getElementById('ci-clockin-m');
  if (ciH) ciH.value = String(hour).padStart(2, '0');
  if (ciM) ciM.value = String(min).padStart(2, '0');

  // 入店時刻基準で退店プルダウン初期化
  _refreshClockOutHourSelect('ci-clockin-h', 'ci-clockout-h');
  updateCIBtnLabel();

  // 黒帯（見出し）への選択値リアルタイム反映：フォーム全体の change/input を集約
  const ciSection = document.querySelector('.ci-section');
  if (ciSection) {
    ciSection.addEventListener('change', _updateCIHeadValues);
    ciSection.addEventListener('input',  _updateCIHeadValues);
  }
  _updateCIHeadValues();
}

/* 勤怠フォームの黒帯（スタッフ／日付／出勤／退勤）に現在の選択値を表示。
   売上・コスト入力の uzf-head と同じ「黒帯に確定値を出す」挙動に統一。 */
function _updateCIHeadValues() {
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t || ''; };

  const mode = document.querySelector('input[name="ci-mode"]:checked')?.value || 'registered';
  let staffName = '';
  if (mode === 'registered') {
    const sel = document.getElementById('ci-staff-select');
    staffName = (sel && sel.selectedIndex > 0) ? sel.options[sel.selectedIndex].textContent : '';
  } else {
    staffName = (document.getElementById('ci-staff-name')?.value || '').trim();
  }
  const empSel   = document.getElementById('ci-emp-type');
  const empLabel = (empSel && empSel.value) ? empSel.options[empSel.selectedIndex].textContent : '';
  set('ci-hv-staff', staffName ? (empLabel ? `${staffName}・${empLabel}` : staffName) : '');

  const dateVal = document.getElementById('ci-date')?.value || '';
  set('ci-hv-date', dateVal ? dateVal.replace(/-/g, '/') : '');

  const ciH = document.getElementById('ci-clockin-h')?.value;
  const ciM = document.getElementById('ci-clockin-m')?.value;
  set('ci-hv-in', (ciH && ciM && ciH !== '--' && ciM !== '--') ? `${ciH}:${ciM}` : '');

  const coH = document.getElementById('ci-clockout-h')?.value;
  const coM = document.getElementById('ci-clockout-m')?.value;
  set('ci-hv-out', (coH && coM && coH !== '--' && coM !== '--') ? `${coH}:${coM}` : '');
}

function _applyStaffEmpType() {
  const sel   = document.getElementById('ci-staff-select');
  const empSel = document.getElementById('ci-emp-type');
  if (!sel || !empSel) return;
  const idx   = parseInt(sel.value, 10);
  if (isNaN(idx) || !_ciStaffList[idx]) { empSel.value = ''; return; }
  // employmentType 3種化（サイクルA）：旧 'employed' / 未設定は employed_full に寄せる
  const raw = _ciStaffList[idx].employmentType;
  empSel.value = (raw === 'employed_full' || raw === 'employed_temp' || raw === 'contractor')
    ? raw
    : 'employed_full';
}

/**
 * 入店・退店時刻から日跨ぎかどうかを返す
 * @returns {boolean|null} true=日跨ぎ / false=同日 / null=退店未選択
 */
function isOvernightCI(ciH, ciM, coH, coM) {
  if (coH === '' || coM === '') return null;
  const inMin  = Number(ciH) * 60 + Number(ciM);
  const outMin = Number(coH) * 60 + Number(coM);
  return outMin < inMin;
}

/** 翌日バッジの表示/非表示を更新 */
function _updateOvernightBadge() {
  const badge = document.getElementById('ci-next-day-badge');
  if (!badge) return;
  const ciH = document.getElementById('ci-clockin-h')?.value  || '';
  const ciM = document.getElementById('ci-clockin-m')?.value  || '';
  const coH = document.getElementById('ci-clockout-h')?.value || '';
  const coM = document.getElementById('ci-clockout-m')?.value || '';
  const overnight = isOvernightCI(ciH, ciM, coH, coM);
  badge.style.display = overnight === true ? 'inline-block' : 'none';
}

function updateCIBtnLabel() {
  const btn = document.getElementById('ci-submit-btn');
  if (!btn) return;
  // §5-11：登録ボタンは「登録する」固定。日付・時刻・出勤退勤状態を表記しない。
  btn.textContent = '登録する';
  _updateOvernightBadge();
}

/** エラートースト表示（3秒後自動非表示） */
function _showCIError(message) {
  const toast = document.getElementById('ci-error-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(toast._timeoutId);
  toast._timeoutId = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

/** 全フィールドの赤枠解除 */
function _clearCIFieldErrors() {
  document.querySelectorAll('.ci-field-error').forEach(el => el.classList.remove('ci-field-error'));
  const toast = document.getElementById('ci-error-toast');
  if (toast) toast.style.display = 'none';
}

/**
 * バリデーション実行
 * @returns {{ type:'error', field:Element, message:string } | { type:'confirm' } | null}
 */
function _validateCIForm() {
  _clearCIFieldErrors();

  const labels = deriveUILabels();

  // スタッフ選択チェック（最優先・雇用形態はスタッフに紐づく派生値のため後段）
  const mode        = document.querySelector('input[name="ci-mode"]:checked')?.value || 'registered';
  const staffSelect = document.getElementById('ci-staff-select');
  const staffInput  = document.getElementById('ci-staff-name');
  if (mode === 'registered') {
    if (!staffSelect?.value) {
      return { type: 'error', field: staffSelect, message: 'スタッフを選択してください' };
    }
  } else {
    if (!(staffInput?.value?.trim())) {
      return { type: 'confirm' };   // 手入力で空欄は確認のうえ許容
    }
  }

  // 雇用形態チェック（手入力でスタッフ名のみ入れて未選択の場合に発火）
  const empEl = document.getElementById('ci-emp-type');
  if (!empEl?.value) {
    return { type: 'error', field: empEl, message: '雇用形態を選択してください' };
  }

  // 入店時刻チェック
  const ciH = document.getElementById('ci-clockin-h');
  const ciM = document.getElementById('ci-clockin-m');
  if (!ciH?.value || !ciM?.value) {
    return { type: 'error', field: document.getElementById('ci-clockin-wrap'), message: `${labels.clockin_time}を選択してください` };
  }

  return null;
}

async function submitClockIn() {
  // バリデーション
  const validation = _validateCIForm();
  if (validation?.type === 'error') {
    validation.field?.classList.add('ci-field-error');
    _showCIError(validation.message);
    return;
  }
  if (validation?.type === 'confirm') {
    if (!window.confirm('スタッフ名無しで登録しますか？')) return;
  }

  const labels = deriveUILabels();
  const mode = document.querySelector('input[name="ci-mode"]:checked')?.value || 'registered';

  let staffName, staffId;

  if (mode === 'registered') {
    const sel = document.getElementById('ci-staff-select');
    const idx = parseInt(sel?.value, 10);
    if (!isNaN(idx) && _ciStaffList[idx]) {
      staffName = _ciStaffList[idx].name;
      staffId   = String(_ciStaffList[idx].id);
    } else {
      staffName = '';
      staffId   = '';
    }
  } else {
    staffName = document.getElementById('ci-staff-name')?.value.trim() || '';
    staffId   = '';
  }

  const employmentType = document.getElementById('ci-emp-type')?.value || '';
  const date           = document.getElementById('ci-date')?.value     || '';
  if (!date) return showToast('日付を選択してください', 'error');

  const clockIn = getTimeSelectValue('ci-clockin');

  const clockOut = getTimeSelectValue('ci-clockout'); // 任意

  // 退店時刻の異常チェック
  if (clockOut) {
    const dur = calcWorkDuration(clockIn, clockOut);
    if (dur?.isAbnormal) {
      if (!confirm(`⚠️ 労働時間が${dur.hours}時間${dur.mins}分です。\n異常値の可能性があります。続けますか？`)) return;
    }
  }

  // 日跨ぎ判定・退店日計算
  let clockOutDate = date;
  if (clockOut) {
    const [ciH, ciM] = clockIn.split(':').map(Number);
    const [coH, coM] = clockOut.split(':').map(Number);
    if (coH * 60 + coM < ciH * 60 + ciM) {
      const d = new Date(date);
      d.setDate(d.getDate() + 1);
      clockOutDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }

  const btn = document.getElementById('ci-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = '登録中...'; }

  try {
    const result = await callGAS('clockIn', {
      staffId,
      staffName,
      employmentType,
      date,
      clockInTime:  clockIn,
      clockOutTime: clockOut || '',
      clockOutDate: clockOut ? clockOutDate : '',
    });

    if (result?.status !== 'ok') throw new Error(result?.message || '登録エラー');

    showToast(`${staffName} の${labels.clockin_label}を記録しました ✓`, 'success');
    if (_ciInline) {
      // iPad 右カラム埋め込み：フォームをリセットして連続登録できるようにする
      const host = document.getElementById('hist-ci-host');
      if (host) { host.innerHTML = _buildCIFormBodyHTML(); _initCIFormInModal(); }
    } else {
      closeCIModal();
    }
    await loadAttendanceOnly();

  } catch (e) {
    showToast(e.message || '登録に失敗しました', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      updateCIBtnLabel();
    }
  }
}

/* ══════════════════════════════════════════════════════════
   シートモーダル（SheetModal 利用）
   ══════════════════════════════════════════════════════════ */

function getCurrentTimeRounded() {
  const now = new Date();
  return {
    hour: now.getHours(),
    min:  Math.floor(now.getMinutes() / 5) * 5,
  };
}

function openCIModal() {
  const labels = deriveUILabels();
  _ciInline = false;
  SheetModal.open({
    title:    labels.clockin_register,
    bodyHtml: _buildCIFormBodyHTML(),
    onRender: _initCIFormInModal,
  });
}

function closeCIModal() {
  SheetModal.close();
}

async function loadAttendanceOnly() {
  attendItems = [];
  const monthParam = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  try {
    const result = await callGAS('getAttendanceByMonth', { month: monthParam });
    if (result?.status === 'ok' && Array.isArray(result.data)) {
      renderAttendance(result.data);
    } else {
      renderAttendanceError();
    }
  } catch {
    renderAttendanceError();
  }
}

async function quickClockOut(rowIndex, staffId, staffName) {
  if (!rowIndex) {
    showToast('rowIndex が取得できません。GAS の getAttendanceByMonth に rowIndex を追加してください。', 'error', 4000);
    return;
  }
  const labels = deriveUILabels();
  if (!confirm(`${staffName} の${labels.clockout_label}を現在時刻で記録しますか？`)) return;

  const now          = new Date();
  const clockOutTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 日跨ぎ判定：attendItems から入店レコードを取得
  const record     = attendItems.find(it => it.rowIndex === rowIndex);
  const clockIn    = parseTimeStr(record?.clockIn) || '';
  const clockInDate = record?.date || todayStr();
  let   clockOutDate = clockInDate;

  if (clockIn) {
    const [ciH, ciM] = clockIn.split(':').map(Number);
    const [coH, coM] = clockOutTime.split(':').map(Number);
    if (coH * 60 + coM < ciH * 60 + ciM) {
      const d = new Date(clockInDate);
      d.setDate(d.getDate() + 1);
      clockOutDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }

  showLoading();
  try {
    const result = await callGAS('clockOut', { rowIndex, staffId, clockOutTime, clockOutDate });
    if (result?.status !== 'ok') throw new Error(result?.message || '記録エラー');
    showToast(`${staffName} の${labels.clockout_label}を記録しました ✓`, 'success');
    await loadAttendanceOnly();
  } catch (e) {
    showToast(`${labels.clockout_label}記録に失敗しました：` + e.message, 'error');
  } finally {
    hideLoading();
  }
}

/* ── XSSエスケープ ───────────────────────────────────────── */
function escHtml(str) {
  // app.js の uzEscHtml に委譲（重複定義を解消・SSOT）
  return uzEscHtml(str);
}

/* ══════════════════════════════════════════════════════════
   iPad 右パネル（4状態）
   ══════════════════════════════════════════════════════════ */

let _ipadSelectedRecord = null;

/**
 * ロック状態 + localStorage申請状態を合わせて返す
 * @returns {'editable'|'grace'|'locked'|'pending'}
 */
function getLockState(record) {
  const ls = getLockStatus(record.date);
  if (!ls.locked) {
    return ls.grace ? 'grace' : 'editable';
  }
  const key = `lock_pending_${record.type}_${record.rowIndex}`;
  const pending = localStorage.getItem(key);
  if (pending === 'pending' || pending === 'approved') return 'pending';
  return 'locked';
}

function renderIpadRightPanel(record) {
  const panel = document.querySelector('.ipad-right-panel');
  if (!panel) return;

  // 入力モード（hist-right--input）で外したカード枠を、修正表示では復帰する
  panel.className = 'ipad-right-panel';

  _ipadSelectedRecord = record;
  currentEditItem = record;

  // ロック機能は存在しない（§5-3）。行選択は常に詳細プレビュー→「編集する」。
  panel.className = 'ipad-right-panel';
  panel.innerHTML = `
    <div class="ipad-right-panel__header">詳細</div>
    <div class="ipad-right-form-body">
      ${_buildIpadRecordDetail(record)}
      <div class="ipad-right-actions">
        <button id="ipad-right-close-btn" type="button" class="edit-delete-btn">新規登録に戻る</button>
        <button id="ipad-right-editstart-btn" type="button" class="edit-save-btn">編集する</button>
      </div>
    </div>
  `;

  document.getElementById('ipad-right-editstart-btn')?.addEventListener('click', () => _ipadEditForm(record));
  document.getElementById('ipad-right-close-btn')?.addEventListener('click', () => {
    _deselectIpadRow();
    _renderHistRightDefault();
  });
}

/* 行選択ハイライトを解除 */
function _deselectIpadRow() {
  document.querySelectorAll('.ipad-hist-row--selected').forEach(r => r.classList.remove('ipad-hist-row--selected'));
}

/* ── iPad 修正フォーム本体（プレビューの「編集する」から遷移）──────
   売上・コストは単一エンジン（uz-input 編集モード）。勤怠は黒帯フォーム。
   取消＝新規登録へ戻る（誤操作からの離脱導線）。 */
function _ipadEditForm(record) {
  const panel = document.querySelector('.ipad-right-panel');
  if (!panel) return;
  currentEditItem = record;
  _ipadSelectedRecord = record;

  // 売上・コスト：単一エンジン（uz-input）で修正（カード選択・黒帯積層・ヘッド値）
  if ((record.type === 'sales' || record.type === 'cost') && window.UzInput && UzInput.mountEdit) {
    panel.className = 'ipad-right-panel hist-right--input hist-right--edit';
    panel.innerHTML = `
      <div class="ipad-right-panel__header">修正</div>
      <div id="ipad-edit-host"></div>`;
    UzInput.mountEdit(document.getElementById('ipad-edit-host'), record, {
      onSubmitted: () => { _deselectIpadRow(); loadAll(); _renderHistRightDefault(); },
      onDelete:    () => { _ipadRightDelete(); },
      onCancel:    () => { _deselectIpadRow(); _renderHistRightDefault(); },
    });
    return;
  }

  // 勤怠：黒帯フォーム＋取消／削除／保存（積層エンジン外＝データ別）
  const formHTML = buildAttendanceFormHTML(record);
  panel.className = 'ipad-right-panel';
  panel.innerHTML = `
    <div class="ipad-right-panel__header">修正</div>
    <div class="ipad-right-form-body">
      ${formHTML}
      <div class="ipad-right-actions">
        <button id="ipad-right-cancel-btn" type="button" class="edit-delete-btn">取消</button>
        <button id="ipad-right-delete-btn" type="button" class="edit-delete-btn">削除</button>
        <button id="ipad-right-save-btn" type="button" class="edit-save-btn">保存する</button>
      </div>
    </div>
  `;

  _refreshClockOutHourSelect('ef-clockin-h', 'ef-clockout-h');
  document.getElementById('ef-clockin-h')?.addEventListener('change', () => {
    _refreshClockOutHourSelect('ef-clockin-h', 'ef-clockout-h');
  });

  document.getElementById('ipad-right-save-btn')?.addEventListener('click', () => { saveEdit(); });
  document.getElementById('ipad-right-delete-btn')?.addEventListener('click', () => { _ipadRightDelete(); });
  document.getElementById('ipad-right-cancel-btn')?.addEventListener('click', () => { _deselectIpadRow(); _renderHistRightDefault(); });
}

function _buildIpadRecordDetail(record) {
  const labels = deriveUILabels();
  let rows = '';
  if (record.type === 'sales') {
    rows = `
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">種別</span>
        <span class="ipad-record-detail__val">売上</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">日付</span>
        <span class="ipad-record-detail__val">${escHtml(record.date || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">サービス</span>
        <span class="ipad-record-detail__val">${escHtml(record.itemName || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">税込金額</span>
        <span class="ipad-record-detail__val" style="color:var(--uz-gold);">${formatYen(record.amount)}</span>
      </div>
      ${record.memo ? `<div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">メモ</span>
        <span class="ipad-record-detail__val">${escHtml(record.memo)}</span>
      </div>` : ''}`;
  } else if (record.type === 'cost') {
    rows = `
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">種別</span>
        <span class="ipad-record-detail__val">コスト</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">日付</span>
        <span class="ipad-record-detail__val">${escHtml(record.date || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">科目</span>
        <span class="ipad-record-detail__val">${escHtml(record.itemName || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">税込金額</span>
        <span class="ipad-record-detail__val" style="color:var(--uz-red);">${formatYen(record.amount)}</span>
      </div>
      ${record.memo ? `<div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">メモ</span>
        <span class="ipad-record-detail__val">${escHtml(record.memo)}</span>
      </div>` : ''}`;
  } else {
    // attendance
    rows = `
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">種別</span>
        <span class="ipad-record-detail__val">${escHtml(labels.clockin_record)}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">日付</span>
        <span class="ipad-record-detail__val">${escHtml(record.date || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">スタッフ</span>
        <span class="ipad-record-detail__val">${escHtml(record.staffName || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">${escHtml(labels.clockin_label)}</span>
        <span class="ipad-record-detail__val">${escHtml(parseTimeStr(record.clockIn) || '—')}</span>
      </div>
      <div class="ipad-record-detail__row">
        <span class="ipad-record-detail__key">${escHtml(labels.clockout_label)}</span>
        <span class="ipad-record-detail__val">${escHtml(parseTimeStr(record.clockOut) || '未記録')}</span>
      </div>`;
  }
  return `<div class="ipad-record-detail">${rows}</div>`;
}

function requestUnlock(type, rowIndex) {
  localStorage.setItem(`lock_pending_${type}_${rowIndex}`, 'pending');
  showToast('ロック解除を申請しました', 'success');
  updateIpadApprovalBanner();
}

function approveUnlock(type, rowIndex) {
  localStorage.setItem(`lock_pending_${type}_${rowIndex}`, 'approved');
  showToast('申請を承認しました', 'success');
  updateIpadApprovalBanner();
}

function rejectUnlock(type, rowIndex) {
  localStorage.removeItem(`lock_pending_${type}_${rowIndex}`);
  showToast('申請を却下しました', 'success');
  updateIpadApprovalBanner();
}

function updateIpadApprovalBanner() {
  const banner = document.getElementById('approval-banner');
  if (!banner) return;
  const pendingKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('lock_pending_') && localStorage.getItem(key) === 'pending') {
      pendingKeys.push(key);
    }
  }
  if (pendingKeys.length > 0) {
    const detail = document.getElementById('approval-banner__detail');
    if (detail) detail.textContent = `${pendingKeys.length}件の解除申請があります`;
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}
