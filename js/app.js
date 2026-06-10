/**
 * ウルトラZAIMUくん LEO版 PWA — app.js
 * 共通ロジック・GAS通信
 */

'use strict';

/* ── マスタ localStorage キー（全ファイル共通・SSOT） ──────────
 * app.js が共通基盤として最初に読み込まれる前提でここに集約定義する。
 * sales.js / cost.js は再定義せずこの定数を参照する。
 *  - SERVICE_MASTER_KEY  : 売上品目マスタ（serviceList・settings.B3）
 *  - COST_MASTER_KEY     : 販管費マスタ（costMasterList・settings.B4）
 *  - PURCHASE_MASTER_KEY : 仕入原価マスタ（purchaseMasterList・settings.B5）
 *  - STAFF_MASTER_KEY    : スタッフマスタ（staffList・settings.B2） */
const SERVICE_MASTER_KEY  = 'uz_service_master';
const COST_MASTER_KEY     = 'uz_cost_master';
const PURCHASE_MASTER_KEY = 'uz_purchase_master';
const STAFF_MASTER_KEY    = 'uz_staff_master';

/* ── 店舗分離（clientId ベースのマスタキャッシュ破棄・トップレベル同期実行） ──
 * localStorage はブラウザ単位で共有されるため、別店舗（別 clientId）のアプリを
 * 同一ブラウザで開くと、前店舗のサービス・販管費・仕入・スタッフ等が起動直後に
 * 一瞬表示される（幽霊データ）。
 *
 * 根治設計：各画面（cost.js / sales.js / settings.js / home.js）は DOMContentLoaded で
 * 「localStorage 即時描画 → loadXxxFromGAS で上書き」の二段構えで起動する。よって
 * パージを各画面の描画より前＝app.js 読込直後のトップレベルで同期実行すれば、どの画面の
 * 即時描画時点でも前店舗キャッシュは既に消えており、空を描画 → GAS 実データで埋まる、
 * という正しい流れになる。clientId は URL パス（kana19.github.io/{clientId}/）から抽出する。
 * 複製元 ultra-z-leo 等 clientId を取れない URL では破棄しない（デモ表示を壊さない）。 */
const ACTIVE_CLIENT_KEY = 'uz_active_client';
const MASTER_CACHE_KEYS = [
  SERVICE_MASTER_KEY,   // uz_service_master
  COST_MASTER_KEY,      // uz_cost_master
  PURCHASE_MASTER_KEY,  // uz_purchase_master
  STAFF_MASTER_KEY,     // uz_staff_master（settings.js/sales.js/history.js が読む正本）
  'uz_store_name',
  'uz_business_hours',
];

function detectClientId() {
  try {
    // パス先頭セグメントが uz-XXXXXXXX なら clientId。複製元 ultra-z-leo 等は null。
    const seg = (location.pathname || '').split('/').filter(Boolean)[0] || '';
    return /^uz-[0-9a-z]{8}$/i.test(seg) ? seg : null;
  } catch (e) { return null; }
}

function purgeMasterCacheOnClientChange() {
  try {
    const current = detectClientId();
    if (!current) return; // clientId 不明（複製元等）では破棄しない
    const prev = localStorage.getItem(ACTIVE_CLIENT_KEY);
    if (prev !== current) {
      MASTER_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
      localStorage.setItem(ACTIVE_CLIENT_KEY, current);
    }
  } catch (e) { /* localStorage 不可環境は無視 */ }
}

// 全 DOMContentLoaded リスナー（各画面の即時描画）より前に同期実行する。
purgeMasterCacheOnClientChange();

// デバイス判定・bodyクラス付与（即時実行）
(function() {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isPC = !isIPad && window.innerWidth >= 1025;

  if (isIPad) document.body.classList.add('is-ipad');
  if (isPC)   document.body.classList.add('is-pc');
})();

// DOMContentLoaded後にも付与（Safariサイドバーモード対策）
document.addEventListener('DOMContentLoaded', function() {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (isIPad) {
    document.body.classList.add('is-ipad');
    document.documentElement.classList.add('is-ipad');
  }
});

/* ── サイドバー共通生成（iPad全画面共通・4項目） ─────────────
   各HTMLは <nav class="nav-sidebar" id="nav-sidebar" data-active="…"></nav> の
   空プレースホルダのみを置き、中身はこの関数が一括生成する。
   4項目：ホーム（土星 ti-planet）／月次管理（月 ti-moon・履歴/修正と売上コスト入力を統合した history.html）／
          設定（ti-settings）。勤怠は月次管理の勤怠タブ・出勤状況はホーム。MD 02_画面仕様.md §2-2。
   data-active は当該ページのキー（home/monthly/settings）。
   月次管理は history.html（売上コスト一覧・集計・新規入力・修正を集約）を指す。
   data-page="sales" / "cost" は history へ集約されたため active="monthly" を渡す。
   後続の uzRenderAllBrands / uzLoadSidebarTimer / uzInitSidebarDateTime より
   先に実行する必要があるため、最優先の DOMContentLoaded リスナとして本関数を最初に登録する。 */
const UZ_SIDEBAR_ITEMS = [
  { key: 'home',     href: 'index.html',    icon: 'ti-planet',   label: 'ホーム'   },
  { key: 'monthly',  href: 'history.html',  icon: 'ti-moon',     label: '月次管理' },
  { key: 'settings', href: 'settings.html', icon: 'ti-settings', label: '設定'     }
];

function uzRenderSidebar() {
  const nav = document.getElementById('nav-sidebar');
  if (!nav || nav.dataset.uzRendered === '1') return;

  const active = nav.getAttribute('data-active') || '';

  const itemsHtml = UZ_SIDEBAR_ITEMS.map(function (it) {
    const isActive = it.key === active;
    return (
      '<a href="' + it.href + '" class="sidebar-item' +
        (isActive ? ' sidebar-item--active' : '') + '"' +
        (isActive ? ' aria-current="page"' : '') + '>' +
        '<i class="ti ' + it.icon + ' sidebar-item__icon" aria-hidden="true"></i>' +
        '<span>' + it.label + '</span>' +
      '</a>'
    );
  }).join('');

  nav.innerHTML =
    '<div class="nav-sidebar__brand">' +
      '<div class="nav-sidebar__logo" data-uz-brand data-uz-icon-base="icons/" data-uz-fallback="ウルトラZAIMUくん"></div>' +
      '<span id="sidebar-timer-dot" class="uz-timer-dot uz-timer-dot--sidebar" aria-hidden="true" title="売掛・買掛のお知らせ">' +
        '<span class="uz-timer-dot__core"></span></span>' +
    '</div>' +
    itemsHtml;

  // ホーム画面の「最近の入力」ブロック（#sidebar-recent）は nav 内に温存する。
  // 生成前に存在すれば退避し、項目の後ろへ戻す（着手順3でタブUIへ作り替え）。
  if (!nav.querySelector('#sidebar-recent') && nav.dataset.hasRecent === '1') {
    const recent = document.createElement('div');
    recent.className = 'sidebar-recent';
    recent.id = 'sidebar-recent';
    nav.appendChild(recent);
  }

  nav.dataset.uzRendered = '1';
}

// 最優先で登録（brand描画・timer・日時表示より先に DOM を確定させる）。
document.addEventListener('DOMContentLoaded', uzRenderSidebar);

/* ── GAS設定 ─────────────────────────────────────────────── */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwBDHj9-p6ZT6ExXrxF1Q-XwiEkNMPwDc0aAuk7zptivRhWhepvaCDsjaIJd7WHh_h9-A/exec';

/* ── デモモード（複製元 ultra-z-leo・UI確認用） ───────────────
   複製元はテンプレGASの SPREADSHEET_ID が __SPREADSHEET_ID__ のままで、
   getSettings 等が {status:'error', message:'...__SPREADSHEET_ID__'} を返す。
   これを検知したらデモモードに入り、以後 callGAS をダミー応答に差し替える。
   目的：店舗を生成せず複製元だけで店名・カラータイマー・損益・直近入力・グラフ等の
   UIを実データ込みで検証できるようにする（→ 06_環境.md §5-0 複製元＝UI確認用ツール）。
   生成店舗では SPREADSHEET_ID が実IDに置換されエラーが出ないため、デモは発動しない。 */
