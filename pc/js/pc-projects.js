/**
 * ウルトラZAIMUくんレオ PC版 — pc-projects.js
 * 案件管理画面のロジック
 * 技術仕様§9-5 / §9-6 / §4-3 / 3デバイス統合§8-4 / 戦略思想§3-9-3 準拠
 *
 * 責務：月次管理で案件化された案件の粗利分析・追加紐付け・案件解除
 * GAS変更なし（バージョン14で対応済み）
 */
'use strict';

/* ── 状態 ────────────────────────────────────────────────── */
let _projectData = null;          // getTransactionsHierarchy レスポンス
let _selectedMonth = '';          // 'YYYY-MM' or '' (全件)
let _modalState = null;           // 紐付けモーダル状態

/* ── ユーティリティ ──────────────────────────────────────── */
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function _fmtYen(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('ja-JP');
}

function _calcTaxAmt(amtIncl, rate) {
  if (typeof calcTax === 'function') return calcTax(amtIncl, rate).tax;
  const excl = Math.floor(amtIncl * 100 / (100 + Number(rate)));
  return amtIncl - excl;
}

function _classifyCostType(divisionCode, itemCode) {
  const dv = String(divisionCode || '');
  const ic = String(itemCode || '');
  if (dv === '1') return '仕入原価';
  if (dv === '2' && ic === '21') return '委託・外注';
  if (dv === '2' && ic === '20') return '人件費';
  return '販管費';
}

/* ── 起動 ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initProjects);

async function initProjects() {
  pcBootstrap('pc-projects.html', '案件管理');
  initMonthSelect();
  bindModalEvents();
  document.getElementById('btn-new-project')?.addEventListener('click', onNewProject);
  await loadProjects();
}

/* ── 月選択プルダウン ─────────────────────────────────────── */
function initMonthSelect() {
  const sel = document.getElementById('pj-month');
  if (!sel) return;
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // 全件 + 過去12ヶ月分
  const optAll = document.createElement('option');
  optAll.value = ''; optAll.textContent = '全期間';
  sel.appendChild(optAll);

  for (let i = 0; i < 12; i++) {
    let y = curY, m = curM - i;
    if (m <= 0) { m += 12; y--; }
    const val = `${y}-${String(m).padStart(2, '0')}`;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `${y}年${m}月`;
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  }

  _selectedMonth = `${curY}-${String(curM).padStart(2, '0')}`;
  sel.addEventListener('change', async () => {
    _selectedMonth = sel.value;
    await loadProjects();
  });
}

/* ── データ取得 ───────────────────────────────────────────── */
async function loadProjects() {
  const listEl = document.getElementById('pj-list');
  if (listEl) listEl.innerHTML = '<div class="loading">読み込み中…</div>';

  try {
    const res = await callGAS('getTransactionsHierarchy', { month: _selectedMonth });
    if (!res || res.status !== 'ok' || !res.data) {
      throw new Error((res && res.message) || 'データ取得に失敗しました');
    }
    _projectData = res.data;
    renderProjects();
  } catch (err) {
    console.error('[pc-projects] loadProjects', err);
    if (listEl) listEl.innerHTML = `<div class="loading">${_esc(err.message || err)}</div>`;
  }
}

/* ── 描画 ─────────────────────────────────────────────────── */
function renderProjects() {
  const listEl = document.getElementById('pj-list');
  const summaryEl = document.getElementById('pj-summary');
  if (!listEl) return;

  const nodes = Array.isArray(_projectData?.salesNodes) ? _projectData.salesNodes : [];

  // サマリー
  if (summaryEl) {
    const count = nodes.length;
    const salesTotal = nodes.reduce((s, n) => s + (Number(n.salesAmount) || 0), 0);
    const gpTotal = nodes.reduce((s, n) => s + (Number(n.grossProfit) || 0), 0);
    summaryEl.innerHTML = `<span>案件 <strong>${count}</strong>件</span>`
      + `<span>売上合計 <strong>¥${_fmtYen(salesTotal)}</strong></span>`
      + `<span>粗利合計 <strong class="${gpTotal < 0 ? 'neg' : ''}">¥${_fmtYen(gpTotal)}</strong></span>`;
  }

  if (nodes.length === 0) {
    listEl.innerHTML = '<div class="pc-projects-empty">案件データがありません</div>';
    return;
  }

  listEl.innerHTML = nodes.map(node => renderProjectCard(node)).join('');

  // イベントデリゲーション
  listEl.addEventListener('click', onCardClick);
}

