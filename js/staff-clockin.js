/**
 * staff-clockin.js v3 — スタッフ専用タイムカードPWA
 * v4: ボタンラベル統一（再表示廃止・0〜23時対応・日跨ぎ自動判定）
 * v5: localStorage で staffId 保持（PWAホーム画面起動時のゼロタップ対応）
 * v6: 確定仕様反映（02_画面仕様.md §4-4/§4-6）
 *     - 本人専用：同僚の在席（今日の出勤状況）は表示しない
 *     - 段2 QR現地証明：出勤時に in-appカメラ（getUserMedia + BarcodeDetector）で
 *       店舗QRを読取り 拠点NN を clockIn に送信（J列 qrLocation）。
 *       OS標準カメラ経由（?qr=）も解析。読取不可・非対応時は📍なしで打刻（非ブロッキング）。
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwBDHj9-p6ZT6ExXrxF1Q-XwiEkNMPwDc0aAuk7zptivRhWhepvaCDsjaIJd7WHh_h9-A/exec';
const WD = ['日','月','火','水','木','金','土'];
const STAFF_ID_KEY = 'uz_staff_id';

let state = {
  staffId:'', staffName:'', storeName:'', employmentType:'employed_full',
  myRecord:null, myMonthly:[],
  urlQr:'', qrProofEnabled:false,
  isPunching:false, isEditingTime:false, editHour:0, editMin:0,
};

async function callGAS(action, data={}) {
  const url = `${GAS_URL}?action=${encodeURIComponent(action)}&data=${encodeURIComponent(JSON.stringify(data))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP '+res.status);
  const json = await res.json();
  if (json && json.status==='ok') return json.data ?? json;
  throw new Error(json?.message || 'GAS エラー');
}

document.addEventListener('DOMContentLoaded', async () => {
  startClock();

  const params = new URLSearchParams(location.search);
  // 段2：店舗QR（OS標準カメラ経由）の qr トークン {clientId}-{拠点NN}
  state.urlQr = params.get('qr') || '';

  // 1. URLパラメータから取得試行（初回・オーナーから共有URL）
  let staffId = params.get('staff') || '';

  // 2. URLになければ localStorage から復元（PWAホーム画面起動）
  if (!staffId) {
    try { staffId = localStorage.getItem(STAFF_ID_KEY) || ''; } catch(e) {}
  }

  if (!staffId) {
    showError('URLが正しくありません','staff=スタッフIDパラメータが必要です。\nオーナーから共有されたURLを使用してください。');
    return;
  }

  state.staffId = staffId;

  try {
    const v = await callGAS('validateStaff', { staffId, qr: state.urlQr });
    if (!v || !v.valid) {
      // 無効な staffId は localStorage からも削除（古い端末等の救済）
      try { localStorage.removeItem(STAFF_ID_KEY); } catch(e) {}
      showError('スタッフが見つかりません',`スタッフID「${staffId}」は登録されていません。\nオーナーに確認してください。`);
      return;
    }

    // 3. 有効が確認できた段階で localStorage に保存（2回目以降のゼロタップ起動用）
    try { localStorage.setItem(STAFF_ID_KEY, staffId); } catch(e) {}

    state.staffName  = v.staffName;
    state.storeName  = v.storeName;
    document.getElementById('header-store').textContent = state.storeName || 'ULTRA ZAIMU';
    document.getElementById('header-name').textContent  = state.staffName;

    // 設定を一度だけ取得して employmentType と段2フラグ（qrProofEnabled）をキャッシュ
    try {
      const settings = await callGAS('getSettings', {});
      const me = (settings.staffList||[]).find(s=>s.id===state.staffId);
      if (me && me.employmentType) state.employmentType = me.employmentType;
      const fv = settings.featureVisibility || {};
      state.qrProofEnabled = !!fv.qrProofEnabled;
    } catch(e) { /* 設定取得失敗時も打刻は継続（段1相当で続行） */ }

    hideLoading();
    await loadAttendanceData();
  } catch(e) { showError('接続エラー','通信に失敗しました。\nWi-Fiや電波状況を確認してください。\n\n'+e.message); }
});