let UZ_DEMO = false;

/* デモ用：当月（YYYY-MM）を動的に得る。ダミー履歴を常に当月に乗せUI確認を成立させる */
function _uzDemoMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
function _uzDemoDate(day) {
  return `${_uzDemoMonth()}-${String(day).padStart(2, '0')}`;
}

const UZ_DEMO_DATA = {
  getSettings: {
    storeName: 'サンプル店舗（デモ）',
    businessHours: { open: '09:00', close: '21:00', closeNextDay: false },
    serviceList: [
      { code: 'sv001', name: '店内売上',     taxRate: 10 },
      { code: 'sv002', name: 'テイクアウト', taxRate: 8  },
      { code: 'sv003', name: '物販',         taxRate: 10 }
    ],
    purchaseMasterList: [
      { id: 'p001', name: '食材', defaultTaxRate: 8  },
      { id: 'p002', name: '酒類', defaultTaxRate: 10 }
    ],
    staffList: [
      { id: 1, name: 'デモ太郎', employmentType: 'employed_full' },
      { id: 2, name: 'デモ花子', employmentType: 'employed_temp' }
    ],
    /* 販管費マスタ（主要科目・smartphoneVisible 付き／GAS DEFAULT_COST_MASTER 準拠） */
    costMasterList: [
      { code: '10', name: '水道光熱費', taxRate: 10, divisionCode: '2', smartphoneVisible: true },
      { code: '12', name: '通信費',     taxRate: 10, divisionCode: '2', smartphoneVisible: true },
      { code: '13', name: '広告宣伝費', taxRate: 10, divisionCode: '2', smartphoneVisible: true },
      { code: '17', name: '消耗品費',   taxRate: 10, divisionCode: '2', smartphoneVisible: true },
      { code: '23', name: '地代家賃',   taxRate: 10, divisionCode: '2', smartphoneVisible: true },
      { code: '31', name: '雑費',       taxRate: 10, divisionCode: '2', smartphoneVisible: true }
    ]
  },
  getSummary: {
    sales: 600000, cogs: 180000, grossProfit: 420000,
    sga: 220000, operatingProfit: 200000
  },
  getUncollected: [
    { type: 'uncollected', date: _uzDemoDate(20), name: '店内売上', amount: 80000 },
    { type: 'payable',     date: _uzDemoDate(18), name: '酒類',     amount: 45000 }
  ],
  /* getHistory：GAS正本フィールド準拠（itemName / rowIndex / uncollected|unpaid /
     serviceCode|divisionCode・itemCode）。科目名入りで一覧・集計・売掛買掛ドットを確認可能にする。
     合計は getSummary と一致：売上600,000 / 仕入原価180,000 / 販管費220,000。 */
  getHistory: [
    { type:'sales', rowIndex:2, date:_uzDemoDate(23), itemName:'店内売上',     serviceCode:'sv001', amount:350000, taxRate:10, memo:'',           uncollected:0 },
    { type:'sales', rowIndex:3, date:_uzDemoDate(23), itemName:'物販',         serviceCode:'sv003', amount:50000,  taxRate:10, memo:'グッズ',     uncollected:0 },
    { type:'cost',  rowIndex:2, date:_uzDemoDate(23), itemName:'食材',         divisionCode:'1', itemCode:'p001', amount:100000, taxRate:8,  memo:'',         unpaid:0 },
    { type:'sales', rowIndex:4, date:_uzDemoDate(22), itemName:'テイクアウト', serviceCode:'sv002', amount:200000, taxRate:8,  memo:'',           uncollected:1 },
    { type:'cost',  rowIndex:3, date:_uzDemoDate(22), itemName:'酒類',         divisionCode:'1', itemCode:'p002', amount:80000,  taxRate:10, memo:'仕入',     unpaid:1 },
    { type:'cost',  rowIndex:4, date:_uzDemoDate(21), itemName:'広告宣伝費',   divisionCode:'2', itemCode:'13',   amount:35000,  taxRate:10, memo:'SNS広告', unpaid:0 },
    { type:'cost',  rowIndex:5, date:_uzDemoDate(20), itemName:'水道光熱費',   divisionCode:'2', itemCode:'10',   amount:25000,  taxRate:10, memo:'',         unpaid:0 },
    { type:'cost',  rowIndex:6, date:_uzDemoDate(19), itemName:'地代家賃',     divisionCode:'2', itemCode:'23',   amount:160000, taxRate:10, memo:'当月分',   unpaid:0 }
  ],
  getAttendance: [],
  getLinkCandidates: [],
  getTransactionsHierarchy: { months: [] }
};

/* デモ用：月次推移グラフが13ヶ月ぶんを要求する getSummary の月別ダミー */
function uzDemoSummaryForMonth(month) {
  // 当月のみ値あり・他月は0（複製元のグラフ描画確認用に最小限）
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if (month === cur) return UZ_DEMO_DATA.getSummary;
  return { sales: 0, cogs: 0, grossProfit: 0, sga: 0, operatingProfit: 0 };
}

function uzDemoResponse(action, data) {
  if (action === 'getSummary') {
    return { status: 'ok', data: uzDemoSummaryForMonth(data && data.month) };
  }
  if (action === 'getCostMaster') {
    // 正規化前の素のデフォルト（getCostMaster側で正規化される）
    return { status: 'ok', data: (typeof DEFAULT_COST_MASTER !== 'undefined') ? DEFAULT_COST_MASTER : [] };
  }
  if (Object.prototype.hasOwnProperty.call(UZ_DEMO_DATA, action)) {
    return { status: 'ok', data: UZ_DEMO_DATA[action] };
  }
  // 書き込み系（addSales/saveCostMaster等）はデモでは成功を装って何もしない
  return { status: 'ok', data: null, demo: true };
}

/**
 * GASにGETリクエストを送る（CORS回避のためクエリパラメータで送信）。
 * デモモード時はダミー応答を返す。
 * @param {string} action
 * @param {Object} data
 * @returns {Promise<Object>}
 */
