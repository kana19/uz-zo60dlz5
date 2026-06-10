/* pc-common.js — PC版共通：サイドバー生成・ヘッダー時刻 */
'use strict';

// PC版サイドバーメニュー定義（戦略思想メモ§3-9-3 確定の4項目構造）
// 順序・href・ラベルはここで一元管理する
const PC_NAV = [
  { href: 'pc-monthly.html',    label: '月次管理',  icon: '○' },
  { href: 'pc-projects.html',   label: '案件管理',  icon: '★' },
  { href: 'pc-attendance.html', label: '出勤管理',  icon: '👤', visibilityKey: 'attendance_menu' },
  { href: 'pc-settings.html',   label: '設定',      icon: '⚙' }
];

function pcRenderSidebar(activeHref) {
  // featureVisibility 取得（app.js の getFeatureVisibility を参照）
  const fv = (typeof getFeatureVisibility === 'function')
    ? getFeatureVisibility()
    : { clockin_menu: true, payroll_menu: false };

  // 業態別ラベル取得（app.js の deriveUILabels を参照）
  const uiLabels = (typeof deriveUILabels === 'function') ? deriveUILabels() : {};

  const navHtml = PC_NAV
    .filter(n => !n.visibilityKey || fv[n.visibilityKey] !== false)
    .map(n => {
      const cls = n.href === activeHref ? 'pc-nav__link active' : 'pc-nav__link';
      const labelText = (n.uiLabelKey && uiLabels[n.uiLabelKey]) ? uiLabels[n.uiLabelKey] : n.label;
      const iconHtml = n.icon ? `<span class="pc-nav__icon" aria-hidden="true">${n.icon}</span>` : '';
      return `<a href="${n.href}" class="${cls}">${iconHtml}<span>${escHtml(labelText)}</span></a>`;
    }).join('');

  // 店名ロゴ（クリックで損益概観 index.html へ遷移）
  // 課題1：店舗ロゴ画像（無ければ店舗名）を app.js の uzRenderBrand が描画する。
  // PC版は icons/ が1階層上のため iconBase='../icons/'。
  const html = `
    <aside class="pc-sidebar">
      <a href="index.html" class="pc-sidebar-logo">
        <span class="pc-sidebar-logo-brand"
              data-uz-brand
              data-uz-icon-base="../icons/"
              data-uz-fallback="店舗名未設定"
              data-uz-logo-class="uz-brand-logo pc-sidebar-logo-img"></span>
      </a>
      <nav class="pc-nav">${navHtml}</nav>
    </aside>
  `;
  return html;
}

