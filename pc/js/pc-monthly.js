/**
 * ウルトラZAIMUくんレオ PC版 — pc-monthly.js
 * 月次管理画面のロジック
 * 戦略思想§3-9-3 / §1-4 / §4-3 / 3デバイス統合§6-4 §8-3 §8-4 / 技術仕様§4-5 §4-6 §9-4 §9-4-1 §9-5 §9-6 準拠
 */
'use strict';

/* ── 状態 ──────────────────────────────────────────────── */
// 指示書9§1：月選択UIを廃止。指示書12§1：月パラメータを送らず GAS から全件取得し、月跨ぎは列見出しフィルタで対応

let _monthlyData = [];                 // 統合後の全行配列（並び：date desc, rowIndex desc）
let _settings = { costMaster: [], serviceList: [] };
// 指示書11§3：20件ページング
const PAGE_SIZE = 20;
let _pageIndex = 0;                    // 0 = 最新20件・1 = 21〜40件目 …
let _activeFilters = {};               // 列見出しフィルタ { type: Set, subject: Set, taxRate: Set, project: Set }
let _draftRows = [];                   // 未確定ドラフト行配列（テーブル最上段に表示）
let _editingRowKey = null;             // 編集中の rowKey（同時編集は1行のみ）
let _editingDraft = {};                // 編集中の途中値
let _draftSeq = 0;                     // ドラフトIDカウンタ
let _modalState = null;                // 紐付け候補モーダル状態 { direction, candidates, onConfirm, onClose, keydownHandler }
let _colFilterDocClickHandler = null;  // 列見出しフィルタの外側クリック検知ハンドラ（解除用）

/* ── ユーティリティ ──────────────────────────────────────── */
// _todayYM は指示書9§1 で廃止（月フィルタ UI 撤去）。指示書12§1 で _currentMonth も撤去（全月読込に変更）

function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function _formatYenPlain(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('ja-JP');
}

// 内消費税は app.js の calcTax(taxIncluded, taxRate)（§6-4 整数演算実装）を経由
function _calcTaxAmount(amountInclTax, taxRate) {
  return calcTax(amountInclTax, taxRate).tax;
}

function _rowKey(row) {
  return row.source === 'draft'
    ? `draft-${row.draftId}`
    : `row-${row.source}-${row.rowIndex}`;
}

/* ── 種別分類（コスト科目→typeCode・指示書5§2-1 / 集計対象4区分判定） ── */
function _classifyCost(divisionCode, itemCode) {
  const dv = String(divisionCode || '');
  const ic = String(itemCode || '');
  if (dv === '1') return { type: '仕入原価', typeCode: 'shi' };
  if (dv === '2' && ic === '21') return { type: '委託・外注', typeCode: 'gai' };
  if (dv === '2' && ic === '20') return { type: '人件費', typeCode: 'jin' };
  return { type: '販管費', typeCode: 'h' };
}

// 紐付け対象判定（GAS と同じ条件・指示書5§3-2）
function _isLinkableCost(row) {
  if (row.source !== 'cost') return false;
  if (row.divisionCode === '1') return true;
  if (row.subjectCode === '21' || row.subjectCode === '20' || row.subjectCode === '25') return true;
  return false;
}