async function callGAS(action, data = {}) {
  if (UZ_DEMO) return uzDemoResponse(action, data);
  const params = new URLSearchParams({ action, data: JSON.stringify(data) });
  const res = await fetch(`${GAS_URL}?${params}`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 複製元シグナル検知：SPREADSHEET_ID 未置換ならデモモードへ移行し、ダミーを返す
  if (json && json.status === 'error' && typeof json.message === 'string'
      && json.message.indexOf('__SPREADSHEET_ID__') !== -1) {
    UZ_DEMO = true;
    return uzDemoResponse(action, data);
  }
  return json;
}

/* ══════════════════════════════════════════════════════════
   データ層（共通）
   GAS取得・科目別集計・キャッシュを1箇所に集約する。
   home.js / pl.js / history（月次管理）/ その他画面はここを呼び、
   各自で getHistory を叩いて集計する重複を作らない。

   getHistory の正本データ構造（GAS応答1行）：
     { type:'sales'|'cost', rowIndex, date, amount,
       itemName, divisionCode('1'=仕入原価 / その他=販管費),
       memo, state, ... }
   ══════════════════════════════════════════════════════════ */

/* 月別キャッシュ（getHistory生データ・getSummary・内訳） */
const _uzHistoryCache   = {};   // month -> 正規化済み配列
const _uzSummaryCache   = {};   // month -> summaryデータ | null
const _uzBreakdownCache = {};   // month -> { sales, cogs, sga }

/**
 * 指定月のキャッシュを破棄する。入力（addSales/addCost）・編集・削除の後に呼ぶ。
 * 引数省略で全月破棄。
 */
function uzInvalidateMonth(month) {
  if (month) {
    delete _uzHistoryCache[month];
    delete _uzSummaryCache[month];
    delete _uzBreakdownCache[month];
  } else {
    for (const k in _uzHistoryCache)   delete _uzHistoryCache[k];
    for (const k in _uzSummaryCache)   delete _uzSummaryCache[k];
    for (const k in _uzBreakdownCache) delete _uzBreakdownCache[k];
  }
}

/**
 * getSummary（損益5値）を取得＋キャッシュ。
 * @returns summaryデータ（{ sales, cogs, grossProfit, sga, operatingProfit, ... }）| null
 */
async function uzFetchSummary(month) {
  if (_uzSummaryCache[month] !== undefined) return _uzSummaryCache[month];
  try {
    const res  = await callGAS('getSummary', { month });
    const data = (res && res.status === 'ok' && res.data) ? res.data : null;
    _uzSummaryCache[month] = data;
    return data;
  } catch {
    _uzSummaryCache[month] = null;
    return null;
  }
}

/**
 * getHistory（売上コスト混在）を取得＋キャッシュ。
 * GAS getHistory(month) の応答をそのまま保持する（type='sales'/'cost' 混在・rowIndex付き）。
 * getHistory は type パラメータを解釈せず常に全件返すため、month のみで取得する。
 *
 * 正本フィールド（main.gs getHistory 準拠）：
 *   共通  : type, sheetName, rowIndex, date, amount(税込), taxRate, taxAmount, memo, itemName, isLocked
 *   売上固有: serviceCode, uncollected(売掛=1), salesRowId, isProject
 *   コスト固有: divisionCode('1'=仕入原価/その他=販管費), divisionName, itemCode,
 *             miscItemName, unpaid(買掛=1), withholdingAmount, linkedSalesRowId
 *
 * @returns Array<該当行オブジェクト>（GAS応答のまま・date降順）
 */
async function uzFetchHistory(month) {
  if (_uzHistoryCache[month] !== undefined) return _uzHistoryCache[month];
  try {
    const res  = await callGAS('getHistory', { month }).catch(() => null);
    const data = (res?.status === 'ok' && Array.isArray(res.data)) ? res.data : [];
    _uzHistoryCache[month] = data;
    return data;
  } catch {
    _uzHistoryCache[month] = [];
    return [];
  }
}

/**
 * 科目別内訳を集計＋キャッシュ。集計の唯一の正本。
 * uzFetchHistory を元に売上＝サービス別／仕入原価／販管費へ振り分ける。
 * @returns { sales:[{name,amt}], cogs:[{name,amt}], sga:[{name,amt}] }（金額降順）
 */
async function uzFetchBreakdown(month) {
  if (_uzBreakdownCache[month] !== undefined) return _uzBreakdownCache[month];
  const rows = await uzFetchHistory(month);
  const salesMap = {}, cogsMap = {}, sgaMap = {};
  rows.forEach(r => {
    const amt = Number(r.amount) || 0;
    if (r.type === 'sales') {
      const name = r.itemName || '売上';
      salesMap[name] = (salesMap[name] || 0) + amt;
    } else if (r.type === 'cost') {
      const name = r.itemName || '経費';
      if (String(r.divisionCode) === '1') {
        cogsMap[name] = (cogsMap[name] || 0) + amt;
      } else {
        sgaMap[name] = (sgaMap[name] || 0) + amt;
      }
    }
  });
  const toArr = map => Object.entries(map)
    .map(([name, amt]) => ({ name, amt }))
    .sort((a, b) => b.amt - a.amt);
  const result = { sales: toArr(salesMap), cogs: toArr(cogsMap), sga: toArr(sgaMap) };
  _uzBreakdownCache[month] = result;
  return result;
}

/* ══════════════════════════════════════════════════════════
   描画層（共通）
   全画面共通のHTMLエスケープ・損益内訳アコーディオン。
   home.js / pl.js が各自で持っていた escapeHtml/escHtml・
   togglePlAccordion の重複をここに1本化する。
   ══════════════════════════════════════════════════════════ */

/* HTMLエスケープ（共通）。各画面の escapeHtml/escHtml はこれに委譲する。 */
function uzEscHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* 損益内訳アコーディオンの開閉（共通）。
   ホーム（index.html）・損益サマリー（pl.html）の onclick から呼ばれる。
   内訳データは画面側のグローバル _plBreakdown[key]（{name,amt}配列）を参照する。
   HTML契約：トグル対象 #pl-detail-${key}・chevron #pl-chev-${key}・
            直前要素がボタン（aria-expanded を持つ）。 */
function togglePlAccordion(key) {
  const detail = document.getElementById(`pl-detail-${key}`);
  const chev   = document.getElementById(`pl-chev-${key}`);
  const btn    = detail?.previousElementSibling;
  if (!detail) return;

  const isOpen = !detail.hidden;
  if (isOpen) {
    detail.hidden = true;
    chev?.classList.remove('pl-chevron--open');
    btn?.setAttribute('aria-expanded', 'false');
    return;
  }

  const items = (typeof _plBreakdown !== 'undefined' && _plBreakdown[key]) || [];
  if (items.length === 0) {
    detail.innerHTML =
      '<div class="pl-detail-row" style="color:var(--uz-text3);font-size:12px;padding:4px 0;">内訳データなし</div>';
  } else {
    detail.innerHTML = items.map(it =>
      `<div class="pl-detail-row">
        <span class="pl-detail-row__name">${uzEscHtml(it.name)}</span>
        <span class="pl-detail-row__val">${formatYen(it.amt)}</span>
      </div>`
    ).join('');
  }
  detail.hidden = false;
  chev?.classList.add('pl-chevron--open');
  btn?.setAttribute('aria-expanded', 'true');
}

/**
 * アプリ起動時にGASからsettings（staffList・businessHours等）を取得して
 * localStorageに同期する。通信失敗時は既存キャッシュを維持。
 *
 * 実行タイミング：DOMContentLoaded時にバックグラウンドで非同期実行
 * モーダル起動時には既にlocalStorageが最新化されている設計
 */
async function syncSettingsAtStartup() {
  try {
    // 店舗分離（clientId 不一致時のマスタキャッシュ破棄）は app.js 冒頭の
    // トップレベルで同期実行済み（各画面の即時描画より前に幽霊データを断つ）。
    const res = await callGAS('getSettings', {});
    if (!res || res.status !== 'ok' || !res.data) return;

    const d = res.data;

    // storeName 同期（課題1：ヘッダー/サイドバーの店舗名・ロゴフォールバック表示で使用）
    // テンプレ ultra-z-leo の見本店舗名（HTML ハードコード）を上書きするため、
    // getSettings の storeName を localStorage に保持し各ヘッダーが参照する。
    if (typeof d.storeName === 'string' && d.storeName.trim()) {
      localStorage.setItem('uz_store_name', d.storeName.trim());
    }

    // staffList 同期（settings.js/sales.js/history.js が読む STAFF_MASTER_KEY に統一）
    if (Array.isArray(d.staffList)) {
      localStorage.setItem(STAFF_MASTER_KEY, JSON.stringify(d.staffList));
    }

    // serviceList 同期（売上品目マスタ・settings.B3 が正本 → sales.js が参照）
    // id:'sv001'〜（03_データ仕様.md §1-1）。GAS正本で localStorage を常に上書きする。
    if (Array.isArray(d.serviceList)) {
      localStorage.setItem(SERVICE_MASTER_KEY, JSON.stringify(d.serviceList));
    }

    // costMasterList 同期（販管費マスタ・settings.B4 が正本 → cost.js が参照）
    // GAS生データは正規化を通してから保存する（03_データ仕様.md §1-2 正規化）。
    if (Array.isArray(d.costMasterList)) {
      const normalizedCost = (typeof normalizeCostMasterList === 'function')
        ? normalizeCostMasterList(d.costMasterList)
        : d.costMasterList;
      localStorage.setItem(COST_MASTER_KEY, JSON.stringify(normalizedCost));
    }

    // purchaseMasterList 同期（仕入原価マスタ・settings.B5 が正本 → cost.js 仕入原価タブが参照）
    // id:'p001'〜（03_データ仕様.md §1-3）。登録＝表示固定で smartphoneVisible は持たない。
    if (Array.isArray(d.purchaseMasterList)) {
      localStorage.setItem(PURCHASE_MASTER_KEY, JSON.stringify(d.purchaseMasterList));
    }

    // businessHours 同期（A-9：出勤履歴の打刻忘れ判定・設定画面表示で使用）
    // 形式：{open:"HH:MM", close:"HH:MM", closeNextDay:boolean}
    if (d.businessHours && typeof d.businessHours === 'object' && d.businessHours.open && d.businessHours.close) {
      localStorage.setItem('uz_business_hours', JSON.stringify(d.businessHours));
    } else {
      localStorage.removeItem('uz_business_hours');
    }

    // settings 同期完了イベント発火
    try {
      document.dispatchEvent(new CustomEvent('uz:settings-synced', { detail: { data: d } }));
    } catch (e) { /* CustomEvent 非対応環境は無視 */ }
  } catch (e) {
    console.warn('[app.js] settings起動時同期失敗（キャッシュ値を使用）:', e);
  }
}

/* ── 店舗分離のマスタキャッシュ破棄は app.js 冒頭でトップレベル同期実行済み
 *    （detectClientId / purgeMasterCacheOnClientChange / ACTIVE_CLIENT_KEY /
 *      MASTER_CACHE_KEYS の定義と即時呼び出しは冒頭にある）。 */

// 起動時にバックグラウンドで settings を同期（UIブロックなし）
document.addEventListener('DOMContentLoaded', function() {
  syncSettingsAtStartup();
});

/* ── ブランド表示（店舗ロゴ／店舗名フォールバック）共通ヘルパー ──────
 * 課題1：生成アプリのヘッダー/サイドバーが複製元 ultra-z-leo の見本
 * （店舗名ハードコード・固定ロゴ）のまま表示される不具合への対処。
 *
 * 仕様：
 *   - リポジトリ内の icons/store-logo.png を <img> で表示する
 *   - 画像が存在しない（未アップロード）店舗では <img> の onerror で
 *     店舗名テキスト（uz_store_name → fallbackText）に自動差し替え
 *   - 店舗ロゴは settings ではなくリポジトリ内ファイルのため src 直参照
 *   - 基準パスは iconBase で吸収（ルート='icons/'・PC版='../icons/'）
 *
 * スマホ・iPad・PC の3デバイスが本ヘルパーを共有し挙動を統一する。
 *
 * @param {HTMLElement} targetEl 描画先要素（中身を置き換える）
 * @param {Object} opts
 *   - iconBase   {string} アイコンディレクトリの相対パス（既定 'icons/'）
 *   - fallbackText {string} 店舗名が取れない場合の最終フォールバック文字列
 *   - logoClass  {string} <img> に付与するクラス（既定 'uz-brand-logo'）
 *   - textClass  {string} テキスト時のクラス（既定 'uz-brand-text'）
 */
function uzGetStoreName(fallbackText) {
  try {
    const v = localStorage.getItem('uz_store_name');
    if (v && v.trim()) return v.trim();
  } catch (e) { /* localStorage 不可環境は無視 */ }
  return fallbackText || '';
}

function uzRenderBrand(targetEl, opts) {
  if (!targetEl) return;
  opts = opts || {};
  const iconBase = (typeof opts.iconBase === 'string') ? opts.iconBase : 'icons/';
  const logoClass = opts.logoClass || 'uz-brand-logo';
  const textClass = opts.textClass || 'uz-brand-text';
  const storeName = uzGetStoreName(opts.fallbackText || '');

  // テキストフォールバック用ノード（textContent で安全に設定・XSS回避）
  const makeTextNode = function () {
    const span = document.createElement('span');
    span.className = textClass;
    span.textContent = storeName;
    return span;
  };

  // デモ時フォールバック：実販売時はロゴ表示がスタンダードになるため、
  // 複製元(デモ)でもロゴ実寸(240×60)でカラータイマー・日時とのバランスを確認できるよう
  // ダミーロゴSVG(透過背景・データURI・外部ファイル不要)を表示する。実店舗は store-logo.png を使用。
  const DEMO_LOGO_SVG =
    'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60">' +
      '<rect width="240" height="60" fill="none"/>' +
      '<text x="120" y="40" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" ' +
      'font-size="34" font-weight="700" fill="#1a1a1a">Sample Bar</text></svg>');
  const makeDemoLogoNode = function () {
    const di = document.createElement('img');
    di.className = logoClass;
    di.alt = storeName || 'サンプル店舗（デモ）';
    di.src = DEMO_LOGO_SVG;
    return di;
  };

  // 中身をクリア
  targetEl.textContent = '';

  // store-logo.png を試行（キャッシュバスター付与）
  const img = document.createElement('img');
  img.className = logoClass;
  img.alt = storeName || '店舗ロゴ';
  img.decoding = 'async';
  img.addEventListener('error', function () {
    // 画像が無い（未アップロード）→ デモ時はダミーロゴ／実店舗は店舗名テキスト
    const fallbackNode = (typeof UZ_DEMO !== 'undefined' && UZ_DEMO)
      ? makeDemoLogoNode() : makeTextNode();
    if (img.parentNode === targetEl) {
      targetEl.replaceChild(fallbackNode, img);
    } else {
      targetEl.textContent = '';
      targetEl.appendChild(fallbackNode);
    }
  });
  const buster = (Date.now ? Date.now() : new Date().getTime());
  img.src = iconBase + 'store-logo.png?v=' + buster;
  targetEl.appendChild(img);
}

