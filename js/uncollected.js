/**
 * ウルトラZAIMUくん LEO版 PWA — uncollected.js
 * 未収・買掛け一覧画面ロジック（GAS getUncollected / reconcile 連携版）
 */

'use strict';

/* ── 状態 ────────────────────────────────────────────────── */
let liveData   = [];   // GASから取得したデータ
let openFormId = null; // 現在展開中の消込フォームのID

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadData();
});

/* ── GASからデータ取得 ───────────────────────────────────── */
async function loadData() {
  showLoading();
  try {
    const res = await callGAS('getUncollected', {});
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      // クライアント側でIDを付与（sheetName+rowIndexの組み合わせは一意）
      liveData = res.data.map((item, idx) => ({ ...item, id: idx + 1 }));
    } else {
      liveData = [];
      showToast('データの取得に失敗しました', 'error');
    }
  } catch (e) {
    liveData = [];
    showToast('GAS接続エラー：' + e.message, 'error');
  } finally {
    hideLoading();
    renderAll();
  }
}

/* ── 全体描画（liveDataから描画・GAS再取得なし） ─────────── */
function renderAll() {
  const uncollected = liveData.filter(d => d.type === 'uncollected');
  const payable     = liveData.filter(d => d.type === 'payable');

  renderSummary(uncollected, payable);
  renderList('uncollected-list', uncollected, 'uncollected');
  renderList('payable-list',     payable,     'payable');
  renderBadge('uncollected-badge', uncollected.length);
  renderBadge('payable-badge',     payable.length);
}

/* ── サマリーカード ──────────────────────────────────────── */
function renderSummary(uncollected, payable) {
  const totalUC = uncollected.reduce((s, d) => s + d.amount, 0);
  const totalPY = payable.reduce((s, d) => s + d.amount, 0);

  const ucEl = document.getElementById('total-uncollected');
  const pyEl = document.getElementById('total-payable');
  if (ucEl) ucEl.textContent = formatYen(totalUC);
  if (pyEl) pyEl.textContent = formatYen(totalPY);
}

/* ── バッジ件数 ──────────────────────────────────────────── */
function renderBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = `${count}件`;
  el.style.display = count > 0 ? 'inline' : 'none';
}

/* ── リスト描画 ──────────────────────────────────────────── */
function renderList(containerId, items, type) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (items.length === 0) {
    container.innerHTML = `<div class="uc-empty">現在、${type === 'uncollected' ? '未収' : '未払い'}はありません</div>`;
    return;
  }

  container.innerHTML = items.map(item => buildItemHTML(item, type)).join('');
}

/* ── アイテムHTML生成 ────────────────────────────────────── */
function buildItemHTML(item, type) {
  const dateStr      = formatDate(item.date);
  const isOpen       = openFormId === item.id;
  const btnLabel     = type === 'uncollected' ? '入金消込' : '支払消込';
  const confirmLabel = type === 'uncollected' ? '入金消込を確定する' : '支払消込を確定する';
  const formTitle    = type === 'uncollected' ? '入金情報を入力してください' : '支払情報を入力してください';
  const dateLabel    = type === 'uncollected' ? '入金日' : '支払日';
  const amountLabel  = type === 'uncollected' ? '入金額' : '支払額';

  return `
    <div class="uc-item" id="uc-item-${item.id}">
      <div class="uc-item-main">
        <div class="uc-item-info">
          <div class="uc-item-name">${escHtml(item.itemName)}</div>
          <div class="uc-item-meta">${escHtml(dateStr)} ・ ${formatYen(item.amount)}</div>
          ${item.memo ? `<div class="uc-item-meta" style="font-size:11px;margin-top:2px;">${escHtml(item.memo)}</div>` : ''}
        </div>
        <div class="uc-item-right">
          <button class="uc-reconcile-btn uc-reconcile-btn--${type} ${isOpen ? 'active' : ''}"
                  type="button"
                  onclick="toggleReconcileForm(${item.id})"
                  aria-expanded="${isOpen}">
            ${isOpen ? '▲ 閉じる' : btnLabel}
          </button>
        </div>
      </div>

      <!-- 消込インラインフォーム -->
      <div class="uc-reconcile-form ${isOpen ? 'uc-reconcile-form--open' : ''}"
           id="reconcile-form-${item.id}"
           aria-hidden="${!isOpen}">
        <p style="font-size:12px;color:var(--uz-muted);margin-bottom:10px;">
          ${escHtml(formTitle)}
        </p>
        <div class="uc-reconcile-form__row">
          <div class="uc-reconcile-form__field">
            <label class="uc-reconcile-form__label" for="paid-date-${item.id}">
              ${escHtml(dateLabel)}
            </label>
            <input type="date"
                   id="paid-date-${item.id}"
                   class="uc-reconcile-input"
                   value="${todayStr()}"
                   aria-label="${escHtml(dateLabel)}">
          </div>
          <div class="uc-reconcile-form__field">
            <label class="uc-reconcile-form__label" for="paid-amount-${item.id}">
              ${escHtml(amountLabel)}
            </label>
            <input type="text"
                   id="paid-amount-${item.id}"
                   class="uc-reconcile-input"
                   inputmode="numeric"
                   pattern="[0-9]*"
                   value="${item.amount}"
                   aria-label="${escHtml(amountLabel)}">
          </div>
        </div>
        <button class="uc-reconcile-confirm-btn uc-reconcile-confirm-btn--${type}"
                type="button"
                onclick="handleReconcile(${item.id}, '${type}')">
          ${escHtml(confirmLabel)}
        </button>
      </div>
    </div>
  `;
}