/* ── 起動 ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initMonthly);

async function initMonthly() {
  pcBootstrap('pc-monthly.html', '月次管理');
  bindAddButtons();
  bindModalEvents();
  bindColFilterButtons();
  bindTbodyDelegation();   // 指示書8-5§1：tbody 単位の統一イベントデリゲーション
  bindPaginationButtons(); // 指示書11§3：ページャ（前の20件 / 次の20件）
  await loadMonthlyData('');   // 指示書12§1：月フィルタなし＝GAS 側全件取得
}

// 指示書11§3：ページャUIの click ハンドラを1度だけ結線
function bindPaginationButtons() {
  document.getElementById('page-older')?.addEventListener('click', () => {
    _pageIndex++;
    renderTable();
  });
  document.getElementById('page-newer')?.addEventListener('click', () => {
    if (_pageIndex > 0) _pageIndex--;
    renderTable();
  });
}

/* ── データ取得・統合 ────────────────────────────────────── */
async function loadMonthlyData(month) {
  const tbody = document.getElementById('monthly-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="loading">読み込み中…</td></tr>';

  try {
    const [historyRes, settingsRes] = await Promise.all([
      callGAS('getHistory', { month }).catch(() => null),
      callGAS('getSettings').catch(() => null),
    ]);
    const history = (historyRes && historyRes.status === 'ok' && Array.isArray(historyRes.data))
      ? historyRes.data : [];
    const settings = (settingsRes && settingsRes.status === 'ok' && settingsRes.data)
      ? settingsRes.data : {};

    _settings.costMaster = (typeof getCostMaster === 'function') ? getCostMaster() : [];
    if (settings.costMasterList && Array.isArray(settings.costMasterList) && settings.costMasterList.length) {
      // GAS生データは type/divisionCode が欠落しうるため正規化してから使う（→ app.js）
      _settings.costMaster = (typeof normalizeCostMasterList === 'function')
        ? normalizeCostMasterList(settings.costMasterList)
        : settings.costMasterList;
    }
    _settings.serviceList = Array.isArray(settings.serviceList) ? settings.serviceList : [];

    _monthlyData = mergeAndClassify(history);
    _sortRows(_monthlyData);
    // 月切替時は編集状態とドラフトを破棄
    _editingRowKey = null;
    _editingDraft = {};
    _draftRows = [];
    _pageIndex = 0;   // 指示書11§3：データ再読込時はページ位置を最新（先頭）にリセット
    renderTable();
  } catch (err) {
    console.error('[pc-monthly] loadMonthlyData failed', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="loading">読み込みに失敗しました：${_escHtml(err.message || err)}</td></tr>`;
  }
}

function mergeAndClassify(historyRows) {
  const out = [];
  for (const r of historyRows) {
    if (r.type === 'sales') {
      const salesRowId = String(r.salesRowId || r.projectId || '');
      out.push({
        source:     'sales',
        rowIndex:   Number(r.rowIndex),
        sheetName:  '売上',
        date:       String(r.date || ''),
        type:       '売上',
        typeCode:   'u',
        subject:    String(r.itemName || ''),
        subjectCode: String(r.serviceCode || ''),
        amount:     Number(r.amount) || 0,
        taxRate:    Number(r.taxRate) || 0,
        taxAmount:  (typeof r.taxAmount === 'number' && r.taxAmount > 0)
                       ? r.taxAmount
                       : _calcTaxAmount(r.amount, r.taxRate),
        memo:       String(r.memo || ''),
        isProject:  !!r.isProject,                  // U列='1' を GAS が boolean 化して返す
        isUnpaid:   Number(r.uncollected) === 1,
        isLocked:   !!r.isLocked,                   // S列=1 を GAS が boolean 化して返す
        salesRowId: salesRowId,
      });
    } else if (r.type === 'cost') {
      const cls = _classifyCost(r.divisionCode, r.itemCode);
      const linkedTo = String(r.linkedSalesRowId !== undefined ? r.linkedSalesRowId : (r.projectId || ''));
      out.push({
        source:     'cost',
        rowIndex:   Number(r.rowIndex),
        sheetName:  'コスト',
        date:       String(r.date || ''),
        type:       cls.type,
        typeCode:   cls.typeCode,
        subject:    String(r.itemName || ''),
        subjectCode: String(r.itemCode || ''),
        divisionCode: String(r.divisionCode || ''),
        amount:     Number(r.amount) || 0,
        taxRate:    Number(r.taxRate) || 0,
        taxAmount:  (typeof r.taxAmount === 'number' && r.taxAmount > 0)
                       ? r.taxAmount
                       : _calcTaxAmount(r.amount, r.taxRate),
        memo:       String(r.memo || ''),
        isProject:  linkedTo.length > 0,            // V列に値あり＝紐付け済み＝案件
        isUnpaid:   Number(r.unpaid) === 1,
        isLocked:   !!r.isLocked,
        salesRowId: linkedTo,
      });
    }
  }
  return out;
}

// 並び順：発生日 desc（直近が最上段）・同日内は rowIndex desc（指示書12§2：新規登録が上）
function _sortRows(rows) {
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.rowIndex - a.rowIndex;
  });
}

/* ── フィルタ（列見出しフィルタ・指示書8§2 / 8-2§1 / 8-3 / 戦略思想§4-3） ─── */
// 列ごとの値抽出（指示書8-2§1：ドロップダウン表示ラベルと filter Set の値を一致させる）
//  - type/subject/memo：行の文字列をそのまま返す
//  - taxRate：「10%」「8%」「0%」等の表示文字列
//  - project：「案件あり」「案件なし」（ラベル文字列・boolean ではない）
//  - date  ：「YYYY年M月」形式（指示書8-3§2：他列と同じチェックボックス方式に統一）
function _getColValue(row, col) {
  if (col === 'type')    return String(row.type || (row.source === 'sales' ? '売上' : ''));
  if (col === 'subject') return String(row.subject || row.subjectName || '');
  if (col === 'taxRate') return `${Number(row.taxRate) || 0}%`;
  if (col === 'project') return row.isProject ? '案件あり' : '案件なし';
  if (col === 'memo')    return String(row.memo || '');
  if (col === 'date') {
    const m = String(row.date || '').match(/^(\d{4})-(\d{1,2})-/);
    return m ? `${m[1]}年${Number(m[2])}月` : '';
  }
  return '';
}

// フィルタ判定（exceptCol を除外して評価）
//  指示書8-3§2：date 列も他列と同じ Set<string> フィルタとして統一処理
function _matchesActiveFiltersExcept(row, exceptCol) {
  for (const [col, val] of Object.entries(_activeFilters)) {
    if (col === exceptCol) continue;
    if (!val || val.size === 0) continue;
    if (!val.has(_getColValue(row, col))) return false;
  }
  return true;
}

// フィルタ適用：_activeFilters に登録された各列について、行が条件に合致するかを確認
function applyFilters(rows) {
  if (Object.keys(_activeFilters).length === 0) return rows;
  return rows.filter(r => _matchesActiveFiltersExcept(r, null));
}

// 列フィルタが現在「実質的に有効」かを判定（指示書8-3§2：date を含め全列 Set 非空で判定）
function _hasActiveColFilter(col) {
  const v = _activeFilters[col];
  return !!v && v.size > 0;
}

// 指示書9§1：月選択 change リスナーは撤去（月フィルタUI 廃止のため）

/**
 * 列見出しに▼フィルタボタンを追加（th[data-filter-col] に対応）
 * クリックで _openColFilter(col, btn) を呼び、絞り込みドロップダウンを開く
 * フィルタ適用中はボタンに btn-col-filter--active を付与
 */
function bindColFilterButtons() {
  document.querySelectorAll('th[data-filter-col]').forEach(th => {
    const col = th.getAttribute('data-filter-col');
    if (!col) return;
    if (th.querySelector('.btn-col-filter')) return;  // 二重バインド防止
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-col-filter';
    btn.dataset.col = col;
    btn.textContent = '▼';
    btn.title = `${th.firstChild ? th.firstChild.textContent.trim() : col} で絞り込み`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openColFilter(col, btn);
    });
    th.appendChild(btn);
  });
}

function _refreshColFilterButtonStates() {
  document.querySelectorAll('.btn-col-filter').forEach(btn => {
    const col = btn.dataset.col;
    btn.classList.toggle('btn-col-filter--active', _hasActiveColFilter(col));
  });
}

/**
 * 列見出しフィルタのドロップダウンを開く（指示書8§2 / 8-2§1）
 * 値の母集団：他の全フィルタは適用するが、自列のフィルタだけは外して集計（Excel互換）
 *  → 「自列の値を全部見える状態」で他列での絞り込みを反映する
 * 値とラベルは _getColValue が返す表示文字列で統一（チェックボックス value とラベルは同一）
 */
function _openColFilter(col, btnEl) {
  _closeColFilter();
  const universe = _monthlyData.filter(r => _matchesActiveFiltersExcept(r, col));
  const valueSet = new Set();
  for (const r of universe) valueSet.add(_getColValue(r, col));
  const values = Array.from(valueSet).sort((a, b) => {
    if (col === 'taxRate') return Number(String(a).replace('%', '')) - Number(String(b).replace('%', ''));
    if (col === 'date') {
      // 「YYYY年M月」を年×100+月の整数に変換して比較（lexicographic だと "12月" < "5月" と誤判定するため）
      const parse = s => {
        const m = String(s).match(/^(\d+)年(\d+)月$/);
        return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
      };
      return parse(a) - parse(b);
    }
    return String(a).localeCompare(String(b));
  });
  const active = _activeFilters[col];
  // 既存のフィルタが無ければ全チェック・あれば該当のみチェック
  const isChecked = (v) => !active || active.size === 0 || active.has(v);

  const dropdown = document.createElement('div');
  dropdown.className = 'col-filter-dropdown';
  dropdown.id = '_col-filter-dropdown';
  dropdown.dataset.col = col;
  const allCheckedNow = values.length > 0 && values.every(isChecked);
  // 指示書8-4§2：value 属性を必ず付与する。data-cf-value のみだと i.value が HTML 既定の "on" を返し、
  // _activeFilters[col] が Set(["on"]) になって _getColValue の返り値と全件不一致 → 全行非表示の原因になる
  const itemsHtml = values.map(v => `
    <label><input type="checkbox" value="${_escHtml(v)}" data-cf-value="${_escHtml(v)}" ${isChecked(v) ? 'checked' : ''}> ${_escHtml(v)}</label>
  `).join('') || '<div class="col-filter-empty">表示できる値がありません</div>';
  dropdown.innerHTML = `
    <label class="col-filter-all"><input type="checkbox" data-cf-all ${allCheckedNow ? 'checked' : ''}> すべて選択</label>
    <hr>
    <div class="col-filter-list">${itemsHtml}</div>
    <div class="col-filter-actions">
      <button type="button" data-cf-action="clear">クリア</button>
      <button type="button" data-cf-action="apply">適用</button>
    </div>
  `;
  document.body.appendChild(dropdown);
  const rect = btnEl.getBoundingClientRect();
  dropdown.style.top  = (rect.bottom + window.scrollY + 2) + 'px';
  dropdown.style.left = (rect.left   + window.scrollX) + 'px';

  // 「すべて選択」⇄ 個別チェック の同期
  const allInput = dropdown.querySelector('input[data-cf-all]');
  const valInputs = Array.from(dropdown.querySelectorAll('input[data-cf-value]'));
  if (allInput) {
    allInput.addEventListener('change', () => {
      valInputs.forEach(inp => { inp.checked = allInput.checked; });
    });
  }
  valInputs.forEach(inp => {
    inp.addEventListener('change', () => {
      if (allInput) allInput.checked = valInputs.every(i => i.checked);
    });
  });
  // クリア・適用（指示書11§3：フィルタ変更時はページを最新にリセット）
  dropdown.addEventListener('click', (e) => {
    const a = e.target && e.target.dataset && e.target.dataset.cfAction;
    if (a === 'clear') {
      delete _activeFilters[col];
      _pageIndex = 0;
      _closeColFilter();
      renderTable();
    } else if (a === 'apply') {
      const checked = valInputs.filter(i => i.checked).map(i => i.value);
      if (checked.length === values.length) {
        delete _activeFilters[col];
      } else {
        _activeFilters[col] = new Set(checked);
      }
      _pageIndex = 0;
      _closeColFilter();
      renderTable();
    }
  });

  // 外側クリックで閉じる
  setTimeout(() => {
    _colFilterDocClickHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btnEl) {
        _closeColFilter();
      }
    };
    document.addEventListener('click', _colFilterDocClickHandler);
  }, 0);
}

function _closeColFilter() {
  const d = document.getElementById('_col-filter-dropdown');
  if (d) d.remove();
  if (_colFilterDocClickHandler) {
    document.removeEventListener('click', _colFilterDocClickHandler);
    _colFilterDocClickHandler = null;
  }
}

/**
 * フィルタ適用中の集計行（指示書8§2 / 8-2§4 / 8-6§2）
 *  thead 直下の sticky 行に各列対応のセルを更新する：
 *    発生日列 → 件数 / 金額列 → 金額合計 / 消費税列 → 消費税合計（その他列は空欄）
 *  フィルタ未適用時は集計行を非表示。ドラフト行は集計対象外。
 *  Excel AutoFilter ステータスバー / SaaS（kintone・Notion）の集計UI と同等（戦略思想§4-3）。
 */
function _renderFilterSummary(visibleRows) {
  const summaryRow = document.getElementById('monthly-summary-row');
  if (!summaryRow) return;
  const hasFilter = Object.keys(_activeFilters).some(c => _hasActiveColFilter(c));
  if (!hasFilter) { summaryRow.hidden = true; return; }
  let count = 0, sumAmount = 0, sumTax = 0;
  for (const r of visibleRows) {
    if (r.source === 'draft') continue;
    count++;
    sumAmount += Number(r.amount)    || 0;
    sumTax    += Number(r.taxAmount) || 0;
  }
  const setCell = (col, txt) => {
    const c = summaryRow.querySelector(`[data-summary-col="${col}"]`);
    if (c) c.textContent = txt;
  };
  setCell('count',  `${count}件`);
  setCell('amount', `¥${_formatYenPlain(sumAmount)}`);
  setCell('tax',    `¥${_formatYenPlain(sumTax)}`);
  summaryRow.hidden = false;
}

/* ── 描画 ────────────────────────────────────────────────── */
function renderTable() {
  const tbody = document.getElementById('monthly-tbody');
  if (!tbody) return;
  // 指示書8-3§1：実質的に有効なフィルタが1つも無ければ _monthlyData をそのまま使う（applyFilters は呼ばない）
  // 指示書8-5§3：filteredRows を1変数に確定し、本体描画と集計行に同じ参照を渡す（編集後の集計再計算を保証）
  const hasActiveFilter = Object.keys(_activeFilters).some(c => _hasActiveColFilter(c));
  const filteredRows = hasActiveFilter ? applyFilters(_monthlyData) : _monthlyData;

  // 指示書11§3：編集中の行が表示ページに含まれるよう _pageIndex を自動調整
  if (_editingRowKey) {
    const editingIdx = filteredRows.findIndex(r => _rowKey(r) === _editingRowKey);
    if (editingIdx >= 0) _pageIndex = Math.floor(editingIdx / PAGE_SIZE);
  }
  // _pageIndex を有効範囲内にクランプ
  const maxPage = Math.max(0, Math.ceil(filteredRows.length / PAGE_SIZE) - 1);
  if (_pageIndex > maxPage) _pageIndex = maxPage;
  if (_pageIndex < 0) _pageIndex = 0;
  const pageStart = _pageIndex * PAGE_SIZE;
  const pagedRows = filteredRows.slice(pageStart, pageStart + PAGE_SIZE);

  // ドラフト行を最上段（指示書5§2-2 step3 / §3-5）
  const draftHtml = _draftRows.map(d => renderDraftRow(d)).join('');
  const rowHtml   = pagedRows.map(r => renderRow(r)).join('');
  tbody.innerHTML = (draftHtml + rowHtml) || '<tr><td colspan="8" class="loading">該当する行がありません</td></tr>';
  // bindRowEvents は撤去（指示書8-5§1：tbody-level delegation で1度だけ結線・renderTable の負荷も低減）
  _refreshColFilterButtonStates();
  _renderFilterSummary(filteredRows);   // 集計はフィルタ後の全件が対象（ページング前）
  _renderPagination(filteredRows.length);
}

// 指示書11§3：ページャUI 更新（21件以上のときのみ表示）
function _renderPagination(totalCount) {
  const container = document.getElementById('monthly-pagination');
  const olderBtn  = document.getElementById('page-older');
  const newerBtn  = document.getElementById('page-newer');
  const info      = document.getElementById('page-info');
  if (!container || !olderBtn || !newerBtn || !info) return;
  if (totalCount <= PAGE_SIZE) { container.hidden = true; return; }
  container.hidden = false;
  const pageStart = _pageIndex * PAGE_SIZE;
  const start = pageStart + 1;
  const end   = Math.min(pageStart + PAGE_SIZE, totalCount);
  info.textContent = `${start}〜${end}件目 / 全${totalCount}件`;
  // 前の20件（古い方向）：21件目以降が存在するときのみ
  olderBtn.hidden = end >= totalCount;
  // 次の20件（最新方向）：2ページ目以降のときのみ
  newerBtn.hidden = _pageIndex === 0;
}

function renderRow(row) {
  const key = _rowKey(row);
  const isEditing = _editingRowKey === key;
  const classes = [
    isEditing ? 'pc-row--editing' : '',
    row.isUnpaid ? 'pc-row--unpaid' : '',
    row.isLocked ? 'pc-row--locked' : '',
  ].filter(Boolean).join(' ');

  const cellDate    = isEditing
    ? `<input type="date" class="pc-edit-input" data-field="date" value="${_escHtml(row.date)}">`
    : _escHtml(row.date);
  const cellSubject = isEditing
    ? renderSubjectSelect(row, 'edit')
    : _escHtml(row.subject);
  const cellAmount  = isEditing
    ? `<input type="number" class="pc-edit-input pc-edit-input--num" data-field="amount" value="${row.amount}">`
    : _formatYenPlain(row.amount);
  const cellTaxRate = isEditing
    ? renderTaxRateSelect(row.taxRate, 'edit')
    : `${row.taxRate}%`;
  const cellTax     = _formatYenPlain(row.taxAmount);
  const cellMemo    = isEditing
    ? `<input type="text" class="pc-edit-input" data-field="memo" value="${_escHtml(row.memo)}">`
    : _escHtml(row.memo);

  // 案件列：状態別に1セルへ集約（指示書8§1：操作列廃止・☆/★/解除申請/編集中ボタンを統合）
  //  - 編集中：保存・取消
  //  - ロック：解除申請（指示書15：削除ボタンは出さない）
  //  - 案件済（isProject=true）：★（解除）+ 削除（指示書15）
  //  - 未案件（isProject=false かつ案件化可能）：☆（案件化）+ 削除（指示書15）
  //  - 案件化対象外コスト：削除（指示書15）
  let cellProject;
  if (isEditing) {
    cellProject = `
      <button type="button" class="pc-action-btn pc-action-btn--save" data-action="save-edit">保存</button>
      <button type="button" class="pc-action-btn" data-action="cancel-edit">取消</button>
    `;
  } else if (row.isLocked) {
    cellProject = `<button type="button" class="pc-action-btn pc-action-btn--unlock" data-action="request-unlock">解除申請</button>`;
  } else {
    const parts = [];
    if (row.isProject) {
      parts.push(`<button type="button" class="btn-star btn-star--active" data-action="unmark-project" title="案件登録解除">★</button>`);
    } else {
      const canMark = row.source === 'sales' || (row.source === 'cost' && _isLinkableCost(row));
      if (canMark) {
        parts.push(`<button type="button" class="btn-star" data-action="mark-project" title="案件化">☆</button>`);
      }
    }
    parts.push(`<button type="button" class="pc-action-btn pc-action-btn--delete" data-action="delete-row" title="行を削除">削除</button>`);
    cellProject = parts.join('');
  }

  // 指示書11§4：tr 自体を focusable に（tabindex=0・ロック行のみ除外）
  //  編集中の行も focusable にすることで、Tab で input から抜けたあと tr に focus が移り
  //  data-selected="true" による行選択ハイライトが視認できるようになる
  const rowFocusable = !row.isLocked;
  const tabindexAttr = rowFocusable ? ' tabindex="0"' : '';

  return `
    <tr class="${classes}" data-row-key="${_escHtml(key)}" data-source="${row.source}" data-row-index="${row.rowIndex}"${tabindexAttr}>
      <td data-field-cell="date">${cellDate}</td>
      <td>${_escHtml(row.type)}</td>
      <td data-field-cell="subject">${cellSubject}</td>
      <td class="num" data-field-cell="amount">${cellAmount}</td>
      <td data-field-cell="taxRate">${cellTaxRate}</td>
      <td class="num">${cellTax}</td>
      <td data-field-cell="memo">${cellMemo}</td>
      <td class="pc-project-col">${cellProject}</td>
    </tr>
  `;
}

function renderDraftRow(draft) {
  const key = _rowKey(draft);
  const isCost = draft.realSource === 'cost';
  const cls = _classifyCost(draft.divisionCode, draft.subjectCode);
  // 種別表示：売上は固定、コストは区分タブUI（§1：戦略思想§1-4 / 技術仕様§9-4）
  const typeCellHtml = isCost
    ? renderCostDivisionTabs(draft)
    : `<span>売上</span>`;
  // 科目セル：コストは区分連動絞り込みプルダウン、売上はサービスマスタプルダウン
  const subjectCellHtml = isCost
    ? renderCostSubjectSelectFiltered(draft)
    : renderSubjectSelect(draft, 'draft');
  const draftTax = _calcTaxAmount(draft.amount, draft.taxRate);
  // 指示書11§1：取消↔登録の切り替え方式
  //   必須項目未入力 → 「取消」ボタンのみ表示・「登録」を hidden
  //   必須項目すべて入力 → 「登録」ボタンのみ表示・「取消」を hidden
  //   両ボタンを最初から DOM に持たせ、hidden 属性のトグルだけで切り替えることで focus を保持
  const valid = _isDraftValid(draft);
  const discardHidden = valid ? 'hidden' : '';
  const commitHidden  = valid ? '' : 'hidden';

  return `
    <tr class="pc-row--draft" data-row-key="${_escHtml(key)}" data-draft-id="${draft.draftId}">
      <td><input type="date" class="pc-edit-input" data-field="date" value="${_escHtml(draft.date)}"></td>
      <td>${typeCellHtml}</td>
      <td>${subjectCellHtml}</td>
      <td class="num"><input type="number" class="pc-edit-input pc-edit-input--num" data-field="amount" value="${draft.amount || ''}" placeholder="0"></td>
      <td>${renderTaxRateSelect(draft.taxRate, 'draft')}</td>
      <td class="num">${_formatYenPlain(draftTax)}</td>
      <td><input type="text" class="pc-edit-input" data-field="memo" value="${_escHtml(draft.memo)}" placeholder="メモ"></td>
      <td class="pc-project-col">
        <button type="button" class="pc-action-btn" data-action="discard-draft" ${discardHidden}>取消</button>
        <button type="button" class="pc-action-btn pc-action-btn--save" data-action="commit-draft" ${commitHidden}>登録</button>
      </td>
    </tr>
  `;
}

/**
 * コストドラフト行の区分タブ（仕入原価 / 販管費）
 * 区分未選択時はどちらも非アクティブ・科目プルダウンは disabled になる
 * クリック時 selectDraftDivision() で区分切替＋科目リセット＋再描画
 */
function renderCostDivisionTabs(draft) {
  const cur = String(draft.divisionCode || '');
  return `
    <div class="pc-division-tabs" role="tablist">
      <button type="button" class="pc-division-tab ${cur === '1' ? 'is-active' : ''}"
              data-action="select-division" data-division-code="1" role="tab">仕入原価</button>
      <button type="button" class="pc-division-tab ${cur === '2' ? 'is-active' : ''}"
              data-action="select-division" data-division-code="2" role="tab">販管費</button>
    </div>
  `;
}

/**
 * コストドラフト用 区分連動科目プルダウン（§1：技術仕様§9-4 §13-3）
 *  - 区分未選択：disabled・「先に区分を選択してください」
 *  - 区分=1（仕入原価）：costMaster の divisionCode='1' のみ＋諸口
 *  - 区分=2（販管費）  ：costMaster の divisionCode!='1' のうち smartphoneVisible≠false のみ＋諸口
 *  販管費科目のアプリ表示フラグ（smartphoneVisible）は全デバイス共通で参照する（OFF科目はコスト入力に出さない・既定全ON）
 */
function renderCostSubjectSelectFiltered(draft) {
  const div = String(draft.divisionCode || '');
  if (!div) {
    return `<select class="pc-edit-input" data-field="subjectCode" disabled>
              <option value="">先に区分を選択してください</option>
            </select>`;
  }
  const items = (_settings.costMaster || [])
    .filter(it => it && it.name && String(it.name).trim() !== '')
    .filter(it => {
      const itDiv = String(it.divisionCode || '');
      return div === '1' ? itDiv === '1' : itDiv !== '1';
    })
    .filter(it => {
      // 販管費（div='2'）のみ smartphoneVisible を参照。仕入原価はフラグ非搭載のため対象外。
      // smartphoneVisible キーが無い既存データは表示扱い（後方互換）。
      if (div === '1') return true;
      return it.smartphoneVisible !== false;
    });
  // 諸口を末尾に追加（divisionCode に紐付く）
  items.push({
    code: `MISC_${div}`, name: '諸口', taxRate: 10,
    divisionCode: div, type: 'misc',
  });
  const opts = ['<option value="">（科目を選択）</option>'].concat(
    items.map(it => {
      const code = String(it.code || '');
      const name = String(it.name || '');
      const sel = (String(draft.subjectCode || '') === code) ? 'selected' : '';
      return `<option value="${_escHtml(code)}" data-name="${_escHtml(name)}" data-tax="${Number(it.taxRate) || 0}" data-div="${_escHtml(it.divisionCode || div)}" ${sel}>${_escHtml(name)}</option>`;
    })
  ).join('');
  return `<select class="pc-edit-input" data-field="subjectCode">${opts}</select>`;
}

/**
 * ドラフト行の登録ボタン活性化判定（§1-7 / 戦略思想§1-4 §1-5-2）
 *  - 発生日：YYYY-MM-DD 形式
 *  - 区分タブ：コストは divisionCode 必須（売上は不要）
 *  - 科目：subjectCode 必須
 *  - 税率：taxRate が数値（0% も valid）
 *  - 金額：0円超の整数
 * いずれか満たさない場合は false → 登録ボタン disabled でAI自動確定を物理的に阻止
 */
function _isDraftValid(draft) {
  if (!draft) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.date || ''))) return false;
  const isCost = draft.realSource === 'cost';
  if (isCost && !String(draft.divisionCode || '')) return false;
  if (!String(draft.subjectCode || '')) return false;
  const rate = Number(draft.taxRate);
  if (!Number.isFinite(rate)) return false;
  const amt = Number(draft.amount);
  if (!Number.isFinite(amt) || amt <= 0) return false;
  return true;
}

/**
 * ドラフト行の区分タブクリックハンドラ
 *  - 同一タブクリックは no-op
 *  - 異なるタブ選択時：subjectCode / subject をリセットし、taxRate を初期 10% に戻す
 *  - 行を再描画して科目プルダウンを再生成
 */
function selectDraftDivision(draftId, divisionCode) {
  const d = _draftRows.find(x => String(x.draftId) === String(draftId));
  if (!d) return;
  if (String(d.divisionCode || '') === String(divisionCode)) return;
  d.divisionCode = String(divisionCode);
  d.subjectCode = '';
  d.subject = '';
  d.taxRate = 10;
  renderTable();
}

/**
 * ドラフト行の取消↔登録ボタン切替（指示書11§1：DOM部分更新・focus 保持用）
 * 入力中（amount/memo/date/taxRate/subjectCode の input イベント）から呼ばれる
 *  必須項目未入力 → 「取消」表示・「登録」非表示
 *  必須項目すべて入力 → 「登録」表示・「取消」非表示
 */
function _updateDraftSubmitState(tr, draft) {
  const valid = _isDraftValid(draft);
  const discardBtn = tr.querySelector('button[data-action="discard-draft"]');
  const commitBtn  = tr.querySelector('button[data-action="commit-draft"]');
  if (discardBtn) discardBtn.hidden = valid;
  if (commitBtn)  commitBtn.hidden  = !valid;
}

function renderSubjectSelect(row, mode) {
  if (row.realSource === 'sales' || row.source === 'sales') {
    const optsItems = (_settings.serviceList || []).map(s => {
      const code = String(s.code || s.serviceCode || '');
      const name = String(s.name || s.serviceName || '');
      const sel = (row.subjectCode === code || row.subject === name) ? 'selected' : '';
      return `<option value="${_escHtml(code)}" data-name="${_escHtml(name)}" ${sel}>${_escHtml(name)}</option>`;
    }).join('');
    // 指示書8-5§2：draft 時は placeholder option を先頭に置き明示選択を強制
    //  （browser が serviceList 先頭を auto-select 表示しても input イベントが発火せず draft.subjectCode='' のままで
    //   登録ボタンが永続的に disabled になるバグの再発防止。serviceList が空でも placeholder は表示される）
    if (mode === 'draft') {
      const fallback = optsItems ? '' : '<option value="" disabled>（サービスマスタ未登録）</option>';
      return `<select class="pc-edit-input" data-field="subjectCode"><option value="">（科目を選択）</option>${optsItems}${fallback}</select>`;
    }
    // edit 時は既存選択肢のみ（既選択中の subject を維持・誤クリアを防止）
    return `<select class="pc-edit-input" data-field="subjectCode">${optsItems || '<option value="">（マスタ未設定）</option>'}</select>`;
  }
  // cost：行の divisionCode で絞り込む（§3-3 #4 区分連動絞り込み）
  // 既存行の編集では区分自体は変更不可とし、同区分内での科目変更のみ許容する
  const rowDiv = String(row.divisionCode || '');
  const opts = (_settings.costMaster || [])
    .filter(it => it && it.name)
    .filter(it => {
      if (!rowDiv) return true; // 区分不明は全件表示（後方互換）
      const itDiv = String(it.divisionCode || '');
      return rowDiv === '1' ? itDiv === '1' : itDiv !== '1';
    })
    .map(it => {
      const code = String(it.code || '');
      const name = String(it.name || '');
      const sel = (row.subjectCode === code || row.subject === name) ? 'selected' : '';
      return `<option value="${_escHtml(code)}" data-name="${_escHtml(name)}" data-tax="${it.taxRate || 0}" data-div="${_escHtml(it.divisionCode || '')}" ${sel}>${_escHtml(name)}</option>`;
    }).join('');
  return `<select class="pc-edit-input" data-field="subjectCode">${opts || '<option value="">（科目マスタ未設定）</option>'}</select>`;
}

function renderTaxRateSelect(currentRate, mode) {
  const r = Number(currentRate) || 0;
  const opts = [10, 8, 0].map(v => {
    const sel = v === r ? 'selected' : '';
    return `<option value="${v}" ${sel}>${v}%</option>`;
  }).join('');
  return `<select class="pc-edit-input" data-field="taxRate">${opts}</select>`;
}

/* ── tbody 単位の統一イベントデリゲーション ────────────────
 * 指示書8-5§1：操作列廃止後の DOM 構造変更で per-tr 結線が破綻する問題を根本解消するため、
 *  click / input / keydown を tbody に1度だけ結線し、event.target.closest で振分ける。
 *  initMonthly から1度だけ呼ばれる。renderTable は tbody.innerHTML を書換えるだけで再結線不要。
 *  case 一覧は旧 bindRowEvents と完全互換。
 */
function bindTbodyDelegation() {
  const tbody = document.getElementById('monthly-tbody');
  if (!tbody) return;

  // ─── click：data-action ボタンの振分け＋編集セルクリック ───
  tbody.addEventListener('click', (e) => {
    // 1) data-action ボタンを最優先で処理（ドラフト登録/取消・☆/★案件化・解除申請・保存/取消・区分タブ）
    const actionEl = e.target.closest('[data-action]');
    if (actionEl && tbody.contains(actionEl)) {
      const tr = actionEl.closest('tr[data-row-key]');
      if (!tr) return;
      const rowKey = tr.getAttribute('data-row-key');
      const action = actionEl.getAttribute('data-action');
      switch (action) {
        case 'mark-project':    onMarkAsProject(rowKey);   break;
        case 'unmark-project':  onUnmarkAsProject(rowKey); break;
        case 'reconcile':       onReconcile(rowKey);       break;
        case 'request-unlock':  onRequestUnlock(rowKey);   break;
        case 'save-edit':       commitEdit();              break;
        case 'cancel-edit':     cancelEdit();              break;
        case 'delete-row':      onDeleteRow(rowKey);       break;   // 指示書15
        case 'commit-draft':    commitDraftRow(rowKey.replace('draft-', ''));   break;
        case 'discard-draft':   discardDraftRow(rowKey.replace('draft-', ''));  break;
        case 'select-division': {
          const draftId = rowKey.replace('draft-', '');
          const divCode = actionEl.getAttribute('data-division-code');
          selectDraftDivision(draftId, divCode);
          break;
        }
      }
      return;   // アクション処理後は編集セルクリックへ進まない
    }

    // 2) 編集セルクリック（td[data-field-cell]）→ startEdit またはロック警告
    const td = e.target.closest('td[data-field-cell]');
    if (td && tbody.contains(td)) {
      // 既に input/select 上のクリックなら edit 開始しない（既に編集中フォーカス内）
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const tr = td.closest('tr[data-row-key]');
      if (!tr) return;
      const rowKey = tr.getAttribute('data-row-key');
      if (rowKey.startsWith('draft-')) return;   // ドラフト行は click-to-edit 対象外
      const row = _monthlyData.find(r => _rowKey(r) === rowKey);
      if (!row) return;
      if (row.isLocked) { showToast('ロックされています', 'info', 2000); return; }
      const field = td.getAttribute('data-field-cell');
      if (!isFieldEditable(field, tr.getAttribute('data-source'))) return;
      startEdit(rowKey, field);
      return;
    }

    // 3) 指示書11§4：アクション/編集セル以外の click → tr.focus() で行選択状態へ
    //    例：種別セル（売上テキスト/コスト区分タブ外側）・案件列の空セル・行余白など
    const trAny = e.target.closest('tr[data-row-key]');
    if (trAny && tbody.contains(trAny) && trAny.hasAttribute('tabindex')) {
      trAny.focus();
    }
  });

  // ─── focusin：行選択状態（data-selected）の切替 ───
  //  指示書11§4：tr 自身に focus → data-selected="true"（ハイライト）
  //              input/select/button に focus → 全 tr の data-selected を解除
  //  これで「input フォーカス枠」と「行ハイライト」の両立を避けつつ視覚的にどちらか必ず示す
  tbody.addEventListener('focusin', (e) => {
    tbody.querySelectorAll('tr[data-selected="true"]').forEach(t => t.removeAttribute('data-selected'));
    const tr = e.target.closest('tr[data-row-key]');
    if (tr && e.target === tr) {
      tr.setAttribute('data-selected', 'true');
    }
  });

  // ─── focusout：focus が tbody 外へ抜けたら data-selected を解除 ───
  //  setTimeout(0) で次の focus 確定を待ってから判定
  tbody.addEventListener('focusout', () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (!tbody.contains(active) || active === document.body) {
        tbody.querySelectorAll('tr[data-selected="true"]').forEach(t => t.removeAttribute('data-selected'));
      }
    }, 0);
  });

  // ─── input：ドラフト or 編集中の入力値捕捉 ───
  tbody.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp || !inp.classList || !inp.classList.contains('pc-edit-input')) return;
    const tr = inp.closest('tr[data-row-key]');
    if (!tr) return;
    const rowKey = tr.getAttribute('data-row-key');
    const field  = inp.getAttribute('data-field');
    if (rowKey.startsWith('draft-')) {
      const draftId = rowKey.replace('draft-', '');
      const d = _draftRows.find(x => String(x.draftId) === String(draftId));
      if (!d) return;
      captureFieldValue(d, inp, field);
      updateDraftTaxDisplay(tr, d);
      _updateDraftSubmitState(tr, d);   // §1-7：登録ボタン活性化条件のリアルタイム判定
      // 科目プルダウン変更時は税率セレクト表示も同期（taxRate は captureFieldValue で更新済み）
      if (field === 'subjectCode') {
        const taxSel = tr.querySelector('select[data-field="taxRate"]');
        if (taxSel) taxSel.value = String(Number(d.taxRate) || 0);
      }
    } else {
      captureFieldValue(_editingDraft, inp, field);
    }
  });

  // ─── keydown：Excel 標準キー操作（指示書9§5 / 戦略思想§4-3） ───
  //  Esc → 取消（任意の focus 位置で動作・登録ボタン上で Esc を押してもドラフト破棄できるよう統一）
  //  Enter → 保存（pc-edit-input 上のみ・ドラフトは _isDraftValid 通過時 commitDraftRow / 編集中は commitEdit）
  //  ↑↓ → 行間フォーカス移動（INPUT 限定・SELECT 上では既定動作・ドラフト行は対象外）
  //  Tab / Delete → ブラウザ既定動作（独自 preventDefault せず）
  //  AI 自動確定禁止：mark-project / unmark-project ボタン上の Enter キーは preventDefault で抑止
  tbody.addEventListener('keydown', (e) => {
    const tr = e.target.closest && e.target.closest('tr[data-row-key]');
    const inp = e.target;
    const isEditInput = inp && inp.classList && inp.classList.contains('pc-edit-input');

    // Esc：focus 位置に関わらず統一処理（指示書9§2：登録ボタン上 Esc でもドラフト破棄）
    if (e.key === 'Escape' && tr) {
      const rowKey = tr.getAttribute('data-row-key');
      e.preventDefault();
      if (rowKey.startsWith('draft-')) {
        discardDraftRow(rowKey.replace('draft-', ''));
      } else if (_editingRowKey) {
        cancelEdit();
      }
      return;
    }

    // Enter：pc-edit-input 上のみ・保存に専念（指示書9§5：次セル移動は撤去）
    if (e.key === 'Enter' && !e.shiftKey && isEditInput && tr) {
      const rowKey = tr.getAttribute('data-row-key');
      e.preventDefault();
      if (rowKey.startsWith('draft-')) {
        // 指示書8-6§1：必須項目バリデーション通過時のみ commitDraftRow 発火
        const draftId = rowKey.replace('draft-', '');
        const d = _draftRows.find(x => String(x.draftId) === String(draftId));
        if (d && _isDraftValid(d)) commitDraftRow(draftId);
        // 未通過時は no-op
      } else if (_editingRowKey) {
        // 編集中：commitEdit で保存
        commitEdit();
      }
      return;
    }

    // ↑↓：tr 自身に focus がある「行選択状態」のときのみ行移動を発火（指示書10§5）
    //   input / select / button が focus 中は browser default を維持（カーソル移動・option 切替・無動作）
    //   tr の focus は tabindex="0" + Tab/click 等でユーザーが意図的に位置づけたときのみ
    //   ドラフト行は tabindex なしのため自然に対象外（rowFocusable=false）
    //   指示書12§3：移動先は input ではなく tr 自体に focus → 金色アウトライン維持で連続移動可
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.tagName === 'TR' && tr) {
      e.preventDefault();
      const focusableRows = Array.from(tbody.querySelectorAll('tr[data-row-key][tabindex="0"]'));
      const idx = focusableRows.indexOf(tr);
      if (idx < 0) return;
      const nextTr = e.key === 'ArrowDown' ? focusableRows[idx + 1] : focusableRows[idx - 1];
      if (nextTr) nextTr.focus();
      return;
    }

    // §1-4 AI 自動確定禁止：AI 提案系ボタン上の Enter キーを抑止（commit-draft は対象外＝§1-5-2 非該当）
    const actionEl = e.target.closest && e.target.closest('[data-action]');
    if (actionEl && e.key === 'Enter') {
      const action = actionEl.getAttribute('data-action');
      if (action === 'mark-project' || action === 'unmark-project') {
        e.preventDefault();
      }
    }
  });
}

function isFieldEditable(field, source) {
  // 仕様§2-4 / §3-4：date / subject(=subjectCode) / amount / taxRate / memo
  return ['date', 'subject', 'amount', 'taxRate', 'memo'].includes(field);
}

function captureFieldValue(target, inp, field) {
  let v = inp.value;
  if (field === 'amount') v = Number(v) || 0;
  if (field === 'taxRate') v = Number(v) || 0;
  if (field === 'subject') field = 'subjectCode';
  if (inp.tagName === 'SELECT' && field === 'subjectCode') {
    const opt = inp.options[inp.selectedIndex];
    if (opt && opt.dataset && opt.dataset.name) {
      target.subject = opt.dataset.name;
    }
    if (opt && opt.dataset && opt.dataset.tax !== undefined) {
      target.taxRate = Number(opt.dataset.tax) || 0;
    }
    if (opt && opt.dataset && opt.dataset.div !== undefined) {
      target.divisionCode = String(opt.dataset.div || '');
    }
  }
  target[field] = v;
}

function updateDraftTaxDisplay(tr, draft) {
  const numCells = tr.querySelectorAll('td.num');
  // 金額・消費税の2列が num。最後の num が消費税列
  if (numCells && numCells.length >= 2) {
    numCells[numCells.length - 1].textContent = _formatYenPlain(_calcTaxAmount(draft.amount, draft.taxRate));
  }
}

/* ── インライン編集 ──────────────────────────────────────── */
function startEdit(rowKey, field) {
  if (_editingRowKey === rowKey) return;
  if (_editingRowKey) cancelEdit();
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) return;
  if (row.isLocked) {
    showToast('ロックされています', 'info', 2000);
    return;
  }
  _editingRowKey = rowKey;
  _editingDraft = { ...row };
  renderTable();
  setTimeout(() => {
    const tr = document.querySelector(`tr[data-row-key="${CSS.escape(rowKey)}"]`);
    if (!tr) return;
    const target = tr.querySelector(`[data-field="${field === 'subject' ? 'subjectCode' : field}"]`);
    if (target) {
      target.focus();
      if (target.tagName === 'INPUT' && target.type !== 'date') {
        try { target.select(); } catch (_) {}
      }
    }
  }, 0);
}

// 「保存」ボタン押下のみで updateRow を呼ぶ（Tab/Enter/フォーカス外しでは送信しない・§1-4 / §3-4）
async function commitEdit() {
  const rowKey = _editingRowKey;
  if (!rowKey) return;
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) { cancelEdit(); return; }

  // 編集ドラフトから fields 構築
  // amount / taxRate は常に送信（指示書7§1：GAS 側 calcTax_ 整数演算で K列消費税を毎回正規化するため）
  // date / memo / subjectCode / subjectName は変更があった場合のみ送信
  const fields = {};
  if (_editingDraft.date && _editingDraft.date !== row.date) fields.date = _editingDraft.date;
  fields.amount  = Number(_editingDraft.amount)  || 0;
  fields.taxRate = Number(_editingDraft.taxRate) || 0;
  if (_editingDraft.memo !== undefined && _editingDraft.memo !== row.memo) {
    fields.memo = _editingDraft.memo;
  }
  if (_editingDraft.subjectCode && _editingDraft.subjectCode !== row.subjectCode) {
    fields.subjectCode = _editingDraft.subjectCode;
    fields.subjectName = _editingDraft.subject || '';
  }

  try {
    const res = await callGAS('updateRow', {
      sheetName: row.sheetName,
      rowIndex: row.rowIndex,
      fields: fields,
    });
    if (!res || res.status !== 'ok') {
      const msg = (res && res.message) || '不明なエラー';
      showToast(`保存失敗：${msg}`, 'error', 3500);
      return;
    }
    // ローカル state にも反映
    Object.assign(row, {
      date:    fields.date    !== undefined ? fields.date    : row.date,
      amount:  fields.amount,
      taxRate: fields.taxRate,
      memo:    fields.memo    !== undefined ? fields.memo    : row.memo,
      subjectCode: fields.subjectCode !== undefined ? fields.subjectCode : row.subjectCode,
      subject:     fields.subjectName !== undefined ? fields.subjectName : row.subject,
    });
    if (res.data && res.data.recalculated) {
      row.taxAmount = Number(res.data.recalculated.taxAmount) || 0;
    } else {
      row.taxAmount = _calcTaxAmount(row.amount, row.taxRate);
    }
    showToast('保存しました', 'success', 2000);
    cancelEdit();
  } catch (err) {
    console.error('[pc-monthly] commitEdit', err);
    showToast(`保存失敗：${err.message || err}`, 'error', 3500);
  }
}

function cancelEdit() {
  _editingRowKey = null;
  _editingDraft = {};
  renderTable();
}

/* ── ドラフト行 ──────────────────────────────────────────── */
function bindAddButtons() {
  document.getElementById('btn-add-sales')?.addEventListener('click', () => addDraftRow('sales'));
  document.getElementById('btn-add-cost')?.addEventListener('click', () => addDraftRow('cost'));
}

function addDraftRow(source) {
  if (_editingRowKey) cancelEdit();
  _draftSeq++;
  const today = (typeof todayStr === 'function') ? todayStr() : new Date().toISOString().slice(0, 10);
  const draft = {
    source: 'draft',
    realSource: source,
    draftId: _draftSeq,
    date: today,
    subject: '',
    subjectCode: '',
    // §1：コストは初期 区分未選択（販管費/仕入原価のタブで明示選択させる）
    divisionCode: '',
    amount: 0,
    taxRate: 10,
    memo: '',
  };
  // 最上段に挿入（§2-2 step3）
  _draftRows.unshift(draft);
  _pageIndex = 0;   // 指示書11§3：ドラフト追加時はページを最新へリセット（ドラフトは先頭に表示される）
  renderTable();
  // 指示書10§2：新規ドラフト作成後、当該行の最初のフォーカス可能要素（日付 input）にフォーカス
  //  → 直後に Esc を押せば tbody keydown ハンドラに確実に届き、ドラフト破棄が動作する
  setTimeout(() => {
    const tr = document.querySelector(`tr[data-row-key="draft-${draft.draftId}"]`);
    if (tr) {
      const firstInput = tr.querySelector('input, select');
      if (firstInput) firstInput.focus();
    }
  }, 0);
}

async function commitDraftRow(draftId) {
  const draft = _draftRows.find(d => String(d.draftId) === String(draftId));
  if (!draft) return;
  // §1-7：disabled の登録ボタン誤発火対策（キーボード経由等）も含む二重防御
  if (!_isDraftValid(draft)) {
    const errors = validateDraftRow(draft);
    showToast(errors[0] || '入力に不足があります', 'error', 3000);
    return;
  }

  try {
    let res;
    if (draft.realSource === 'sales') {
      const tax = _calcTaxAmount(draft.amount, draft.taxRate);
      res = await callGAS('addSales', {
        date: draft.date,
        customerCode: '',
        serviceCode: draft.subjectCode || '',
        serviceName: draft.subject || '',
        miscItemName: '',
        amountExTax: (Number(draft.amount) || 0) - tax,
        taxRate: Number(draft.taxRate) || 0,
        tax: tax,
        amountInTax: Number(draft.amount) || 0,
        memo: draft.memo || '',
        uncollected: 0,
      });
    } else {
      // 区分タブで明示選択された divisionCode を最優先とする（マスタ未登録の諸口にも対応）
      const cm = (_settings.costMaster || []).find(it => String(it.code) === String(draft.subjectCode));
      const divisionCode = String(draft.divisionCode || (cm && cm.divisionCode) || '2');
      const divisionName = divisionCode === '1' ? '仕入原価' : '販管費';
      const itemName = (cm && cm.name) || draft.subject || '';
      const tax = _calcTaxAmount(draft.amount, draft.taxRate);
      res = await callGAS('addCost', {
        date: draft.date,
        divisionCode: divisionCode,
        divisionName: divisionName,
        itemCode: draft.subjectCode || '',
        itemName: itemName,
        miscItemName: '',
        taxExcluded: (Number(draft.amount) || 0) - tax,
        taxRate: Number(draft.taxRate) || 0,
        tax: tax,
        taxIncluded: Number(draft.amount) || 0,
        memo: draft.memo || '',
        unpaid: 0,
        withholdingAmount: 0,
        clientId: '',
        projectId: '',
      });
    }
    if (!res || res.status !== 'ok') {
      showToast(`登録失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return;
    }
    showToast('登録しました', 'success', 2000);
    discardDraftRow(draftId);
    await loadMonthlyData('');   // 指示書12§1：全件再読込

  } catch (err) {
    console.error('[pc-monthly] commitDraftRow', err);
    showToast(`登録失敗：${err.message || err}`, 'error', 3500);
  }
}

function discardDraftRow(draftId) {
  _draftRows = _draftRows.filter(d => String(d.draftId) !== String(draftId));
  renderTable();
}

function validateDraftRow(draft) {
  const errs = [];
  if (!draft.date || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) errs.push('発生日を入力してください');
  // §1：コストは区分タブ未選択を弾く
  if (draft.realSource === 'cost' && !String(draft.divisionCode || '')) {
    errs.push('区分（仕入原価／販管費）を選択してください');
  }
  if (!draft.subjectCode && !draft.subject) errs.push('科目を選択してください');
  const rate = Number(draft.taxRate);
  if (!Number.isFinite(rate)) errs.push('税率を選択してください');
  const amt = Number(draft.amount) || 0;
  if (amt <= 0) errs.push('金額を入力してください');
  return errs;
}

/* ── 案件化フロー（売上→コスト・コスト→売上 の双方向） ─── */
async function onMarkAsProject(rowKey) {
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) return;
  if (row.source === 'sales') {
    await onMarkAsProjectFromSales(row);
  } else if (row.source === 'cost') {
    await onMarkAsProjectFromCost(row);
  }
}

