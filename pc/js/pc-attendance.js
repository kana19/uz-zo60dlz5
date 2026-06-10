/* ==========================================
   PC版 出勤管理画面 (pc-attendance.js)
   A-2-Y v2: キングExcel準拠 1テーブル統合
   横軸＝スタッフ  縦軸＝日付1-31 → 給与計算行
   ========================================== */
'use strict';

(function () {

  /* ---------- 定数 ---------- */
  const EMPLOYMENT_LABELS = {
    employed_full: '常勤雇用', employed_part: '臨時バイト',
    employed: '常勤雇用', contractor: '委託・外注'
  };
  const WH_LABELS = { off: '対象外', standard: '一般報酬', hostess: 'ホステス特例' };
  const PAY_TYPE_OPTIONS = [
    { value: 'hourly', label: '時給' },
    { value: 'daily', label: '日給' },
    { value: 'monthly', label: '月給' }
  ];
  const WH_OPTIONS = [
    { value: 'off', label: '対象外' },
    { value: 'standard', label: '一般' },
    { value: 'hostess', label: 'ホステス' }
  ];
  const PAYROLL_CODES = ['20', '21', '25'];

  /* ---------- 状態 ---------- */
  let _staffList = [];
  let _attendanceRecords = [];
  let _costRows = [];
  let _currentMonth = _todayMonth();
  let _confirmedStaffIds = new Set();
  let _payrollState = {};
  let _confirmTarget = null;

  /* ---------- 初期化 ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    if (typeof pcBootstrap === 'function') pcBootstrap('pc-attendance.html', '出勤管理');
    _bindMonthNav();
    _bindFilter();
    _bindConfirmDialog();
    _bindBulkConfirm();
    _bindMemoSave();
    await _loadAll();
  });

  async function _loadAll() {
    try {
      const settings = await _callGAS('getSettings');
      _staffList = (settings.staffList || []).map(_normalizeStaff);
      await _loadMonth();
    } catch (e) {
      console.error('init error:', e);
    }
  }

  async function _loadMonth() {
    try {
      const [attRes, histRes] = await Promise.all([
        _callGAS('getAttendanceByMonth', { month: _currentMonth }),
        _callGAS('getHistory', { month: _currentMonth })
      ]);
      _attendanceRecords = Array.isArray(attRes) ? attRes : (attRes.records || attRes.data || []);
      const histArr = Array.isArray(histRes) ? histRes : (histRes.data || []);
      _costRows = histArr.filter(r => r.type === 'cost');
    } catch (e) {
      console.error('loadMonth error:', e);
      _attendanceRecords = [];
      _costRows = [];
    }
    _buildPayrollState();
    _renderTable();
    _updateMonthLabel();
  }

  /* ==========================================
     1テーブル統合レンダリング
     ========================================== */

  function _buildCostAmountMap() {
    const map = {};
    (_costRows || []).forEach(r => {
      if (!PAYROLL_CODES.includes(String(r.itemCode || ''))) return;
      const misc = String(r.miscItemName || '');
      const staffName = misc.replace(/^\[月次\]/, '').trim();
      if (!staffName) return;
      const key = r.date + '|' + staffName;
      map[key] = (map[key] || 0) + (Number(r.amount) || 0);
    });
    return map;
  }

  function _renderTable() {
    const filter = document.getElementById('staffFilter').value;
    const staff = _getFilteredStaff(filter);
    const daysInMonth = _getDaysInMonth(_currentMonth);
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');
    const costMap = _buildCostAmountMap();

    if (staff.length === 0) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td style="padding:40px;color:var(--uz-text-muted);">スタッフなし</td></tr>';
      return;
    }

    // ===== ヘッダー =====
    const catCols = _getCatColumns(staff);
    thead.innerHTML = '<tr><th class="att-row-label"></th>' +
      staff.map(s => {
        const et = EMPLOYMENT_LABELS[_normalizeEmploymentType(s.employmentType)] || '';
        return `<th>${_escHtml(s.name)}<span class="att-th-sub">${et}</span></th>`;
      }).join('') +
      catCols.map(c => `<th style="color:var(--uz-gold);font-size:10px;">${c.label}</th>`).join('') +
      '</tr>';

    let html = '';

    // ===== 日付行（1〜daysInMonth） =====
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = _currentMonth + '-' + String(d).padStart(2, '0');
      html += `<tr><td class="att-row-label">${d}</td>`;

      staff.forEach(s => {
        const dayRecs = _attendanceRecords.filter(r => r.staffId === s.id && r.date === dateStr);
        if (dayRecs.length === 0) {
          html += `<td class="att-day-cell" data-staff="${_escHtml(s.id)}" data-date="${dateStr}"></td>`;
        } else {
          const clockRecs = dayRecs.filter(r => r.clockIn);
          const moneyRecs = dayRecs.filter(r => !r.clockIn);
          let parts = [];
          let hasProject = false;

          clockRecs.forEach(r => {
            const isPending = !r.clockOut;
            parts.push(`<div class="${isPending ? 'att-pending-line' : ''}">${_escHtml(r.clockIn + '〜' + (r.clockOut || ''))}</div>`);
            if (r.projectId) hasProject = true;
          });
          moneyRecs.forEach(r => {
            if (r.projectId) hasProject = true;
            const costKey = dateStr + '|' + (r.staffName || s.name);
            const amount = costMap[costKey] || 0;
            parts.push(`<div class="att-money-line">${amount > 0 ? '★ ' + _fmtAmountShort(amount) : '★'}</div>`);
          });

          const hasPending = clockRecs.some(r => !r.clockOut);
          const moneyOnly = clockRecs.length === 0 && moneyRecs.length > 0;
          let cls = 'att-day-cell att-day-cell--active';
          if (hasPending) cls += ' att-day-cell--pending';
          if (moneyOnly) cls += ' att-day-cell--money-only';
          if (hasProject) cls += ' att-day-cell--project';

          html += `<td class="${cls}" data-staff="${_escHtml(s.id)}" data-date="${dateStr}">${parts.join('')}</td>`;
        }
      });
      // 科目列は日付行では空
      catCols.forEach(() => { html += '<td></td>'; });
      html += '</tr>';
    }

    // ===== 区切り行 =====
    html += `<tr class="att-sep-row"><td colspan="${1 + staff.length + catCols.length}"></td></tr>`;

    // ===== 給与計算行 =====
    const calcRows = [
      { key: 'hours', label: '実稼働時間' },
      { key: 'days', label: '出勤日数' },
      { key: 'blank1', label: '' },
      { key: 'unitPrice', label: '単価' },
      { key: 'payType', label: '' },
      { key: 'gross', label: '算出金額' },
      { key: 'adjustment', label: '調整額' },
      { key: 'adjustmentMemo', label: '' },
      { key: 'adjustedTotal', label: '調整後金額' },
      { key: 'whMode', label: '源泉徴収' },
      { key: 'whAmount', label: '' },
      { key: 'net', label: '差引金額' },
      { key: 'blank2', label: '' },
      { key: 'status', label: 'ステータス' },
      { key: 'action', label: '' }
    ];

    // 科目別合計の集計
    const catSums = {};
    catCols.forEach(c => { catSums[c.code] = { gross: 0, wh: 0, net: 0 }; });
    staff.forEach(s => {
      const st = _payrollState[s.id] || {};
      const code = _getStaffCostCode(s);
      if (catSums[code]) {
        catSums[code].gross += (st.gross || 0) + (st.adjustment || 0);
        catSums[code].wh += st.whAmount || 0;
        catSums[code].net += st.net || 0;
      }
    });

    calcRows.forEach(row => {
      html += `<tr><td class="att-row-label">${row.label}</td>`;

      staff.forEach(s => {
        const sid = _escHtml(s.id);
        const st = _payrollState[s.id] || {};

        switch (row.key) {
          case 'hours':
            html += `<td class="att-calc-cell att-calc-cell--editable" data-staff="${sid}" data-field="hours">${(st.hours || 0).toFixed(1)}${st.excludedProject > 0 ? ' <span class="att-exclude-note">(-' + st.excludedProject + '件)</span>' : ''}</td>`;
            break;
          case 'days':
            html += `<td class="att-calc-cell att-calc-cell--editable" data-staff="${sid}" data-field="days">${st.days || 0}</td>`;
            break;
          case 'blank1': case 'blank2':
            html += '<td></td>';
            break;
          case 'unitPrice':
            html += `<td class="att-calc-cell att-calc-cell--editable" data-staff="${sid}" data-field="unitPrice">${_fmtNum(st.unitPrice)}</td>`;
            break;
          case 'payType':
            html += `<td class="att-calc-cell"><select class="att-inline-select" data-staff="${sid}" data-field="payType">` +
              PAY_TYPE_OPTIONS.map(o => `<option value="${o.value}"${st.payType === o.value ? ' selected' : ''}>${o.label}</option>`).join('') +
              '</select></td>';
            break;
          case 'gross':
            html += `<td class="att-calc-cell att-calc-cell--gross att-calc-cell--editable" data-staff="${sid}" data-field="gross">${_fmtYen(st.gross)}</td>`;
            break;
          case 'adjustment':
            html += `<td class="att-calc-cell att-calc-cell--editable" data-staff="${sid}" data-field="adjustment" style="color:${(st.adjustment || 0) < 0 ? 'var(--uz-danger)' : (st.adjustment || 0) > 0 ? 'var(--uz-success)' : 'var(--uz-text-muted)'}">${(st.adjustment || 0) !== 0 ? ((st.adjustment > 0 ? '+' : '') + _fmtYen(st.adjustment)) : '—'}</td>`;
            break;
          case 'adjustmentMemo':
            html += `<td class="att-calc-cell"><input class="att-adj-memo" data-staff="${sid}" type="text" value="${_escHtml(st.adjustmentMemo || '')}" placeholder="適用"></td>`;
            break;
          case 'adjustedTotal': {
            const adjTotal = (st.gross || 0) + (st.adjustment || 0);
            html += `<td class="att-calc-cell att-calc-cell--gross">${_fmtYen(adjTotal)}</td>`;
            break;
          }
          case 'whMode':
            html += `<td class="att-calc-cell"><select class="att-inline-select" data-staff="${sid}" data-field="whMode">` +
              WH_OPTIONS.map(o => `<option value="${o.value}"${st.whMode === o.value ? ' selected' : ''}>${o.label}</option>`).join('') +
              '</select></td>';
            break;
          case 'whAmount':
            html += `<td class="att-calc-cell att-calc-cell--editable" data-staff="${sid}" data-field="whAmount">${_fmtYen(st.whAmount)}</td>`;
            break;
          case 'net':
            html += `<td class="att-calc-cell att-calc-cell--net">${_fmtYen(st.net)}</td>`;
            break;
          case 'status':
            html += `<td class="att-calc-cell" style="text-align:center;">${_renderStatusBadge(st.status)}</td>`;
            break;
          case 'action':
            html += `<td class="att-calc-cell" style="text-align:center;"><button class="att-confirm-btn" data-staff="${sid}"${st.status === 'confirmed' ? ' disabled' : ''}>${st.status === 'confirmed' ? '確定済' : '確定'}</button></td>`;
            break;
        }
      });

      // 科目別合計列
      catCols.forEach(c => {
        const cs = catSums[c.code];
        switch (row.key) {
          case 'adjustedTotal':
            html += `<td class="att-calc-cell att-calc-cell--total">${_fmtYen(cs.gross)}</td>`;
            break;
          case 'whAmount':
            html += `<td class="att-calc-cell att-calc-cell--total">${_fmtYen(cs.wh)}</td>`;
            break;
          case 'net':
            html += `<td class="att-calc-cell att-calc-cell--total">${_fmtYen(cs.net)}</td>`;
            break;
          default:
            html += '<td></td>';
        }
      });

      html += '</tr>';
    });

    tbody.innerHTML = html;

    // イベント
    _bindTableEvents();
  }

  /** 科目別の合計列定義を取得（使用中の科目のみ） */
  function _getCatColumns(staffArr) {
    const codes = new Set();
    staffArr.forEach(s => codes.add(_getStaffCostCode(s)));
    const defs = [
      { code: '20', label: '給与賃金' },
      { code: '21', label: '外注工賃' },
      { code: '25', label: '税理士報酬' }
    ];
    return defs.filter(d => codes.has(d.code));
  }

  function _getStaffCostCode(s) {
    const et = _normalizeEmploymentType(s.employmentType);
    return et === 'contractor' ? ((s.costCategory === '25') ? '25' : '21') : '20';
  }

  /* ---------- テーブルイベントバインド ---------- */
  function _bindTableEvents() {
    document.querySelectorAll('.att-day-cell').forEach(td => {
      td.addEventListener('click', e => _openDayCellPopover(e, td.dataset.staff, td.dataset.date));
    });
    document.querySelectorAll('.att-inline-select').forEach(sel => {
      sel.addEventListener('change', e => {
        const sid = e.target.dataset.staff;
        const field = e.target.dataset.field;
        const st = _payrollState[sid];
        if (!st) return;
        st[field] = e.target.value;
        if (field === 'payType') {
          const staff = _staffList.find(s => s.id === sid);
          if (staff) {
            st.unitPrice = e.target.value === 'hourly' ? (staff.hourlyWage || 0)
              : e.target.value === 'daily' ? (staff.dailyWage || 0)
              : (staff.monthlyWage || 0);
          }
          st.gross = _calcGross(st.payType, st.unitPrice, st.hours, st.days);
        }
        if (field === 'whMode') {
          const adjTotal = (st.gross || 0) + (st.adjustment || 0);
          st.whAmount = _calcWithholdingAmount(st.whMode, adjTotal, st.days);
        }
        if (field === 'payType') {
          const adjTotal = (st.gross || 0) + (st.adjustment || 0);
          st.whAmount = _calcWithholdingAmount(st.whMode, adjTotal, st.days);
        }
        st.net = (st.gross || 0) + (st.adjustment || 0) - st.whAmount;
        _renderTable();
      });
    });
    document.querySelectorAll('.att-calc-cell--editable').forEach(td => {
      td.addEventListener('click', () => _startInlineEdit(td));
    });
    document.querySelectorAll('.att-adj-memo').forEach(inp => {
      inp.addEventListener('change', e => {
        const sid = e.target.dataset.staff;
        const st = _payrollState[sid];
        if (st) st.adjustmentMemo = e.target.value;
      });
    });
    document.querySelectorAll('.att-confirm-btn').forEach(btn => {
      btn.addEventListener('click', () => _onConfirmSingle(btn.dataset.staff));
    });
  }

  function _startInlineEdit(td) {
    if (td.querySelector('.att-inline-input')) return;
    const sid = td.dataset.staff;
    const field = td.dataset.field;
    const st = _payrollState[sid];
    if (!st) return;

    const currentVal = st[field] || 0;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'att-inline-input';
    input.value = field === 'hours' ? currentVal.toFixed(1) : currentVal;
    if (field === 'hours') input.step = '0.5';

    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const finish = () => {
      const val = Number(input.value) || 0;
      st[field] = val;
      const adjTotal = (st.gross || 0) + (st.adjustment || 0);
      if (['unitPrice', 'hours', 'days'].includes(field)) {
        st.gross = _calcGross(st.payType, st.unitPrice, st.hours, st.days);
        const newAdjTotal = st.gross + (st.adjustment || 0);
        st.whAmount = _calcWithholdingAmount(st.whMode, newAdjTotal, st.days);
      }
      if (field === 'gross' || field === 'adjustment') {
        const newAdjTotal = (st.gross || 0) + (st.adjustment || 0);
        st.whAmount = _calcWithholdingAmount(st.whMode, newAdjTotal, st.days);
      }
      st.net = (st.gross || 0) + (st.adjustment || 0) - st.whAmount;
      _renderTable();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { st[field] = currentVal; _renderTable(); }
    });
  }

  /* ==========================================
     給与計算状態
     ========================================== */
  function _buildPayrollState() {
    const filter = document.getElementById('staffFilter').value;
    const staffFiltered = _getFilteredStaff(filter);
    const newState = {};

    staffFiltered.forEach(s => {
      const prev = _payrollState[s.id] || {};
      const staffAtt = _attendanceRecords.filter(r => r.staffId === s.id);
      const { totalHours, totalDays, excludedProject } = _calcStaffTotals(staffAtt);

      let payType = prev.payType || (s.hourlyWage ? 'hourly' : s.dailyWage ? 'daily' : s.monthlyWage ? 'monthly' : 'hourly');
      const unitPrice = prev.unitPrice !== undefined ? prev.unitPrice :
        (payType === 'hourly' ? (s.hourlyWage || 0) : payType === 'daily' ? (s.dailyWage || 0) : (s.monthlyWage || 0));
      const hours = prev.hours !== undefined ? prev.hours : totalHours;
      const days = prev.days !== undefined ? prev.days : totalDays;

      let gross = prev.gross !== undefined ? prev.gross : _calcGross(payType, unitPrice, hours, days);
      const adjustment = prev.adjustment !== undefined ? prev.adjustment : 0;
      const adjustedTotal = gross + adjustment;
      const whMode = prev.whMode || (s.withholdingMode || 'off');
      const whAmount = prev.whAmount !== undefined ? prev.whAmount : _calcWithholdingAmount(whMode, adjustedTotal, days);
      const net = adjustedTotal - whAmount;

      const hasMonthly = _hasMonthlyConfirmed(s.name);
      const status = prev.status || (hasMonthly ? 'confirmed' : 'pending');
      if (hasMonthly) _confirmedStaffIds.add(s.id);

      newState[s.id] = {
        payType, unitPrice, hours, days, gross, adjustment,
        adjustmentMemo: prev.adjustmentMemo || '',
        whMode, whAmount, net,
        excludedProject, status
      };
    });

    _payrollState = newState;
  }

  /* ==========================================
     確定処理
     ========================================== */
  function _onConfirmSingle(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    const st = _payrollState[staffId];
    if (!staff || !st) return;
    if (st.gross === 0) { alert('算出金額が0円です。'); return; }

    _confirmTarget = { staffId };
    _showConfirmDialog(staff, st);
  }

  function _showConfirmDialog(staff, st) {
    const et = _normalizeEmploymentType(staff.employmentType);
    const whLabel = WH_LABELS[st.whMode] || '対象外';
    let costItemCode, costItemName;
    if (et === 'contractor') {
      const cat = (staff.costCategory === '25') ? '25' : '21';
      costItemCode = cat;
      costItemName = (cat === '25') ? '税理士等の報酬' : '外注工賃';
    } else {
      costItemCode = '20'; costItemName = '給料賃金';
    }

    const adjTotal = (st.gross || 0) + (st.adjustment || 0);
    document.getElementById('confirmTitle').textContent = staff.name + ' 給与確定';
    document.getElementById('confirmBody').innerHTML =
      `<div>算出金額：${st.gross.toLocaleString()}円</div>` +
      ((st.adjustment || 0) !== 0 ? `<div>調整額：${(st.adjustment > 0 ? '+' : '') + st.adjustment.toLocaleString()}円</div><div>調整後金額：${adjTotal.toLocaleString()}円</div>` : '') +
      `<div>源泉徴収額：${st.whAmount.toLocaleString()}円（${whLabel}）</div>` +
      `<div>差引支給額：${st.net.toLocaleString()}円</div>` +
      `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);font-size:11px;">コスト追記：<strong>${costItemName}（科目${costItemCode}）</strong></div>`;

    document.getElementById('confirmDialog').style.display = '';
  }

  async function _executeConfirm() {
    document.getElementById('confirmDialog').style.display = 'none';
    if (_confirmTarget && _confirmTarget.staffId) {
      await _executeSingleConfirm(_confirmTarget.staffId);
    } else if (_confirmTarget && _confirmTarget.bulk) {
      for (const sid of _confirmTarget.staffIds) {
        await _executeSingleConfirm(sid);
      }
    }
    _confirmTarget = null;
    await _loadMonth();
  }

  async function _executeSingleConfirm(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    const st = _payrollState[staffId];
    if (!staff || !st) return;

    const et = _normalizeEmploymentType(staff.employmentType);
    const isContractor = et === 'contractor';
    let itemCode, itemName;
    if (isContractor) {
      const cat = (staff.costCategory === '25') ? '25' : '21';
      itemCode = cat; itemName = (cat === '25') ? '税理士等の報酬' : '外注工賃';
    } else {
      itemCode = '20'; itemName = '給料賃金';
    }

    const confirmAmount = (st.gross || 0) + (st.adjustment || 0);
    const confirmWh = st.whAmount;

    const [y, m] = _currentMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const costDate = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    try {
      await _callGAS('addCost', {
        date: costDate, divisionCode: '2', divisionName: '販管費',
        itemCode, itemName, miscItemName: '',
        taxRate: isContractor ? 10 : 0, taxIncluded: confirmAmount,
        memo: `${staff.name}　${y}年${m}月分${(st.adjustment || 0) !== 0 && st.adjustmentMemo ? '（調整：' + st.adjustmentMemo + '）' : ''}`,
        unpaid: 0, withholdingAmount: confirmWh,
        clientId: '', projectId: '',
        staffId: staff.id, staffName: staff.name, subType: '20a'
      });
      st.status = 'confirmed';
      _confirmedStaffIds.add(staffId);
    } catch (e) {
      console.error('confirm error:', e);
      alert(staff.name + ' の確定処理でエラーが発生しました。');
    }
  }

  function _bindBulkConfirm() {
    document.getElementById('bulkConfirmBtn').addEventListener('click', () => {
      const pending = [];
      Object.entries(_payrollState).forEach(([sid, st]) => {
        if (st.status === 'pending' && st.gross > 0) pending.push(sid);
      });
      if (pending.length === 0) { alert('確定可能なスタッフがいません。'); return; }
      const names = pending.map(sid => { const s = _staffList.find(x => x.id === sid); return s ? s.name : sid; });

      _confirmTarget = { bulk: true, staffIds: pending };
      document.getElementById('confirmTitle').textContent = '一括給与確定';
      document.getElementById('confirmBody').innerHTML =
        `<div>対象：${names.join('、')}</div>` +
        '<div style="margin-top:8px;">各スタッフの算出金額で一括確定します。</div>';
      document.getElementById('confirmDialog').style.display = '';
    });
  }

  function _bindConfirmDialog() {
    document.getElementById('confirmCancel').addEventListener('click', () => {
      document.getElementById('confirmDialog').style.display = 'none';
      _confirmTarget = null;
    });
    document.getElementById('confirmOk').addEventListener('click', _executeConfirm);
  }

  function _hasMonthlyConfirmed(staffName) {
    return (_costRows || []).some(r => {
      if (!PAYROLL_CODES.includes(String(r.itemCode || ''))) return false;
      const misc = String(r.miscItemName || '');
      return misc.startsWith('[月次]') && misc.replace(/^\[月次\]/, '').trim() === staffName;
    });
  }

  /* ---------- メモ ---------- */
  function _bindMemoSave() {
    document.getElementById('memoSave').addEventListener('click', async () => {
      // メモバーはヘッダーのスタッフ名クリックで表示する想定だが、
      // v2では1テーブルなので一旦非表示のまま（将来拡張用）
    });
  }

  /* ---------- ポップオーバー ---------- */
  let _popoverTarget = null;

  function _openDayCellPopover(event, staffId, date) {
    const pop = document.getElementById('dayCellPopover');
    const staff = _staffList.find(s => s.id === staffId);
    const records = _attendanceRecords.filter(r => r.staffId === staffId && r.date === date);
    const isNew = records.length === 0;

    document.getElementById('popoverHeader').textContent =
      `${staff ? staff.name : staffId}　${date.substring(5).replace('-', '/')}${isNew ? '（新規）' : ''}`;
    const rec = records[0] || {};
    document.getElementById('popClockIn').value = rec.clockIn || '';
    document.getElementById('popClockOut').value = rec.clockOut || '';
    document.getElementById('popMemo').value = rec.memo || '';
    _popoverTarget = { staffId, date, rowIndex: rec.rowIndex, isNew };

    const rect = event.currentTarget.getBoundingClientRect();
    pop.style.top = Math.min(rect.bottom + 4, window.innerHeight - 300) + 'px';
    pop.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
    pop.style.display = '';

    document.getElementById('popCancel').onclick = () => pop.style.display = 'none';
    document.getElementById('popSave').onclick = () => _saveDayCell(pop);
  }

  async function _saveDayCell(pop) {
    if (!_popoverTarget) return;
    const clockIn = document.getElementById('popClockIn').value;
    const clockOut = document.getElementById('popClockOut').value;
    const memo = document.getElementById('popMemo').value;

    if (!clockIn) { alert('入店時刻を入力してください。'); return; }

    try {
      if (_popoverTarget.isNew) {
        // 新規打刻追加
        await _callGAS('clockIn', {
          staffId: _popoverTarget.staffId,
          date: _popoverTarget.date,
          clockIn: clockIn,
          clockOut: clockOut || undefined,
          memo: memo || undefined
        });
      } else {
        // 既存レコード修正
        await _callGAS('updateAttendance', {
          rowIndex: _popoverTarget.rowIndex,
          staffId: _popoverTarget.staffId,
          date: _popoverTarget.date,
          clockIn, clockOut, memo
        });
      }
      pop.style.display = 'none';
      await _loadMonth();
    } catch (e) {
      console.error('save day cell error:', e);
      alert('保存に失敗しました。');
    }
  }

  document.addEventListener('click', e => {
    const pop = document.getElementById('dayCellPopover');
    if (pop.style.display !== 'none' && !pop.contains(e.target) && !e.target.closest('.att-day-cell')) {
      pop.style.display = 'none';
    }
  });

  /* ---------- ナビ・フィルター ---------- */
  function _bindMonthNav() {
    document.getElementById('prevMonth').addEventListener('click', () => {
      _currentMonth = _shiftMonth(_currentMonth, -1);
      _payrollState = {}; _confirmedStaffIds.clear();
      _loadMonth();
    });
    document.getElementById('nextMonth').addEventListener('click', () => {
      _currentMonth = _shiftMonth(_currentMonth, 1);
      _payrollState = {}; _confirmedStaffIds.clear();
      _loadMonth();
    });
  }

  function _bindFilter() {
    document.getElementById('staffFilter').addEventListener('change', () => {
      _buildPayrollState();
      _renderTable();
    });
  }

  /* ==========================================
     ユーティリティ
     ========================================== */
  function _getFilteredStaff(filter) {
    return filter === 'all' ? _staffList : _staffList.filter(s => _normalizeEmploymentType(s.employmentType) === filter);
  }
  function _normalizeStaff(s) {
    return { ...s, employmentType: _normalizeEmploymentType(s.employmentType), withholdingMode: s.withholdingMode || 'off', costCategory: (s.costCategory === '25') ? '25' : '21', hourlyWage: Number(s.hourlyWage) || 0, dailyWage: Number(s.dailyWage) || 0, monthlyWage: Number(s.monthlyWage) || 0, managerMemo: s.managerMemo || '' };
  }
  function _normalizeEmploymentType(et) { return et === 'employed' ? 'employed_full' : (et || 'employed_full'); }

  function _calcHours(clockIn, clockOut, dateIn, dateOut) {
    if (!clockIn || !clockOut) return 0;
    const [h1, m1] = clockIn.split(':').map(Number);
    const [h2, m2] = clockOut.split(':').map(Number);
    let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (dateOut && dateOut !== dateIn) mins += 24 * 60;
    else if (mins < 0) mins += 24 * 60;
    return Math.max(0, mins / 60);
  }
  function _calcStaffTotals(records) {
    let totalHours = 0; const uniqueDates = new Set(); let excludedProject = 0;
    records.forEach(r => {
      if (r.projectId) { excludedProject++; return; }
      if (r.clockIn && r.clockOut) totalHours += _calcHours(r.clockIn, r.clockOut, r.date, r.clockOutDate);
      if (r.clockIn) uniqueDates.add(r.date);
    });
    return { totalHours: Math.round(totalHours * 10) / 10, totalDays: uniqueDates.size, excludedProject };
  }
  function _calcGross(payType, unitPrice, hours, days) {
    if (payType === 'hourly') return Math.floor(unitPrice * hours);
    if (payType === 'daily') return Math.floor(unitPrice * days);
    return unitPrice;
  }
  function _calcWithholdingAmount(whMode, amount, days) {
    if (whMode === 'hostess') { const base = amount - 5000 * days; return base > 0 ? Math.floor(base * 0.1021) : 0; }
    if (whMode === 'standard') { return amount <= 1000000 ? Math.floor(amount * 0.1021) : Math.floor(1000000 * 0.1021 + (amount - 1000000) * 0.2042); }
    return 0;
  }
  function _renderStatusBadge(status) {
    if (status === 'confirmed') return '<span class="att-status-badge att-status-badge--confirmed">確定済</span>';
    if (status === 'skipped') return '<span class="att-status-badge att-status-badge--skipped">スキップ</span>';
    return '<span class="att-status-badge att-status-badge--pending">未確定</span>';
  }
  function _fmtNum(n) { return (n || 0).toLocaleString(); }
  function _fmtYen(n) { return (n || 0).toLocaleString() + '円'; }
  function _fmtAmountShort(amount) {
    if (amount >= 10000) return '¥' + (amount / 10000).toFixed(amount % 10000 === 0 ? 0 : 1) + '万';
    if (amount >= 1000) return '¥' + (amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1) + '千';
    return '¥' + amount.toLocaleString();
  }
  function _getDaysInMonth(ms) { const [y, m] = ms.split('-').map(Number); return new Date(y, m, 0).getDate(); }
  function _todayMonth() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function _shiftMonth(ms, delta) { const [y, m] = ms.split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function _updateMonthLabel() { const [y, m] = _currentMonth.split('-').map(Number); document.getElementById('monthLabel').textContent = `${y}年${m}月`; }
  function _escHtml(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

  async function _callGAS(action, data) {
    if (typeof callGAS === 'function') {
      const res = await callGAS(action, data || {});
      if (res && res.status === 'ok' && res.data !== undefined) return res.data;
      return res;
    }
    const gasUrl = window.GAS_URL || '';
    if (!gasUrl) throw new Error('GAS_URL not set');
    const url = gasUrl + '?action=' + action + '&data=' + encodeURIComponent(JSON.stringify(data || {}));
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.status !== 'ok') throw new Error(json.message || 'GAS error');
    return json.data || json;
  }

})();
