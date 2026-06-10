/* pc-settings.js — PC版 設定（店舗情報・サービスマスタ・仕入マスタ・販管費マスタ・スタッフマスタ）
 *
 * 6-G フェーズ2（v0.5.6 連動）：
 *   - getSettings 応答から masterQuota / purchaseMasterList を取得
 *   - サービスマスタ・仕入マスタに「＋追加」「削除」ボタン
 *   - 枠超過時は追加抑止（モーダル＋ヒント表示）
 *   - サーバ側 addServiceItem / deleteServiceItem / addPurchaseItem / deletePurchaseItem を使用
 *   - 販管費マスタ（コード8〜31）は既存のインライン編集＋一括保存方式を維持
 */
'use strict';

let settings = null;
let costMaster = [];
let purchaseList = [];
let masterQuota = { serviceMasterQuota: 5, purchaseMasterQuota: 3, costOptionalQuota: 5 };

document.addEventListener('DOMContentLoaded', async () => {
  pcBootstrap('pc-settings.html', '設定');
  await loadAll();
  document.getElementById('btn-save-cm').addEventListener('click', saveCM);
  document.getElementById('svc-add-btn').addEventListener('click', addService);
  document.getElementById('pur-add-btn').addEventListener('click', addPurchase);
  const svcNameInput = document.getElementById('svc-add-name');
  if (svcNameInput) svcNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addService(); });
  const purNameInput = document.getElementById('pur-add-name');
  if (purNameInput) purNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPurchase(); });
  bindStaffAdd();
});

async function loadAll() {
  const [sRes, cmRes] = await Promise.all([
    callGAS('getSettings', {}).catch(() => null),
    callGAS('getCostMaster', {}).catch(() => null),
  ]);
  settings = (sRes && sRes.status === 'ok' && sRes.data) ? sRes.data : {};
  // 6-G フェーズ2：マスタ件数枠を取得（未投入の既存ユーザーはフォールバック値を使う）
  if (settings.masterQuota && typeof settings.masterQuota === 'object') {
    masterQuota = {
      serviceMasterQuota: Number(settings.masterQuota.serviceMasterQuota) || 5,
      purchaseMasterQuota: Number(settings.masterQuota.purchaseMasterQuota) || 3,
      costOptionalQuota: Number(settings.masterQuota.costOptionalQuota) || 5
    };
  }
  // 6-G フェーズ2：仕入マスタを取得（getSettings 応答から優先・なければ空）
  if (Array.isArray(settings.purchaseMasterList)) {
    purchaseList = settings.purchaseMasterList;
  } else {
    purchaseList = [];
  }
  // 販管費マスタは既存通り getCostMaster 経由（getSettings の costMasterList より優先）
  // GAS生データは type/divisionCode が欠落しうるため normalizeCostMasterList で正規化する（→ app.js）
  let cmRaw;
  if (cmRes && cmRes.status === 'ok' && Array.isArray(cmRes.data) && cmRes.data.length > 0) {
    cmRaw = cmRes.data;
  } else if (Array.isArray(settings.costMasterList) && settings.costMasterList.length > 0) {
    cmRaw = settings.costMasterList;
  } else {
    cmRaw = getCostMaster();
  }
  costMaster = (typeof normalizeCostMasterList === 'function')
    ? normalizeCostMasterList(cmRaw)
    : cmRaw;
  saveCostMasterToStorage(costMaster);
  renderServices();
  renderPurchases();
  renderCM();
  renderStaff();
  renderBasicInfo();
}

/* ── 基本情報セクション（読み取り専用・スマホ版と表記統一） ── */
function renderBasicInfo() {
  // 店舗名
  const storeEl = document.getElementById('info-store-name');
  if (storeEl) {
    const name = settings?.storeName || localStorage.getItem('uz_store_name') || '';
    storeEl.textContent = name || '—';
  }

  // 営業時間（businessHours があれば「19:00 〜 翌03:00」形式・無ければ行ごと非表示）
  const row = document.getElementById('info-business-hours-row');
  const val = document.getElementById('info-business-hours');
  if (row && val) {
    let formatted = null;
    try {
      const bh = settings?.businessHours;
      if (bh && bh.open && bh.close && typeof formatBusinessHours === 'function') {
        formatted = formatBusinessHours(bh);
      } else if (typeof getBusinessHours === 'function' && typeof formatBusinessHours === 'function') {
        formatted = formatBusinessHours(getBusinessHours());
      }
    } catch { formatted = null; }
    if (formatted) {
      val.textContent = formatted;
      row.hidden = false;
    } else {
      row.hidden = true;
    }
  }

  bindVersionTapDebug();
}

