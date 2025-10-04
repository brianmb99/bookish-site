// Bookish app.js (pure serverless variant)

// --- DOM refs ---
const statusEl = document.getElementById('status');
// status banner removed; we now write a single status line into the geek panel
const cardsEl = document.getElementById('cards');
const emptyEl = document.getElementById('empty');
const geekBtn = document.getElementById('geekBtn');
const geekPanel = document.getElementById('geekPanel');
const geekClose = document.getElementById('geekClose');
const geekBody = document.getElementById('geekBody');
const geekStatusLine = document.getElementById('geekStatusLine');
const modal = document.getElementById('modal');
// Funding modal refs
const fundModal = document.getElementById('fundingModal');
const fundClose = document.getElementById('fundClose');
const fundAddrEl = document.getElementById('fundAddr');
const fundCopyBtn = document.getElementById('fundCopy');
const fundL1El = document.getElementById('fundL1');
const fundIrysEl = document.getElementById('fundIrys');
const fundCostEl = document.getElementById('fundCost');
const fundMsgEl = document.getElementById('fundMsg');
const fundRefreshBtn = document.getElementById('fundRefresh');
const fundDoBtn = document.getElementById('fundDo');
const fundRetryBtn = document.getElementById('fundRetry');
// Account panel refs
const accountBtn = document.getElementById('accountBtn');
const accountPanel = document.getElementById('accountPanel');
const accountClose = document.getElementById('accountClose');
const acctAddr = document.getElementById('acctAddr');
const acctCopy = document.getElementById('acctCopy');
const acctL1 = document.getElementById('acctL1');
const acctCost = document.getElementById('acctCost');
const acctMsg = document.getElementById('acctMsg');
let lastFundTxHash=null;
const acctFundAddrResolved = document.getElementById('acctFundAddrResolved');
const acctNodeUrlDisplay = document.getElementById('acctNodeUrlDisplay');
const form = document.getElementById('entryForm');
const coverFileInput = document.getElementById('hiddenCoverInput');
const coverPreview = document.getElementById('coverPreview');
const tileCoverClick = document.getElementById('tileCoverClick');
const coverPlaceholder = document.getElementById('coverPlaceholder');
const saveBtn = document.getElementById('saveBtn');
const deleteBtn = document.getElementById('deleteBtn');
const cancelBtn = document.getElementById('cancelBtn');
const newBtn = document.getElementById('newBtn');
if(tileCoverClick && coverFileInput){ tileCoverClick.addEventListener('click',()=>coverFileInput.click()); }

// --- State ---
let entries=[]; let syncing=false; let replaying=false; let initialSynced=false;
const SERVERLESS=true;
let browserClient; let keyState={ loaded:false };
window.BOOKISH_DEBUG=true; function dbg(...a){ if(window.BOOKISH_DEBUG) console.debug('[Bookish]',...a); }

// --- Utility / ordering ---
function setStatus(m){ statusEl.textContent=m; if(window.BOOKISH_DEBUG) console.debug('[Bookish] status:', m); }
function orderEntries(){ entries.sort((a,b)=>{ const da=a.dateRead||''; const db=b.dateRead||''; if(da!==db) return db.localeCompare(da); if(a._committed!==b._committed) return a._committed?-1:1; return 0; }); }
function formatDisplayDate(iso){ if(!iso) return ''; const d=new Date(iso+'T00:00:00Z'); if(isNaN(d)) return iso; return d.toLocaleDateString(undefined,{month:'short',year:'numeric'}); }