function renderProjectCard(node) {
  const salesAmt = Number(node.salesAmount) || 0;
  const salesTax = _calcTaxAmt(salesAmt, Number(node.salesTaxRate) || 10);
  const linked = Array.isArray(node.linkedCosts) ? node.linkedCosts : [];
  const costTotal = linked.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const gp = Number(node.grossProfit) ?? (salesAmt - costTotal);
  const gpRate = salesAmt > 0 ? ((gp / salesAmt) * 100).toFixed(1) : '—';
  const gpCls = gp < 0 ? 'neg' : '';

  // 売上ブロック
  const salesBlock = `
    <div class="pj-card__sales">
      <div class="pj-card__section-label">売上</div>
      <div class="pj-card__row">
        <span class="pj-card__date">${_esc(node.salesDate)}</span>
        <span class="pj-card__subject">${_esc(node.salesItem)}</span>
        <span class="pj-card__amount">¥${_fmtYen(salesAmt)}</span>
      </div>
      ${node.salesMemo ? `<div class="pj-card__memo">${_esc(node.salesMemo)}</div>` : ''}
    </div>`;

  // 経費ブロック
  let costsBlock;
  if (linked.length === 0) {
    costsBlock = `
      <div class="pj-card__costs">
        <div class="pj-card__section-label">経費</div>
        <div class="pj-card__costs-empty">紐付け経費なし</div>
      </div>`;
  } else {
    const costRows = linked.map(c => {
      const cType = _classifyCostType(c.divisionCode, c.itemCode);
      return `
        <div class="pj-card__row">
          <span class="pj-card__date">${_esc(c.date)}</span>
          <span class="pj-card__type">${_esc(cType)}</span>
          <span class="pj-card__subject">${_esc(c.subject)}</span>
          <span class="pj-card__amount">¥${_fmtYen(c.amount || 0)}</span>
          ${c.memo ? `<span class="pj-card__memo-inline">${_esc(c.memo)}</span>` : ''}
        </div>`;
    }).join('');
    costsBlock = `
      <div class="pj-card__costs">
        <div class="pj-card__section-label">経費（${linked.length}件・計 ¥${_fmtYen(costTotal)}）</div>
        ${costRows}
      </div>`;
  }

  // 粗利ブロック
  const profitBlock = `
    <div class="pj-card__profit">
      <div class="pj-card__section-label">粗利</div>
      <div class="pj-card__profit-value ${gpCls}">¥${_fmtYen(gp)}</div>
      <div class="pj-card__profit-rate">${gpRate}%</div>
    </div>`;

  // アクションボタン（指示書15：削除ボタン追加・3ボタン横並び）
  // 売上メモは GAS getTransactionsHierarchy が node.memo として返す（salesMemo は未使用）
  const salesMemo = String(node.memo || node.salesMemo || '');
  const actions = `
    <div class="pj-card__actions">
      <button type="button" class="pc-btn pc-btn--ghost pj-action" data-action="add-cost"
              data-sales-row-id="${_esc(node.salesRowId)}"
              data-sales-row-index="${node.salesRowIndex}"
              data-sales-date="${_esc(node.salesDate)}"
              data-sales-item="${_esc(node.salesItem)}"
              data-sales-amount="${salesAmt}">+ 経費を紐付け</button>
      <button type="button" class="pc-btn pc-btn--ghost pj-action pj-action--warn" data-action="unmark"
              data-sales-row-index="${node.salesRowIndex}"
              data-sales-row-id="${_esc(node.salesRowId)}"
              data-sales-item="${_esc(node.salesItem)}">案件解除</button>
      <button type="button" class="pc-btn pc-btn--ghost pj-action pj-action--delete" data-action="delete"
              data-sales-row-index="${node.salesRowIndex}"
              data-sales-row-id="${_esc(node.salesRowId)}"
              data-sales-date="${_esc(node.salesDate)}"
              data-sales-item="${_esc(node.salesItem)}"
              data-sales-amount="${salesAmt}"
              data-sales-memo="${_esc(salesMemo)}"
              data-linked-count="${linked.length}">削除</button>
    </div>`;

  return `
    <div class="pj-card" data-sales-row-id="${_esc(node.salesRowId)}">
      <div class="pj-card__body">
        ${salesBlock}
        <div class="pj-card__divider"></div>
        ${costsBlock}
        ${profitBlock}
      </div>
      ${actions}
    </div>`;
}

