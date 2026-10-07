const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const state = { user:null, page:'dashboard', submissions:[], affiliates:[], accountingMonths:[], availableMonths:[], selectedMonth:null };

const api = async (url, options={}) => {
  const headers = {...(options.headers||{})};
  try {
    const sessionToken = localStorage.getItem('pickr-session-token');
    if (sessionToken && !headers.Authorization) headers.Authorization = `Bearer ${sessionToken}`;
  } catch {}
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type']='application/json';
  const res = await fetch(url, { ...options, headers, credentials: 'include' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
};

async function downloadAttachment(url, fileName) {
  const headers = {};
  try {
    const sessionToken = localStorage.getItem('pickr-session-token');
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  } catch {}
  const response = await fetch(url, { headers, credentials: 'include' });
  if (!response.ok) {
    let message = 'Unable to download this file.';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName || 'proof-file';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function toast(message, error=false){
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${error?' error':''}`;
  setTimeout(()=> el.className='toast', 2600);
}

function esc(v='') { return String(v).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function fmtDate(v){ if(!v)return '—'; const d=new Date(v); return Number.isNaN(d.getTime())?esc(v):d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
function fmtDateTime(v){ if(!v)return '—'; return new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
function monthLabel(value){
  const match=String(value||'').match(/^(\d{4})-(\d{2})$/);
  if(!match) return value||'—';
  return new Date(Number(match[1]),Number(match[2])-1,1).toLocaleDateString(undefined,{month:'long',year:'numeric'});
}
async function loadAccountingMonths(){
  const data=await api('/api/accounting/months');
  state.accountingMonths=data.periods||[];
  state.availableMonths=data.availableMonths||[];
  if(!state.selectedMonth || !state.accountingMonths.some(item=>item.month===state.selectedMonth)) {
    state.selectedMonth=data.defaultMonth || state.availableMonths[0]?.month || state.accountingMonths[0]?.month;
  }
  return data;
}
function statusLabel(s){ return ({needs_review:'Needs review',pending:'Pending',approved:'Approved',rejected:'Rejected'})[s] || s; }
function statusPill(s){ return `<span class="status status-${esc(s)}">${esc(statusLabel(s))}</span>`; }
function fmtBytes(n){ const v=Number(n||0); if(v<1024)return `${v} B`; if(v<1048576)return `${(v/1024).toFixed(1)} KB`; return `${(v/1048576).toFixed(1)} MB`; }
function submissionUser(s){ return s.pickrUsername || s.externalUserId || '—'; }

function relTime(v){
  if(!v) return '—';
  const then=new Date(v).getTime(); if(Number.isNaN(then)) return esc(v);
  const diff=Date.now()-then, m=Math.round(diff/6e4), h=Math.round(diff/36e5), d=Math.round(diff/864e5);
  if(diff<45e3) return 'just now';
  if(m<60) return `${m}m ago`;
  if(h<24) return `${h}h ago`;
  if(d<30) return `${d}d ago`;
  return fmtDate(v);
}

const STATUS_TONES = { approved:'#16875b', pending:'#b26c00', needs_review:'#4f6df5', rejected:'#c63b4a' };

// Pure SVG donut chart — animated on mount, no libraries.
function donutChart(segments, centerValue, centerLabel){
  const R=62, C=2*Math.PI*R, total=segments.reduce((s,x)=>s+x.value,0)||1;
  let offset=0;
  const arcs=segments.filter(s=>s.value>0).map(s=>{
    const len=(s.value/total)*C, dash=`${len} ${C-len}`, dashoffset=-offset;
    offset+=len;
    return `<circle class="donut-seg" r="${R}" cx="75" cy="75" stroke="${s.color}" stroke-dasharray="${dash}" style="stroke-dashoffset:${C}"><animate attributeName="stroke-dashoffset" from="${C}" to="${dashoffset}" dur="1.1s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1"/></circle>`;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 150 150"><circle class="donut-track" r="${R}" cx="75" cy="75"/>${arcs}</svg><div class="donut-center"><b class="count-up" data-count="${centerValue}">0</b><span>${esc(centerLabel)}</span></div></div>`;
}

// 14-day submission trend from raw rows.
function trendBars(rows){
  const days=[]; const today=new Date(); today.setHours(0,0,0,0);
  for(let i=13;i>=0;i--){ const d=new Date(today); d.setDate(d.getDate()-i); days.push({d,count:0}); }
  rows.forEach(r=>{ const t=new Date(r.createdAt); t.setHours(0,0,0,0); const day=days.find(x=>x.d.getTime()===t.getTime()); if(day) day.count++; });
  const max=Math.max(1,...days.map(x=>x.count));
  const bars=days.map(x=>{ const h=Math.round((x.count/max)*100); const label=x.d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); return `<div class="bar" style="height:${Math.max(3,h)}%"><em>${x.count} on ${esc(label)}</em></div>`; }).join('');
  const first=days[0].d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const last=days[days.length-1].d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  return {html:`<div class="trend">${bars}</div><div class="trend-axis"><span>${esc(first)}</span><span>Last 14 days</span><span>${esc(last)}</span></div>`, total:days.reduce((s,x)=>s+x.count,0)};
}

// Animate every [data-count] number from 0 to its target.
function runCounters(root=document){
  $$('[data-count]',root).forEach(el=>{
    const target=Number(el.dataset.count)||0; if(target===0){ el.textContent='0'; return; }
    const start=performance.now(), dur=750;
    const tick=t=>{ const p=Math.min(1,(t-start)/dur); const eased=1-Math.pow(1-p,3); el.textContent=Math.round(eased*target).toLocaleString(); if(p<1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

function setTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  try{ localStorage.setItem('pickr-theme',theme); }catch{}
}
function initTheme(){
  const btn=$('#themeToggle'); if(!btn) return;
  btn.onclick=()=>{
    const next=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
    setTheme(next); toast(`${next==='dark'?'Dark':'Light'} theme on`);
  };
}

function skeleton(){
  return `<div class="sk-grid">${Array.from({length:4}).map(()=>'<div class="sk-card"></div>').join('')}</div><div class="panel"><div class="panel-body">${Array.from({length:5}).map(()=>'<div class="sk-line" style="margin:14px 0;width:'+(60+Math.random()*35)+'%"></div>').join('')}</div></div>`;
}

function navItems(){
  if (state.user.role === 'admin') {
    return [
      ['MAIN'],['dashboard','▦','Dashboard'],['submissions','☷','All submissions'],['commissions','💰','Commission payouts'],['months','◫','Monthly close'],['affiliates','◎','Affiliates'],['audit','↻','Activity log']
    ];
  } else if (state.user.role === 'account_manager') {
    return [
      ['MAIN'],['dashboard','▦','Dashboard'],['submit','＋','Submit new user'],['submissions','☷','Team submissions'],['commissions','💰','Commissions']
    ];
  } else if (state.user.role === 'commission_worker') {
    return [
      ['MAIN'],['dashboard','▦','Dashboard'],['submit','＋','Submit new user'],['submissions','☷','My submissions'],['commissions','💰','Commissions']
    ];
  } else {
    return [
      ['MAIN'],['dashboard','▦','Dashboard'],['submit','＋','Submit new user'],['submissions','☷','My submissions']
    ];
  }
}

function renderNav(){
  $('#nav').innerHTML = navItems().map(item => item.length===1
    ? `<div class="nav-section">${item[0]}</div>`
    : `<button class="nav-btn ${state.page===item[0]?'active':''}" data-page="${item[0]}"><span class="nav-icon">${item[1]}</span>${item[2]}</button>`
  ).join('');
  $$('.nav-btn').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
}

const titles = {
  dashboard:['OVERVIEW','Dashboard'], submit:['WORKFLOW','Submit new user'], submissions:['RECORDS','Submissions'],
  affiliates:['MANAGEMENT','Affiliates'], audit:['SECURITY','Activity log'], commissions:['EARNINGS','Commissions'], months:['ACCOUNTING','Monthly close']
};

async function navigate(page){
  state.page = page;
  renderNav();
  const [k,t] = titles[page] || ['PORTAL','Dashboard'];
  $('#pageKicker').textContent=k; $('#pageTitle').textContent=t;
  $('.sidebar').classList.remove('open');
  if(page!=='submit') $('#content').innerHTML = skeleton();
  try {
    if(page==='dashboard') await renderDashboard();
    if(page==='submit') await renderSubmit();
    if(page==='submissions') await renderSubmissions();
    if(page==='affiliates') await renderAffiliates();
    if(page==='audit') await renderAudit();
    if(page==='commissions') await renderCommissions();
    if(page==='months') await renderMonths();
  } catch(e){
    toast(e.message,true);
    $('#content').innerHTML = `<div class="panel"><div class="empty"><b>Unable to load this page</b><p>${esc(e.message || 'Please try again.')}</p><button class="btn btn-primary" id="retryPage">Try again</button></div></div>`;
    $('#retryPage').onclick=()=>navigate(page);
  }
}

function bootUser(user){
  state.user=user;
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  const isSalesWorker = ['worker', 'affiliate', 'commission_worker', 'commission worker'].includes(String(user.role).toLowerCase());
  const sidebarRole = isSalesWorker ? '✦ Sales Associate' : user.role;
  $('#sideName').textContent=user.name; $('#sideRole').textContent=sidebarRole; $('#sideAvatar').textContent=user.name[0]?.toUpperCase()||'A';
  $('#roleBadge').textContent=isSalesWorker?'Sales Associate':user.role;
  state.page='dashboard'; renderNav(); navigate('dashboard');
  initTheme();
}

async function renderDashboard(){
  await loadAccountingMonths();
  const month=state.selectedMonth;
  const [{counts,recent,byAffiliate},{submissions}] = await Promise.all([
    api(`/api/dashboard?month=${encodeURIComponent(month)}`),
    api(`/api/submissions?month=${encodeURIComponent(month)}`).catch(()=>({submissions:[]}))
  ]);
  const content = $('#content');
  const first = esc(state.user.name.split(' ')[0]);
  const approvalRate = counts.total ? Math.round((counts.approved/counts.total)*100) : 0;
  const stats = [
    ['Total submitted',counts.total,'All records','▦','tone-blue'],
    ['Approved',counts.approved,`${approvalRate}% approval rate`,'✓','tone-green'],
    ['Pending',counts.pending,'Waiting for review','◷','tone-amber'],
    ['Rejected',counts.rejected,'Not accepted','✕','tone-red']
  ];
  const recentRows = recent.length ? recent.map(s=>`<tr class="clickable" data-id="${s.id}"><td><b>${esc(s.customerName||'—')}</b><div class="muted mono">@${esc(submissionUser(s))}</div></td><td>${esc(s.operator)}</td>${state.user.role==='admin'?`<td>${esc(s.affiliateName)}</td>`:''}<td>${fmtDate(s.signupDate)}</td><td>${statusPill(s.status)}</td><td><span title="${fmtDateTime(s.createdAt)}">${relTime(s.createdAt)}</span></td></tr>`).join('') : '';
  const segs=[
    {name:'Approved',value:counts.approved,color:STATUS_TONES.approved},
    {name:'Pending',value:counts.pending,color:STATUS_TONES.pending},
    {name:'Needs review',value:counts.needsReview||0,color:STATUS_TONES.needs_review},
    {name:'Rejected',value:counts.rejected,color:STATUS_TONES.rejected}
  ];
  const trend=trendBars(submissions);
  const vizGrid = `<div class="viz-grid">
    <div class="panel"><div class="panel-header"><h3>Status breakdown</h3><span class="muted" style="font-size:11px">${counts.total} total</span></div><div class="donut-panel">${donutChart(segs,counts.total,'Total')}<div class="legend">${segs.map(s=>{const pct=counts.total?Math.round(s.value/counts.total*100):0;return `<div class="legend-row"><span class="legend-dot" style="background:${s.color}"></span><span class="lg-name">${s.name}</span><span class="lg-val">${s.value}</span><span class="lg-pct">${pct}%</span></div>`}).join('')}</div></div></div>
    <div class="panel"><div class="panel-header"><h3>Submission activity</h3><span class="muted" style="font-size:11px">${trend.total} in last 14 days</span></div><div class="trend-panel">${trend.html}</div></div>
  </div>`;
  content.innerHTML = `
    <div class="welcome-row"><div><h2>${state.user.role==='admin'?'Operations overview':`Hi, ${first}`}</h2><p class="muted">${monthLabel(month)} · ${state.user.role==='admin'?'Review affiliate activity and keep every submission accountable.':'Submit each referred user here and track the review status.'}</p></div>${state.user.role==='affiliate'?'<button class="btn btn-primary" id="dashSubmit">+ Submit new user</button>':''}</div>
    <div class="stat-grid">${stats.map(s=>`<div class="stat-card ${s[4]}"><div class="stat-icon">${s[3]}</div><div class="stat-body"><div class="stat-label">${s[0]}</div><div class="stat-value count-up" data-count="${s[1]}">0</div><div class="stat-sub">${s[2]}</div></div></div>`).join('')}</div>
    ${vizGrid}
    <div class="panel-grid">
      <div class="panel"><div class="panel-header"><h3>Recent submissions</h3><button class="btn btn-soft small-btn" id="viewAll">View all</button></div>${recent.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>User / Pickr username</th><th>Operator</th>${state.user.role==='admin'?'<th>Affiliate</th>':''}<th>Signup date</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${recentRows}</tbody></table></div>`:`<div class="empty"><b>No submissions yet</b>${state.user.role==='affiliate'?'Submit your first user to get started.':'Affiliate submissions will appear here.'}</div>`}</div>
      <div>${state.user.role==='affiliate'
        ? `<div class="quick-card"><h3>New referral?</h3><p>Log the user name, Pickr username, operator, signup date, and up to 5 screenshots.</p><button class="btn" id="quickSubmit">Submit user</button></div><div class="panel" style="margin-top:16px"><div class="panel-header"><h3>How it works</h3></div><div class="panel-body"><div class="metric-row"><span>1. Enter user details</span><b>Required</b></div><div class="metric-row"><span>2. Add screenshots</span><b>Up to 5</b></div><div class="metric-row"><span>3. Admin verifies</span><b>Review</b></div></div></div>`
        : `<div class="panel"><div class="panel-header"><h3>Affiliate performance</h3></div><div class="panel-body">${byAffiliate.length?byAffiliate.slice(0,6).map((a,i)=>{const pct=a.total?Math.round(a.approved/a.total*100):0;return `<div class="affiliate-rank" style="margin-bottom:15px"><div class="rank-num">${i+1}</div><div style="flex:1"><div style="display:flex;justify-content:space-between;font-size:11px"><b>${esc(a.name)}</b><span class="muted">${a.approved} approved</span></div><div class="progress"><i style="width:${pct}%"></i></div></div></div>`}).join(''):'<div class="empty">No affiliates yet.</div>'}</div></div>`}
      </div>
    </div>`;
  runCounters(content);
  const viewAll = $('#viewAll');
  if (viewAll) viewAll.onclick=()=>navigate('submissions');
  $('#dashSubmit') && ($('#dashSubmit').onclick=()=>navigate('submit'));
  $('#quickSubmit') && ($('#quickSubmit').onclick=()=>navigate('submit'));
  $$('tr[data-id]').forEach(r=>r.onclick=()=>openSubmission(r.dataset.id, recent));
}

async function renderSubmit(){
  if(!['affiliate','commission_worker','account_manager'].includes(state.user.role)) return navigate('dashboard');
  const [{operators=[]}]=await Promise.all([api('/api/operators'),loadAccountingMonths()]);
  const selectableMonths=state.availableMonths;
  const defaultMonth=selectableMonths.some(item=>item.month===state.selectedMonth)?state.selectedMonth:selectableMonths[0]?.month;
  const operatorChoices=operators.map(operator=>`<button type="button" data-operator="${esc(operator.name)}"><b>${esc(operator.name)}</b><span>$${Number(operator.workerEarnings).toFixed(0)} when approved</span></button>`).join('');
  let selectedFiles=[];
  $('#content').innerHTML = `
    <div class="step-strip"><div class="step"><div class="step-num">1</div><span>Enter user details</span></div><div class="step"><div class="step-num">2</div><span>Add screenshots</span></div><div class="step"><div class="step-num">3</div><span>Submit for review</span></div></div>
    <form id="submitForm" class="form-card">
      <h2>Log a referred user</h2><p class="muted">Enter the information exactly as it appears in Pickr. Duplicate Pickr usernames for the same operator are blocked automatically.</p>
      <div class="form-grid">
        <label>User full name<input name="customerName" autocomplete="name" placeholder="e.g. John Smith" required><span class="form-help">Name of the user you referred.</span></label>
        <label>Pickr website username<input name="pickrUsername" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. johnsmith23" required><span class="form-help">Enter their Pickr username exactly.</span></label>
        <label>Operator<input name="operator" type="hidden" required><div class="operator-picker"><button id="operatorPicker" class="operator-picker-toggle" type="button" aria-expanded="false"><span>Select an operator</span><span>⌄</span></button><div id="operatorOptions" class="operator-options hidden">${operatorChoices}</div></div><span class="form-help">Choose the operator for this submission.</span></label>
        <label>Amount wagered<input name="amount" type="number" step="0.01" placeholder="e.g. 100.00" required><span class="form-help">Total amount the user wagered or bet.</span></label>
        <label>Signup date<input name="signupDate" type="date" required></label>
        <label>Submission month<select name="accountingMonth" required>${selectableMonths.map(item=>`<option value="${item.month}" ${item.month===defaultMonth?'selected':''}>${esc(monthLabel(item.month))}</option>`).join('')}</select><span class="form-help">The month this person belongs to. Closed months are unavailable.</span></label>
        <div class="full upload-field">
          <div class="upload-label">Screenshots / proof <span>Optional · up to 5 files</span></div>
          <input id="proofFiles" type="file" multiple accept="image/*,.heic,.heif,.avif,.pdf,application/pdf" hidden>
          <label class="upload-zone" for="proofFiles">
            <div class="upload-icon">＋</div>
            <div><b>Choose screenshots or files</b><span>Tap to select from Photos or Files on iPhone</span><small>JPG, PNG, WebP, GIF, HEIC/HEIF, AVIF or PDF · 15 MB each</small></div>
          </label>
          <div id="fileList" class="file-list"></div>
        </div>
        <label class="full">Notes <span class="optional">Optional</span><textarea name="notes" placeholder="Any extra information the admin should know."></textarea></label>
      </div>
      <div class="note-card" style="margin-top:20px">Your submission is timestamped and tied to your affiliate login. Screenshots are stored with this record so the admin can review them.</div>
      <div class="form-actions"><button type="button" class="btn" id="cancelSubmit">Cancel</button><button class="btn btn-primary" id="submitBtn" type="submit">Submit for review</button></div>
      <div id="submitError" class="form-error"></div>
    </form>`;
  const form=$('#submitForm');
  const input=$('#proofFiles');
  const list=$('#fileList');
  form.signupDate.value = new Date().toISOString().slice(0,10);
  $('#cancelSubmit').onclick=()=>navigate('dashboard');
  const operatorPicker = $('#operatorPicker');
  const operatorOptions = $('#operatorOptions');
  operatorPicker.onclick=()=>{
    const isHidden = operatorOptions.classList.toggle('hidden');
    operatorPicker.setAttribute('aria-expanded', String(!isHidden));
  };
  $$('[data-operator]', form).forEach(option=>option.onclick=()=>{
    form.operator.value = option.dataset.operator;
    operatorPicker.firstElementChild.textContent = option.dataset.operator;
    operatorOptions.classList.add('hidden');
    operatorPicker.setAttribute('aria-expanded', 'false');
  });

  const renderFiles=()=>{
    list.innerHTML=selectedFiles.map((file,i)=>{
      const lower=file.name.toLowerCase();
      const previewable=file.type.startsWith('image/') && !lower.endsWith('.heic') && !lower.endsWith('.heif');
      const preview=previewable?`<img src="${URL.createObjectURL(file)}" alt="">`:`<div class="file-type">${lower.endsWith('.pdf')?'PDF':'IMG'}</div>`;
      return `<div class="file-chip">${preview}<div class="file-chip-copy"><b>${esc(file.name)}</b><span>${fmtBytes(file.size)}</span></div><button type="button" class="file-remove" data-file-index="${i}" aria-label="Remove file">×</button></div>`;
    }).join('');
    $$('[data-file-index]').forEach(btn=>btn.onclick=()=>{selectedFiles.splice(Number(btn.dataset.fileIndex),1);renderFiles();});
  };

  input.onchange=()=>{
    const incoming=[...input.files];
    if(incoming.length>5){ toast('You can upload a maximum of 5 files.',true); input.value=''; return; }
    const tooLarge=incoming.find(f=>f.size>15*1024*1024);
    if(tooLarge){ toast(`${tooLarge.name} is larger than 15 MB.`,true); input.value=''; return; }
    selectedFiles=incoming;
    renderFiles();
  };

  form.onsubmit=async e=>{
    e.preventDefault(); $('#submitError').textContent='';
    const btn=$('#submitBtn');
    const data=new FormData();
    data.append('customerName',form.customerName.value);
    data.append('pickrUsername',form.pickrUsername.value);
    data.append('operator',form.operator.value);
    data.append('accountingMonth',form.accountingMonth.value);
    data.append('amount',form.amount.value);
    data.append('signupDate',form.signupDate.value);
    data.append('notes',form.notes.value);
    selectedFiles.forEach(file=>data.append('attachments',file,file.name));
    try{
      btn.disabled=true; btn.textContent='Submitting…';
      await api('/api/submissions',{method:'POST',body:data});
      toast('User submitted for review.'); navigate('submissions');
    } catch(err){ $('#submitError').textContent=err.message; btn.disabled=false; btn.textContent='Submit for review'; }
  };
}

async function renderSubmissions(){
  await loadAccountingMonths();
  const month=state.selectedMonth;
  const {submissions}=await api(`/api/submissions?month=${encodeURIComponent(month)}`); state.submissions=submissions;
  const isAdmin=state.user.role==='admin';
  const statuses=[['all','All'],['pending','Pending'],['approved','Approved'],['needs_review','Needs review'],['rejected','Rejected']];
  const chipCount=st=> st==='all'?submissions.length:submissions.filter(s=>s.status===st).length;
  const getVal={
    customerName:s=>(s.customerName||'').toLowerCase(), pickr:s=>submissionUser(s).toLowerCase(),
    operator:s=>(s.operator||'').toLowerCase(), affiliateName:s=>(s.affiliateName||'').toLowerCase(),
    signupDate:s=>s.signupDate||'', files:s=>(s.attachments||[]).length, createdAt:s=>s.createdAt||'', status:s=>s.status||''
  };
  const cols=[['customerName','User'],['pickr','Pickr username'],['operator','Operator'],...(isAdmin?[['affiliateName','Affiliate']]:[]),['signupDate','Signup date'],['files','Files'],['createdAt','Submitted'],['status','Status']];
  const view={ q:'', status:'all', sort:'createdAt', dir:-1 };
  $('#content').innerHTML = `
    <div class="welcome-row"><div><h2>${isAdmin?'All submissions':'My submissions'}</h2><p class="muted">${isAdmin?'Review every affiliate record and its uploaded proof from one place.':'Track everything you have submitted and its current review status.'}</p></div><div class="toolbar"><select id="submissionMonth" class="filter-input">${state.accountingMonths.map(item=>`<option value="${item.month}" ${item.month===month?'selected':''}>${esc(monthLabel(item.month))}${item.status==='closed'?' · Closed':''}</option>`).join('')}</select>${!isAdmin?'<button class="btn btn-primary" id="newFromList">+ Submit new user</button>':''}</div></div>
    <div class="panel"><div class="panel-header" style="flex-wrap:wrap"><div class="chips" id="statusChips">${statuses.map(([v,l])=>`<button class="chip ${v==='all'?'active':''}" data-chip="${v}">${l}<span class="chip-count">${chipCount(v)}</span></button>`).join('')}</div><div class="toolbar"><input id="searchRows" class="filter-input" placeholder="Search name, username, operator"></div></div><div id="submissionTable"></div></div>`;
  $('#newFromList') && ($('#newFromList').onclick=()=>navigate('submit'));
  $('#submissionMonth').onchange=e=>{state.selectedMonth=e.target.value;renderSubmissions();};
  const draw=()=>{
    const q=view.q.toLowerCase().trim();
    let rows=submissions.filter(s=>(view.status==='all'||s.status===view.status)&&(!q||[s.customerName,submissionUser(s),s.operator,s.affiliateName].join(' ').toLowerCase().includes(q)));
    const g=getVal[view.sort]||getVal.createdAt;
    rows=[...rows].sort((a,b)=>{const va=g(a),vb=g(b); return (va<vb?-1:va>vb?1:0)*view.dir;});
    const head=cols.map(([key,label])=>`<th class="sortable ${view.sort===key?'sorted':''}" data-sort="${key}">${label}<span class="arrow">${view.sort===key?(view.dir===1?'▲':'▼'):'▲'}</span></th>`).join('')+'<th></th>';
    $('#submissionTable').innerHTML = rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${rows.map(s=>`<tr><td><b>${esc(s.customerName||'—')}</b></td><td class="mono">@${esc(submissionUser(s))}</td><td>${esc(s.operator)}</td>${isAdmin?`<td>${esc(s.affiliateName)}</td>`:''}<td>${fmtDate(s.signupDate)}</td><td>${(s.attachments||[]).length}</td><td><span title="${fmtDateTime(s.createdAt)}">${relTime(s.createdAt)}</span></td><td>${statusPill(s.status)}</td><td><button class="btn btn-soft small-btn" data-open="${s.id}">${isAdmin?'Review':'View'}</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>No matching records</b>Try another search or status.</div>';
    $$('[data-open]').forEach(b=>b.onclick=()=>openSubmission(b.dataset.open, submissions));
    $$('th.sortable').forEach(th=>th.onclick=()=>{const k=th.dataset.sort; if(view.sort===k) view.dir*=-1; else {view.sort=k; view.dir=1;} draw();});
  };
  $$('#statusChips [data-chip]').forEach(c=>c.onclick=()=>{view.status=c.dataset.chip; $$('#statusChips .chip').forEach(x=>x.classList.toggle('active',x===c)); draw();});
  $('#searchRows').oninput=e=>{view.q=e.target.value; draw();};
  draw();
}

function openSubmission(id, list=state.submissions){
  const s=list.find(x=>x.id===id); if(!s)return;
  const isAdmin=state.user.role==='admin';
  const isOwner=s.affiliateId===state.user.id;
  const canEdit=(isAdmin||isOwner)&&['pending','needs_review'].includes(s.status);
  const openMonths=state.accountingMonths.filter(item=>item.status==='open');
  const reimbursement=s.reimbursement || {status:'unpaid',amount:Number(s.amount||0)};
  const history=(s.history||[]).map(h=>`<div class="history-item"><div class="history-dot"></div><div class="history-copy"><b>${esc(statusLabel(h.status))}</b><div>${fmtDateTime(h.at)}${h.note?` · ${esc(h.note)}`:''}</div></div></div>`).join('');
  const attachments=(s.attachments||[]).map(a=>{
    const href=`/api/submissions/${encodeURIComponent(s.id)}/files/${encodeURIComponent(a.id)}`;
    const lower=(a.originalName||'').toLowerCase();
    const previewable=(a.mimeType||'').startsWith('image/') && !lower.endsWith('.heic') && !lower.endsWith('.heif');
    return `<button type="button" class="evidence-card" data-download-file="${esc(href)}" data-file-name="${esc(a.originalName)}">${previewable?`<div class="evidence-file-icon">IMG</div>`:`<div class="evidence-file-icon">${lower.endsWith('.pdf')?'PDF':'IMG'}</div>`}<div><b>${esc(a.originalName)}</b><span>${fmtBytes(a.size)} · Tap to download</span></div></button>`;
  }).join('');
  $('#modalBody').innerHTML = `
    <span class="eyebrow dark">SUBMISSION RECORD</span><h2>${esc(s.customerName||submissionUser(s))}</h2><div>${statusPill(s.status)}</div>
    <div class="detail-grid">
      <div class="detail-item"><small>Pickr username</small><b>@${esc(submissionUser(s))}</b></div><div class="detail-item"><small>Operator</small><b>${esc(s.operator)}</b></div>
      <div class="detail-item"><small>Signup date</small><b>${fmtDate(s.signupDate)}</b></div>${isAdmin?`<div class="detail-item"><small>Submitted by affiliate</small><b>${esc(s.affiliateName)}</b></div>`:''}
      <div class="detail-item"><small>Submission month</small><b>${esc(monthLabel(s.accountingMonth || String(s.createdAt||'').slice(0,7)))}</b></div>
      <div class="detail-item"><small>Deposit / wagered amount</small><b>$${Number(s.amount||0).toFixed(2)}</b></div><div class="detail-item"><small>Deposit reimbursement</small><b>${reimbursement.status==='paid'?`Paid ${fmtDate(reimbursement.paidAt)}`:'Not reimbursed'}</b></div>
      <div class="detail-item"><small>Submitted</small><b>${fmtDateTime(s.createdAt)}</b></div><div class="detail-item"><small>Uploaded files</small><b>${(s.attachments||[]).length} / 5</b></div>
      <div class="detail-item" style="grid-column:1/-1"><small>Affiliate notes</small><b>${esc(s.notes||'—')}</b></div>
      ${s.adminNote?`<div class="detail-item" style="grid-column:1/-1"><small>Admin note</small><b>${esc(s.adminNote)}</b></div>`:''}
    </div>
    <div class="evidence-section"><div class="evidence-heading"><b>Screenshots / proof</b><span>${(s.attachments||[]).length} file${(s.attachments||[]).length===1?'':'s'}</span></div>${attachments?`<div class="evidence-grid">${attachments}</div>`:'<div class="empty compact">No screenshots were attached.</div>'}</div>
    ${canEdit?`<details class="submission-editor"><summary>Edit submission</summary><div class="form-grid" style="margin-top:14px"><label>User full name<input id="editCustomerName" value="${esc(s.customerName)}"></label><label>Pickr username<input id="editPickrUsername" value="${esc(submissionUser(s))}"></label><label>Operator<input id="editOperator" value="${esc(s.operator)}"></label><label>Amount wagered<input id="editAmount" type="number" min="0" step="0.01" value="${Number(s.amount||0)}"></label><label>Signup date<input id="editSignupDate" type="date" value="${esc(s.signupDate||'')}"></label><label class="full">Notes<textarea id="editNotes">${esc(s.notes||'')}</textarea></label></div><div class="modal-actions"><button class="btn btn-primary" id="saveSubmission">Save changes</button><button class="btn btn-danger" id="deleteSubmission">Delete submission</button></div></details>`:''}
    ${isAdmin?`<div class="month-move"><b>Owner month switch</b><p class="muted">Move this submission and linked commission records to an open month.</p><div class="toolbar"><select id="moveSubmissionMonth" class="filter-input">${openMonths.map(item=>`<option value="${item.month}" ${item.month===s.accountingMonth?'selected':''}>${esc(monthLabel(item.month))}</option>`).join('')}</select><button class="btn btn-soft small-btn" id="moveSubmission">Move month</button></div></div><textarea id="adminNote" class="modal-note" placeholder="Optional note to record with this decision">${esc(s.adminNote||'')}</textarea><div class="modal-actions"><button class="btn btn-good" data-status="approved">Approve</button><button class="btn btn-soft" data-status="needs_review">Needs review</button><button class="btn btn-danger" data-status="rejected">Reject</button><button class="btn" data-status="pending">Set pending</button></div>${s.status==='approved'&&reimbursement.status!=='paid'&&Number(s.amount||0)>0?`<button class="btn btn-primary" id="reimburseDeposit">Mark $${Number(s.amount).toFixed(2)} deposit reimbursed</button>`:''}`:''}
    <div class="history-list"><b style="font-size:11px">Status history</b>${history||'<div class="muted" style="font-size:11px;margin-top:10px">No history.</div>'}</div>`;
  $('#modal').classList.remove('hidden');
  $$('[data-download-file]').forEach(button => button.onclick=async()=>{
    try {
      button.disabled = true;
      await downloadAttachment(button.dataset.downloadFile, button.dataset.fileName);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  $('#reimburseDeposit') && ($('#reimburseDeposit').onclick=async()=>{
    if (!confirm(`Mark the $${Number(s.amount).toFixed(2)} deposit as reimbursed?`)) return;
    try {
      await api(`/api/submissions/${id}/reimbursement`, {method:'PATCH'});
      toast('Deposit marked as reimbursed.');
      closeModal();
      await renderSubmissions();
    } catch (error) { toast(error.message, true); }
  });
  $('#saveSubmission') && ($('#saveSubmission').onclick=async()=>{
    try {
      await api(`/api/submissions/${id}`,{method:'PATCH',body:JSON.stringify({customerName:$('#editCustomerName').value,pickrUsername:$('#editPickrUsername').value,operator:$('#editOperator').value,amount:$('#editAmount').value,signupDate:$('#editSignupDate').value,notes:$('#editNotes').value})});
      toast('Submission updated.'); closeModal(); await renderSubmissions();
    } catch(error) { toast(error.message,true); }
  });
  $('#deleteSubmission') && ($('#deleteSubmission').onclick=async()=>{
    if(!confirm('Delete this submission? This cannot be undone.')) return;
    try {
      await api(`/api/submissions/${id}`,{method:'DELETE'});
      toast('Submission deleted.'); closeModal(); await renderSubmissions();
    } catch(error) { toast(error.message,true); }
  });
  $('#moveSubmission') && ($('#moveSubmission').onclick=async()=>{
    const accountingMonth=$('#moveSubmissionMonth').value;
    if(accountingMonth===s.accountingMonth){ toast('This submission is already in that month.'); return; }
    if(!confirm(`Move this submission to ${monthLabel(accountingMonth)}?`)) return;
    try {
      await api(`/api/submissions/${id}`,{method:'PATCH',body:JSON.stringify({action:'move_month',accountingMonth})});
      toast(`Submission moved to ${monthLabel(accountingMonth)}.`); closeModal(); await renderSubmissions();
    } catch(error) { toast(error.message,true); }
  });
  $$('[data-status]').forEach(b=>b.onclick=async()=>{
    try{
      await api(`/api/submissions/${id}/status`,{method:'PATCH',body:JSON.stringify({status:b.dataset.status,adminNote:$('#adminNote').value})});
      toast(`Submission marked ${statusLabel(b.dataset.status).toLowerCase()}.`); closeModal();
      if(state.page==='submissions') await renderSubmissions(); else await renderDashboard();
    }catch(e){toast(e.message,true)}
  });
}

async function renderAffiliates(){
  if(state.user.role!=='admin')return navigate('dashboard');
  const {affiliates}=await api('/api/affiliates'); state.affiliates=affiliates;
  $('#content').innerHTML = `
    <div class="welcome-row"><div><h2>Affiliate accounts</h2><p class="muted">Create logins, disable access, and review each affiliate's totals.</p></div><button class="btn btn-primary" id="addAffiliate">+ Add affiliate</button></div>
    <div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Affiliate</th><th>Email</th><th>Status</th><th>Submitted</th><th>Approved</th><th>Pending</th><th></th></tr></thead><tbody>${affiliates.map(a=>`<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.email)}</td><td>${a.active?'<span class="status status-approved">Active</span>':'<span class="status status-inactive">Inactive</span>'}</td><td>${a.total}</td><td>${a.approved}</td><td>${a.pending}</td><td><button class="btn ${a.active?'btn-danger':'btn-good'} small-btn" data-toggle="${a.id}">${a.active?'Disable':'Enable'}</button></td></tr>`).join('')}</tbody></table></div>${!affiliates.length?'<div class="empty">No affiliate accounts yet.</div>':''}</div>`;
  $('#addAffiliate').onclick=openAddAffiliate;
  $$('[data-toggle]').forEach(b=>b.onclick=async()=>{try{await api(`/api/affiliates/${b.dataset.toggle}/toggle`,{method:'PATCH'});toast('Affiliate access updated.');renderAffiliates()}catch(e){toast(e.message,true)}});
}

function openAddAffiliate(){
  $('#modalBody').innerHTML=`<span class="eyebrow dark">NEW ACCOUNT</span><h2>Add affiliate</h2><p class="muted" style="font-size:12px">Create a login that can submit and view only its own users.</p><form id="affiliateForm" class="form-grid" style="margin-top:20px"><label class="full">Name<input name="name" required placeholder="Affiliate name"></label><label class="full">Email<input name="email" type="email" required placeholder="affiliate@example.com"></label><label class="full">Temporary password<input name="password" type="password" minlength="8" required placeholder="Minimum 8 characters"></label><div class="full form-actions"><button class="btn btn-primary" type="submit">Create affiliate</button></div><div id="affError" class="form-error full"></div></form>`;
  $('#modal').classList.remove('hidden');
  $('#affiliateForm').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/affiliates',{method:'POST',body:JSON.stringify(body)});toast('Affiliate account created.');closeModal();renderAffiliates()}catch(err){$('#affError').textContent=err.message}};
}

async function renderAudit(){
  if(state.user.role!=='admin')return navigate('dashboard');
  const {audit}=await api('/api/audit');
  $('#content').innerHTML=`<div class="welcome-row"><div><h2>Activity log</h2><p class="muted">Recent security and workflow actions across the portal.</p></div></div><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>${audit.map(a=>`<tr><td>${fmtDateTime(a.at)}</td><td>${esc(a.actorName)}</td><td class="mono">${esc(a.type)}</td><td>${esc(Object.entries(a.meta||{}).map(([k,v])=>`${k}: ${v}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div></div>`;
}

async function renderMonths(){
  if(state.user.role!=='admin') return navigate('dashboard');
  await loadAccountingMonths();
  const rows=state.accountingMonths;
  $('#content').innerHTML=`
    <div class="welcome-row"><div><h2>Monthly accounting</h2><p class="muted">The active month switches automatically on the second day. Close a month after every user is reviewed, commissions are paid, and deposits are reimbursed.</p></div><div class="toolbar"><input id="openMonthValue" class="filter-input" type="month" aria-label="Month to open"><button class="btn btn-soft" id="openMonth">Open month</button></div></div>
    <div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Month</th><th>Submissions</th><th>Commissions</th><th>Reimbursements</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(period=>`<tr><td><b>${esc(monthLabel(period.month))}</b>${period.month===state.selectedMonth?'<div class="muted">Currently selected</div>':''}</td><td>${period.submissions}<div class="muted">${period.unresolvedSubmissions} awaiting review</div></td><td>$${Number(period.commissionTotal||0).toFixed(2)}<div class="muted">${period.pendingCommissions} unpaid</div></td><td>$${Number(period.reimbursementTotal||0).toFixed(2)}<div class="muted">${period.unpaidReimbursements} unpaid</div></td><td><span class="status ${period.status==='closed'?'status-inactive':'status-approved'}">${period.status}</span></td><td>${period.status==='closed'?`<button class="btn btn-soft small-btn" data-month-action="reopen" data-month="${period.month}">Reopen month</button>`:`<button class="btn ${period.readyToClose?'btn-primary':'btn-soft'} small-btn" data-month-action="close" data-month="${period.month}" ${period.readyToClose?'':'disabled'}>${period.readyToClose?'Close month':'Finish outstanding items'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-month-action]').forEach(button=>button.onclick=async()=>{
    const action=button.dataset.monthAction;
    const month=button.dataset.month;
    if(!confirm(`${action==='close'?'Close':'Reopen'} ${monthLabel(month)}?`)) return;
    try{
      await api(`/api/accounting/months/${encodeURIComponent(month)}`,{method:'PATCH',body:JSON.stringify({action})});
      toast(`${monthLabel(month)} ${action==='close'?'closed':'reopened'}.`);
      await renderMonths();
    }catch(error){toast(error.message,true);}
  });
  $('#openMonth').onclick=async()=>{
    const month=$('#openMonthValue').value;
    if(!month){toast('Choose a month to open.',true);return;}
    try{
      await api('/api/accounting/months',{method:'POST',body:JSON.stringify({month})});
      toast(`${monthLabel(month)} is open for submissions.`);
      state.selectedMonth=month;
      await renderMonths();
    }catch(error){toast(error.message,true);}
  };
}

async function renderCommissions(){
  await loadAccountingMonths();
  const month=state.selectedMonth;
  const [{commissions},{summary={}}]=await Promise.all([
    api(`/api/commissions?month=${encodeURIComponent(month)}`),
    api(`/api/commissions/summary?month=${encodeURIComponent(month)}`)
  ]);
  const {totalEarned=0,totalPending=0,totalPaid=0,byOperator={}}=summary;
  const isWorker=state.user.role==='commission_worker';
  const isManager=state.user.role==='account_manager';
  const isAdmin=state.user.role==='admin';
  const title=isManager?'Team Earnings':isWorker?'My Earnings':'All Commissions';
  const {operators=[]}=isWorker ? await api('/api/operators') : {};
  const ratePanel = isWorker ? `<div class="panel"><div class="panel-header"><h3>Current approval payouts</h3><span class="muted" style="font-size:11px">Paid when a submission is approved</span></div><div class="panel-body">${operators.map(operator=>`<div class="metric-row"><span><b>${esc(operator.name)}</b></span><b>$${Number(operator.workerEarnings).toFixed(0)}</b></div>`).join('')}</div></div>` : '';
  const emptyDetails = `<div class="empty"><b>No commissions yet</b><p>Your earnings will appear here as soon as an eligible submission is approved.</p></div>`;
  $('#content').innerHTML=`
    <div class="welcome-row"><div><h2>${title}</h2><p class="muted">${isWorker?'See every approved submission, its fixed payout, and whether it is still awaiting payout.':isManager?'Track your team’s approved earnings and payout status.':'Review pending commissions and mark the monthly payout when it has been sent.'}</p></div><div class="toolbar"><select id="commissionMonth" class="filter-input">${state.accountingMonths.map(item=>`<option value="${item.month}" ${item.month===month?'selected':''}>${esc(monthLabel(item.month))}${item.status==='closed'?' · Closed':''}</option>`).join('')}</select>${isAdmin?`<button class="btn btn-primary" id="payPendingCommissions" ${totalPending?'':'disabled'}>Pay ${esc(monthLabel(month))} · $${totalPending}</button>`:''}</div></div>
    <div class="stat-grid">
      <div class="stat-card tone-green"><div class="stat-icon">✓</div><div class="stat-body"><div class="stat-label">Total earned</div><div class="stat-value">$<span class="count-up" data-count="${totalEarned}">0</span></div><div class="stat-sub">All approved earnings</div></div></div>
      <div class="stat-card tone-amber"><div class="stat-icon">◷</div><div class="stat-body"><div class="stat-label">Awaiting payout</div><div class="stat-value">$<span class="count-up" data-count="${totalPending}">0</span></div><div class="stat-sub">Approved and not yet paid</div></div></div>
      <div class="stat-card tone-blue"><div class="stat-icon">💰</div><div class="stat-body"><div class="stat-label">Total paid</div><div class="stat-value">$<span class="count-up" data-count="${totalPaid}">0</span></div><div class="stat-sub">Completed payouts</div></div></div>
    </div>
    <div class="panel-grid"><div class="panel"><div class="panel-header"><h3>Breakdown by operator</h3></div><div class="panel-body">${Object.entries(byOperator).length ? Object.entries(byOperator).map(([op, stats]) => `<div class="metric-row"><span><b>${esc(op)}</b><small class="muted">${stats.count} approved submission${stats.count===1?'':'s'}</small></span><span><b>$${stats.total}</b><small class="muted">${stats.pending ? `$${stats.pending} pending` : 'Paid'}</small></span></div>`).join('') : '<div class="empty">No commission data</div>'}</div></div>${ratePanel || `<div class="panel"><div class="panel-header"><h3>Payout status</h3></div><div class="panel-body"><p class="muted" style="margin:0;font-size:12px">Commission records are created automatically when an eligible submission is approved.</p></div></div>`}</div>
    <div class="panel"><div class="panel-header"><h3>Commission details</h3><span class="muted" style="font-size:11px">${commissions.length} record${commissions.length===1?'':'s'}</span></div>${commissions.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Approved</th><th>Operator</th>${isManager?'<th>Worker</th>':''}<th>Payout</th><th>Status</th></tr></thead><tbody>${commissions.map(c=>`<tr><td>${fmtDate(c.createdAt)}</td><td><b>${esc(c.operator)}</b><div class="muted mono">#${esc(c.submissionId || '').slice(-6)}</div></td>${isManager?`<td>${esc(c.userName)}</td>`:''}<td><b>$${c.amount}</b></td><td>${statusPill(c.status)}</td></tr>`).join('')}</tbody></table></div>`:emptyDetails}</div>`;
  runCounters($('#content'));
  $('#commissionMonth').onchange=e=>{state.selectedMonth=e.target.value;renderCommissions();};
  $('#payPendingCommissions') && ($('#payPendingCommissions').onclick=async()=>{
    if (!confirm(`Mark ${commissions.filter(c=>c.status==='pending').length} pending commission record(s) as paid for a total of $${totalPending}?`)) return;
    try {
      const result=await api('/api/commissions/pay-pending',{method:'POST',body:JSON.stringify({month})});
      toast(`Marked ${result.records} commission record(s) paid: $${result.total}.`);
      await renderCommissions();
    } catch (error) { toast(error.message,true); }
  });
}

function closeModal(){ $('#modal').classList.add('hidden'); $('#modalBody').innerHTML=''; }
$('#modalClose').onclick=closeModal; $('#modal').onclick=e=>{if(e.target===$('#modal'))closeModal()};
$('#menuBtn').onclick=()=>$('.sidebar').classList.toggle('open');
$('#logoutBtn').onclick=async()=>{try{await api('/api/logout',{method:'POST'})}finally{try{localStorage.removeItem('pickr-session-token')}catch{};location.reload()}};

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ closeModal(); return; }
});

$('#passwordToggle').onclick=()=>{
  const input=$('#loginPassword');
  const show=input.type==='password';
  input.type=show?'text':'password';
  $('#passwordToggle').textContent=show?'Hide':'Show';
  $('#passwordToggle').setAttribute('aria-label',show?'Hide password':'Show password');
  $('#passwordToggle').setAttribute('aria-pressed',String(show));
};

$('#loginForm').onsubmit=async e=>{
  e.preventDefault(); $('#loginError').textContent='';
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  const submit=$('#loginSubmit');
  
  if (!email || !password) {
    $('#loginError').textContent = 'Please enter email and password';
    return;
  }
  
  try{
    submit.disabled=true; submit.textContent='Signing in…';
    const body = JSON.stringify({email, password});
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'include',
      body
    });
    
    let data = {};
    try { data = await res.json(); } catch {}
    
    if (!res.ok) {
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    
    if (!data.user) {
      $('#loginError').textContent = 'Invalid response from server';
      return;
    }
    
    if (data.sessionToken) {
      try { localStorage.setItem('pickr-session-token', data.sessionToken); } catch {}
    }
    bootUser(data.user);
  }catch(err){
    console.error('Full error:', err);
    $('#loginError').textContent = err.message || 'Login failed';
  } finally {
    submit.disabled=false; submit.textContent='Sign in';
  }
};

(async()=>{try{const {user}=await api('/api/me');bootUser(user)}catch{}})();