// --- Modal helpers ---
function openModal(entry){
  modal.classList.add('active');
  // Ensure all inputs enabled (was previously gated by edit toggle)
  const inputs=[...form.querySelectorAll('input,select,textarea')];
  inputs.forEach(i=>{ if(i.name==='priorTxid') return; i.disabled=false; });
  // Populate fields
  form.priorTxid.value=entry?entry.txid:'';
  form.title.value=entry?entry.title:'';
  form.author.value=entry?entry.author:'';
  form.edition.value=entry?entry.edition:'';
  form.format.value=entry?entry.format:'paperback';
  form.dateRead.value=entry?entry.dateRead:new Date().toISOString().slice(0,10);
  if(entry&&entry.coverImage){
    coverPreview.src='data:'+(entry.mimeType||'image/*')+';base64,'+entry.coverImage;
    coverPreview.style.display='block'; coverPlaceholder.style.display='none';
    coverPreview.dataset.b64=entry.coverImage; if(entry.mimeType) coverPreview.dataset.mime=entry.mimeType;
  } else { coverPreview.style.display='none'; coverPlaceholder.style.display='block'; delete coverPreview.dataset.b64; delete coverPreview.dataset.mime; }
  // Delete button only for existing entry
  if(deleteBtn) deleteBtn.style.display=entry?'inline-flex':'none';
  if(cancelBtn) cancelBtn.style.display='inline-flex';
  // Dirty tracking snapshot
  snapshotOriginal();
  updateDirty();
  if(window.bookSearch) window.bookSearch.handleModalOpen(!!entry);
}
function closeModal(){ modal.classList.remove('active'); form.reset(); coverPreview.style.display='none'; delete form.dataset.orig; saveBtn.disabled=true; }
window.bookishApp={ openModal };
// Dirty tracking helpers
function currentFormState(){ return JSON.stringify({
  prior: form.priorTxid.value||'',
  title: form.title.value.trim(),
  author: form.author.value.trim(),
  edition: form.edition.value.trim(),
  format: form.format.value,
  dateRead: form.dateRead.value,
  cover: coverPreview.dataset.b64||''
}); }
function snapshotOriginal(){ form.dataset.orig = currentFormState(); }
function updateDirty(){ const orig=form.dataset.orig||''; const cur=currentFormState(); saveBtn.disabled = (orig===cur); }
if(!form._dirtyBound){
  form._dirtyBound=true;
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
}

// --- Cover file input ---
coverFileInput.addEventListener('change',()=>{ const f=coverFileInput.files[0]; if(!f) return; const r=new FileReader(); r.onload=e=>{ const b64full=e.target.result; const b64=b64full.split(',')[1]; coverPreview.src=b64full; coverPreview.style.display='block'; coverPlaceholder.style.display='none'; coverPreview.dataset.b64=b64; coverPreview.dataset.mime=f.type||'image/jpeg'; }; r.readAsDataURL(f); });

const closeModalBtn = document.getElementById('closeModal');
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', closeModal);

// --- Funding UI logic ---
let lastPendingOp=null;
function openFundingModal(pending){
  lastPendingOp = pending||lastPendingOp;
  if(fundModal) fundModal.classList.add('active');
  refreshFundingInfo().catch(()=>{});
}
function closeFundingModal(){ if(fundModal) fundModal.classList.remove('active'); }
async function refreshFundingInfo(){
  try{
    await (window.bookishWallet?.ensure?.());
    const addr = await (window.bookishWallet?.getAddress?.());
    if(addr) fundAddrEl.textContent = addr;
    // L1 balance
    const balWei = await (window.bookishWallet?.getBalance?.());
    if(balWei!=null){
      const eth = Number(balWei)/1e18; fundL1El.textContent = eth.toFixed(6)+' ETH';
    }
    // Irys balance removed from UI
    // Estimate current pending cost if payload present
    if(lastPendingOp && window.bookishIrys){
      try{
        // use estimator based on entry json size
        const bytes = await (browserClient?.estimateEntryBytes?.(lastPendingOp.payload) || window.bookishEstimate?.entryBytes?.(lastPendingOp.payload));
        if(bytes){
          const price = await window.bookishIrys.estimateCost(bytes);
          fundCostEl.textContent = `${bytes} bytes ≈ ${(Number(price)/1e18).toFixed(6)} ETH`;
        }
      }catch{}
    }
    fundMsgEl.textContent = '';
  }catch(e){ fundMsgEl.textContent = 'Unable to refresh balances'; }
}
fundClose?.addEventListener('click', closeFundingModal);
fundCopyBtn?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(fundAddrEl.textContent||''); fundMsgEl.textContent='Address copied'; }catch{} });
fundRefreshBtn?.addEventListener('click', ()=> refreshFundingInfo());
fundDoBtn?.addEventListener('click', async ()=>{
  fundDoBtn.disabled=true; fundMsgEl.textContent='Funding…';
  try{
    if(!lastPendingOp) throw new Error('no-pending');
    const bytes = await (browserClient?.estimateEntryBytes?.(lastPendingOp.payload) || window.bookishEstimate?.entryBytes?.(lastPendingOp.payload));
    if(!bytes) throw new Error('no-estimate');
    const price = await window.bookishIrys.estimateCost(bytes);
    await window.bookishIrys.fund(price.toString());
    fundMsgEl.textContent='Funded. You can retry publish now.';
    await refreshFundingInfo();
  }catch(e){ fundMsgEl.textContent='Funding failed.'; }
  finally{ fundDoBtn.disabled=false; }
});
fundRetryBtn?.addEventListener('click', async ()=>{
  if(!lastPendingOp){ fundMsgEl.textContent='Nothing to retry.'; return; }
  closeFundingModal();
  setStatus('Retrying publish…');
  try{
    if(lastPendingOp.type==='create'){
      await createServerless(lastPendingOp.payload);
    } else if(lastPendingOp.type==='edit'){
      await editServerless(lastPendingOp.priorTxid, lastPendingOp.payload);
    }
    lastPendingOp=null;
  }catch{ setStatus('Retry failed'); }
});