/* ── イベント処理 ─────────────────────────────────────────── */
function onCardClick(e) {
  const btn = e.target.closest('.pj-action');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'add-cost') onAddCost(btn);
  else if (action === 'unmark') onUnmark(btn);
  else if (action === 'delete') onDeleteProject(btn);   // 指示書15
}

/* ── + 経費を紐付け（追加紐付け） ──────────────────────────── */
async function onAddCost(btn) {
  const salesRowId = btn.dataset.salesRowId;
  const salesRowIndex = Number(btn.dataset.salesRowIndex);
  const salesDate = btn.dataset.salesDate;
  const salesItem = btn.dataset.salesItem;
  const salesAmount = Number(btn.dataset.salesAmount);

  // getLinkCandidates（sales-to-cost方向）
  let candidates;
  try {
    const res = await callGAS('getLinkCandidates', {
      direction: 'sales-to-cost',
      salesRowId: salesRowId,
      salesDate: salesDate,
    });
    if (!res || res.status !== 'ok') {
      showToast(`候補取得失敗：${(res && res.message) || '不明なエラー'}`, 'error', 3500);
      return;
    }
    candidates = (res.data && Array.isArray(res.data.candidates)) ? res.data.candidates : [];
  } catch (err) {
    showToast(`候補取得失敗：${err.message || err}`, 'error', 3500);
    return;
  }

  if (candidates.length === 0) {
    showToast('該当範囲に紐付け候補がありません', 'info', 2500);
    return;
  }

  openLinkModal({
    direction: 'sales-to-cost',
    hint: `「${salesDate} の前月頭〜${salesDate}」の集計対象4区分・未紐付け経費`,
    target: { kind: 'sales', date: salesDate, subject: salesItem, amount: salesAmount, memo: '' },
    candidates: candidates,
    onConfirm: async (selectedCostRowIndexes) => {
      if (!selectedCostRowIndexes || selectedCostRowIndexes.length === 0) {
        closeLinkModal();
        return;
      }
      try {
        const items = selectedCostRowIndexes.map(rIdx => ({
          rowIndex: rIdx,
          salesRowId: salesRowId,
        }));
        const linkRes = await callGAS('linkTransactions', { items });
        if (!linkRes || linkRes.status !== 'ok') {
          throw new Error((linkRes && linkRes.message) || '紐付けに失敗しました');
        }
        showToast('経費を紐付けました', 'success', 2000);
        closeLinkModal();
        await loadProjects();
      } catch (err) {
        showLinkError(err.message || String(err));
      }
    }
  });
}

/* ── 案件削除（指示書15・戦略思想§1-5-2 AI自動確定禁止） ───
 * 1. 削除ボタン → openDeleteConfirmModal で確認ダイアログ
 * 2. ユーザーが「削除する」を明示タップ → GAS deleteRow（売上行物理削除＋紐付けコスト V列空欄化）
 * 3. 成功時 loadProjects で案件管理画面再描画（経費自体は月次管理に残る）
 */