// settings 同期完了で店舗名が遅れて届いた場合、ブランド表示を再描画する。
// 各ページは data-uz-brand 属性に iconBase / fallback を持たせるだけでよい。
function uzRenderAllBrands() {
  const nodes = document.querySelectorAll('[data-uz-brand]');
  nodes.forEach(function (el) {
    uzRenderBrand(el, {
      iconBase: el.getAttribute('data-uz-icon-base') || 'icons/',
      fallbackText: el.getAttribute('data-uz-fallback') || '',
      logoClass: el.getAttribute('data-uz-logo-class') || 'uz-brand-logo',
      textClass: el.getAttribute('data-uz-text-class') || 'uz-brand-text'
    });
  });
}

// 初回ロード時に描画（store-logo.png があれば即表示・無ければ店舗名）。
document.addEventListener('DOMContentLoaded', uzRenderAllBrands);
// settings 同期で storeName が確定したら再描画（テキストフォールバック更新）。
document.addEventListener('uz:settings-synced', uzRenderAllBrands);

/* ════════════════════════════════════════════════════════════
   カラータイマー SSOT（状態判定1・マークアップ1・02_画面仕様.md §5-4）
   home / sidebar / history（取引・勤怠）が共通利用する単一系統。
   外枠は不変、状態は核(__core)のみに与える。
   ════════════════════════════════════════════════════════════ */