// --- Account panel logic ---
function openAccount(){ if(accountPanel) accountPanel.style.display='block'; refreshAccountInfo().catch(()=>{}); }
function closeAccount(){ if(accountPanel) accountPanel.style.display='none'; }
async function refreshAccountInfo(){
  try{
    await (window.bookishWallet?.ensure?.());
    const addr = await (window.bookishWallet?.getAddress?.());
    if(addr) acctAddr.textContent = addr;
  const balWei = await (window.bookishWallet?.getBalance?.());
  if(balWei!=null){ const eth = Number(balWei)/1e18; acctL1.textContent = eth.toFixed(6)+' ETH'; }
    // Irys balance removed from UI
    // Node URL display
    try{
      const url = (window.bookishIrys?.getNodeUrl?.()) || '';
      if(url) acctNodeUrlDisplay.textContent = url;
    }catch{}
    // Resolve funding address for manual on-chain funding (best-effort)
    try{
      const url = (window.bookishIrys?.getNodeUrl?.());
      const token = (window.bookishIrys?.getToken?.()) || 'base-eth';
      let addrResolved = null;
      if(url){
        const info = await fetch(url+`/info`).then(r=>r.ok?r.json():null).catch(()=>null);
        const map = (info && (info.addresses||info.fundingAddresses||info.wallets||info.currencies))||{};
        if(map[token]?.address) addrResolved = map[token].address; else if(typeof map[token]==='string') addrResolved = map[token];
      }
      if(acctFundAddrResolved) acctFundAddrResolved.textContent = addrResolved || '—';
    }catch{}
    acctMsg.textContent = '';
  }catch(e){ acctMsg.textContent = 'Unable to refresh balances'; }
}
accountBtn?.addEventListener('click', openAccount);
if(accountBtn){ accountBtn.onclick = openAccount; }
accountClose?.addEventListener('click', closeAccount);
acctCopy?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(acctAddr.textContent||''); acctMsg.textContent='Address copied'; }catch{} });

// No settings UI anymore; defaults used

// --- Render ---
function markDeletingVisual(entry){ entry._deleting=true; entry._committed=false; const el=document.querySelector('.card[data-txid="'+entry.txid+'"]'); if(el){ el.classList.add('deleting'); el.style.pointerEvents='none'; el.style.opacity='0.35'; } }
function render(){
  cardsEl.innerHTML='';
  if(!entries.length){ emptyEl.style.display='block'; return; } else emptyEl.style.display='none';
  for(const e of entries){
    if(e.status==='tombstoned') continue;
    const div=document.createElement('div');
    const rawFmt=(e.format||'').toLowerCase(); let fmtVariant=rawFmt==='audiobook'?'audio':(rawFmt==='ebook'?'ebook':'print');
    div.className='card'+(e._deleting?' deleting':''); div.dataset.txid=e.txid; div.dataset.fmt=fmtVariant; div.dataset.format=rawFmt;
    const dotClass=e._committed?'':'local'; const dateDisp=formatDisplayDate(e.dateRead);
    div.innerHTML=`
      <div class="status-dot ${dotClass}" ${networkStatusMode?"":"style=\"display:none\""} title="${dotClass==='local'?'Local only / unknown':'Confirmed (pending propagation)'}"></div>
      <div class="cover">${e.coverImage?`<img src="data:${e.mimeType||'image/jpeg'};base64,${e.coverImage}">`:'<span style="font-size:.55rem;opacity:.4">NO COVER</span>'}</div>
      <div class="meta">
        <p class="title">${e.title||'<i>Untitled</i>'}</p>
        <p class="author">${e.author||''}</p>
        <div class="details"><span class="read-date">Read ${dateDisp||''}</span></div>
      </div>`;
    div.onclick=()=>{ if(!e._deleting) openModal(e); };
    cardsEl.appendChild(div);
  }
  // Update dots based on network status mode
  setTimeout(updateNetDots,0);
}

