/**
 * ウルトラZAIMUくん LEO版 PWA — pl.js
 * 損益サマリー画面ロジック（GAS getSummary + getHistory 連携版）
 *
 * A-9：トップ画面（index.html + home.js）と完全に同じアコーディオン実装に統一。
 *   - HTML構造：index.html 287〜307行のpl-row + pl-accordion-btnパターンに準拠
 *   - ID命名：pl-row-${key} / pl-chev-${key} / pl-detail-${key}
 *   - トグル関数：togglePlAccordion（home.js準拠）
 *   - 内訳取得：home.js _loadBreakdown 準拠（getHistoryからJS側自前集計）
 *   - 内訳プロパティ：{name, amt}（home.js準拠）
 *   - 死コード「確定申告 科目別集計（収支内訳書 行番号対応）」を削除
 */

'use strict';

/* ── データ取得：集計・キャッシュは app.js データ層に集約済み ──────
   fetchSummary / fetchBreakdown は uzFetchSummary / uzFetchBreakdown の
   別名（既存呼び出し名を維持するための薄いラッパ）。
   自前集計・独自キャッシュは廃止（集計の正本は app.js uzFetchBreakdown）。 */
const fetchSummary   = (monthStr) => uzFetchSummary(monthStr);
const fetchBreakdown = (monthStr) => uzFetchBreakdown(monthStr);

/* ── 定数 ────────────────────────────────────────────────── */
const _now       = new Date();
const THIS_YEAR  = _now.getFullYear();
const THIS_MONTH = _now.getMonth() + 1;
const MIN_YEAR   = 2025;

/* ── 状態 ────────────────────────────────────────────────── */
let currentTab    = 'monthly';
let currentPeriod = `${THIS_YEAR}-${String(THIS_MONTH).padStart(2, '0')}`;
let currentYear   = THIS_YEAR;
let compareMode   = false;

/* 内訳データの保持（home.js準拠：開閉時に参照） */
const _plBreakdown = {};

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindPeriodNav();
  bindCompareBtn();
  bindYtdCompareBtn();
  bindTaxDownload();
  renderAll();
});

/* ── タブ切替 ────────────────────────────────────────────── */
function bindTabs() {
  document.querySelectorAll('.pl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.pl-tab').forEach(b =>
        b.classList.toggle('pl-tab--active', b === btn)
      );
      compareMode = false;
      updateCompareBtn();
      renderAll();
    });
  });
}

/* ── 期間ナビゲーション ──────────────────────────────────── */
function bindPeriodNav() {
  document.getElementById('period-prev')?.addEventListener('click', () => movePeriod(-1));
  document.getElementById('period-next')?.addEventListener('click', () => movePeriod(+1));
  document.getElementById('ytd-prev')?.addEventListener('click',    () => moveYear(-1));
  document.getElementById('ytd-next')?.addEventListener('click',    () => moveYear(+1));
}

function movePeriod(dir) {
  const [y, m] = currentPeriod.split('-').map(Number);
  let newM = m + dir;
  let newY = y;
  if (newM < 1)  { newY--; newM = 12; }
  if (newM > 12) { newY++; newM = 1; }
  if (newY < MIN_YEAR) return;
  if (newY > THIS_YEAR || (newY === THIS_YEAR && newM > THIS_MONTH)) return;
  currentPeriod = `${newY}-${String(newM).padStart(2, '0')}`;
  compareMode   = false;
  updateCompareBtn();
  renderAll();
}

function moveYear(dir) {
  const newYear = currentYear + dir;
  if (newYear < MIN_YEAR || newYear > THIS_YEAR) return;
  currentYear = newYear;
  renderAll();
}

/* ── 比較モード ──────────────────────────────────────────── */
function bindCompareBtn() {
  document.getElementById('compare-btn')?.addEventListener('click', () => {
    compareMode = !compareMode;
    updateCompareBtn();
    renderAll();
  });
}

function updateCompareBtn() {
  const btn = document.getElementById('compare-btn');
  if (!btn) return;
  btn.classList.toggle('pl-compare-btn--active', compareMode);
  btn.setAttribute('aria-pressed', String(compareMode));
  btn.textContent = compareMode ? '前年同月比 ON' : '前年同月比';
}