function startClock() {
  function tick() {
    const now=new Date(), hh=String(now.getHours()).padStart(2,'0'), mm=String(now.getMinutes()).padStart(2,'0'), ts=`${hh}:${mm}`;
    const ht=document.getElementById('header-time'); if(ht) ht.textContent=ts;
    const hd=document.getElementById('header-date'); if(hd) hd.textContent=`${now.getMonth()+1}/${now.getDate()}（${WD[now.getDay()]}）`;
    if(!state.isEditingTime){ const pt=document.getElementById('punch-current-time'); if(pt) pt.textContent=ts; }
  }
  tick(); setInterval(tick,10000);
}

async function loadAttendanceData() {
  const today=todayStr();
  const result=await callGAS('getAttendanceForStaff',{staffId:state.staffId,month:today.substring(0,7)});
  state.myRecord=result.myRecord||null; state.myMonthly=result.myMonthly||[];
  renderAll();
}
function renderAll() { renderPunchArea(); renderMonthly(); }

function renderPunchArea() {
  const rec=state.myRecord, area=document.getElementById('punch-area');
  const isActive=rec&&rec.isActive, isDone=rec&&!rec.isActive;
  const badgeClass=isActive?'active':'inactive';
  const badgeText=isActive?'出勤中':'未出勤';
  const btnClass=isActive?'clockout-btn':'clockin-btn';
  const btnIcon=isActive?'🔴':'🟢';
  const btnLabel=isActive?'退勤':'出勤';
  // 段2かつ未出勤（次の打刻が出勤）のとき📍バッジを添える
  const pinBadge=(state.qrProofEnabled && !isActive)?'<span class="qr-pin-badge">📍現地</span>':'';
  const subInfo=isActive
    ?`<div class="ci-info">出勤：<span class="ci-time">${rec.clockIn}</span>${rec.qrLocation?` <span class="ci-pin">📍${esc(rec.qrLocation)}</span>`:''}</div>`
    :isDone?`<div class="prev-record">直前：${rec.clockIn} 〜 ${rec.clockOut||'--:--'}</div>`:'';

  area.innerHTML=`
    <div class="status-badge ${badgeClass}"><span class="status-dot"></span><span>${badgeText}</span></div>
    ${subInfo}
    <div class="current-time-display" id="current-time-block">
      <div class="current-time-big" id="punch-current-time">--:--</div>
      <div class="current-time-label">現在時刻</div>
    </div>
    <button class="punch-btn ${btnClass}" id="punch-btn" onclick="onPunchTap()">
      <span class="punch-btn-icon">${btnIcon}</span>
      <span class="punch-btn-label">${btnLabel}</span>
    </button>
    ${pinBadge}
    <button class="time-edit-trigger" id="time-edit-trigger" onclick="openTimeEdit()">🕐 時刻を変更して${btnLabel}</button>
    <div class="time-edit-panel" id="time-edit-panel" style="display:none">
      <div class="time-edit-title">時刻を入力</div>
      <div class="time-spinner-row">
        <div class="time-spinner-col">
          <button class="spin-btn" onclick="adjustTime('h',1)">▲</button>
          <div class="spin-val" id="edit-hh">00</div>
          <button class="spin-btn" onclick="adjustTime('h',-1)">▼</button>
        </div>
        <div class="time-colon">:</div>
        <div class="time-spinner-col">
          <button class="spin-btn" onclick="adjustTime('m',15)">▲</button>
          <div class="spin-val" id="edit-mm">00</div>
          <button class="spin-btn" onclick="adjustTime('m',-15)">▼</button>
        </div>
      </div>
      <div class="time-edit-hint">時間±1・分±15分</div>
      <div class="time-edit-actions">
        <button class="time-cancel-btn" onclick="closeTimeEdit()">キャンセル</button>
        <button class="time-confirm-btn" onclick="onPunchWithEditedTime()">この時刻で${btnLabel}</button>
      </div>
    </div>`;

  const now=new Date(), pt=document.getElementById('punch-current-time');
  if(pt) pt.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

function openTimeEdit() {
  const now=new Date();
  state.editHour=now.getHours(); state.editMin=Math.floor(now.getMinutes()/5)*5; state.isEditingTime=true;
  document.getElementById('time-edit-panel').style.display='';
  document.getElementById('time-edit-trigger').style.display='none';
  document.getElementById('current-time-block').style.display='none';
  document.getElementById('punch-btn').style.display='none';
  updateSpinner();
}
function closeTimeEdit() {
  state.isEditingTime=false;
  document.getElementById('time-edit-panel').style.display='none';
  document.getElementById('time-edit-trigger').style.display='';
  document.getElementById('current-time-block').style.display='';
  document.getElementById('punch-btn').style.display='';
}
function adjustTime(unit,delta) {
  if(unit==='h') state.editHour=(state.editHour+delta+24)%24;
  else state.editMin=(state.editMin+delta+60)%60;
  updateSpinner();
}
function updateSpinner() {
  document.getElementById('edit-hh').textContent=String(state.editHour).padStart(2,'0');
  document.getElementById('edit-mm').textContent=String(state.editMin).padStart(2,'0');
}

async function onPunchTap() {
  if(state.isPunching) return;
  const now=new Date();
  await executePunch(`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);
}
async function onPunchWithEditedTime() {
  if(state.isPunching) return;
  closeTimeEdit();
  await executePunch(`${String(state.editHour).padStart(2,'0')}:${String(state.editMin).padStart(2,'0')}`);
}

async function executePunch(time) {
  if(state.isPunching) return;
  state.isPunching=true;
  const rec=state.myRecord, date=todayStr();
  try {
    if(rec&&rec.isActive) {
      // 退勤：QRは取らない（誤打刻防止のワンタップ確認は出勤ボタン側の運用で担保）
      const btn=document.getElementById('punch-btn'); if(btn) btn.classList.add('punching');
      await callGAS('clockOut',{staffId:state.staffId,rowIndex:rec.rowIndex,clockOutTime:time});
      state.myRecord={...rec,clockOut:time,isActive:false};
      showBanner(`退勤しました（${time}）`);
    } else {
      // 出勤：段2なら in-appカメラで店舗QRを読取り 拠点トークンを取得（非ブロッキング）
      const qr = await acquireQr();
      const btn=document.getElementById('punch-btn'); if(btn) btn.classList.add('punching');
      const result=await callGAS('clockIn',{staffId:state.staffId,staffName:state.staffName,employmentType:state.employmentType,date,clockInTime:time,qr});
      const loc = result && result.qrLocation ? String(result.qrLocation) : '';
      state.myRecord={rowIndex:result.rowIndex||0,date,clockIn:time,clockOut:null,isActive:true,qrLocation:loc};
      showBanner(`出勤しました（${time}）${loc?` 📍${loc}`:''}`);
    }
    await loadAttendanceData();
  } catch(e) {
    showBanner('⚠️ 通信エラー。もう一度試してください。');
    console.error(e);
  } finally {
    setTimeout(()=>{ const b=document.getElementById('punch-btn'); if(b) b.classList.remove('punching'); state.isPunching=false; },500);
  }
}

/* ══════════════════════════════════════════════════════════
   QR現地証明（段2・→ 02_画面仕様.md §4-6）
   非ブロッキング：読取不可・非対応・スキップ時は '' を返し打刻を止めない。
   ══════════════════════════════════════════════════════════ */

// 出勤時の拠点トークンを取得する。優先順：OS標準カメラ経由(?qr=) → in-appカメラ → なし。
async function acquireQr() {
  if (state.urlQr) return state.urlQr;                 // 店舗QRをOS標準カメラで読みアプリ起動
  if (state.qrProofEnabled) return await scanQrInApp(); // 段2：アプリ内カメラ
  return '';                                            // 段1：QRなし運用
}

// QRの生値（フルURL または トークン）から qr トークン {clientId}-{拠点NN} を取り出す。
function parseQrToken(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  try { const u = new URL(s); const q = u.searchParams.get('qr'); if (q) return q; } catch(e) {}
  const m = s.match(/[?&]qr=([^&]+)/); if (m) return decodeURIComponent(m[1]);
  return s;                                             // 例：'ultra-z-leo-01'（トークン直書きQR）
}

let _qrStream = null;
async function scanQrInApp() {
  if (!('BarcodeDetector' in window)) return '';        // iOS Safari 等は非対応→📍なしで続行
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch(e) { return ''; }                              // 権限拒否・カメラ無→非ブロッキング
  _qrStream = stream;
  const overlay = document.getElementById('qr-overlay');
  const video   = document.getElementById('qr-video');
  if (overlay) overlay.classList.add('show');
  video.srcObject = stream;
  await video.play().catch(()=>{});

  let detector;
  try { detector = new BarcodeDetector({ formats: ['qr_code'] }); }
  catch(e) { stopQrScan(); return ''; }

  return await new Promise(resolve => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; clearTimeout(timer); stopQrScan(); resolve(val); };
    const cancel = document.getElementById('qr-cancel');
    if (cancel) cancel.onclick = () => finish('');       // 「QRなしで打刻」
    const timer = setTimeout(() => finish(''), 60000);   // 60秒で諦め（非ブロッキング）
    const loop = async () => {
      if (done) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) { finish(parseQrToken(codes[0].rawValue)); return; }
      } catch(e) {}
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

function stopQrScan() {
  const overlay = document.getElementById('qr-overlay'); if (overlay) overlay.classList.remove('show');
  const video   = document.getElementById('qr-video');   if (video) video.srcObject = null;
  if (_qrStream) { _qrStream.getTracks().forEach(t=>t.stop()); _qrStream = null; }
}

function renderMonthly() {
  const list=document.getElementById('monthly-list'), count=document.getElementById('monthly-count');
  const mo=parseInt(todayStr().substring(5,7),10);
  document.getElementById('monthly-title-text').textContent=`${mo}月の記録`;
  count.textContent=`${state.myMonthly.length}件`;
  if(!state.myMonthly.length){ list.innerHTML='<div class="monthly-empty">記録がありません</div>'; return; }
  list.innerHTML=state.myMonthly.map(r=>{
    const d=new Date(r.date+'T00:00:00');
    const coTxt=r.clockOut?r.clockOut:`<span style="color:var(--green)">出勤中</span>`;
    const pin=r.qrLocation?` <span class="ci-pin">📍${esc(r.qrLocation)}</span>`:'';
    return `<div class="monthly-row">
      <div class="monthly-date-col"><div class="monthly-date-day">${d.getDate()}</div><div class="monthly-date-wd">${WD[d.getDay()]}</div></div>
      <div class="monthly-times">
        <div class="monthly-time-row">${r.clockIn||'--:--'}<span class="sep">〜</span>${coTxt}${pin}</div>
        ${r.isActive?`<div class="monthly-time-active">● 出勤中</div>`:''}
      </div>
      <div class="monthly-duration">${r.workMinutes?fmtMin(r.workMinutes):''}</div>
    </div>`;
  }).join('');
}

function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtMin(min){ const h=Math.floor(min/60),m=min%60; return h===0?`${m}分`:`${h}h${m>0?m+'m':''}`; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showBanner(msg){ const el=document.getElementById('banner'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3500); }
function hideLoading(){ const el=document.getElementById('loading-screen'); el.classList.add('hidden'); setTimeout(()=>el.style.display='none',400); document.getElementById('main-screen').classList.add('show'); }
function showError(title,msg){ document.getElementById('loading-screen').classList.add('hidden'); document.getElementById('error-title').textContent=title; document.getElementById('error-msg').textContent=msg; document.getElementById('error-screen').classList.add('show'); }