let networkStatusMode=false;
async function updateNetDots(){
  if(!networkStatusMode){
    // revert to local-only indicator
    for(const e of entries){
      const card = cardsEl.querySelector(`.card[data-txid="${e.txid}"]`); if(!card) continue;
      const dot = card.querySelector('.status-dot'); if(!dot) continue;
      dot.style.display='none';
      dot.classList.remove('irys','arweave');
      dot.classList.add('local');
      dot.title='Local only / unknown';
    }
    return;
  }
  const ops=[];
  for(const e of entries){
    if(!e.txid) continue;
    const card = cardsEl.querySelector(`.card[data-txid="${e.txid}"]`); if(!card) continue;
    const dot = card.querySelector('.status-dot'); if(!dot) continue;
    dot.style.display='block';
    ops.push((async()=>{
      try{
        const rec = await (window.bookishNet?.probeAvailability?.(e.txid));
        dot.classList.remove('local','irys','arweave');
        if(rec?.arweave){ dot.classList.add('arweave'); dot.title='Visible on Arweave (final)'; }
        else if(rec?.irys){ dot.classList.add('irys'); dot.title='Seen via Irys (fast path)'; }
        else { dot.classList.add('local'); dot.title='Local only / unknown'; }
      }catch{
        dot.classList.remove('irys','arweave'); dot.classList.add('local'); dot.title='Local only / unknown';
      }
    })());
  }
  await Promise.allSettled(ops);
}

// --- Diagnostics status line (inside geek panel) ---
let diagItems=[]; let diagTimer=null; let diagIdx=0;
let diagTickTimer=null; let diagIdle=true;
function diagRender(){
  if(!geekStatusLine) return;
  if(!diagItems.length){ geekStatusLine.textContent=''; return; }
  geekStatusLine.textContent = String(diagItems[diagIdx % diagItems.length]);
}
function diagSet(items){
  diagItems = Array.isArray(items) ? items.filter(Boolean) : (items?[String(items)]:[]);
  diagIdx=0; diagRender();
  if(diagTimer) clearInterval(diagTimer);
  if(diagItems.length>1){ diagTimer=setInterval(()=>{ diagIdx=(diagIdx+1)%diagItems.length; diagRender(); }, 2500); }
  diagIdle=false;
}
function diagClear(){ diagItems=[]; if(diagTimer) clearInterval(diagTimer); diagTimer=null; diagRender(); diagIdle=true; }
function diagMaybeSet(items){ try{ if(typeof networkStatusMode!=='undefined' && networkStatusMode) diagSet(items); }catch{} }
function diagMaybeClear(){ try{ if(typeof networkStatusMode!=='undefined' && networkStatusMode) diagClear(); }catch{} }

function fmtCountdown(ms){ if(ms<=0) return 'now'; const s=Math.ceil(ms/1000); return s+'s'; }
function diagIdleSeed(){
  // If nothing active, show countdowns for next sync and next probe
  const now=Date.now();
  const nextSyncAt = (window.bookishNextSyncAt||0);
  const syncIn = Math.max(0, nextSyncAt - now);
  const nextProbeAt = (window.bookishNet?.nextProbeAt)||0;
  const probeIn = Math.max(0, nextProbeAt - now);
  const inflightIrys = (window.bookishNet?.irysInFlight)||0;
  const inflightAr = (window.bookishNet?.arweaveInFlight)||0;
  const probePart = inflightAr>0 ? 'Probing Arweave now…' : (probeIn<=0 ? 'Probing Arweave now…' : `Next Arweave probe in ${fmtCountdown(probeIn)}`);
  const syncPart = (syncing || inflightIrys>0) ? 'Syncing…' : `Next Irys sync in ${fmtCountdown(syncIn)}`;
  const line = `${syncPart}; ${probePart}`;
  // Do not flip to active; keep idle mode and recompute every tick
  diagItems=[line]; diagRender();
}