/**
 * 案件登録解除ディスパッチャ（指示書8§1-3 / 戦略思想§1-5-2 AI自動確定禁止）
 * 売上行の★クリック：紐付き済みコストをチェックボックスで提示し、外したものは同時に紐付け解除
 * コスト行の★クリック：単一の紐付け解除確認モーダル
 * 3ステップ厳守：提案 → ユーザー確認（チェック操作）→ 確定（解除するボタン）
 */
async function onUnmarkAsProject(rowKey) {
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row || !row.isProject) return;
  if (row.source === 'cost') {
    return _onUnlinkCostFromSales(row);
  }
  if (row.source !== 'sales') return;

  // 売上：現在表示中の月から、この売上に紐付く全コスト行を抽出
  const linkedCosts = row.salesRowId
    ? _monthlyData.filter(r => r.source === 'cost' && r.salesRowId === row.salesRowId)
    : [];

  if (linkedCosts.length === 0) {
    // 紐付き0件：案件登録のみ解除（指示書8§1-3 経費0件分岐）
    openZeroCandidatesPrompt({
      message: '紐付き経費はありません。案件登録のみ解除します。',
      target: { kind: 'sales', date: row.date, subject: row.subject, amount: row.amount, memo: row.memo },
      confirmLabel: '解除する',
      onConfirm: async () => {
        try { await _executeUnmarkSales(row, [], true); }
        catch (err) { showLinkCandidatesError(err.message || String(err)); }
      }
    });
    return;
  }

  _openUnmarkSalesModal(row, linkedCosts);
}