window.uzTimer = (function () {
  /* 平日数（土日除外・祝日は考慮しない）：from〜to を両端含めて数える。to<from は 0。 */
  function bizDaysBetween(from, to) {
    const cur = new Date(from); cur.setHours(0,0,0,0);
    const end = new Date(to);   end.setHours(0,0,0,0);
    let n = 0;
    while (cur <= end) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) n++;
      cur.setDate(cur.getDate() + 1);
    }
    return n;
  }
  /* 当月末までの営業日数（後方互換） */
  function bizDaysToMonthEnd(now) {
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return bizDaysBetween(now, last);
  }
  /* 日付文字列(YYYY-MM-DD / YYYY/MM/DD)が属する月の末日。不正なら null。 */
  function monthEndOf(dateStr) {
    const p = String(dateStr || '').split(/[-\/]/).map(Number);
    if (!p[0] || !p[1]) return null;
    return new Date(p[0], p[1], 0);
  }
  /* 売掛・買掛の状態：消灯(null)/青/赤/赤点滅
     dueDateStr 指定時はその項目の月末を期限とし、期限超過かつ未処理なら点滅を維持する
     （知らせ＋処理督促の表示のため、未処理の間はリセットしない）。
     未指定時は当月末カウントダウン（集約boolean呼び出しの後方互換）。 */
  function stateAR(hasItem, now, dueDateStr) {
    if (!hasItem) return null;
    now = now || new Date();
    const today = new Date(now); today.setHours(0,0,0,0);
    let due = (dueDateStr ? monthEndOf(dueDateStr) : null)
              || new Date(now.getFullYear(), now.getMonth() + 1, 0);
    due.setHours(0,0,0,0);
    if (today > due) return 'blink';          // 期限（月末）超過＋未処理 → 最緊急を維持
    const b = bizDaysBetween(today, due);     // 今日〜期限の平日数（今日含む）
    if (b <= 1) return 'blink';
    if (b <= 3) return 'red';
    return 'blue';
  }
  /* 複数の未処理項目から最緊急状態を代表として返す（ホーム/サイドバー集約用）。
     items: [{date}] を想定。空/未指定なら消灯(null)。 */
  function mostUrgentAR(items, now) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const rank = { blink: 3, red: 2, blue: 1 };
    let best = null, bestRank = 0;
    for (const it of items) {
      const s = stateAR(true, now, it && it.date);
      const r = rank[s] || 0;
      if (r > bestRank) { bestRank = r; best = s; }
    }
    return best;
  }
  /* 勤怠（稼働時間）の状態：退勤済=グレー／勤務中<7h=青／7h=赤／7h57m〜=赤点滅 */
  function stateWork(workedMin, hasClockOut) {
    if (hasClockOut) return 'gray';
    if (workedMin == null) return 'blue';   // 勤務中だが算出不可→点灯
    if (workedMin >= 477) return 'blink';    // 7時間57分（8時間の3分前）以降
    if (workedMin >= 420) return 'red';      // 7時間到達
    return 'blue';                           // 7時間未満
  }
  /* 日付(YYYY-MM-DD)＋出勤時刻(HH:MM)から現在までの稼働分（翌日跨ぎ簡易補正） */
  function workedMin(dateStr, clockInStr, now) {
    if (!dateStr || !clockInStr) return null;
    const m = String(clockInStr).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const parts = String(dateStr).split(/[-\/]/).map(Number);
    const [y, mo, d] = parts;
    if (!y || !mo || !d) return null;
    const ci = new Date(y, mo - 1, d, Number(m[1]), Number(m[2]), 0, 0);
    let diff = Math.floor(((now || new Date()) - ci) / 60000);
    if (diff < 0) diff += 24 * 60;
    return diff;
  }
  function coreCls(state) { return state ? ' uz-timer-dot__core--' + state : ''; }
  /* マークアップ生成（外枠＋核）。size: 'home'|'hist'|'sidebar' */
  function dotHTML(state, size) {
    return '<span class="uz-timer-dot uz-timer-dot--' + (size || 'hist') + '" aria-hidden="true">' +
             '<span class="uz-timer-dot__core' + coreCls(state) + '"></span></span>';
  }
  /* 既存の外枠要素に核を確保し状態クラスを付け替える */
  function apply(outerEl, state) {
    if (!outerEl) return;
    let core = outerEl.querySelector('.uz-timer-dot__core');
    if (!core) {
      core = document.createElement('span');
      core.className = 'uz-timer-dot__core';
      outerEl.appendChild(core);
    }
    core.classList.remove(
      'uz-timer-dot__core--blue','uz-timer-dot__core--red',
      'uz-timer-dot__core--blink','uz-timer-dot__core--gray'
    );
    if (state) core.classList.add('uz-timer-dot__core--' + state);
  }
  return { bizDaysToMonthEnd, bizDaysBetween, monthEndOf, stateAR, mostUrgentAR, stateWork, workedMin, dotHTML, apply };
})();

/* ── サイドバー カラータイマー（全画面共通・ウルトラマンの胸のシンボル） ──
   店名の真下中央に1個表示。売掛・買掛の最緊急状態を代表表示する（お知らせ機能・リンクなし）。
   状態：①該当0件=消灯（シルバー縁のみ）／②売掛 or 買掛 1件以上=青／
        ③その月末まで3営業日以内=赤／④その月末まで1営業日以内=赤点滅。
   集約ロジック：売掛・買掛いずれかが④なら④、いずれかが③なら③、いずれか残件あれば②、全0なら①。
   月末営業日は土日のみ除外（祝日は考慮しない・home.js _getTimerState と同一）。 */
function uzTimerStateFromBizDays() {
  return window.uzTimer.stateAR(true);
}

function uzApplySidebarTimer(arItems) {
  const dot = document.getElementById('sidebar-timer-dot');
  if (!dot) return;
  // 売掛・買掛の全未処理項目から最緊急状態を代表表示（期限超過は点滅を維持）。0件なら消灯。
  window.uzTimer.apply(dot, window.uzTimer.mostUrgentAR(arItems, new Date()));
}

async function uzLoadSidebarTimer() {
  if (!document.getElementById('sidebar-timer-dot')) return;
  try {
    const res = await callGAS('getUncollected', {});
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      const arItems = res.data.filter(r => r.type === 'uncollected' || r.type === 'payable');
      uzApplySidebarTimer(arItems);
    }
  } catch { /* GAS失敗時は消灯のまま */ }
}

/* ── サイドバー日時表示（iPad全画面共通） ──────────────────
 * カラータイマーの直下に現在日時をリアルタイム表示（スマホ版ホームと同テイスト）。
 * timer-dot を内包する .nav-sidebar__brand 直下に動的挿入し、HTMLを各画面で編集せず一括適用。 */
function uzInitSidebarDateTime() {
  const dot = document.getElementById('sidebar-timer-dot');
  if (!dot) return;
  const brand = dot.closest('.nav-sidebar__brand') || dot.parentElement;
  if (!brand || document.getElementById('sidebar-datetime')) return;

  const box = document.createElement('div');
  box.id = 'sidebar-datetime';
  box.className = 'sidebar-datetime';
  box.innerHTML =
    '<span id="sidebar-date" class="sidebar-datetime__date"></span>' +
    '<span id="sidebar-time" class="sidebar-datetime__time"></span>';
  brand.appendChild(box);

  const tick = () => {
    const now = new Date();
    const w = ['日','月','火','水','木','金','土'][now.getDay()];
    const dateEl = document.getElementById('sidebar-date');
    const timeEl = document.getElementById('sidebar-time');
    if (dateEl) dateEl.textContent =
      `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日（${w}）`;
    if (timeEl) timeEl.textContent =
      `${String(now.getHours()).padStart(2,'0')}:` +
      `${String(now.getMinutes()).padStart(2,'0')}:` +
      `${String(now.getSeconds()).padStart(2,'0')}`;
  };
  tick();
  setInterval(tick, 1000);
}

document.addEventListener('DOMContentLoaded', uzLoadSidebarTimer);
document.addEventListener('DOMContentLoaded', uzInitSidebarDateTime);

/* ── UI用語（「出勤／退勤」表記に静的統一） ─
 * deriveUILabels() は固定ラベルを返す。
 * 呼び出し側（history.js / home.js / pc-common.js）が参照する。
 */
const _UI_LABELS_STATIC = {
  clockin_record:      '出勤記録',
  clockin_history:     '出勤履歴',
  clockin_active:      '出勤中',
  clockin_time:        '出勤時刻',
  clockout_time:       '退勤時刻',
  clockin_action:      '出勤を記録',
  clockout_action:     '退勤を記録',
  clockin_register:    '新規登録',
  clockout_done:       '退勤済',
  not_clocked_in:      '未出勤',
  clockin_label:       '出勤',
  clockout_label:      '退勤',
  clockout_unrecorded: '退勤未記録',
  attendance_empty:    '本日の出勤記録がありません',
};