function bindYtdCompareBtn() {
  document.getElementById('ytd-compare-btn')?.addEventListener('click', () => {
    compareMode = !compareMode;
    const btn = document.getElementById('ytd-compare-btn');
    if (btn) {
      btn.classList.toggle('pl-compare-btn--active', compareMode);
      btn.setAttribute('aria-pressed', String(compareMode));
      btn.textContent = compareMode ? '前年比較 ON' : '前年比較';
    }
    renderAll();
  });
}

/* ── 描画エントリ ────────────────────────────────────────── */
function renderAll() {
  if (currentTab === 'monthly') {
    renderMonthly();
  } else {
    renderYTD();
  }
}

/* ── 月次描画 ────────────────────────────────────────────── */
async function renderMonthly() {
  showSection('monthly-section');
  hideSection('ytd-section');

  const [y, m] = currentPeriod.split('-').map(Number);

  const labelEl = document.getElementById('period-label');
  if (labelEl) labelEl.textContent = `${y}年${m}月`;

  const isMin = y === MIN_YEAR && m === 1;
  const isMax = y === THIS_YEAR && m === THIS_MONTH;
  const prevBtn = document.getElementById('period-prev');
  const nextBtn = document.getElementById('period-next');
  if (prevBtn) prevBtn.disabled = isMin;
  if (nextBtn) nextBtn.disabled = isMax;

  plShowLoading('pl-table');

  /* getSummary と getHistory(内訳) を並行取得 */
  const [data, breakdown] = await Promise.all([
    fetchSummary(currentPeriod),
    fetchBreakdown(currentPeriod),
  ]);

  const prevKey  = `${y - 1}-${String(m).padStart(2, '0')}`;
  const prevData = compareMode ? await fetchSummary(prevKey) : null;

  const infoBanner = document.getElementById('compare-info');
  if (infoBanner) {
    infoBanner.classList.toggle('pl-compare-info--show', compareMode);
    if (compareMode) {
      infoBanner.textContent = prevData
        ? `比較対象: ${y - 1}年${m}月`
        : '前年同月のデータがありません';
    }
  }

  if (!data) {
    renderEmpty('pl-table');
    return;
  }

  const gross  = data.sales - data.cogs;
  const profit = gross - data.sga;

  const plData = {
    sales:  { total: data.sales, breakdown: breakdown.sales, key: 'sales' },
    cogs:   { total: data.cogs,  breakdown: breakdown.cogs,  key: 'cogs'  },
    gross:  { total: gross },
    sga:    { total: data.sga,   breakdown: breakdown.sga,   key: 'sga'   },
    profit: { total: profit },
  };

  let prevPlData = null;
  if (prevData) {
    const prevGross  = prevData.sales - prevData.cogs;
    const prevProfit = prevGross - prevData.sga;
    prevPlData = {
      sales: prevData.sales, cogs: prevData.cogs,
      gross: prevGross, sga: prevData.sga, profit: prevProfit,
    };
  }

  renderPLTable(plData, prevPlData);
}

/* ── 年度累計描画 ────────────────────────────────────────── */
async function renderYTD() {
  showSection('ytd-section');
  hideSection('monthly-section');

  const ytdLabel = document.getElementById('ytd-label');
  if (ytdLabel) ytdLabel.textContent = `${currentYear}年(1〜12月)`;

  const ytdPrev = document.getElementById('ytd-prev');
  const ytdNext = document.getElementById('ytd-next');
  if (ytdPrev) ytdPrev.disabled = currentYear <= MIN_YEAR;
  if (ytdNext) ytdNext.disabled = currentYear >= THIS_YEAR;

  plShowLoading('ytd-pl-table');

  const [current, previous] = await Promise.all([
    aggregateYear(currentYear),
    compareMode ? aggregateYear(currentYear - 1) : Promise.resolve(null),
  ]);

  const gross  = current.sales - current.cogs;
  const profit = gross - current.sga;

  const plData = {
    sales:  { total: current.sales, breakdown: current.salesBreakdown, key: 'sales-ytd' },
    cogs:   { total: current.cogs,  breakdown: current.cogsBreakdown,  key: 'cogs-ytd'  },
    gross:  { total: gross },
    sga:    { total: current.sga,   breakdown: current.sgaBreakdown,   key: 'sga-ytd'   },
    profit: { total: profit },
  };

  let prevPlData = null;
  if (compareMode && previous && previous.sales > 0) {
    const prevGross  = previous.sales - previous.cogs;
    const prevProfit = prevGross - previous.sga;
    prevPlData = {
      sales: previous.sales, cogs: previous.cogs,
      gross: prevGross, sga: previous.sga, profit: prevProfit,
    };
  }

  const infoBanner = document.getElementById('compare-info');
  if (infoBanner) {
    infoBanner.classList.toggle('pl-compare-info--show', compareMode);
    if (compareMode) {
      infoBanner.textContent = prevPlData
        ? `比較対象: ${currentYear - 1}年(年度累計)`
        : `${currentYear - 1}年のデータがありません`;
    }
  }

  renderPLTable(plData, prevPlData, 'ytd-pl-table');
}