async function onDeleteProject(btn) {
  const salesRowIndex = Number(btn.dataset.salesRowIndex);
  const salesRowId = String(btn.dataset.salesRowId || '');
  const salesDate = btn.dataset.salesDate || '';
  const salesItem = btn.dataset.salesItem || '';
  const salesAmount = Number(btn.dataset.salesAmount) || 0;
  const salesMemo = btn.dataset.salesMemo || '';

  if (typeof openDeleteConfirmModal !== 'function') {
    showToast('削除モーダル未定義（pc-common.js を確認してください）', 'error', 3500);
    return;
  }

  // 指示書15-2：紐付け経費の配列を _projectData から取得
  const node = _projectData?.salesNodes?.find(n => String(n.salesRowId) === salesRowId);
  const linkedCosts = (Array.isArray(node?.linkedCosts) ? node.linkedCosts : []).map(c => ({
    rowIndex: c.rowIndex,
    date: c.date,
    subject: c.subject,
    amount: c.amount,
  }));

  openDeleteConfirmModal({
    sheetName: '売上',
    rowIndex: salesRowIndex,
    date: salesDate,
    type: '売上',
    subject: salesItem,
    amount: salesAmount,
    memo: salesMemo,
    isProject: true,
    linkedCosts: linkedCosts,
    modalTitle: '案件を削除しますか？',
    onConfirm: async (selectedItems) => {
      await _executeDeleteProject({ salesRowIndex }, selectedItems);
    },
  });
}

async function _executeDeleteProject(target, selectedItems) {
  try {
    // 指示書15-2：チェック付き経費を先に降順で物理削除（rowIndex ズレ防止）
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

    // 売上行を削除（チェック外し経費の V列は GAS deleteRow が自動空欄化）
    const res = await callGAS('deleteRow', {
      sheetName: '売上',
      rowIndex: target.salesRowIndex,
    });
    if (!res || res.status !== 'ok') {
      const msg = (res && res.message) || '削除に失敗しました';
      if (typeof showDeleteConfirmError === 'function') {
        showDeleteConfirmError(msg);
      } else {
        showToast(`削除失敗：${msg}`, 'error', 3500);
      }
      return;
    }
    if (typeof closeDeleteConfirmModal === 'function') closeDeleteConfirmModal();
    showToast('案件を削除しました', 'success', 2000);
    await loadProjects();
  } catch (err) {
    console.error('[pc-projects] _executeDeleteProject', err);
    if (typeof showDeleteConfirmError === 'function') {
      showDeleteConfirmError(`削除エラー：${err.message || err}`);
    } else {
      showToast(`削除エラー：${err.message || err}`, 'error', 3500);
    }
  }
}

/* ── 案件解除 ─────────────────────────────────────────────── */
async function onUnmark(btn) {
  const salesRowIndex = Number(btn.dataset.salesRowIndex);
  const salesItem = btn.dataset.salesItem;
  const salesRowId = btn.dataset.salesRowId;

  // 紐付け経費がある場合は警告
  const node = _projectData?.salesNodes?.find(n => n.salesRowId === salesRowId);
  const linkedCount = node?.linkedCosts?.length || 0;

  let msg = `「${salesItem}」の案件化を解除しますか？\n売上自体は月次管理に残ります。`;
  if (linkedCount > 0) {
    msg += `\n\n※ 紐付け済み経費（${linkedCount}件）の紐付けも同時に解除されます。`;
  }

  if (!confirm(msg)) return;

  try {
    // 紐付け経費を先に解除
    if (linkedCount > 0) {
      const items = node.linkedCosts.map(c => ({
        rowIndex: c.rowIndex,
        salesRowId: '',
      }));
      const unlinkRes = await callGAS('linkTransactions', { items });
      if (!unlinkRes || unlinkRes.status !== 'ok') {
        throw new Error((unlinkRes && unlinkRes.message) || '経費の紐付け解除に失敗しました');
      }
    }

    // unmarkAsProject
    const res = await callGAS('unmarkAsProject', { rowIndex: salesRowIndex });
    if (!res || res.status !== 'ok') {
      throw new Error((res && res.message) || '案件解除に失敗しました');
    }
    showToast('案件を解除しました', 'success', 2000);
    await loadProjects();
  } catch (err) {
    console.error('[pc-projects] onUnmark', err);
    showToast(`案件解除失敗：${err.message || err}`, 'error', 3500);
  }
}