// AI提案：紐付きコスト一覧を全チェック済みのチェックボックスで表示
//  指示書13§2：チェック状態に応じて文言とボタン活性を動的に切替
//   - 全アンチェック   → 「すべての経費の紐付けを解除し、案件登録を解除します。」（売上U列もクリア）
//   - 一部アンチェック → 「チェックを外した経費の紐付けのみ解除します。案件登録と残りの経費の紐付けは維持されます。」（V列のみ）
//   - 全チェック       → ボタン disabled（解除対象なし）
function _openUnmarkSalesModal(salesRow, linkedCosts) {
  const modal = document.getElementById('pc-link-candidates-modal');
  const list  = document.getElementById('pc-link-candidates-list');
  const hintEl = document.getElementById('pc-link-candidates-hint');
  const errEl  = document.getElementById('pc-link-candidates-error');
  const confirmBtn = document.getElementById('pc-link-candidates-confirm');
  if (!modal || !list || !hintEl) return;

  _renderModalTargetHeader({ kind: 'sales', date: salesRow.date, subject: salesRow.subject, amount: salesRow.amount, memo: salesRow.memo });
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  list.innerHTML = linkedCosts.map(c => `
    <label class="pc-link-candidates-row">
      <input type="checkbox" name="pc-unmark-cost" value="${c.rowIndex}" checked>
      <span>${_escHtml(c.date || '')}</span>
      <span>${_escHtml(c.subject || '')}</span>
      <span class="pc-link-candidates-row__amount">${_formatYenPlain(c.amount || 0)}</span>
      <span class="pc-link-candidates-row__memo">${_escHtml(c.memo || '')}</span>
    </label>
  `).join('');

  if (confirmBtn) {
    confirmBtn.hidden = false;
    confirmBtn.textContent = '実行';   // 指示書13-2§1：他モーダル共有のため close 時は '確定' に戻す
  }

  // 指示書13§2 / 13-2§2：チェック状態の変化を監視して文言・ボタン活性（および視覚的 disabled）を再計算
  //  pc-btn-primary には :disabled 用 CSS が無く、disabled 属性のみでは視覚的に切り替わらないため
  //  inline style で opacity / cursor を切り替えて disabled 状態を明示する
  const setConfirmDisabled = (disabled) => {
    if (!confirmBtn) return;
    confirmBtn.disabled = disabled;
    confirmBtn.style.opacity = disabled ? '0.45' : '';
    confirmBtn.style.cursor  = disabled ? 'not-allowed' : '';
  };
  const updateUnmarkSalesState = () => {
    const total = linkedCosts.length;
    const checkedCount = list.querySelectorAll('input[type="checkbox"]:checked').length;
    if (checkedCount === total) {
      hintEl.textContent = '解除する経費がありません。チェックを外して紐付けを解除する経費を選択してください。';
      setConfirmDisabled(true);
    } else if (checkedCount === 0) {
      hintEl.textContent = 'すべての経費の紐付けを解除し、案件登録を解除します。';
      setConfirmDisabled(false);
    } else {
      hintEl.textContent = 'チェックを外した経費の紐付けのみ解除します。案件登録と残りの経費の紐付けは維持されます。';
      setConfirmDisabled(false);
    }
  };
  list.addEventListener('change', updateUnmarkSalesState);
  updateUnmarkSalesState();

  _modalState = {
    direction: 'unmark-sales',
    mode: 'unmark-sales',
    onConfirm: async () => {
      const checkedInputs = list.querySelectorAll('input[type="checkbox"]:checked');
      const keepRowIndexes = new Set(Array.from(checkedInputs).map(i => Number(i.value)));
      const unlinkRowIndexes = linkedCosts
        .map(c => c.rowIndex)
        .filter(rIdx => !keepRowIndexes.has(rIdx));
      // 指示書13§2：全アンチェック=完全解除（売上U列クリア）／一部アンチェック=対象V列のみクリア
      const fullUnmark = keepRowIndexes.size === 0;
      try { await _executeUnmarkSales(salesRow, unlinkRowIndexes, fullUnmark); }
      catch (err) { showLinkCandidatesError(err.message || String(err)); }
    },
  };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLinkCandidatesModal(); }
  };
  document.addEventListener('keydown', keydownHandler);
  _modalState.keydownHandler = keydownHandler;

  modal.hidden = false;
}