/* ── 年度集計(月別にfetchして合算) ──────────────────────── */
async function aggregateYear(year) {
  const maxMonth = (year === THIS_YEAR) ? THIS_MONTH : 12;
  const monthKeys = [];
  for (let mm = 1; mm <= maxMonth; mm++) {
    monthKeys.push(`${year}-${String(mm).padStart(2, '0')}`);
  }

  /* 合計値とbreakdownを月別に並行取得 */
  const summaries  = await Promise.all(monthKeys.map(fetchSummary));
  const breakdowns = await Promise.all(monthKeys.map(fetchBreakdown));

  let sales = 0, cogs = 0, sga = 0;
  const salesMap = {}, cogsMap = {}, sgaMap = {};

  summaries.forEach(d => {
    if (!d) return;
    sales += d.sales || 0;
    cogs  += d.cogs  || 0;
    sga   += d.sga   || 0;
  });

  /* breakdownを合算（プロパティ amt） */
  breakdowns.forEach(b => {
    (b?.sales || []).forEach(i => {
      salesMap[i.name] = (salesMap[i.name] || 0) + (i.amt || 0);
    });
    (b?.cogs || []).forEach(i => {
      cogsMap[i.name] = (cogsMap[i.name] || 0) + (i.amt || 0);
    });
    (b?.sga || []).forEach(i => {
      sgaMap[i.name] = (sgaMap[i.name] || 0) + (i.amt || 0);
    });
  });

  const toArr = obj => Object.entries(obj)
    .map(([name, amt]) => ({ name, amt }))
    .sort((a, b) => b.amt - a.amt);

  return {
    sales, cogs, sga,
    salesBreakdown: toArr(salesMap),
    cogsBreakdown:  toArr(cogsMap),
    sgaBreakdown:   toArr(sgaMap),
  };
}

/* ── PLテーブル描画 ──────────────────────────────────────── */
function renderPLTable(plData, prevData, tableId = 'pl-table') {
  const container = document.getElementById(tableId);
  if (!container) return;

  /* 内訳データを保持（アコーディオン展開時に参照） */
  _plBreakdown[plData.sales.key] = plData.sales.breakdown || [];
  _plBreakdown[plData.cogs.key]  = plData.cogs.breakdown  || [];
  _plBreakdown[plData.sga.key]   = plData.sga.breakdown   || [];

  const rows = [
    {
      key:        plData.sales.key || 'sales',
      label:      '売上',
      value:      plData.sales.total,
      prevValue:  prevData?.sales,
      expandable: true,
      type:       'normal',
    },
    {
      key:        plData.cogs.key || 'cogs',
      label:      '仕入原価',
      value:      plData.cogs.total,
      prevValue:  prevData?.cogs,
      expandable: true,
      type:       'normal',
    },
    {
      key:        'gross',
      label:      '粗利',
      value:      plData.gross.total,
      prevValue:  prevData?.gross,
      expandable: false,
      type:       'result',
    },
    {
      key:        plData.sga?.key || 'sga',
      label:      '販管費',
      value:      plData.sga.total,
      prevValue:  prevData?.sga,
      expandable: true,
      type:       'normal',
    },
    {
      key:        'profit',
      label:      '経常利益',
      value:      plData.profit.total,
      prevValue:  prevData?.profit,
      expandable: false,
      type:       'profit',
    },
  ];

  container.innerHTML = rows.map(row => buildRowHTML(row)).join('');
}