// --- Key handling ---
async function ensureKeys(){
  if(keyState.loaded) return true;
  let symTxt=localStorage.getItem('bookish.sym');
  if(!symTxt){ const sym=prompt('Paste symmetric key hex (64 chars)'); if(!sym){ setStatus('Sym key missing'); return false; } if(!/^[0-9a-fA-F]{64}$/.test(sym.trim())){ alert('Bad symmetric key format'); return false; } localStorage.setItem('bookish.sym',sym.trim()); symTxt=sym.trim(); }
  try { const sym=localStorage.getItem('bookish.sym'); if(window.createBrowserClient){ browserClient=await window.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } else if(window.bookishBrowserClient){ browserClient=await window.bookishBrowserClient.createBrowserClient({ symKeyHex:sym, appName:'bookish', schemaVersion:'0.1.0', keyId:'default' }); } if(!browserClient){ setStatus('Client loading…'); return false; } keyState.loaded=true; const addr=await browserClient.address(); setStatus('EVM '+(addr?addr.slice(0,8)+'…':'ready')); return true; } catch(e){ console.error(e); setStatus('Key load error'); return false; }
}

// --- Arweave queries ---
async function serverlessFetchEntries(){ if(!browserClient) return { entries:[], tombstones:[] }; const owner=null; let allEdges=[]; let cursor=undefined; let safety=0; const PAGE=50; for(;;){ const { edges, pageInfo } = await browserClient.searchByOwner(owner,{limit:PAGE,cursor}); allEdges.push(...edges); if(!pageInfo.hasNextPage) break; cursor=edges[edges.length-1]?.cursor; if(++safety>40) break; } const { liveEdges, tombstones } = browserClient.computeLiveSets(allEdges); const hydrated=[]; for(const e of liveEdges){ try{ const dec=await browserClient.decryptTx(e.node.id); hydrated.push({ txid:e.node.id, ...dec, block:e.node.block }); }catch{} } hydrated.sort((a,b)=>{ const da=a.dateRead||'0000-00-00'; const db=b.dateRead||'0000-00-00'; if(da!==db) return db.localeCompare(da); const ha=(a.block&&a.block.height)||0; const hb=(b.block&&b.block.height)||0; return hb-ha; }); return { entries:hydrated, tombstones }; }

// --- Ops replay ---
async function replayOps(){
  if(replaying) return; replaying=true;
  try{
    const ops=await window.bookishCache.listOps();
    if(!ops.length) return;
  diagMaybeSet(['Replaying pending changes…']);
    for(const op of ops){
      if(op.type==='create'){
        const local=entries.find(e=>e.id===op.localId);
        if(!local){ await window.bookishCache.removeOp(op.id); continue; }
        if(local.txid){ await window.bookishCache.removeOp(op.id); continue; }
        try {
          const res=await browserClient.uploadEntry(op.payload,{});
          const oldId=local.id; local.txid=res.txid; local.id=res.txid; local.pending=false; local.status='confirmed';
          await window.bookishCache.replaceProvisional(oldId,local);
          await window.bookishCache.removeOp(op.id);
          setStatus('Republished '+(local.title||''));
          orderEntries(); render();
        } catch{
          setStatus('Replay pending…');
          diagMaybeSet(['Awaiting Irys credit…','Will retry automatically']);
          break;
        }
      }
    }
  } finally {
    replaying=false;
  if(!syncing) diagMaybeClear();
  }
}