/* ── + 新規案件（補助フロー・インラインドラフトカード方式） ──── */
let _newProjectDraft = null;   // ドラフト状態
let _pjSettings = null;        // getSettings キャッシュ

async function ensureSettings() {
  if (_pjSettings) return _pjSettings;
  try {
    const res = await callGAS('getSettings', {});
    if (res && res.status === 'ok' && res.data) {
      _pjSettings = res.data;
    } else {
      _pjSettings = {};
    }
  } catch {
    _pjSettings = {};
  }
  return _pjSettings;
}

function getServiceList() {
  if (!_pjSettings) return [];
  let svcs = _pjSettings.serviceList ?? _pjSettings.services ?? [];
  if (typeof svcs === 'string') { try { svcs = JSON.parse(svcs); } catch { svcs = []; } }
  if (!Array.isArray(svcs)) svcs = [];
  return svcs;
}

async function onNewProject() {
  if (_newProjectDraft) return; // 既にドラフト表示中
  await ensureSettings();

  const today = new Date().toISOString().slice(0, 10);
  _newProjectDraft = { date: today, serviceCode: '', serviceName: '', amount: 0, taxRate: 10, memo: '' };

  renderNewProjectDraft();
}

function renderNewProjectDraft() {
  const listEl = document.getElementById('pj-list');
  if (!listEl) return;

  // ドラフトカードHTMLを先頭に挿入
  const existing = document.getElementById('pj-draft-card');
  if (existing) existing.remove();

  const svcs = getServiceList();
  const svcOpts = ['<option value="">（品目を選択）</option>'].concat(
    svcs.map(s => {
      const code = _esc(s.code || s.serviceCode || '');
      const name = _esc(s.name || s.serviceName || '');
      const tax = Number(s.taxRate) || 10;
      const sel = (_newProjectDraft.serviceCode === code) ? 'selected' : '';
      return `<option value="${code}" data-name="${name}" data-tax="${tax}" ${sel}>${name}</option>`;
    })
  ).join('');

  const d = _newProjectDraft;
  const valid = _isNewDraftValid(d);

  const card = document.createElement('div');
  card.id = 'pj-draft-card';
  card.className = 'pj-card pj-card--draft';
  card.innerHTML = `
    <div class="pj-draft-form">
      <div class="pj-card__section-label">新規案件（売上登録）</div>
      <div class="pj-draft-fields">
        <label class="pj-draft-field">
          <span>発生日</span>
          <input type="date" id="pj-draft-date" class="pc-edit-input" value="${_esc(d.date)}">
        </label>
        <label class="pj-draft-field">
          <span>品目</span>
          <select id="pj-draft-service" class="pc-edit-input">${svcOpts}</select>
        </label>
        <label class="pj-draft-field">
          <span>金額（税込）</span>
          <input type="number" id="pj-draft-amount" class="pc-edit-input pc-edit-input--num" value="${d.amount || ''}" placeholder="0">
        </label>
        <label class="pj-draft-field">
          <span>税率</span>
          <select id="pj-draft-tax" class="pc-edit-input">
            <option value="10" ${d.taxRate === 10 ? 'selected' : ''}>10%</option>
            <option value="8" ${d.taxRate === 8 ? 'selected' : ''}>8%</option>
            <option value="0" ${d.taxRate === 0 ? 'selected' : ''}>0%</option>
          </select>
        </label>
        <label class="pj-draft-field">
          <span>メモ</span>
          <input type="text" id="pj-draft-memo" class="pc-edit-input" value="${_esc(d.memo)}" placeholder="任意">
        </label>
      </div>
      <div class="pj-draft-actions">
        <button type="button" id="pj-draft-commit" class="pc-btn pc-btn-primary" ${valid ? '' : 'hidden'}>登録</button>
        <span class="pj-draft-spacer"></span>
        <button type="button" id="pj-draft-discard" class="pc-btn pc-btn--ghost" ${valid ? 'hidden' : ''}>取消</button>
      </div>
    </div>`;

  listEl.insertBefore(card, listEl.firstChild);
  bindDraftEvents(card);
  card.querySelector('#pj-draft-date')?.focus();
}