/**
 * 行HTMLを構築する。
 * トップ画面(index.html 287〜307行)と完全に同じ構造を採用する。
 *
 *   売上・仕入原価・販管費 → expandable=true   → pl-accordion-btn(内訳展開可能)
 *   粗利・経常利益         → expandable=false  → pl-row内に直接label+value
 */
function buildRowHTML(row) {
  const { key, label, value, prevValue, expandable, type } = row;

  /* 行クラスを組み立て(base.css 395行以降に準拠)
     売上・粗利・経常利益 = pl-row 単独(白背景)
     仕入原価・販管費    = pl-row + pl-row--surface(薄グレー背景) */
  const isSurface = (key.startsWith('cogs') || key.startsWith('sga'));
  let rowCls = 'pl-row';
  if (expandable)        rowCls += ' pl-row--accordion';
  if (isSurface)         rowCls += ' pl-row--surface';
  if (type === 'result') rowCls += ' pl-row--result';
  if (type === 'profit') rowCls += ' pl-row--highlight';

  /* 前年比diff(金額の下にコンパクト表示) */
  let diffHTML = '';
  if (compareMode && prevValue != null) {
    const diff    = value - prevValue;
    const diffPct = prevValue !== 0 ? Math.round(diff / prevValue * 100) : 0;
    const sign    = diff >= 0 ? '+' : '';
    const isGood  = (type === 'profit' || key.startsWith('sales') || key === 'gross')
      ? diff >= 0 : diff <= 0;
    const cls = isGood ? 'pl-value-diff--up' : 'pl-value-diff--down';
    diffHTML = `<span class="pl-value-diff ${cls}">前年比 ${sign}${formatYen(diff)} (${sign}${diffPct}%)</span>`;
  }

  /* アコーディオンあり(売上・仕入原価・販管費) */
  if (expandable) {
    return `
      <div class="${rowCls}" id="pl-row-${key}">
        <button class="pl-accordion-btn" type="button"
                onclick="togglePlAccordion('${key}')"
                aria-expanded="false"
                aria-controls="pl-detail-${key}">
          <span class="pl-label-wrap">
            <span class="pl-label">${escHtml(label)}</span>
            <i class="ti ti-chevron-down pl-chevron" id="pl-chev-${key}" aria-hidden="true"></i>
          </span>
          <span class="pl-value">${formatYen(value)}${diffHTML}</span>
        </button>
        <div class="pl-accordion-detail" id="pl-detail-${key}" hidden></div>
      </div>`;
  }

  /* アコーディオンなし(粗利・経常利益) */
  return `
    <div class="${rowCls}" id="pl-row-${key}">
      <span class="pl-label-wrap">
        <span class="pl-label">${escHtml(label)}</span>
      </span>
      <span class="pl-value">${formatYen(value)}${diffHTML}</span>
    </div>`;
}

/* ── 内訳展開トグル(home.js準拠・amt参照) ────────────── */
/* アコーディオン開閉は app.js 共通 togglePlAccordion を使用 */

/* ── ヘルパー ────────────────────────────────────────────── */
function showSection(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function hideSection(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function plShowLoading(tableId) {
  const el = document.getElementById(tableId);
  if (el) el.innerHTML = '<div class="pl-empty">読み込み中...</div>';
}

function renderEmpty(tableId) {
  const el = document.getElementById(tableId);
  if (el) el.innerHTML = '<div class="pl-empty">この月のデータはまだありません。<br>売上・コストを入力してください。</div>';
}

function escHtml(str) {
  return uzEscHtml(str);
}

/* ── 税理士用DLボタン ────────────────────────────────────── */
function bindTaxDownload() {
  const btn     = document.getElementById('tax-download-btn');
  const fromSel = document.getElementById('tax-from-month');
  const toSel   = document.getElementById('tax-to-month');
  if (!btn) return;

  // 期間プルダウン初期化
  const now      = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // デフォルト開始：当年1月(2025年以前なら2025-01)
  const defaultFrom = `${Math.max(now.getFullYear(), 2025)}-01`;
  buildMonthOptions(fromSel, defaultFrom);
  buildMonthOptions(toSel,   curMonth);

  btn.addEventListener('click', () => {
    const from = fromSel?.value || curMonth;
    const to   = toSel?.value   || curMonth;
    downloadTaxCSVByRange(from, to, btn);
  });
}