/* ── バージョン5タップで GAS接続情報を展開（隠しコマンド・スマホ版と統一） ── */
function bindVersionTapDebug() {
  const ver = document.getElementById('info-version');
  const dbg = document.getElementById('info-debug');
  if (!ver || !dbg || ver.dataset.tapBound === '1') return;
  ver.dataset.tapBound = '1';

  let count = 0;
  let timer = null;
  ver.addEventListener('click', () => {
    count++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { count = 0; }, 1200);
    if (count >= 5) {
      count = 0;
      dbg.hidden = !dbg.hidden;
      if (!dbg.hidden) {
        const statusEl = document.getElementById('gas-status-val');
        if (statusEl) {
          statusEl.textContent = '接続済み ✓';
          statusEl.style.color = 'var(--uz-green)';
        }
        const urlEl = document.getElementById('gas-url-val');
        try {
          if (urlEl && typeof GAS_URL === 'string') urlEl.textContent = GAS_URL;
        } catch { /* ignore */ }
      }
    }
  });
}

/* ── サービスマスタ ─────────────────────────────────────── */
function getServiceListFromState() {
  let svcs = settings?.serviceList ?? settings?.services ?? [];
  if (typeof svcs === 'string') { try { svcs = JSON.parse(svcs); } catch { svcs = []; } }
  if (!Array.isArray(svcs)) svcs = [];
  return svcs;
}