function _isNewDraftValid(d) {
  if (!d) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return false;
  if (!d.serviceCode) return false;
  const amt = Number(d.amount);
  if (!Number.isFinite(amt) || amt <= 0) return false;
  return true;
}

function _syncDraftFromDOM() {
  if (!_newProjectDraft) return;
  const dateEl = document.getElementById('pj-draft-date');
  const svcEl = document.getElementById('pj-draft-service');
  const amtEl = document.getElementById('pj-draft-amount');
  const taxEl = document.getElementById('pj-draft-tax');
  const memoEl = document.getElementById('pj-draft-memo');

  if (dateEl) _newProjectDraft.date = dateEl.value;
  if (svcEl) {
    _newProjectDraft.serviceCode = svcEl.value;
    const opt = svcEl.options[svcEl.selectedIndex];
    _newProjectDraft.serviceName = opt?.dataset?.name || '';
    if (opt?.dataset?.tax !== undefined) {
      _newProjectDraft.taxRate = Number(opt.dataset.tax) || 10;
      if (taxEl) taxEl.value = String(_newProjectDraft.taxRate);
    }
  }
  if (amtEl) _newProjectDraft.amount = Number(amtEl.value) || 0;
  if (taxEl) _newProjectDraft.taxRate = Number(taxEl.value) || 0;
  if (memoEl) _newProjectDraft.memo = memoEl.value;
}

function _updateDraftButtons() {
  const valid = _isNewDraftValid(_newProjectDraft);
  const discardBtn = document.getElementById('pj-draft-discard');
  const commitBtn = document.getElementById('pj-draft-commit');
  if (discardBtn) discardBtn.hidden = valid;
  if (commitBtn) commitBtn.hidden = !valid;
}

function bindDraftEvents(card) {
  // input/change イベントで状態同期＋ボタン切替
  card.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', () => { _syncDraftFromDOM(); _updateDraftButtons(); });
    el.addEventListener('change', () => { _syncDraftFromDOM(); _updateDraftButtons(); });
  });

  // Escキーで破棄
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); discardNewDraft(); }
  });

  // 取消ボタン
  document.getElementById('pj-draft-discard')?.addEventListener('click', discardNewDraft);
  // 登録ボタン
  document.getElementById('pj-draft-commit')?.addEventListener('click', commitNewDraft);
}

function discardNewDraft() {
  _newProjectDraft = null;
  const card = document.getElementById('pj-draft-card');
  if (card) card.remove();
}

async function commitNewDraft() {
  if (!_newProjectDraft || !_isNewDraftValid(_newProjectDraft)) return;
  const d = _newProjectDraft;
  const commitBtn = document.getElementById('pj-draft-commit');
  if (commitBtn) commitBtn.disabled = true;

  try {
    const res = await callGAS('addSales', {
      date: d.date,
      service: d.serviceName,       // GAS側はサービス名（文字列）を期待
      amount: d.amount,
      taxRate: d.taxRate,
      memo: d.memo,
      isProject: '1',
    });
    if (!res || res.status !== 'ok') {
      throw new Error((res && res.message) || '売上登録に失敗しました');
    }
    const newSalesRowId = (res.data && res.data.salesRowId) || null;
    showToast('新規案件を登録しました', 'success', 2000);
    discardNewDraft();
    await loadProjects();

    // 登録直後に経費紐付けモーダルを自動起動（ワンステップ短縮）
    if (newSalesRowId) {
      const node = _projectData?.salesNodes?.find(n => n.salesRowId === newSalesRowId);
      if (node) {
        const btn = document.querySelector(`.pj-action[data-action="add-cost"][data-sales-row-id="${newSalesRowId}"]`);
        if (btn) {
          setTimeout(() => onAddCost(btn), 300);
        }
      }
    }
  } catch (err) {
    console.error('[pc-projects] commitNewDraft', err);
    showToast(`登録失敗：${err.message || err}`, 'error', 3500);
    if (commitBtn) commitBtn.disabled = false;
  }
}