// 解除実行（指示書13§2：fullUnmark=true → 売上U列も解除・false → コストV列のみ解除）
//  - 全アンチェック（fullUnmark=true）：unmarkAsProject（売上U列クリア）+ linkTransactions(salesRowId='')
//  - 一部アンチェック（fullUnmark=false）：linkTransactions のみ実行・売上の案件登録は維持
//  GAS の linkTransactions は salesRowId 空文字を渡すと紐付け解除として動作する
async function _executeUnmarkSales(salesRow, costRowIndexesToUnlink, fullUnmark) {
  if (fullUnmark) {
    const unmarkRes = await callGAS('unmarkAsProject', {
      rowIndex: salesRow.rowIndex,
      sheetName: '売上',
    });
    if (!unmarkRes || unmarkRes.status !== 'ok') {
      throw new Error((unmarkRes && unmarkRes.message) || '案件解除に失敗しました');
    }
    salesRow.isProject = false;
  }

  if (costRowIndexesToUnlink.length > 0) {
    const items = costRowIndexesToUnlink.map(rIdx => ({ rowIndex: rIdx, salesRowId: '' }));
    const linkRes = await callGAS('linkTransactions', { items });
    if (!linkRes || linkRes.status !== 'ok') {
      throw new Error((linkRes && linkRes.message) || '紐付け解除に失敗しました');
    }
    for (const rIdx of costRowIndexesToUnlink) {
      const c = _monthlyData.find(r => r.source === 'cost' && r.rowIndex === rIdx);
      if (c) { c.isProject = false; c.salesRowId = ''; }
    }
  }
  showToast(fullUnmark ? '案件登録を解除しました' : '紐付けを解除しました', 'success', 2000);
  closeLinkCandidatesModal();
  renderTable();
}