// --- Sync ---
async function syncRemote(manual){ if(syncing) return; syncing=true; if(manual) setStatus('Refreshing…'); else if(!initialSynced) setStatus('Syncing…'); diagMaybeSet(['Syncing…']); try { await replayOps(); const have=await ensureKeys(); if(!have){ entries=await window.bookishCache.getAllActive(); orderEntries(); render(); setStatus('Read-only'); diagMaybeClear(); return; } const { entries:remoteEntries, tombstones } = await serverlessFetchEntries(); if(window.BOOKISH_DEBUG) console.debug('[Bookish] fetched remote entries:', remoteEntries.length, 'tombstones:', tombstones.length);
  const remote=remoteEntries.map(e=>({ ...e, status:'confirmed', id:e.txid })); entries=await window.bookishCache.applyRemote(remote, tombstones); entries.forEach(e=> e._committed=true); orderEntries(); render(); initialSynced=true; setStatus('Synced'); if(typeof networkStatusMode!=='undefined' && networkStatusMode) setTimeout(updateNetDots, 50);
  diagMaybeClear();
} catch(err){ console.warn('[Bookish] sync error:', err); if(!initialSynced) setStatus('Offline (cached)'); else setStatus('Sync issue'); diagMaybeSet(['Sync issue – working offline','Will retry shortly']); } finally { syncing=false; const due=Date.now()+60000; window.bookishNextSyncAt=due; setTimeout(()=>syncRemote(),60000); } }

// --- Create / edit / delete ---
async function createServerless(payload){ if(window.bookishCache){ const dup=await window.bookishCache.detectDuplicate(payload); if(dup){ setStatus('Duplicate (existing entry)'); const el=cardsEl.querySelector('[data-txid="'+(dup.txid||dup.id)+'"]'); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('pulse'); setTimeout(()=>el.classList.remove('pulse'),1500);} return; } }
  const localId='local-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const rec={id:localId, txid:null, ...payload, createdAt:Date.now(), status:'pending', pending:true, _committed:false};
  entries.push(rec); if(window.bookishCache) window.bookishCache.putEntry(rec); orderEntries(); render();
  try {
    // Ensure hidden EVM wallet exists before upload
    if(window.bookishWallet?.ensure){ const ensured = await window.bookishWallet.ensure(); if(window.BOOKISH_DEBUG) console.debug('[Bookish] wallet ensure:', ensured, await window.bookishWallet.getAddress()); }
    if(window.BOOKISH_DEBUG) console.debug('[Bookish] uploadEntry start');
  diagMaybeSet(['Publishing via Irys…','If funding is needed, you’ll be prompted']);
    const res=await browserClient.uploadEntry(payload,{});
    if(window.BOOKISH_DEBUG) console.debug('[Bookish] uploadEntry ok:', res);
    const oldId=rec.id; rec.txid=res.txid; rec.id=res.txid; rec.pending=false; rec.status='confirmed';
    if(window.bookishCache) await window.bookishCache.replaceProvisional(oldId,rec);
    orderEntries(); render(); setStatus((res&&res.irys)?'Published via Irys (pending)':'Published (pending)');
  diagMaybeClear();
    if(typeof networkStatusMode!=='undefined' && networkStatusMode) setTimeout(updateNetDots, 50);
  } catch(e){
    console.warn('[Bookish] uploadEntry error:', e);
    if(e && (e.code==='funding-required' || e.code==='irys-required')){
      // Queue op and nudge user to Account panel
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
  setStatus('Funding required: open Account to fund, then refresh and retry.');
  diagMaybeSet(['Funding required (402)','Open Account to fund, then retry']);
    } else if(e && e.code==='post-fund-timeout'){
      // We funded, but node hasn't credited yet. Keep the op queued and inform the user.
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
      setStatus('Funding sent. Credit pending on Irys (can take a few minutes). Try again shortly from Account.');
  diagMaybeSet(['Funding sent – awaiting credit','Retry from Account shortly']);
    } else if(e && (e.code==='base-insufficient-funds' || e.code==='base-insufficient-funds-recent')){
      // Wallet lacks L1 ETH to fund bundler; queue op and prompt manual top-up
      const pending = { type:'create', localId:rec.id, payload };
      if(window.bookishCache) await window.bookishCache.queueOp(pending);
      lastPendingOp = pending;
      setStatus('Your Base wallet is low on ETH. Add a small amount and retry from Account.');
  diagMaybeSet(['Base wallet low on ETH','Add a small amount, then retry']);
    } else {
      setStatus('Queued (offline)');
      await window.bookishCache.queueOp({ type:'create', localId:rec.id, payload });
  diagMaybeSet(['Offline – queued for publish']);
    }
  }
}
async function editServerless(priorTxid,payload){ const old=entries.find(e=>e.txid===priorTxid); if(!old) throw new Error('Entry not found'); const snapshot={...old}; Object.assign(old,payload); old.pending=true; old.status='pending'; old._committed=false; await window.bookishCache.putEntry(old); orderEntries(); render(); try { payload.bookId=old.bookId; diagMaybeSet(['Saving via Irys…']); const res=await browserClient.uploadEntry({ ...payload },{ extraTags:[{name:'Prev',value:priorTxid}] }); const oldTxid=priorTxid; old.txid=res.txid; old.id=res.txid; old.pending=false; old.status='confirmed'; await window.bookishCache.replaceProvisional(oldTxid,old); orderEntries(); render(); setStatus((res&&res.irys)?'Saved via Irys (pending)':'Saved (pending)'); diagMaybeClear(); } catch(e){ if(e && (e.code==='funding-required' || e.code==='irys-required')){ // revert UI and prompt funding
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    setStatus('Funding required: open Account to fund, then retry.');
  diagMaybeSet(['Funding required (402)','Open Account to fund, then retry']);
  } else if(e && e.code==='post-fund-timeout'){
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    setStatus('Funding sent. Credit pending on Irys (few minutes). Retry from Account shortly.');
  diagMaybeSet(['Funding sent – awaiting credit','Retry from Account shortly']);
  } else if(e && (e.code==='base-insufficient-funds' || e.code==='base-insufficient-funds-recent')){
    Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render();
    const pending = { type:'edit', priorTxid, payload };
    lastPendingOp = pending;
    setStatus('Your Base wallet is low on ETH. Top up and retry from Account.');
  diagMaybeSet(['Base wallet low on ETH','Add a small amount, then retry']);
  } else { Object.assign(old,snapshot); await window.bookishCache.putEntry(old); orderEntries(); render(); setStatus('Save failed'); diagMaybeSet(['Save failed']); } } }