function renderServices() {
  const svcs = getServiceListFromState();
  const body = document.getElementById('svc-body');
  const quota = masterQuota.serviceMasterQuota;

  if (svcs.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
  } else {
    body.innerHTML = svcs.map(s => {
      const idKey = escHtml(String(s.id || s.code || ''));
      return `<tr>
        <td>${idKey}</td>
        <td>${escHtml(s.name||'')}</td>
        <td>${Number(s.taxRate)||0}%</td>
        <td><button class="pc-btn pc-btn--ghost" type="button" onclick="deleteService('${idKey}')">削除</button></td>
      </tr>`;
    }).join('');
  }

  const badge = document.getElementById('svc-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${svcs.length}/${quota}`;
  }
  const addRow = document.getElementById('svc-add-row');
  const hint = document.getElementById('svc-limit-hint');
  const atMax = svcs.length >= quota;
  if (addRow) addRow.style.display = atMax ? 'none' : '';
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function addService() {
  const nameEl = document.getElementById('svc-add-name');
  const taxEl  = document.getElementById('svc-add-tax');
  const btn    = document.getElementById('svc-add-btn');
  const name = nameEl.value.trim();
  const taxRate = parseInt(taxEl.value);
  if (!name) return showToast('サービス名を入力してください', 'error');
  if (name.length > 30) return showToast('サービス名は30文字以内で入力してください', 'error');

  const list = getServiceListFromState();
  if (list.length >= masterQuota.serviceMasterQuota) {
    return showToast(`件数枠の上限（${masterQuota.serviceMasterQuota}件）に達しています`, 'error');
  }
  if (list.some(s => s.name === name)) {
    return showToast('同じ名前のサービスが既に登録されています', 'error');
  }

  btn.disabled = true;
  try {
    const res = await callGAS('addServiceItem', { name, taxRate });
    if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
      settings.serviceList = res.serviceList;
      nameEl.value = '';
      taxEl.value = '10';
      renderServices();
      showToast(`${name}を追加しました`, 'success');
    } else if (res && res.code === 'quota_exceeded') {
      showToast(res.message || '件数枠の上限に達しています', 'error');
      if (typeof res.quota === 'number') {
        masterQuota.serviceMasterQuota = res.quota;
      }
      renderServices();
    } else {
      showToast((res && res.message) || '追加に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteService(id) {
  const list = getServiceListFromState();
  const target = list.find(s => String(s.id || s.code) === String(id));
  if (!target) return;
  if (list.length <= 1) return showToast('最低1種のサービスが必要です', 'error');
  if (!confirm(`「${target.name}」を削除しますか？\n登録済みの売上データには影響しません。`)) return;
  try {
    const res = await callGAS('deleteServiceItem', { id: String(target.id || target.code) });
    if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
      settings.serviceList = res.serviceList;
      renderServices();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  }
}

/* ── 仕入原価マスタ（6-G フェーズ2 新設）─────────────── */
function renderPurchases() {
  const body = document.getElementById('pur-body');
  const quota = masterQuota.purchaseMasterQuota;

  if (!Array.isArray(purchaseList) || purchaseList.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
  } else {
    body.innerHTML = purchaseList.map(p => {
      const idKey = escHtml(String(p.id || ''));
      const rate = (p.defaultTaxRate !== undefined) ? p.defaultTaxRate : (p.taxRate !== undefined ? p.taxRate : 10);
      return `<tr>
        <td>${idKey}</td>
        <td>${escHtml(p.name||'')}</td>
        <td>${Number(rate)||0}%</td>
        <td><button class="pc-btn pc-btn--ghost" type="button" onclick="deletePurchase('${idKey}')">削除</button></td>
      </tr>`;
    }).join('');
  }

  const badge = document.getElementById('pur-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${purchaseList.length}/${quota}`;
  }
  const addRow = document.getElementById('pur-add-row');
  const hint = document.getElementById('pur-limit-hint');
  const atMax = purchaseList.length >= quota;
  if (addRow) addRow.style.display = atMax ? 'none' : '';
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function addPurchase() {
  const nameEl = document.getElementById('pur-add-name');
  const taxEl  = document.getElementById('pur-add-tax');
  const btn    = document.getElementById('pur-add-btn');
  const name = nameEl.value.trim();
  const taxRate = parseInt(taxEl.value);
  if (!name) return showToast('科目名を入力してください', 'error');
  if (name.length > 30) return showToast('科目名は30文字以内で入力してください', 'error');

  if (purchaseList.length >= masterQuota.purchaseMasterQuota) {
    return showToast(`件数枠の上限（${masterQuota.purchaseMasterQuota}件）に達しています`, 'error');
  }
  if (purchaseList.some(p => p.name === name)) {
    return showToast('同じ名前の科目が既に登録されています', 'error');
  }

  btn.disabled = true;
  try {
    const res = await callGAS('addPurchaseItem', { name, defaultTaxRate: taxRate });
    if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
      purchaseList = res.purchaseMasterList;
      nameEl.value = '';
      taxEl.value = '10';
      renderPurchases();
      showToast(`${name}を追加しました`, 'success');
    } else if (res && res.code === 'quota_exceeded') {
      showToast(res.message || '件数枠の上限に達しています', 'error');
      if (typeof res.quota === 'number') {
        masterQuota.purchaseMasterQuota = res.quota;
      }
      renderPurchases();
    } else {
      showToast((res && res.message) || '追加に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deletePurchase(id) {
  const target = purchaseList.find(p => String(p.id) === String(id));
  if (!target) return;
  if (!confirm(`「${target.name}」を削除しますか？\n登録済みのコストデータには影響しません。`)) return;
  try {
    const res = await callGAS('deletePurchaseItem', { id: String(target.id) });
    if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
      purchaseList = res.purchaseMasterList;
      renderPurchases();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  }
}

/* ── 販管費マスタ（既存維持・販管費専用に役割明確化）─────── */
function renderCM() {
  const body = document.getElementById('cm-body');
  // 仕入原価行（divisionCode='1'）を除外して販管費のみ表示
  // 既存データの divisionCode が未設定の場合は販管費扱い（後方互換）
  const filtered = costMaster.filter(row => {
    return !row.divisionCode || row.divisionCode === '2';
  });
  body.innerHTML = filtered.map((row) => {
    const i = costMaster.indexOf(row);
    const fixed = row.type === 'fixed';
    const taxOpts = [0,8,10].map(v => `<option value="${v}" ${Number(row.taxRate)===v?'selected':''}>${v}%</option>`).join('');
    const nameCell = fixed
      ? `<input type="text" class="pc-input cm-name" value="${escHtml(row.name||'')}" data-i="${i}" disabled style="width:100%;opacity:0.6;">`
      : `<input type="text" class="pc-input cm-name" value="${escHtml(row.name||'')}" data-i="${i}" placeholder="任意科目名" style="width:100%;">`;
    const visChecked = (row.smartphoneVisible === false) ? '' : ' checked';
    return `<tr>
      <td>${escHtml(row.code||'')}</td>
      <td>${nameCell}</td>
      <td><select class="pc-select cm-tax" data-i="${i}">${taxOpts}</select></td>
      <td style="text-align:center;"><input type="checkbox" class="cm-vis" data-i="${i}" style="width:18px;height:18px;accent-color:var(--uz-gold,#b8860b);cursor:pointer;"${visChecked}></td>
      <td>${fixed ? '固定' : '任意'}</td>
    </tr>`;
  }).join('');
}

async function saveCM() {
  document.querySelectorAll('.cm-name').forEach(inp => {
    const i = Number(inp.dataset.i);
    if (costMaster[i] && costMaster[i].type !== 'fixed') costMaster[i].name = inp.value.trim();
  });
  document.querySelectorAll('.cm-tax').forEach(sel => {
    const i = Number(sel.dataset.i);
    if (costMaster[i]) costMaster[i].taxRate = Number(sel.value);
  });
  document.querySelectorAll('.cm-vis').forEach(chk => {
    const i = Number(chk.dataset.i);
    if (costMaster[i]) costMaster[i].smartphoneVisible = chk.checked;
  });
  saveCostMasterToStorage(costMaster);
  // costMasterList は販管費専用（→ 03_データ仕様.md §1-2）。仕入原価を正本に書き戻さない。
  const sanitized = costMaster.filter(row => !row.divisionCode || row.divisionCode === '2');
  const res = await callGAS('saveCostMaster', { costMasterList: sanitized }).catch(() => null);
  if (res && res.status === 'ok') {
    showToast('販管費マスタを保存しました', 'success');
  } else {
    showToast('保存失敗（ローカルには保存）', 'error');
  }
}


/* ══════════════════════════════════════════════════════════════
   スタッフマスタ（追加・編集・削除・パスワード対応）
   - スタッフマスタ登録者＝月次給与計算対象（出勤管理→確定で計上）
   - コスト科目は会計上の計上先：委託・外注のみ 21/25、雇用系は20固定
     （給与計算正本 pc-attendance.js _getStaffCostCode と一致）
   - 給与単価（hourlyWage/dailyWage/monthlyWage）・源泉区分（withholdingMode）
     ・経営メモ（managerMemo）はPC版出勤管理で設定する領域。
     ここでの編集・追加時はスプレッドで既存値を必ず保持し、消さない。
   ══════════════════════════════════════════════════════════════ */
const STAFF_PW_PATTERN = /^[A-Za-z0-9]{5}$/;
function validateStaffPassword(pw) { return typeof pw === 'string' && STAFF_PW_PATTERN.test(pw); }
async function hashStaffPassword(staffId, password) {
  const salted  = `staff:${staffId}:${password}`;
  const encoded = new TextEncoder().encode(salted);
  const buf     = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmpType(value) {
  if (value === 'employed_full' || value === 'employed_temp' || value === 'contractor') return value;
  if (value === 'employed') return 'employed_full';
  return 'employed_full';
}

/* コスト科目：委託・外注のみ 21/25。雇用系は給与計算側で20固定のため参照されない */
function normalizeCostCategory(value) {
  return (value === '25') ? '25' : '21';
}

function empTypeLabel(empType) {
  if (empType === 'contractor') return '委託・外注';
  if (empType === 'employed_temp') return '臨時アルバイト';
  return '常勤雇用';
}

function getStaffArray() {
  let staff = settings?.staffList ?? settings?.staff ?? [];
  if (typeof staff === 'string') { try { staff = JSON.parse(staff); } catch { staff = []; } }
  if (!Array.isArray(staff)) staff = [];
  return staff;
}

function renderStaff() {
  const staff = getStaffArray();
  const body = document.getElementById('staff-body');
  if (!body) return;
  if (staff.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
    return;
  }
  body.innerHTML = staff.map(s => {
    const empType = normalizeEmpType(s.employmentType);
    const sid = escHtml(String(s.id || ''));
    const isContractor = empType === 'contractor';
    const costLabel = isContractor
      ? ((normalizeCostCategory(s.costCategory) === '25') ? '25：税理士等の報酬' : '21：外注工賃')
      : '20：給料賃金';
    return `<tr id="staff-row-${sid}">
      <td>${sid}</td>
      <td>${escHtml(s.name || '')}</td>
      <td>${empTypeLabel(empType)}</td>
      <td>${costLabel}</td>
      <td><button class="pc-btn pc-btn--ghost" type="button" onclick="editStaff('${sid}')">編集</button></td>
    </tr>`;
  }).join('');
}

function editStaff(id) {
  const staff = getStaffArray().find(s => String(s.id) === String(id));
  if (!staff) return;
  const row = document.getElementById(`staff-row-${id}`);
  if (!row) return;
  const empType = normalizeEmpType(staff.employmentType);
  const costCat = normalizeCostCategory(staff.costCategory);
  const costDisabled = empType !== 'contractor';
  row.innerHTML = `
    <td colspan="5">
      <div class="staff-edit-cell">
        <div class="staff-edit-line">
          <input type="text" id="staff-edit-name-${id}" class="pc-input" style="flex:1;min-width:140px;" value="${escHtml(staff.name || '')}" maxlength="20" placeholder="スタッフ名">
          <select id="staff-edit-emp-${id}" class="pc-select" style="width:160px;" onchange="onEditEmpChange('${id}')">
            <option value="employed_full"${empType === 'employed_full' ? ' selected' : ''}>常勤雇用（社員）</option>
            <option value="employed_temp"${empType === 'employed_temp' ? ' selected' : ''}>臨時アルバイト</option>
            <option value="contractor"${empType === 'contractor' ? ' selected' : ''}>委託・外注</option>
          </select>
          <select id="staff-edit-cost-${id}" class="pc-select" style="width:170px;"${costDisabled ? ' disabled' : ''}>
            <option value="21"${costCat === '21' ? ' selected' : ''}>21：外注工賃</option>
            <option value="25"${costCat === '25' ? ' selected' : ''}>25：税理士等の報酬</option>
          </select>
        </div>
        <div class="staff-edit-line">
          <input type="text" id="staff-edit-password-${id}" class="pc-input" style="flex:1;min-width:200px;" placeholder="パスワード変更（任意・5桁英数字）" maxlength="5" autocomplete="off">
          <button class="pc-btn" type="button" onclick="saveEditStaff('${id}')">保存</button>
          <button class="pc-btn pc-btn--ghost" type="button" onclick="renderStaff()">キャンセル</button>
          <button class="pc-btn pc-btn--danger" type="button" onclick="deleteStaff('${id}')">削除</button>
        </div>
        <p class="pc-note" style="margin:2px 0 0;color:var(--uz-muted);font-size:11px;">給与単価・源泉区分・経営メモは出勤管理で設定します（ここでの編集では変更されません）。</p>
      </div>
    </td>`;
  document.getElementById(`staff-edit-name-${id}`)?.focus();
}

/* 編集モード：雇用形態に応じてコスト科目セレクトの活性を切替（委託・外注のみ活性） */
function onEditEmpChange(id) {
  const empEl  = document.getElementById(`staff-edit-emp-${id}`);
  const costEl = document.getElementById(`staff-edit-cost-${id}`);
  if (!empEl || !costEl) return;
  costEl.disabled = (normalizeEmpType(empEl.value) !== 'contractor');
}

async function saveEditStaff(id) {
  const nameEl = document.getElementById(`staff-edit-name-${id}`);
  const empEl  = document.getElementById(`staff-edit-emp-${id}`);
  const costEl = document.getElementById(`staff-edit-cost-${id}`);
  const pwEl   = document.getElementById(`staff-edit-password-${id}`);
  if (!nameEl || !empEl) return;

  const name = nameEl.value.trim();
  if (!name) return showToast('スタッフ名を入力してください', 'error');

  const list = getStaffArray();
  if (list.some(s => String(s.id) !== String(id) && s.name === name)) {
    return showToast('同じ名前のスタッフが既に登録されています', 'error');
  }

  const pwInput = pwEl ? pwEl.value.trim() : '';
  let passwordUpdate = null;
  if (pwInput) {
    if (!validateStaffPassword(pwInput)) {
      return showToast('パスワードは5桁の半角英数字で入力してください', 'error');
    }
    passwordUpdate = {
      passwordHash: await hashStaffPassword(id, pwInput),
      passwordUpdatedAt: new Date().toISOString(),
    };
  }

  const empType = normalizeEmpType(empEl.value);
  const costCategory = (empType === 'contractor') ? normalizeCostCategory(costEl ? costEl.value : '21') : '21';

  // 既存フィールド（給与単価・源泉区分・経営メモ等）は ...s で必ず保持
  const updated = list.map(s =>
    String(s.id) === String(id)
      ? { ...s, name, employmentType: empType, costCategory, ...(passwordUpdate || {}) }
      : s
  );

  const res = await callGAS('saveStaffList', { staffList: updated }).catch(() => null);
  if (res && res.status === 'ok') {
    settings.staffList = updated;
    renderStaff();
    showToast(passwordUpdate ? `${name}を更新しました（パスワード変更含む）` : `${name}を更新しました`, 'success');
  } else {
    showToast('保存失敗：' + (res && res.message || '不明なエラー'), 'error');
  }
}

async function deleteStaff(id) {
  const list = getStaffArray();
  const target = list.find(s => String(s.id) === String(id));
  if (!target) return;
  if (!confirm(`「${target.name}」を削除しますか？\n出退勤の記録済みデータには影響しません。`)) return;
  const updated = list.filter(s => String(s.id) !== String(id));
  const res = await callGAS('saveStaffList', { staffList: updated }).catch(() => null);
  if (res && res.status === 'ok') {
    settings.staffList = updated;
    renderStaff();
    showToast(`${target.name}を削除しました`, 'success');
  } else {
    showToast('削除失敗：' + (res && res.message || '不明なエラー'), 'error');
  }
}

function bindStaffAdd() {
  const btn       = document.getElementById('staff-add-btn');
  const nameInput = document.getElementById('staff-add-name');
  const empSelect = document.getElementById('staff-add-emp');
  const costSelect= document.getElementById('staff-add-cost');
  const pwInput   = document.getElementById('staff-add-password');
  if (!btn || !nameInput) return;

  if (empSelect && costSelect) {
    empSelect.addEventListener('change', () => {
      costSelect.disabled = (normalizeEmpType(empSelect.value) !== 'contractor');
    });
  }

  const doAdd = async () => {
    const name = nameInput.value.trim();
    if (!name) return showToast('スタッフ名を入力してください', 'error');

    const password = pwInput ? pwInput.value.trim() : '';
    if (!validateStaffPassword(password)) {
      return showToast('パスワードは5桁の半角英数字で入力してください', 'error');
    }

    const list = getStaffArray();
    if (list.some(s => s.name === name)) {
      return showToast('同じ名前のスタッフが既に登録されています', 'error');
    }

    const maxId = list.length > 0 ? Math.max(...list.map(s => Number(s.id) || 0)) : 0;
    const newId = maxId + 1;
    const empType = normalizeEmpType(empSelect ? empSelect.value : '');
    const costCategory = (empType === 'contractor') ? normalizeCostCategory(costSelect ? costSelect.value : '21') : '21';
    const passwordHash = await hashStaffPassword(newId, password);

    // 給与単価・源泉区分は出勤管理で設定する領域。新規追加時は既定値で初期化
    const updated = [...list, {
      id: newId, name, employmentType: empType, costCategory,
      withholdingMode: 'off', hourlyWage: 0, dailyWage: 0, monthlyWage: 0, managerMemo: '',
      passwordHash, passwordUpdatedAt: new Date().toISOString(),
    }];

    btn.disabled = true;
    const res = await callGAS('saveStaffList', { staffList: updated }).catch(() => null);
    btn.disabled = false;
    if (res && res.status === 'ok') {
      settings.staffList = updated;
      nameInput.value = '';
      if (empSelect) empSelect.value = 'employed_full';
      if (costSelect) { costSelect.value = '21'; costSelect.disabled = true; }
      if (pwInput) pwInput.value = '';
      renderStaff();
      showToast(`${name}を追加しました`, 'success');
    } else {
      showToast('追加失敗：' + (res && res.message || '不明なエラー'), 'error');
    }
  };

  btn.addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  if (pwInput) pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
}