/* ── businessHours（営業時間）取得・判定ヘルパー ──────────
 * settings B18 から取得した営業時間に基づき、出勤履歴の打刻忘れ判定を行う。
 * 設計：02_画面仕様_md.md §6「勤務状態表示」
 *   - 退勤打刻あり = 通常表示
 *   - 退勤空欄 + 営業終了時刻＋1時間未経過 = 勤務中
 *   - 退勤空欄 + 営業終了時刻＋1時間経過後 = 打刻忘れ
 *   - businessHours 未設定時：入店打刻から24時間ルールにフォールバック
 */

const BUSINESS_HOURS_KEY = 'uz_business_hours';

/**
 * 営業時間情報を取得（未設定時は null）
 * @returns {{open:string, close:string, closeNextDay:boolean} | null}
 */
function getBusinessHours() {
  try {
    const raw = localStorage.getItem(BUSINESS_HOURS_KEY);
    if (!raw) return null;
    const bh = JSON.parse(raw);
    if (!bh || !bh.open || !bh.close) return null;
    return bh;
  } catch (e) {
    return null;
  }
}

/**
 * 営業時間を表示文字列に整形（例：「19:00 〜 翌03:00」）
 * @param {Object} bh businessHours オブジェクト
 * @returns {string|null}
 */
function formatBusinessHours(bh) {
  if (!bh || !bh.open || !bh.close) return null;
  const prefix = bh.closeNextDay ? '翌' : '';
  return `${bh.open} 〜 ${prefix}${bh.close}`;
}

/**
 * 「HH:MM」文字列を分数に変換
 */
function _hmToMinutes(hm) {
  if (!hm) return 0;
  const m = String(hm).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * 出勤記録に対する打刻忘れ判定。
 * @param {Object} record  attendance行 { date:'YYYY-MM-DD', clockIn:'HH:MM' or Date文字列, clockOut:同 }
 * @param {Date}   [now]   現在時刻（テスト時オーバーライド用）
 * @returns {'completed'|'working'|'forgotten'}
 *   - completed: 退勤打刻済み（通常表示）
 *   - working  : 退勤空欄かつ営業終了+1h未経過（勤務中）
 *   - forgotten: 退勤空欄かつ営業終了+1h経過後（打刻忘れ）
 */
function judgeAttendanceState(record, now) {
  if (!record) return 'completed';
  // parseTimeStr は history.js 側にしか無いため、ここでは最小実装で時刻を抜き出す
  const clockOutStr = _extractHHMM(record.clockOut);
  if (clockOutStr) return 'completed';

  const clockInStr = _extractHHMM(record.clockIn);
  if (!clockInStr || !record.date) return 'completed';

  const nowDt = now || new Date();
  const bh = getBusinessHours();

  // 入店日時を Date オブジェクト化
  const [y, m, d] = String(record.date).split(/[-\/]/).map(Number);
  if (!y || !m || !d) return 'completed';
  const clockInMin = _hmToMinutes(clockInStr);
  const clockInDt = new Date(y, m - 1, d, Math.floor(clockInMin / 60), clockInMin % 60, 0);

  let thresholdDt;
  if (bh) {
    // 営業時間ベース：閉店時刻 + 1時間
    const closeMin = _hmToMinutes(bh.close);
    const closeDt = new Date(y, m - 1, d, Math.floor(closeMin / 60), closeMin % 60, 0);
    if (bh.closeNextDay) closeDt.setDate(closeDt.getDate() + 1);
    thresholdDt = new Date(closeDt.getTime() + 60 * 60 * 1000); // +1時間
  } else {
    // フォールバック：入店から24時間
    thresholdDt = new Date(clockInDt.getTime() + 24 * 60 * 60 * 1000);
  }

  return nowDt.getTime() > thresholdDt.getTime() ? 'forgotten' : 'working';
}

/**
 * シリアル日時/ISO/HH:MM 文字列から HH:MM を取り出す（最小実装）
 */
function _extractHHMM(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{1,2}:\d{2}/.test(s)) return s.slice(0, 5);
  const m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return '';
}

/**
 * UI用語ラベルマップを返す。常に「出勤／退勤」表記の固定ラベルを返す。
 * @returns {Object} ラベルマップ
 */
function deriveUILabels() {
  return Object.assign({}, _UI_LABELS_STATIC);
}

/* ── 雇用形態ラベル（3種化対応） ─────────────────────────────
 * 戦略思想§3-9-3 サイクルA：employmentType を3種化（人事台帳の一貫性）
 *   - employed_full : 常勤雇用（社員・正社員ホステス・店長等／集計対象外）
 *   - employed_temp : 臨時アルバイト（短期バイト・週末ヘルプ等／変動費）
 *   - contractor    : 委託・外注（ホステス委託・派遣・外部キャスト等／案件直接費）
 *   - 旧 'employed'・未設定値はすべて 'employed_full' として表示する（後方互換）
 */
function employmentTypeLabel(value) {
  switch (value) {
    case 'employed_full': return '常勤雇用';
    case 'employed_temp': return '臨時アルバイト';
    case 'contractor':    return '委託・外注';
    default:              return '常勤雇用';   // 旧 'employed' 含む後方互換
  }
}

/* ── 機能表示フラグ（featureVisibility）─────────────────────
 * 固定値を返す。clockin_menu=true / payroll_menu=false。
 * ターゲット社が運営ポータル経由で settings B16 を書き換える運用に対応する（運営ポータル実装時）。
 */
function getFeatureVisibility() {
  return { clockin_menu: true, payroll_menu: false };
}



/* ── 金額フォーマット ────────────────────────────────────── */
/**
 * 数値を日本円表示（¥1,234,567）に変換
 * @param {number} amount
 * @returns {string}
 */
function formatYen(amount) {
  if (amount == null || isNaN(amount)) return '¥—';
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('ja-JP');
  return (amount < 0 ? '△¥' : '¥') + formatted;
}

/**
 * 税込金額から税抜・消費税を逆算する（全デバイス共通・3デバイス統合仕様§6-4）
 *
 * §6-4 正規ロジック：税抜 = floor(税込 / (1 + 税率/100))、消費税 = 税込 − 税抜
 * 浮動小数点誤差を避けるため、JS では (1 + rate/100) を経由せず整数演算で実装する：
 *   taxExcluded = floor(taxIncluded * 100 / (100 + rate))
 * これは数学的に等価だが、たとえば 55000 / 1.1 が 49999.99999999999 になる FP誤差を回避する
 * （例：55000円・10% → 税抜 50000・消費税 5000。FP では 5001 になるバグを修正）
 *
 * 極小金額への配慮：税抜が 0 に丸められる場合（例：1円・10%）は税込全額を税抜扱いにし
 * 消費税 0 を返す。負値や `-1` を返さない（§0-3 テスト3）。
 *
 * @param {number} taxIncluded 税込金額（円・整数）
 * @param {number} taxRate     税率（%・10 / 8 / 0 のいずれか）
 * @returns {{ taxExcluded: number, tax: number }}
 */
function calcTax(taxIncluded, taxRate) {
  const inAmt = Number.isFinite(Number(taxIncluded)) ? Math.max(0, Math.floor(Number(taxIncluded))) : 0;
  const rate  = Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0;
  if (rate <= 0) {
    return { taxExcluded: inAmt, tax: 0 };
  }
  const taxExcluded = Math.floor((inAmt * 100) / (100 + rate));
  if (taxExcluded === 0 && inAmt > 0) {
    return { taxExcluded: inAmt, tax: 0 };
  }
  const tax = inAmt - taxExcluded;
  return { taxExcluded, tax };
}

/* ── 日付ユーティリティ ──────────────────────────────────── */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 今日の日付文字列（YYYY-MM-DD）を返す
 * @returns {string}
 */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 月末まで何日あるか返す
 * @returns {number}
 */
function daysUntilMonthEnd() {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return lastDay - now.getDate();
}

/**
 * 月末3日前かどうか
 * @returns {boolean}
 */
function isNearMonthEnd() {
  return daysUntilMonthEnd() < 3;
}