// コスト行の★クリック：単発の紐付け解除確認（売上U列は触らない）
//  指示書13§1：紐付け先の親売上情報を金色背景＋金色左ボーダーで強調表示
async function _onUnlinkCostFromSales(costRow) {
  if (costRow.source !== 'cost' || !costRow.isProject) return;

  // 紐付け先の親売上を _monthlyData から検索（V列=salesRowId が一致する売上行）
  const parentSales = costRow.salesRowId
    ? _monthlyData.find(r => r.source === 'sales' && String(r.salesRowId) === String(costRow.salesRowId))
    : null;

  const modal = document.getElementById('pc-link-candidates-modal');
  const list  = document.getElementById('pc-link-candidates-list');
  const hintEl = document.getElementById('pc-link-candidates-hint');
  const errEl  = document.getElementById('pc-link-candidates-error');
  const confirmBtn = document.getElementById('pc-link-candidates-confirm');
  if (!modal || !list || !hintEl) return;

  _renderModalTargetHeader({ kind: 'cost', date: costRow.date, type: costRow.type, subject: costRow.subject, amount: costRow.amount, memo: costRow.memo });
  hintEl.textContent = '紐付けを解除します。売上側の案件登録はそのまま残ります。';
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  // 指示書13§1：紐付け先売上セクション（金色背景＋金色左ボーダー）
  const parentBoxStyle = 'margin: 12px 16px; padding: 10px 14px; background: var(--uz-amber-bg); border-left: 4px solid var(--uz-gold); border-radius: 4px;';
  const parentLabelStyle = 'font-size: 11px; font-weight: 700; color: var(--uz-gold); margin-bottom: 6px;';
  const parentRowStyle = 'display: grid; grid-template-columns: 90px 60px 1fr 110px 1fr; gap: 10px; align-items: center; font-size: 13px;';
  const parentAmountStyle = 'text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;';
  const parentMemoStyle = 'color: var(--uz-text2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  const parentHtml = parentSales ? `
    <div style="${parentBoxStyle}">
      <div style="${parentLabelStyle}">紐付け先売上</div>
      <div style="${parentRowStyle}">
        <span>${_escHtml(parentSales.date || '')}</span>
        <span>売上</span>
        <span>${_escHtml(parentSales.subject || '')}</span>
        <span style="${parentAmountStyle}">¥${_formatYenPlain(parentSales.amount || 0)}</span>
        <span style="${parentMemoStyle}">${_escHtml(parentSales.memo || '')}</span>
      </div>
    </div>
  ` : `<div class="pc-link-candidates-empty">紐付け先の売上が見つかりません（既に削除されているか、現在の表示範囲外の可能性があります）。続行するとコスト側の紐付け情報のみ解除されます。</div>`;
  list.innerHTML = parentHtml;

  if (confirmBtn) {
    confirmBtn.hidden = false;
    confirmBtn.textContent = '解除する';
    confirmBtn.disabled = false;
  }

  _modalState = {
    direction: 'unlink-cost',
    mode: 'unlink-cost',
    onConfirm: async () => {
      try {
        const res = await callGAS('linkTransactions', {
          items: [{ rowIndex: costRow.rowIndex, salesRowId: '' }],
        });
        if (!res || res.status !== 'ok') {
          throw new Error((res && res.message) || '紐付け解除に失敗しました');
        }
        costRow.isProject = false;
        costRow.salesRowId = '';
        showToast('紐付けを解除しました', 'success', 2000);
        closeLinkCandidatesModal();
        renderTable();
      } catch (err) {
        console.error('[pc-monthly] _onUnlinkCostFromSales', err);
        showLinkCandidatesError(err.message || String(err));
      }
    },
  };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLinkCandidatesModal(); }
  };
  document.addEventListener('keydown', keydownHandler);
  _modalState.keydownHandler = keydownHandler;

  modal.hidden = false;
}

// 売上→コスト方向：候補をチェックボックスで複数選択 → 確定
async function onMarkAsProjectFromSales(row) {
  // salesRowId が空の場合は markAsProject 呼び出し時に GAS が救済採番する。
  // ただし候補取得には salesDate が必要・getLinkCandidates の現実装は salesRowId を必須とするため
  // T列未採番行は先に markAsProject を呼んで採番してから候補取得 → 改めて確定の2段構えにする…
  // が複雑になるため、本指示書では salesRowId が無い行は自動採番のみ実施・候補なしダイアログに進める
  const candidates = await fetchLinkCandidatesForSales(row);
  if (candidates === null) return; // エラー時はトースト済み

  if (candidates.length === 0) {
    // 候補ゼロ：「経費0件案件として登録しますか？」ダイアログ（§3-1 step3）
    openZeroCandidatesPrompt({
      message: '該当範囲に紐付け候補がありません。経費0件案件として登録しますか？',
      target: { kind: 'sales', date: row.date, subject: row.subject, amount: row.amount, memo: row.memo },
      confirmLabel: '登録する',
      onConfirm: async () => {
        await callMarkAndLink(row, []);
      }
    });
    return;
  }

  openLinkCandidatesModal({
    direction: 'sales-to-cost',
    hint: `「${row.date} の前月頭〜${row.date}」までに発生した集計対象4区分の経費`,
    target: { kind: 'sales', date: row.date, subject: row.subject, amount: row.amount, memo: row.memo },
    candidates: candidates,
    onConfirm: async (selectedCostRowIndexes) => {
      await callMarkAndLink(row, selectedCostRowIndexes);
    }
  });
}

async function fetchLinkCandidatesForSales(row) {
  if (!row.salesRowId) {
    // salesRowId 未採番の場合は候補取得不可・ゼロ件として扱う
    return [];
  }
  try {
    const res = await callGAS('getLinkCandidates', {
      direction: 'sales-to-cost',
      salesRowId: row.salesRowId,
      salesDate: row.date,
    });
    if (!res || res.status !== 'ok') {
      showToast(`候補取得失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return null;
    }
    return (res.data && Array.isArray(res.data.candidates)) ? res.data.candidates : [];
  } catch (err) {
    console.error('[pc-monthly] fetchLinkCandidatesForSales', err);
    showToast(`候補取得失敗：${err.message || err}`, 'error', 3500);
    return null;
  }
}