/* ── 紐付け候補モーダル（monthly.html と同一DOM・共通ロジック） ──── */
function bindModalEvents() {
  const modal = document.getElementById('pc-link-candidates-modal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    const action = e.target?.dataset?.action;
    if (action === 'cancel') closeLinkModal();
    else if (action === 'confirm') handleModalConfirm();
  });
}

function openLinkModal({ direction, hint, target, candidates, onConfirm }) {
  const modal = document.getElementById('pc-link-candidates-modal');
  const list = document.getElementById('pc-link-candidates-list');
  const hintEl = document.getElementById('pc-link-candidates-hint');
  const errEl = document.getElementById('pc-link-candidates-error');
  if (!modal || !list || !hintEl) return;

  renderModalTarget(target);
  hintEl.textContent = hint || '';
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  const inputType = direction === 'cost-to-sales' ? 'radio' : 'checkbox';
  const inputName = 'pj-link-cand';

  list.innerHTML = candidates.map(c => {
    const valueAttr = String(c.rowIndex);
    return `
      <label class="pc-link-candidates-row">
        <input type="${inputType}" name="${inputName}" value="${valueAttr}">
        <span>${_esc(c.date || '')}</span>
        <span>${_esc(c.subject || '')}</span>
        <span class="pc-link-candidates-row__amount">${_fmtYen(c.amount || 0)}</span>
        <span class="pc-link-candidates-row__memo">${_esc(c.memo || '')}</span>
      </label>`;
  }).join('');

  _modalState = { direction, candidates, onConfirm };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLinkModal(); }
  };
  document.addEventListener('keydown', keydownHandler);
  _modalState.keydownHandler = keydownHandler;

  modal.hidden = false;
}

async function handleModalConfirm() {
  if (!_modalState || !_modalState.onConfirm) return;

  if (_modalState.direction === 'sales-to-cost') {
    const list = document.getElementById('pc-link-candidates-list');
    const checked = list ? list.querySelectorAll('input[type="checkbox"]:checked') : [];
    const selected = Array.from(checked).map(i => Number(i.value)).filter(n => !isNaN(n));
    await _modalState.onConfirm(selected);
  }
}

function closeLinkModal() {
  const modal = document.getElementById('pc-link-candidates-modal');
  if (modal) modal.hidden = true;
  if (_modalState?.keydownHandler) {
    document.removeEventListener('keydown', _modalState.keydownHandler);
  }
  const confirmBtn = document.getElementById('pc-link-candidates-confirm');
  if (confirmBtn) {
    confirmBtn.hidden = false;
    confirmBtn.textContent = '確定';
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '';
    confirmBtn.style.cursor = '';
  }
  const targetEl = document.getElementById('pc-link-candidates-target');
  if (targetEl) { targetEl.innerHTML = ''; targetEl.hidden = true; }
  _modalState = null;
}

function renderModalTarget(target) {
  const el = document.getElementById('pc-link-candidates-target');
  if (!el) return;
  if (!target) { el.innerHTML = ''; el.hidden = true; return; }
  const label = target.kind === 'sales' ? '対象売上：' : '対象コスト：';
  const sep = '<span class="pc-link-candidates-target__sep">/</span>';
  const parts = [
    `<span class="pc-link-candidates-target__label">${_esc(label)}</span>`,
    `<span class="pc-link-candidates-target__date">${_esc(target.date || '')}</span>`,
    sep,
    `<span class="pc-link-candidates-target__subject">${_esc(target.subject || '')}</span>`,
    sep,
    `<span class="pc-link-candidates-target__amount">¥${_fmtYen(target.amount || 0)}</span>`,
  ];
  const memo = String(target.memo || '').trim();
  if (memo) {
    parts.push(sep);
    parts.push(`<span class="pc-link-candidates-target__memo">${_esc(memo)}</span>`);
  }
  el.innerHTML = parts.join('');
  el.hidden = false;
}

function showLinkError(msg) {
  const errEl = document.getElementById('pc-link-candidates-error');
  if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  else if (typeof showToast === 'function') showToast(msg, 'error', 3500);
}