async function deleteServerless(priorTxid){ const entry=entries.find(e=>e.txid===priorTxid); if(!entry) return; markDeletingVisual(entry); setStatus('Deleting…'); try { await browserClient.tombstone(priorTxid,{ note:'user delete' }); entry.status='tombstoned'; entry.tombstonedAt=Date.now(); await window.bookishCache.putEntry(entry); entries=entries.filter(e=>e.status!=='tombstoned'); orderEntries(); render(); setStatus('Deleted (pending)'); } catch{ entry._deleting=false; render(); setStatus('Delete failed'); } }

// --- Form handlers ---
form.addEventListener('submit',ev=>{ ev.preventDefault(); const priorTxid=form.priorTxid.value||undefined; const payload={ title:form.title.value.trim(), author:form.author.value.trim(), edition:form.edition.value.trim(), format:form.format.value, dateRead:form.dateRead.value }; if(coverPreview.dataset.b64){ payload.coverImage=coverPreview.dataset.b64; if(coverPreview.dataset.mime) payload.mimeType=coverPreview.dataset.mime; } setStatus(priorTxid?'Saving edit…':'Publishing…'); if(priorTxid){ // immediate close, background edit
  closeModal();
  editServerless(priorTxid,payload).catch(()=> setStatus('Save failed'));
} else { closeModal(); createServerless(payload).catch(()=> setStatus('Save failed')); }
});

deleteBtn?.addEventListener('click', async ()=>{ const txid=form.priorTxid.value; if(!txid) return; closeModal(); await deleteServerless(txid); });

// header refresh removed; app auto-syncs

newBtn?.addEventListener('click', ()=>openModal(null));

// --- Cache layer ---
async function initCacheLayer(){ if(window.bookishCache){ await window.bookishCache.initCache(); entries=await window.bookishCache.getAllActive(); entries.forEach(e=>{ e._committed=!!(e.status==='confirmed'&&e.seenRemote); }); orderEntries(); render(); setStatus('Cached'); syncRemote(); } }

// --- Status & sync bootstrap ---
async function loadStatus(){ const have=await ensureKeys(); if(!have){ setStatus('Serverless (read-only)'); return; } try { const owner=await browserClient.address(); setStatus('Owner '+owner.slice(0,8)+'…'); } catch{ setStatus('Key error'); } }