// 案件化＋紐付けの GAS 呼び出し（売上→コスト確定時）
async function callMarkAndLink(salesRow, selectedCostRowIndexes) {
  try {
    // 1. markAsProject（U列='1' 化＋必要なら T列救済採番）
    const markRes = await callGAS('markAsProject', { rowIndex: salesRow.rowIndex });
    if (!markRes || markRes.status !== 'ok') {
      throw new Error((markRes && markRes.message) || '案件化に失敗しました');
    }
    const newSalesRowId = (markRes.data && markRes.data.salesRowId) || salesRow.salesRowId;
    salesRow.isProject = true;
    if (newSalesRowId) salesRow.salesRowId = String(newSalesRowId);

    // 2. linkTransactions（複数 items 一括・§1-5）
    if (selectedCostRowIndexes && selectedCostRowIndexes.length > 0) {
      const items = selectedCostRowIndexes.map(rIdx => ({
        rowIndex: rIdx,
        salesRowId: salesRow.salesRowId,
      }));
      const linkRes = await callGAS('linkTransactions', { items });
      if (!linkRes || linkRes.status !== 'ok') {
        throw new Error((linkRes && linkRes.message) || '紐付けに失敗しました');
      }
      // ローカル state：選択コスト行に🔶を反映
      for (const rIdx of selectedCostRowIndexes) {
        const c = _monthlyData.find(r => r.source === 'cost' && r.rowIndex === rIdx);
        if (c) {
          c.isProject = true;
          c.salesRowId = salesRow.salesRowId;
        }
      }
    }
    showToast('案件化しました', 'success', 2000);
    closeLinkCandidatesModal();
    renderTable();
  } catch (err) {
    console.error('[pc-monthly] callMarkAndLink', err);
    showLinkCandidatesError(err.message || String(err));
  }
}

// コスト→売上方向：候補をラジオで単一選択 → 確定
async function onMarkAsProjectFromCost(row) {
  const candidates = await fetchLinkCandidatesForCost(row);
  if (candidates === null) return;

  if (candidates.length === 0) {
    // §3-2 step3：閉じるのみのダイアログ（経費0件案件は概念上売上案件化時のみ）
    openZeroCandidatesPrompt({
      message: '該当範囲に売上候補がありません。',
      target: { kind: 'cost', date: row.date, type: row.type, subject: row.subject, amount: row.amount, memo: row.memo },
      confirmLabel: null,                  // 確定ボタン非表示
      onConfirm: null
    });
    return;
  }

  openLinkCandidatesModal({
    direction: 'cost-to-sales',
    hint: `「${row.date} 〜 ${row.date} の翌月末」までに発生した売上`,
    target: { kind: 'cost', date: row.date, type: row.type, subject: row.subject, amount: row.amount, memo: row.memo },
    candidates: candidates,
    onConfirm: async (selectedSalesRowId) => {
      // selectedSalesRowId はラジオ選択された売上の rowIndex
      await callMarkAndLinkFromCost(row, selectedSalesRowId);
    }
  });
}