function pcRenderHeader(title) {
  const now = new Date();
  const storeName = (typeof localStorage !== 'undefined' && localStorage.getItem('uz_store_name')) || '';
  return `
    <header class="pc-header">
      <div class="pc-header__title">${title}</div>
      <div class="pc-header__meta">
        <span>${escHtml(storeName)}</span>
        <span style="margin-left:16px;" id="pc-clock">${fmtDateTime(now)}</span>
      </div>
    </header>
  `;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function fmtDateTime(d) {
  const W = ['日','月','火','水','木','金','土'];
  const y = d.getFullYear(), m = d.getMonth()+1, day = d.getDate();
  const h = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}/${m}/${day}(${W[d.getDay()]}) ${h}:${mm}`;
}

function pcStartClock() {
  setInterval(() => {
    const el = document.getElementById('pc-clock');
    if (el) el.textContent = fmtDateTime(new Date());
  }, 30000);
}

/* ── PC版ページブート ──────────────────────── */
function pcBootstrap(activeHref, title) {
  const app = document.getElementById('pc-app');
  if (!app) return;
  app.insertAdjacentHTML('afterbegin', pcRenderSidebar(activeHref));
  const main = document.getElementById('pc-main');
  if (main) main.insertAdjacentHTML('afterbegin', pcRenderHeader(title));
  pcStartClock();
  // 課題1：サイドバー/ヘッダー挿入後にブランド（店舗ロゴ／店舗名）を描画。
  // app.js の DOMContentLoaded 描画より後に DOM 挿入されるため明示的に呼ぶ。
  if (typeof uzRenderAllBrands === 'function') uzRenderAllBrands();
}

/* ──────────────────────────────────────────────────────────
   削除確認モーダル（指示書15／15-2・月次管理＋案件管理 共通）
   戦略思想§1-5-2 AI自動確定禁止：必ず「削除ボタン→ダイアログ→削除する」の3ステップ
   呼び出し元は monthly.html / projects.html に同じ ID で配置されたモーダルDOMを共有
   options:
     - sheetName : '売上' or 'コスト'
     - rowIndex  : 対象行番号
     - date / type / subject / amount / memo : 対象行の表示情報
     - isProject (bool) : 案件売上かどうか（モーダルタイトル既定値の決定に使用）
     - linkedCosts (Array<{rowIndex, date, subject, amount}>) :
         紐付け経費の配列。length > 0 のときチェックボックス方式で描画。
         省略 / 空配列のときは単純確認方式（既存挙動）。
     - modalTitle (string・省略時 '行を削除しますか？')
     - onConfirm (async function(selectedItems)) :
         削除確定時に呼ばれる。selectedItems = {
           deleteSales: true,
           costsToDelete: number[],       // チェックON経費の rowIndex 配列
           costsToUnlinkOnly: number[]    // チェックOFF経費の rowIndex 配列
         }
   ────────────────────────────────────────────────────────── */
let _pcDeleteModalState = null;

function _pcFmtYen(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('ja-JP');
}

function openDeleteConfirmModal(options) {
  if (!options) return;
  const modal = document.getElementById('pc-delete-confirm-modal');
  if (!modal) return;
  const titleEl = document.getElementById('pc-delete-confirm-title');
  const targetEl = document.getElementById('pc-delete-target-info');
  const warnEl = document.getElementById('pc-delete-warning');
  const errEl = document.getElementById('pc-delete-confirm-error');
  const confirmBtn = document.getElementById('pc-delete-confirm-btn');

  const linkedCosts = Array.isArray(options.linkedCosts) ? options.linkedCosts : [];
  const useCheckboxMode = linkedCosts.length > 0;

  if (titleEl) titleEl.textContent = options.modalTitle || '行を削除しますか？';

  // 対象情報の組み立て
  if (targetEl) {
    const date = escHtml(options.date || '');
    const type = escHtml(options.type || '');
    const subject = escHtml(options.subject || '');
    const amount = _pcFmtYen(options.amount || 0);
    const memo = String(options.memo || '').trim();

    if (useCheckboxMode) {
      // 指示書15-2：チェックボックス方式（紐付け経費あり売上削除）
      // 売上行はチェックON固定で操作不能（disabled）。経費は初期ON、外せば紐付けのみ解除
      const salesRow = `
        <label class="pc-delete-checkbox-row pc-delete-checkbox-row--locked">
          <input type="checkbox" checked disabled data-target="sales">
          <span>売上：${date} / ${subject} / ¥${amount}</span>
        </label>
      `;
      const costRows = linkedCosts.map(c => {
        const cDate = escHtml(c.date || '');
        const cSubject = escHtml(c.subject || '');
        const cAmount = _pcFmtYen(c.amount || 0);
        const cRowIndex = Number(c.rowIndex);
        // 指示書15-3：経費は初期OFF（会計データの「うっかり削除」を防ぐ世界標準UI準拠）
        return `
          <label class="pc-delete-checkbox-row">
            <input type="checkbox" data-target="cost" data-row-index="${cRowIndex}">
            <span>経費：${cDate} / ${cSubject} / ¥${cAmount}</span>
          </label>
        `;
      }).join('');
      const memoHtml = memo
        ? `<div class="pc-delete-target-info__memo">メモ：${escHtml(memo)}</div>`
        : '';
      targetEl.innerHTML = `
        <div class="pc-delete-target-info__label">削除対象</div>
        <div class="pc-delete-checkboxes">
          ${salesRow}
          ${costRows}
        </div>
        ${memoHtml}
      `;
    } else {
      // 単純確認方式（既存挙動・紐付けなし or コスト単独削除）
      const memoHtml = memo
        ? `<div class="pc-delete-target-info__memo">メモ：${escHtml(memo)}</div>`
        : '';
      targetEl.innerHTML = `
        <div class="pc-delete-target-info__label">削除対象</div>
        <div class="pc-delete-target-info__main">${date} / ${type} / ${subject} / ¥${amount}</div>
        ${memoHtml}
      `;
    }
  }

  // 警告メッセージ
  if (warnEl) {
    if (useCheckboxMode) {
      // 指示書15-3：経費は初期OFF。「コストも削除する場合はチェックを入れてください」に文言反転
      warnEl.innerHTML = `
        <div>⚠ 売上は月次管理からも削除されます。</div>
        <div>　 紐付けされたコストも削除する場合はチェックを入れてください（チェックを外したコストは月次管理に残り、紐付けのみ解除されます）。</div>
      `;
      warnEl.hidden = false;
    } else {
      warnEl.innerHTML = '';
      warnEl.hidden = true;
    }
  }

  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '';
    confirmBtn.style.cursor = '';
  }

  // 既存リスナーがあれば一旦破棄してから登録（多重呼び出し防止）
  _pcCloseDeleteConfirmModalCleanup();

  const onClick = async (e) => {
    const action = e.target?.dataset?.action;
    if (action === 'cancel') {
      closeDeleteConfirmModal();
    } else if (action === 'confirm') {
      if (typeof options.onConfirm === 'function') {
        // 二重実行防止
        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.style.opacity = '0.45';
          confirmBtn.style.cursor = 'not-allowed';
        }
        // チェックボックス状態を集計して selectedItems を構築
        const selectedItems = _pcCollectDeleteSelections(targetEl, linkedCosts);
        try {
          await options.onConfirm(selectedItems);
        } catch (err) {
          showDeleteConfirmError(err && err.message ? err.message : String(err));
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '';
            confirmBtn.style.cursor = '';
          }
        }
      } else {
        closeDeleteConfirmModal();
      }
    }
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDeleteConfirmModal(); }
  };

  modal.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  _pcDeleteModalState = { modal, onClick, onKeydown };

  modal.hidden = false;
}

// チェックボックス状態を集計して selectedItems を返す
function _pcCollectDeleteSelections(targetEl, linkedCosts) {
  const selectedItems = {
    deleteSales: true,
    costsToDelete: [],
    costsToUnlinkOnly: [],
  };
  if (!targetEl || !Array.isArray(linkedCosts) || linkedCosts.length === 0) {
    return selectedItems;
  }
  const checkboxes = targetEl.querySelectorAll('input[type="checkbox"][data-target="cost"]');
  checkboxes.forEach(cb => {
    const rowIndex = Number(cb.dataset.rowIndex);
    if (!isFinite(rowIndex) || rowIndex <= 0) return;
    if (cb.checked) {
      selectedItems.costsToDelete.push(rowIndex);
    } else {
      selectedItems.costsToUnlinkOnly.push(rowIndex);
    }
  });
  return selectedItems;
}

function closeDeleteConfirmModal() {
  const modal = document.getElementById('pc-delete-confirm-modal');
  if (modal) modal.hidden = true;
  _pcCloseDeleteConfirmModalCleanup();
}

function _pcCloseDeleteConfirmModalCleanup() {
  if (!_pcDeleteModalState) return;
  const { modal, onClick, onKeydown } = _pcDeleteModalState;
  if (modal && onClick) modal.removeEventListener('click', onClick);
  if (onKeydown) document.removeEventListener('keydown', onKeydown);
  _pcDeleteModalState = null;
}

function showDeleteConfirmError(msg) {
  const errEl = document.getElementById('pc-delete-confirm-error');
  if (errEl) { errEl.textContent = msg || ''; errEl.hidden = !msg; }
}