/* ── トースト通知 ────────────────────────────────────────── */
let _toastTimer = null;

/**
 * トーストを表示
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration ミリ秒
 */
function showToast(message, type = 'info', duration = 2500) {
  let toast = document.getElementById('uz-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'uz-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast toast--${type} toast--show`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.remove('toast--show');
  }, duration);
}

/* ── ローディング ────────────────────────────────────────── */
/**
 * ローディングオーバーレイ表示
 */
function showLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.add('loading-overlay--show');
}

/**
 * ローディングオーバーレイ非表示
 */
function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.remove('loading-overlay--show');
}

/* ── 時刻セレクト ────────────────────────────────────────── */
const _TIME_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const _TIME_MINS  = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

/**
 * 時・分セレクト2つのHTML断片を返す
 * @param {string}  idPrefix  'form-clockin' など（-h / -m が付く）
 * @param {string}  value     'HH:MM' または ''
 * @param {boolean} required  false なら先頭に空選択肢を追加
 */
function timeSelectHTML(idPrefix, value, required = false) {
  const parts = (value || '').split(':');
  const selH  = (parts[0] || '').padStart(2, '0');
  const selM  = (parts[1] || '').padStart(2, '0');

  const blankH = required ? '' : '<option value="">--</option>';
  const blankM = required ? '' : '<option value="">--</option>';

  const optsH = blankH + _TIME_HOURS.map(v =>
    `<option value="${v}"${v === selH ? ' selected' : ''}>${v}</option>`
  ).join('');
  const optsM = blankM + _TIME_MINS.map(v =>
    `<option value="${v}"${v === selM ? ' selected' : ''}>${v}</option>`
  ).join('');

  return `<div style="display:flex;align-items:center;gap:6px;">` +
    `<select id="${idPrefix}-h" class="date-input" style="width:72px;">${optsH}</select>` +
    `<span style="color:var(--uz-text);font-weight:600;font-size:16px;">:</span>` +
    `<select id="${idPrefix}-m" class="date-input" style="width:72px;">${optsM}</select>` +
    `</div>`;
}

/**
 * 時刻セレクトの現在値を "HH:MM" で返す（未選択なら ''）
 * @param {string} idPrefix
 * @returns {string}
 */
function getTimeSelectValue(idPrefix) {
  const h = document.getElementById(`${idPrefix}-h`)?.value || '';
  const m = document.getElementById(`${idPrefix}-m`)?.value || '';
  if (!h || !m) return '';
  return `${h}:${m}`;
}

/**
 * 時刻セレクトに値をセット
 * @param {string} idPrefix
 * @param {string} value 'HH:MM' または ''
 */
function setTimeSelect(idPrefix, value) {
  const hEl = document.getElementById(`${idPrefix}-h`);
  const mEl = document.getElementById(`${idPrefix}-m`);
  if (!hEl || !mEl) return;
  if (!value) {
    hEl.value = '';
    mEl.value = '';
    return;
  }
  const parts = value.split(':');
  const h     = (parts[0] || '').padStart(2, '0');
  const m     = (parts[1] || '').padStart(2, '0');
  hEl.value = h;
  mEl.value = m;
}

/* ── 労働時間計算（日またぎ自動判定） ───────────────────── */
/**
 * 労働時間を計算し、日またぎ・異常判定を返す
 * @param {string} clockIn  'HH:MM'
 * @param {string} clockOut 'HH:MM'
 * @returns {object|null} { minutes, hours, mins, isOvernight, isAbnormal, clockOutDisplay } | null
 *
 * 判定ルール:
 *   - 退店時刻 >= 入店時刻 → 同日退店
 *   - 退店時刻 <  入店時刻 → 翌日退店（+24時間）
 *   - 労働時間が13時間超 → 異常フラグ
 */
const _WORK_ABNORMAL_MINUTES = 13 * 60; // 13時間を超えたら異常

function calcWorkDuration(clockIn, clockOut) {
  if (!clockIn || !clockOut) return null;
  const mIn  = clockIn.match(/^(\d{1,2}):(\d{2})/);
  const mOut = clockOut.match(/^(\d{1,2}):(\d{2})/);
  if (!mIn || !mOut) return null;

  const inMin  = parseInt(mIn[1], 10)  * 60 + parseInt(mIn[2], 10);
  const outMin = parseInt(mOut[1], 10) * 60 + parseInt(mOut[2], 10);

  const isOvernight = outMin < inMin;
  const totalMin    = isOvernight ? (outMin + 24 * 60 - inMin) : (outMin - inMin);

  return {
    minutes: totalMin,
    hours: Math.floor(totalMin / 60),
    mins:  totalMin % 60,
    isOvernight,
    isAbnormal: totalMin > _WORK_ABNORMAL_MINUTES,
    clockOutDisplay: isOvernight ? `翌${clockOut}` : clockOut,
  };
}

/* ── ページナビゲーション ────────────────────────────────── */
/**
 * 指定URLに遷移
 * @param {string} url
 */
function navigate(url) {
  window.location.href = url;
}

/* ── コスト科目マスタ ─────────────────────────────────────── */
// COST_MASTER_KEY は冒頭で集約定義済み（SSOT）

/**
 * デフォルト販管費科目マスタ（青色申告決算書 完全整合・販管費専用）
 * 仕入原価（purchaseMasterList・settings.B5）とは独立したマスタ。
 * このマスタには divisionCode:'1'（仕入原価）を含めない。
 */
const DEFAULT_COST_MASTER = [
  // ── 販管費（divisionCode:"2"）固定科目 ──
  { code: '8',  taxRow: 8,  name: '租税公課',       taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '9',  taxRow: 9,  name: '荷造運賃',       taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '10', taxRow: 10, name: '水道光熱費',     taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '11', taxRow: 11, name: '旅費交通費',     taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '12', taxRow: 12, name: '通信費',         taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '13', taxRow: 13, name: '広告宣伝費',     taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '14', taxRow: 14, name: '接待交際費',     taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '15', taxRow: 15, name: '損害保険料',     taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '16', taxRow: 16, name: '修繕費',         taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '17', taxRow: 17, name: '消耗品費',       taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '18', taxRow: 18, name: '減価償却費',     taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '19', taxRow: 19, name: '福利厚生費',     taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '20', taxRow: 20, name: '給料賃金',       taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '21', taxRow: 21, name: '外注工賃',       taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '22', taxRow: 22, name: '利子割引料',     taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '23', taxRow: 23, name: '地代家賃',       taxRate: 10, type: 'fixed',  divisionCode: '2' },
  { code: '24', taxRow: 24, name: '貸倒金',         taxRate: 0,  type: 'fixed',  divisionCode: '2' },
  { code: '25', taxRow: 25, name: '税理士等の報酬', taxRate: 10, type: 'fixed',  divisionCode: '2' },
  // ── 販管費（divisionCode:"2"）任意科目（行26〜30） ──
  { code: '26', taxRow: 26, name: '', taxRate: 10, type: 'custom', divisionCode: '2' },
  { code: '27', taxRow: 27, name: '', taxRate: 10, type: 'custom', divisionCode: '2' },
  { code: '28', taxRow: 28, name: '', taxRate: 10, type: 'custom', divisionCode: '2' },
  { code: '29', taxRow: 29, name: '', taxRate: 10, type: 'custom', divisionCode: '2' },
  { code: '30', taxRow: 30, name: '', taxRate: 10, type: 'custom', divisionCode: '2' },
  // ── 販管費（divisionCode:"2"）固定科目（続き） ──
  { code: '31', taxRow: 31, name: '雑費',           taxRate: 10, type: 'fixed',  divisionCode: '2' },
];

/**
 * コスト科目マスタ（販管費）を正規化する。
 * GAS getCostMaster / settings B4 の生データは divisionCode / type / taxRow が
 * 欠落・汚染しうる（複製元が保存可能だった時代のノイズ等）。
 * DEFAULT_COST_MASTER を code 辞書として正規構造に矯正する。
 *
 * 方針（02_画面仕様.md PC設定・04_運営ポータル.md §6 準拠）：
 *  - 固定枠（code 8〜25・31）：名称は readonly のため正規名で矯正（ノイズ名を排除）。
 *    税率・smartphoneVisible は保存値を尊重。divisionCode/type/taxRow は正規定義で補完。
 *  - 任意枠（code 26〜30）：名称は編集可のため保存値を尊重。divisionCode='2'/type='custom' を保証。
 *  - 正規 code に無い不正項目（複製元ノイズ等）は破棄する。
 *  - GAS に欠落した正規 code は DEFAULT から補完し、24件構造を常に保証する。
 *
 * @param {Array} raw GAS/B4 由来の生配列
 * @returns {Array} 正規化済み（DEFAULT と同じ code 順・24件）
 */
function normalizeCostMasterList(raw) {
  const rawByCode = {};
  if (Array.isArray(raw)) {
    raw.forEach(it => {
      if (it && it.code != null) rawByCode[String(it.code)] = it;
    });
  }
  return DEFAULT_COST_MASTER.map(def => {
    const r = rawByCode[def.code];
    const isCustom = def.type === 'custom';
    // 名称：固定枠は正規名で矯正、任意枠は保存値（空可）を尊重
    const name = isCustom
      ? (r && typeof r.name === 'string' ? r.name : '')
      : def.name;
    // 税率：保存値があれば尊重、なければ正規デフォルト
    const taxRate = (r && r.taxRate != null && !isNaN(Number(r.taxRate)))
      ? Number(r.taxRate) : def.taxRate;
    // 表示：保存値を尊重（未定義 or true → true / false のみ false）
    const smartphoneVisible = r ? (r.smartphoneVisible !== false) : true;
    return {
      code:        def.code,
      taxRow:      def.taxRow,
      name:        name,
      taxRate:     taxRate,
      type:        def.type,
      divisionCode: '2',          // 販管費マスタは常に '2'
      smartphoneVisible: smartphoneVisible,
    };
  });
}

/**
 * コスト科目マスタをlocalStorageから取得（なければデフォルト）
 * @returns {Array}
 */
function getCostMaster() {
  try {
    const saved = localStorage.getItem(COST_MASTER_KEY);
    return saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(DEFAULT_COST_MASTER));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_COST_MASTER));
  }
}

/**
 * コスト科目マスタをlocalStorageに保存
 * @param {Array} list
 */
function saveCostMasterToStorage(list) {
  localStorage.setItem(COST_MASTER_KEY, JSON.stringify(list));
}

/* ── 仕入原価マスタ（purchaseMasterList・settings.B5） ──────────
 * 販管費マスタ（costMasterList・B4）とは独立。id:'p001'〜。
 * 登録＝表示固定で smartphoneVisible は持たない（03_データ仕様.md §1-3 / §6-5）。
 * GAS正本は syncSettingsAtStartup が PURCHASE_MASTER_KEY に同期する。 */
function getPurchaseMaster() {
  try {
    const saved = localStorage.getItem(PURCHASE_MASTER_KEY);
    const list = saved ? JSON.parse(saved) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/* ── 税理士用CSV DL（共通ユーティリティ） ─────────────────── */

/**
 * 月プルダウンの選択肢を生成（直近24ヶ月分、新しい順）
 * @param {HTMLSelectElement} selectEl
 * @param {string} defaultValue 'YYYY-MM'
 */
function buildMonthOptions(selectEl, defaultValue) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const now = new Date();
  const MIN = '2025-01';
  for (let i = 0; i < 24; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (val < MIN) break;
    const opt = document.createElement('option');
    opt.value       = val;
    opt.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    selectEl.appendChild(opt);
  }
  if (defaultValue) selectEl.value = defaultValue;
}

/**
 * YYYY-MM の範囲から月リストを生成
 * @param {string} from 'YYYY-MM'
 * @param {string} to   'YYYY-MM'
 * @returns {string[]}
 */
function _buildMonthRange(from, to) {
  const months = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
    if (months.length > 24) break; // 最大2年分
  }
  return months;
}

/**
 * 税理士用CSV（期間指定）をダウンロード
 * @param {string} fromMonth 'YYYY-MM'
 * @param {string} toMonth   'YYYY-MM'
 * @param {HTMLButtonElement|null} btnEl ボタン要素（ローディング表示用）
 */
async function downloadTaxCSVByRange(fromMonth, toMonth, btnEl) {
  if (!fromMonth || !toMonth || fromMonth > toMonth) {
    alert('期間を正しく選択してください(開始月 ≤ 終了月)');
    return;
  }

  const origText = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '取得中...'; }

  try {
    const months = _buildMonthRange(fromMonth, toMonth);

    const results = await Promise.all(
      months.map(mo =>
        callGAS('getSummary', { month: mo })
          .then(r => (r && r.status === 'ok' && r.data) ? r.data : null)
          .catch(() => null)
      )
    );

    // 販管費科目マスタ（確定申告行番号対応・costMasterList・販管費専用）
    const master = typeof getCostMaster === 'function' ? getCostMaster() : [];

    // 仕入原価科目は purchaseMasterList（settings.B5）が正本（→ 03_データ仕様.md §1-3 / §5-7）
    let purchaseList = [];
    try {
      const rawP = localStorage.getItem('uz_purchase_master');
      if (rawP) purchaseList = JSON.parse(rawP);
    } catch { purchaseList = []; }
    const cogsSubjects = (Array.isArray(purchaseList) ? purchaseList : [])
      .filter(item => item && item.name)
      .map(item => ({ name: item.name, row: '-', key: null, div: 'cogs' }));

    // 販管費科目（divisionCode:"2"）
    const sgaSubjects = master
      .filter(item => item.divisionCode === '2' && item.name)
      .sort((a, b) => (a.taxRow ?? 99) - (b.taxRow ?? 99))
      .map(item => ({ name: item.name, row: item.taxRow ? `行${item.taxRow}` : '-', key: null, div: 'sga' }));

    const subjects = [
      { name: '売上(収入)金額', row: '行1',  key: 'sales'  },
      { name: '仕入金額合計',     row: '-',    key: 'cogs'   },
      ...cogsSubjects,
      { name: '粗利',             row: '-',    key: 'gross'  },
      { name: '販管費合計',       row: '-',    key: 'sga'    },
      ...sgaSubjects,
      { name: '経常利益',         row: '行43', key: 'profit' },
    ];

    // ヘッダー行
    const monthLabels = months.map(mo => {
      const [y, mm] = mo.split('-').map(Number);
      return `${y}年${mm}月`;
    });
    const header = ['科目', '行番号', ...monthLabels, '期間合計'];
    const csvRows = [header];

    subjects.forEach(s => {
      const monthly = results.map(d => {
        if (!d) return 0;
        if (s.key === 'sales')  return d.sales  || 0;
        if (s.key === 'cogs')   return d.cogs   || 0;
        if (s.key === 'gross')  return (d.sales || 0) - (d.cogs || 0);
        if (s.key === 'sga')    return d.sga    || 0;
        if (s.key === 'profit') return (d.sales || 0) - (d.cogs || 0) - (d.sga || 0);
        // 内訳科目：sgaBreakdown + cogsBreakdown から検索
        const breakdown = [...(d.sgaBreakdown || []), ...(d.cogsBreakdown || [])];
        const found = breakdown.find(it => it.name === s.name);
        return found ? (found.amount || 0) : 0;
      });
      const total = monthly.reduce((a, b) => a + b, 0);
      csvRows.push([s.name, s.row, ...monthly, total]);
    });

    // CSV文字列生成（BOM付きUTF-8）
    const csv  = csvRows
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const bom  = '\uFEFF';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ultra_zaimu_${fromMonth.replace('-', '')}-${toMonth.replace('-', '')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (e) {
    alert('ダウンロードに失敗しました: ' + e.message);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = origText; }
  }
}