async function fetchLinkCandidatesForCost(row) {
  try {
    const res = await callGAS('getLinkCandidates', {
      direction: 'cost-to-sales',
      costRowIndex: row.rowIndex,
      costDate: row.date,
    });
    if (!res || res.status !== 'ok') {
      showToast(`候補取得失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return null;
    }
    return (res.data && Array.isArray(res.data.candidates)) ? res.data.candidates : [];
  } catch (err) {
    console.error('[pc-monthly] fetchLinkCandidatesForCost', err);
    showToast(`候補取得失敗：${err.message || err}`, 'error', 3500);
    return null;
  }
}

async function callMarkAndLinkFromCost(costRow, selectedSalesRowIndex) {
  try {
    const sales = _findSalesByRowIndex(selectedSalesRowIndex) || _findSalesInCandidates(selectedSalesRowIndex);
    if (!sales || !sales.salesRowId) {
      // ローカルにいない（フィルタ外・別月）売上の場合は markAsProject の戻り salesRowId を信頼
      const markRes = await callGAS('markAsProject', { rowIndex: selectedSalesRowIndex });
      if (!markRes || markRes.status !== 'ok') {
        throw new Error((markRes && markRes.message) || '案件化に失敗しました');
      }
      const newSalesRowId = String((markRes.data && markRes.data.salesRowId) || '');
      if (!newSalesRowId) throw new Error('salesRowId が取得できませんでした');
      const linkRes = await callGAS('linkTransactions', {
        items: [{ rowIndex: costRow.rowIndex, salesRowId: newSalesRowId }],
      });
      if (!linkRes || linkRes.status !== 'ok') {
        throw new Error((linkRes && linkRes.message) || '紐付けに失敗しました');
      }
      costRow.isProject = true;
      costRow.salesRowId = newSalesRowId;
      showToast('案件として紐付けました', 'success', 2000);
      closeLinkCandidatesModal();
      renderTable();
      return;
    }

    // ローカルに見つかった場合：markAsProject → linkTransactions
    const markRes = await callGAS('markAsProject', { rowIndex: sales.rowIndex });
    if (!markRes || markRes.status !== 'ok') {
      throw new Error((markRes && markRes.message) || '案件化に失敗しました');
    }
    const linkRes = await callGAS('linkTransactions', {
      items: [{ rowIndex: costRow.rowIndex, salesRowId: sales.salesRowId }],
    });
    if (!linkRes || linkRes.status !== 'ok') {
      throw new Error((linkRes && linkRes.message) || '紐付けに失敗しました');
    }
    sales.isProject = true;
    costRow.isProject = true;
    costRow.salesRowId = sales.salesRowId;
    showToast('案件として紐付けました', 'success', 2000);
    closeLinkCandidatesModal();
    renderTable();
  } catch (err) {
    console.error('[pc-monthly] callMarkAndLinkFromCost', err);
    showLinkCandidatesError(err.message || String(err));
  }
}

function _findSalesByRowIndex(rowIndex) {
  return _monthlyData.find(r => r.source === 'sales' && r.rowIndex === Number(rowIndex));
}
function _findSalesInCandidates(rowIndex) {
  if (!_modalState || !Array.isArray(_modalState.candidates)) return null;
  const c = _modalState.candidates.find(x => Number(x.rowIndex) === Number(rowIndex));
  if (!c) return null;
  return { rowIndex: c.rowIndex, salesRowId: c.salesRowId };
}

/* ── 紐付け候補モーダル（共通UI・指示書5§2-4 / §3-3） ─── */
function bindModalEvents() {
  const modal = document.getElementById('pc-link-candidates-modal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    const action = e.target && e.target.dataset && e.target.dataset.action;
    if (action === 'cancel') {
      closeLinkCandidatesModal();
    } else if (action === 'confirm') {
      handleModalConfirm();
    }
  });
}

function openLinkCandidatesModal({ direction, hint, target, candidates, onConfirm }) {
  const modal = document.getElementById('pc-link-candidates-modal');
  const list  = document.getElementById('pc-link-candidates-list');
  const hintEl = document.getElementById('pc-link-candidates-hint');
  const errEl  = document.getElementById('pc-link-candidates-error');
  if (!modal || !list || !hintEl) return;

  // §2 対象取引情報ヘッダー（売上案件化時・コスト案件化時 共通）
  _renderModalTargetHeader(target);
  hintEl.textContent = hint || '';
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  const inputType = direction === 'cost-to-sales' ? 'radio' : 'checkbox';
  const inputName = 'pc-link-cand';

  list.innerHTML = candidates.map((c, i) => {
    const checked = (direction === 'sales-to-cost' && c.currentlyLinked) ? 'checked' : '';
    const projectFlag = (direction === 'cost-to-sales' && c.isProject)
      ? `<span class="pc-link-candidates-row__project-flag" title="既に案件化済み">🔶</span>`
      : '';
    const hashCls = (direction === 'sales-to-cost' && c.currentlyLinked) ? 'is-current-link' : '';
    const valueAttr = (direction === 'cost-to-sales')
      ? String(c.rowIndex)        // ラジオ：売上 rowIndex
      : String(c.rowIndex);       // チェックボックス：コスト rowIndex
    return `
      <label class="pc-link-candidates-row ${hashCls}">
        <input type="${inputType}" name="${inputName}" value="${valueAttr}" ${checked}>
        <span>${_escHtml(c.date || '')}</span>
        <span>${_escHtml(c.subject || '')}${projectFlag}</span>
        <span class="pc-link-candidates-row__amount">${_formatYenPlain(c.amount || 0)}</span>
        <span class="pc-link-candidates-row__memo">${_escHtml(c.memo || '')}</span>
      </label>
    `;
  }).join('');

  _modalState = { direction, candidates, onConfirm, mode: 'list' };

  // ESC キー
  const keydownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLinkCandidatesModal();
    }
  };
  document.addEventListener('keydown', keydownHandler);
  _modalState.keydownHandler = keydownHandler;

  modal.hidden = false;
}

// 候補ゼロ用の特殊モーダル（「経費0件案件として登録しますか？」 or 「該当範囲に売上候補がありません」）
function openZeroCandidatesPrompt({ message, target, confirmLabel, onConfirm }) {
  const modal = document.getElementById('pc-link-candidates-modal');
  const list  = document.getElementById('pc-link-candidates-list');
  const hintEl = document.getElementById('pc-link-candidates-hint');
  const errEl  = document.getElementById('pc-link-candidates-error');
  const confirmBtn = document.getElementById('pc-link-candidates-confirm');
  if (!modal || !list || !hintEl) return;

  // §2 対象取引情報ヘッダー（候補0件時もどの取引に対する確認かを明示）
  _renderModalTargetHeader(target);
  hintEl.textContent = '';
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  list.innerHTML = `<div class="pc-link-candidates-empty">${_escHtml(message)}</div>`;

  if (confirmBtn) {
    if (confirmLabel) {
      confirmBtn.hidden = false;
      confirmBtn.textContent = confirmLabel;
    } else {
      confirmBtn.hidden = true;
    }
  }

  _modalState = { direction: 'zero', onConfirm, mode: 'zero' };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLinkCandidatesModal();
    }
  };
  document.addEventListener('keydown', keydownHandler);
  _modalState.keydownHandler = keydownHandler;

  modal.hidden = false;
}

async function handleModalConfirm() {
  if (!_modalState) return;
  const direction = _modalState.direction;
  const onConfirm = _modalState.onConfirm;
  if (!onConfirm) return;

  if (_modalState.mode === 'zero' || _modalState.mode === 'unmark-sales' || _modalState.mode === 'unlink-cost') {
    // zero：経費0件案件として登録 ／ unmark-sales：チェックボックス状態は onConfirm 内部で取得
    // unlink-cost（指示書13§1）：単発のコスト→売上 紐付け解除
    await onConfirm();
    return;
  }

  if (direction === 'sales-to-cost') {
    const list = document.getElementById('pc-link-candidates-list');
    const checked = list ? list.querySelectorAll('input[type="checkbox"]:checked') : [];
    const selected = Array.from(checked).map(i => Number(i.value)).filter(n => !isNaN(n));
    await onConfirm(selected);
    return;
  }

  if (direction === 'cost-to-sales') {
    const list = document.getElementById('pc-link-candidates-list');
    const r = list ? list.querySelector('input[type="radio"]:checked') : null;
    if (!r) {
      showLinkCandidatesError('売上を1件選択してください');
      return;
    }
    const selectedRowIndex = Number(r.value);
    if (isNaN(selectedRowIndex)) {
      showLinkCandidatesError('選択値が不正です');
      return;
    }
    await onConfirm(selectedRowIndex);
    return;
  }
}

function closeLinkCandidatesModal() {
  const modal = document.getElementById('pc-link-candidates-modal');
  if (modal) modal.hidden = true;
  if (_modalState && _modalState.keydownHandler) {
    document.removeEventListener('keydown', _modalState.keydownHandler);
  }
  // confirm ボタンの非表示・disabled 状態を戻す（指示書13§2：disabled 残留防止）
  // 指示書13-2§2：inline style（opacity / cursor）も次回オープンに引き継がないようクリア
  const confirmBtn = document.getElementById('pc-link-candidates-confirm');
  if (confirmBtn) {
    confirmBtn.hidden = false;
    confirmBtn.textContent = '確定';
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '';
    confirmBtn.style.cursor = '';
  }
  // 対象取引情報ヘッダーをクリア（次回オープン時の混入防止）
  const targetEl = document.getElementById('pc-link-candidates-target');
  if (targetEl) {
    targetEl.innerHTML = '';
    targetEl.hidden = true;
  }
  _modalState = null;
}

/**
 * 候補プルダウンモーダルの対象取引情報ヘッダーを描画（指示書6§2 / 技術仕様§9-4-1）
 *  target = null/undefined → 非表示
 *  target = { kind: 'sales'|'cost', date, type?, subject, amount, memo }
 *    - kind='sales' → 「対象売上：YYYY-MM-DD / 科目 / ¥金額 / メモ」
 *    - kind='cost'  → 「対象コスト：YYYY-MM-DD / 種別 / 科目 / ¥金額 / メモ」
 *  メモ空欄時は区切り「/」ごと省略
 */
function _renderModalTargetHeader(target) {
  const targetEl = document.getElementById('pc-link-candidates-target');
  if (!targetEl) return;
  if (!target) {
    targetEl.innerHTML = '';
    targetEl.hidden = true;
    return;
  }
  const labelText = target.kind === 'sales' ? '対象売上：' : '対象コスト：';
  const sep = `<span class="pc-link-candidates-target__sep">/</span>`;
  const parts = [
    `<span class="pc-link-candidates-target__label">${_escHtml(labelText)}</span>`,
    `<span class="pc-link-candidates-target__date">${_escHtml(target.date || '')}</span>`,
  ];
  if (target.kind === 'cost' && target.type) {
    parts.push(sep);
    parts.push(`<span class="pc-link-candidates-target__type">${_escHtml(target.type)}</span>`);
  }
  parts.push(sep);
  parts.push(`<span class="pc-link-candidates-target__subject">${_escHtml(target.subject || '')}</span>`);
  parts.push(sep);
  parts.push(`<span class="pc-link-candidates-target__amount">¥${_formatYenPlain(target.amount || 0)}</span>`);
  const memoTrim = String(target.memo || '').trim();
  if (memoTrim) {
    parts.push(sep);
    parts.push(`<span class="pc-link-candidates-target__memo">${_escHtml(memoTrim)}</span>`);
  }
  targetEl.innerHTML = parts.join('');
  targetEl.hidden = false;
}

function showLinkCandidatesError(msg) {
  const errEl = document.getElementById('pc-link-candidates-error');
  if (!errEl) {
    showToast(msg, 'error', 3500);
    return;
  }
  errEl.textContent = msg;
  errEl.hidden = false;
}

/* ── アクションボタン（消込・解除申請） ──────────────────── */
async function onReconcile(rowKey) {
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) return;
  const today = (typeof todayStr === 'function') ? todayStr() : new Date().toISOString().slice(0, 10);
  const paidDate = prompt('入金日（YYYY-MM-DD）', today);
  if (paidDate === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) {
    showToast('日付形式が不正です', 'error', 2500);
    return;
  }
  const paidAmountStr = prompt('入金額', String(row.amount));
  if (paidAmountStr === null) return;
  const paidAmount = Number(paidAmountStr);
  if (!isFinite(paidAmount) || paidAmount < 0) {
    showToast('金額が不正です', 'error', 2500);
    return;
  }
  try {
    const res = await callGAS('reconcile', {
      sheetName: row.sheetName,
      rowIndex: row.rowIndex,
      paidDate: paidDate,
      paidAmount: paidAmount,
    });
    if (!res || res.status !== 'ok') {
      showToast(`消込失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return;
    }
    row.isUnpaid = false;
    showToast('消込しました', 'success', 2000);
    renderTable();
  } catch (err) {
    console.error('[pc-monthly] onReconcile', err);
    showToast(`消込失敗：${err.message || err}`, 'error', 3500);
  }
}

async function onRequestUnlock(rowKey) {
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) return;
  const reason = prompt('解除申請の理由（任意）', '');
  if (reason === null) return; // キャンセル
  try {
    const res = await callGAS('requestUnlock', {
      sheetName: row.sheetName,
      rowIndex: row.rowIndex,
      reason: reason || '',
    });
    if (!res || res.status !== 'ok') {
      showToast(`解除申請失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return;
    }
    showToast('解除申請を送信しました', 'success', 2500);
  } catch (err) {
    console.error('[pc-monthly] onRequestUnlock', err);
    showToast(`解除申請失敗：${err.message || err}`, 'error', 3500);
  }
}

/* ── 行削除（指示書15・戦略思想§1-5-2 AI自動確定禁止 3ステップ厳守） ───
 * 1. 削除ボタンクリック → openDeleteConfirmModal（pc-common.js）でダイアログ表示
 * 2. ユーザーが「削除する」を明示タップ → _executeDeleteRow が GAS deleteRow 呼び出し
 * 3. 成功時 loadMonthlyData で全件再取得（rowIndex ズレ解消）
 * 売上案件削除時は紐付けコスト件数を _monthlyData から算出して警告表示する
 */
async function onDeleteRow(rowKey) {
  const row = _monthlyData.find(r => _rowKey(r) === rowKey);
  if (!row) return;
  if (row.isLocked) { showToast('ロック行は削除できません', 'info', 2000); return; }

  // 指示書15-2：売上行で紐付け経費がある場合のみチェックボックス方式
  // 紐付け経費を _monthlyData から salesRowId で抽出
  let linkedCosts = [];
  if (row.source === 'sales' && row.salesRowId) {
    linkedCosts = _monthlyData
      .filter(r => r.source === 'cost' && String(r.salesRowId || '') === String(row.salesRowId))
      .map(r => ({
        rowIndex: r.rowIndex,
        date: r.date,
        subject: r.subject,
        amount: r.amount,
      }));
  }

  const hasLinked = linkedCosts.length > 0;

  openDeleteConfirmModal({
    sheetName: row.sheetName,
    rowIndex: row.rowIndex,
    date: row.date,
    type: row.type,
    subject: row.subject,
    amount: row.amount,
    memo: row.memo,
    isProject: row.source === 'sales' && !!row.isProject,
    linkedCosts: linkedCosts,
    modalTitle: hasLinked ? '案件を削除しますか？' : '行を削除しますか？',
    onConfirm: async (selectedItems) => {
      await _executeDeleteRow(row, selectedItems);
    },
  });
}

async function _executeDeleteRow(row, selectedItems) {
  try {
    // 指示書15-2：チェック付き経費を先に降順で物理削除（rowIndex ズレ防止）
    // 売上削除時、残った（チェック外し）経費の V列は GAS deleteRow が自動空欄化するため
    // フロント側で linkTransactions による空欄化処理は不要
    if (selectedItems && Array.isArray(selectedItems.costsToDelete) && selectedItems.costsToDelete.length > 0) {
      const sortedCostRows = [...selectedItems.costsToDelete].sort((a, b) => b - a);
      for (const costRowIndex of sortedCostRows) {
        const cRes = await callGAS('deleteRow', {
          sheetName: 'コスト',
          rowIndex: costRowIndex,
        });
        if (!cRes || cRes.status !== 'ok') {
          const msg = (cRes && cRes.message) || 'コスト削除に失敗しました';
          if (typeof showDeleteConfirmError === 'function') {
            showDeleteConfirmError(msg);
          } else {
            showToast(`削除失敗：${msg}`, 'error', 3500);
          }
          return;
        }
      }
    }

    // 売上（または単独コスト）行を削除
    const res = await callGAS('deleteRow', {
      sheetName: row.sheetName,
      rowIndex: row.rowIndex,
    });
    if (!res || res.status !== 'ok') {
      const msg = (res && res.message) || '削除に失敗しました';
      // ロック行拒否などはモーダル内エラー表示・モーダルは開いたまま
      if (typeof showDeleteConfirmError === 'function') {
        showDeleteConfirmError(msg);
      } else {
        showToast(`削除失敗：${msg}`, 'error', 3500);
      }
      return;
    }
    // モーダル閉じてからトースト＋データ再読込（rowIndex 再構築）
    if (typeof closeDeleteConfirmModal === 'function') closeDeleteConfirmModal();
    showToast('削除しました', 'success', 2000);
    await loadMonthlyData('');
  } catch (err) {
    console.error('[pc-monthly] _executeDeleteRow', err);
    if (typeof showDeleteConfirmError === 'function') {
      showDeleteConfirmError(`削除エラー：${err.message || err}`);
    } else {
      showToast(`削除エラー：${err.message || err}`, 'error', 3500);
    }
  }
}