// --- Init ---
window.bookishNextSyncAt = Date.now() + 60000;
loadStatus(); initCacheLayer(); setTimeout(()=>syncRemote(),300);
// Initialize hidden EVM wallet (ensures presence once sym key exists) and show address hint
(async function initWallet(){ try { const ok = await (window.bookishWallet?.ensure?.()); const addr = await (window.bookishWallet?.getAddress?.()); if(addr){ setStatus((statusEl.textContent?statusEl.textContent+' • ':'')+'EVM '+addr.slice(0,6)+'…'); } } catch{} })();
window.addEventListener('online',()=>{ setStatus('Online – syncing'); replayOps().then(()=>syncRemote(true)); });

// --- Geek panel wiring ---
function updateGeekPanel(){
  if(!geekBody) return;
  const net = window.bookishNet || { reads:{ irys:0, arweave:0, errors:0 } };
  geekBody.textContent = `Reads – Irys: ${net.reads.irys||0}, Arweave: ${net.reads.arweave||0}, Errors: ${net.reads.errors||0}`;
}
if(geekBtn && geekPanel && geekClose){
  geekBtn.addEventListener('click',()=>{
    const open = (geekPanel.style.display==='none' || !geekPanel.style.display);
    geekPanel.style.display = open?'block':'none';
    updateGeekPanel();
    // Toggle network status mode with panel
    if(typeof networkStatusMode!=='undefined') networkStatusMode = open;
    if(window.BOOKISH_DEBUG) console.debug('[Bookish] network status mode:', networkStatusMode);
    setTimeout(()=>{ if(typeof updateNetDots==='function') updateNetDots(); }, 10);
    if(!open){
      diagClear(); if(diagTickTimer) { clearInterval(diagTickTimer); diagTickTimer=null; }
    } else {
      diagIdle=true; diagIdleSeed();
      if(diagTickTimer) clearInterval(diagTickTimer);
      diagTickTimer=setInterval(()=>{ if(diagIdle) diagIdleSeed(); else diagRender(); }, 1000);
    }
  });
  geekClose.addEventListener('click',()=>{ geekPanel.style.display='none'; if(typeof networkStatusMode!=='undefined') networkStatusMode=false; diagClear(); if(diagTickTimer){ clearInterval(diagTickTimer); diagTickTimer=null; } setTimeout(()=>{ if(typeof updateNetDots==='function') updateNetDots(); }, 10); });
  setInterval(()=>{ updateGeekPanel(); if(typeof networkStatusMode!=='undefined' && networkStatusMode) updateNetDots(); }, 5000);
}

// --- Pinch / wheel zoom (restore) ---
(function enableMobilePinch(){
  let cols=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mobile-columns')||'2',10);
  function clamp(n){ return Math.min(3, Math.max(1,n)); }
  function apply(){
    document.documentElement.style.setProperty('--mobile-columns', String(cols));
    document.documentElement.dataset.cols=String(cols);
    const scale = cols===1?1.15:(cols===2?1:0.82);
    document.documentElement.style.setProperty('--mobile-scale', scale);
  }
  let pinchStartDist=null; let startCols=cols;
  function dist(t1,t2){ const dx=t1.clientX-t2.clientX, dy=t1.clientY-t2.clientY; return Math.hypot(dx,dy); }
  window.addEventListener('touchstart',e=>{ if(e.touches.length===2){ pinchStartDist=dist(e.touches[0],e.touches[1]); startCols=cols; } });
  window.addEventListener('touchmove',e=>{ if(e.touches.length===2 && pinchStartDist){ const d=dist(e.touches[0],e.touches[1]); const scale=d/pinchStartDist; const target = scale>1? Math.round(startCols - (scale-1)*1.2): Math.round(startCols + (1-scale)*1.2); const next=clamp(target); if(next!==cols){ cols=next; apply(); } e.preventDefault(); } }, { passive:false });
  window.addEventListener('touchend',()=>{ pinchStartDist=null; });
  window.addEventListener('wheel',e=>{ if(!e.ctrlKey) return; e.preventDefault(); cols=clamp(cols + (e.deltaY>0?1:-1)); apply(); }, { passive:false });
  apply();
})();