/* ── 消込フォーム 開閉 ───────────────────────────────────── */
function toggleReconcileForm(id) {
  openFormId = openFormId === id ? null : id;
  renderAll();

  if (openFormId === id) {
    setTimeout(() => {
      document.getElementById(`reconcile-form-${id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }
}

/* ── 消込処理 ────────────────────────────────────────────── */
async function handleReconcile(id, type) {
  const item = liveData.find(d => d.id === id);
  if (!item) return;

  const paidDate   = document.getElementById(`paid-date-${id}`)?.value || '';
  const paidAmtRaw = document.getElementById(`paid-amount-${id}`)?.value.replace(/,/g, '') || '0';
  const paidAmount = parseInt(paidAmtRaw) || 0;

  if (!paidDate)       return showToast('日付を入力してください', 'error');
  if (paidAmount <= 0) return showToast('金額を入力してください', 'error');

  const confirmMsg = type === 'uncollected'
    ? `${item.itemName}（${formatYen(item.amount)}）の入金消込を確定しますか？`
    : `${item.itemName}（${formatYen(item.amount)}）の支払消込を確定しますか？`;

  if (!confirm(confirmMsg)) return;

  const btn = document.querySelector(`#uc-item-${id} .uc-reconcile-confirm-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '処理中...'; }

  try {
    const res = await callGAS('reconcile', {
      sheetName:  item.sheetName,
      rowIndex:   item.rowIndex,
      paidAmount,
      paidDate,
    });

    if (!res || res.status !== 'ok') {
      throw new Error(res?.message || '消込に失敗しました');
    }

    // 消込成功 → liveDataから除外して再描画
    liveData   = liveData.filter(d => d.id !== id);
    openFormId = null;
    renderAll();

    const msg = type === 'uncollected' ? '入金消込を完了しました ✓' : '支払消込を完了しました ✓';
    showToast(msg, 'success');

  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = type === 'uncollected' ? '入金消込を確定する' : '支払消込を確定する'; }
    showToast('消込に失敗しました：' + e.message, 'error');
  }
}

/* ── 日付フォーマット ────────────────────────────────────── */
function formatDate(dateStr) {
  if (!dateStr) return '';
  // GASは YYYY/MM/DD または YYYY-MM-DD で返す場合がある
  const [y, m, d] = String(dateStr).split(/[-\/]/).map(Number);
  if (!y || !m || !d) return String(dateStr);
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/* ── XSSエスケープ ───────────────────────────────────────── */
function escHtml(str) {
  // app.js の uzEscHtml に委譲（重複定義を解消・SSOT）
  return uzEscHtml(str);
}
