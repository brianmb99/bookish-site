// book_search.js
// Lightweight module to search OpenLibrary and populate the entry form
(function(){
  const form=document.getElementById('entryForm'); if(!form) return; const coverPreview=document.getElementById('coverPreview');
  const ui=document.getElementById('bookSearchUI'); const input=document.getElementById('bookSearchInput'); const resultsEl=document.getElementById('bookSearchResults');
  const editionNav=document.getElementById('editionNav'); const prevBtn=document.getElementById('prevEdition'); const nextBtn=document.getElementById('nextEdition'); const editionInfo=document.getElementById('editionInfo');
  const controls=document.getElementById('searchControls');
  let sortMode='relevance'; let activeFilter='all';
  // precision state
  let lastQuery=''; let queryTokens=[]; let strictActive=false; // whether strict pass produced results
  const STOPWORDS=new Set(['the','and','of','a','an','to','in','on','for','by','with','at','from']);
  // storage
  let olDocs=[]; let itunesItems=[]; // raw combined after merge
  let debounceTimer=null; let currentWork=null; let currentAudio=null; let editions=[]; let editionIndex=0;
  function markDirty(){ try{ form.dispatchEvent(new Event('input',{bubbles:true})); }catch{} }
  function showUI(isEdit){ ui.style.display=isEdit?'none':'block'; if(isEdit) clearSearchState(); }
  function clearSearchState(){ currentWork=null; currentAudio=null; editions=[]; editionIndex=0; input.value=''; resultsEl.innerHTML=''; resultsEl.style.display='none'; editionNav.style.display='none'; if(controls) controls.style.display='none'; lastQuery=''; queryTokens=[]; strictActive=false; }
  function baseTitle(q){ const idx=q.indexOf(':'); return idx>2 ? q.slice(0,idx).trim() : q.trim(); }
  function tokenize(q){ return q.toLowerCase().split(/[^a-z0-9]+/).filter(t=> t && t.length>2 && !STOPWORDS.has(t)); }
  function prepareQuery(q){ lastQuery=q.trim(); queryTokens=tokenize(lastQuery); }
  async function searchTitle(q){ q=q.trim(); if(!q){ clearResults(); return; } prepareQuery(q); resultsEl.style.display='block'; resultsEl.innerHTML='<div style="opacity:.5">Searching…</div>'; const termFull=encodeURIComponent(q); const base=baseTitle(q);
    const titleUrl = 'https://openlibrary.org/search.json?title='+encodeURIComponent(base)+'&limit=50';
    const broadUrl = 'https://openlibrary.org/search.json?q='+encodeURIComponent(q)+'&limit=50';
    Promise.all([
      fetch(titleUrl).then(r=>r.json().then(j=>({ ok:r.ok, ...j })).catch(()=>({ ok:false, docs:[] }))).catch(()=>({ ok:false, docs:[] })),
      fetch(broadUrl).then(r=>r.json().then(j=>({ ok:r.ok, ...j })).catch(()=>({ ok:false, docs:[] }))).catch(()=>({ ok:false, docs:[] })),
      fetch('https://itunes.apple.com/search?media=audiobook&term='+termFull+'&limit=25').then(r=>r.json()).catch(()=>({results:[]}))
    ]).then(([olTitle, olBroad, it])=>{ const failTitle=!olTitle.ok; const failBroad=!olBroad.ok; mergeOpenLibrary((olTitle.docs)||[], (olBroad.docs)||[]); itunesItems = (it.results||[]); if(controls) controls.style.display = (olDocs.length+itunesItems.length)?'flex':'none'; computeScoring(); renderCombined({failTitle,failBroad}); }); }
  function clearResults(){ resultsEl.innerHTML=''; resultsEl.style.display='none'; if(controls) controls.style.display='none'; }
  function mergeOpenLibrary(listA,listB){ const map=new Map(); function add(d,src){ if(!d || !d.key) return; if(!map.has(d.key)){ map.set(d.key,{...d,_src:src}); } else { // merge publish_year arrays
      const ex=map.get(d.key); if(Array.isArray(d.publish_year)){ ex.publish_year = Array.isArray(ex.publish_year)? [...new Set(ex.publish_year.concat(d.publish_year))]: d.publish_year; }
      if(!ex.subtitle && d.subtitle) ex.subtitle=d.subtitle;
      if(ex._src!==src) ex._src='both';
    }} listA.forEach(d=>add(d,'title')); listB.forEach(d=>add(d,'broad')); olDocs=Array.from(map.values()); }
  function enrich(){ olDocs.forEach(d=>{ if(d._yearComputed!==undefined) return; let y=0; if(Array.isArray(d.publish_year)&&d.publish_year.length){ y=Math.max(...d.publish_year); } else if(d.first_publish_year) y=d.first_publish_year; d._yearComputed=y||0; }); itunesItems.forEach(i=>{ if(i._yearComputed===undefined){ i._yearComputed = i.releaseDate? parseInt(i.releaseDate.slice(0,4),10)||0 : 0; } }); }
  // scoring & strict filtering
  function computeScoring(){ if(!queryTokens.length){ strictActive=false; return; } const tokens=queryTokens; const tokenSet=new Set(tokens); let anyStrict=false;
    function scoreFields(title, subtitle, author){ const fullTitle=(title||'') + (subtitle?(' '+subtitle):''); const lower=fullTitle.toLowerCase(); const lowerAuthor=(author||'').toLowerCase(); let coverage=0; let presentTokens=0; tokens.forEach(t=>{ if(lower.includes(t) || lowerAuthor.includes(t)){ presentTokens++; } }); coverage=presentTokens / tokens.length; // 0..1
      const exactEq = lower.trim()===lastQuery.toLowerCase()?1:0; const starts = lower.startsWith(lastQuery.toLowerCase())?1:0; const phrase = lower.includes(lastQuery.toLowerCase())?1:0; let score = coverage*100 + exactEq*150 + starts*40 + phrase*25; return {score, coverage, lowerTitle:lower}; }
    olDocs.forEach(d=>{ const a=(d.author_name&&d.author_name[0])||''; const {score,coverage}=scoreFields(d.title,d.subtitle,a); d._score=score + (d._yearComputed||0)* (sortMode==='relevance'?0.02:0); // slight recency influence
      d._coverage=coverage; // strict candidate if all tokens covered in title/subtitle (ignore author unless needed)
      const titleBlob=((d.title||'')+' '+(d.subtitle||'')).toLowerCase(); let strictOk=true; tokens.forEach(t=>{ if(!titleBlob.includes(t)) strictOk=false; }); d._strict=strictOk && tokens.length>0; if(d._strict) anyStrict=true; });
    itunesItems.forEach(i=>{ const title=i.collectionName||i.trackName||''; const author=i.artistName||''; const {score,coverage}=scoreFields(title,null,author); i._score=score + (i._yearComputed||0)*(sortMode==='relevance'?0.02:0); i._coverage=coverage; let titleBlob=title.toLowerCase(); let strictOk=true; tokens.forEach(t=>{ if(!titleBlob.includes(t)) strictOk=false; }); i._strict=strictOk && tokens.length>0; if(i._strict) anyStrict=true; });
    strictActive=anyStrict; }
  function highlight(text){ if(!queryTokens.length) return text; let html=text; queryTokens.forEach(t=>{ const re=new RegExp('('+t.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+')','ig'); html=html.replace(re,'<mark>$1</mark>'); }); return html; }
  function passesFilter(item){ if(activeFilter==='all') return true; if(item._isItunes){ return activeFilter==='audiobook'; } // OL filters by physical format guess
    if(activeFilter==='audiobook'){ return (item.physical_format||'').toLowerCase().includes('audio'); }
    if(activeFilter==='paperback'){ return (item.physical_format||'').toLowerCase().includes('paper'); }
    if(activeFilter==='hardcover'){ return (item.physical_format||'').toLowerCase().includes('hard'); }
    return true; }
  function sorted(){ enrich(); let baseOl=olDocs.slice(); let baseIt=itunesItems.slice(); if(strictActive){ baseOl=baseOl.filter(d=>d._strict); baseIt=baseIt.filter(i=>i._strict); }
    // apply filter first
    let ol=baseOl.filter(passesFilter); let it = baseIt.filter(()=> activeFilter==='all' || activeFilter==='audiobook'); if(activeFilter!=='audiobook' && activeFilter!=='all'){ it=[]; }
    if(sortMode==='newest'){ ol=[...ol].sort((a,b)=> (b._yearComputed||0)-(a._yearComputed||0)); it=[...it].sort((a,b)=> (b._yearComputed||0)-(a._yearComputed||0)); }
    else { // relevance mode: sort by _score desc then year desc
      ol=[...ol].sort((a,b)=> (b._score||0)-(a._score||0) || (b._yearComputed||0)-(a._yearComputed||0));
      it=[...it].sort((a,b)=> (b._score||0)-(a._score||0) || (b._yearComputed||0)-(a._yearComputed||0));
    }
    return { ol,it }; }
  function renderCombined(flags){ const failTitle=flags&&flags.failTitle; const failBroad=flags&&flags.failBroad; const {ol,it}=sorted(); const rows=[]; if(failTitle && failBroad){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px;color:#f87171">OpenLibrary unavailable (showing audio only / cached broader results if any).</div>'); }
    if(!ol.length && !it.length){ if(strictActive){ resultsEl.innerHTML='<div style="opacity:.5">No exact matches.</div>'; return; } resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; }
    if(!strictActive && queryTokens.length){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px">No exact title match; showing broader results.</div>'); }
    if(failTitle && !failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Exact title search failed (fallback used).</div>'); }
    if(!failTitle && failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Broad search unavailable (exact only).</div>'); }
    ol.forEach(d=>{ const title=(d.title||''); const sub=d.subtitle?(': '+d.subtitle):''; const safe=(title).replace(/</g,'&lt;'); const safeSub=sub.replace(/</g,'&lt;'); const combined=highlight(safe+safeSub); const author=(d.author_name&&d.author_name[0])?d.author_name[0]:''; const safeAuthor=highlight(author.replace(/</g,'&lt;')); const yr=d._yearComputed?` <span style="opacity:.45">${d._yearComputed}</span>`:''; const broadBadge = d._src==='broad' ? '<span class="src" style="background:#555">B</span>' : (d._src==='both' ? '<span class="src" style="background:#444">M</span>' : ''); const metaTitle=(d.title||'')+ (d.subtitle?(': '+d.subtitle):''); rows.push(`<div class="res" data-src="ol" data-work='${d.key}' data-cover='${d.cover_i||''}' data-json='${encodeURIComponent(JSON.stringify({title:metaTitle,author,cover_i:d.cover_i||'',work_key:d.key}))}'>${combined} <span style="opacity:.6">${safeAuthor}</span>${yr}<span class="src src-ol">OL</span>${broadBadge}</div>`); });
    it.forEach(item=>{ const title=(item.collectionName||item.trackName||''); const safe=highlight(title.replace(/</g,'&lt;')); const author=(item.artistName||'').replace(/</g,'&lt;'); const safeAuthor=highlight(author); const year=item._yearComputed||''; const payload={ title, author, year: year?String(year):'', artwork:item.artworkUrl100||'', narrator: author, rawNarrators: author }; rows.push(`<div class="res" data-src="it" data-json='${encodeURIComponent(JSON.stringify(payload))}'>${safe} <span style="opacity:.6">${safeAuthor}${year?(' • '+year):''}</span><span class="src src-it">IT</span></div>`); }); if(!rows.length){ resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; } resultsEl.innerHTML=rows.slice(0,60).join(''); }
  function selectWork(meta){ currentAudio=null; currentWork=meta; editions=[]; editionIndex=0; editionNav.style.display='none'; populateFromBasic(meta); fetchEditions(meta); }
  async function fetchEditions(meta){ try{ const url='https://openlibrary.org'+meta.work_key+'/editions.json?limit=50'; const r=await fetch(url); const j=await r.json(); editions=(j.entries||j.editions||[]).filter(e=>e); if(editions.length){ editionIndex=0; editionNav.style.display='flex'; applyEdition(); } }catch(e){} }
  async function selectItunes(payload){ currentWork=null; editions=[]; editionIndex=0; editionNav.style.display='none'; currentAudio=payload; let changed=false; if(!form.title.value){ form.title.value=payload.title; changed=true; } if(!form.author.value){ form.author.value=payload.author; changed=true; } if(payload.year){ form.edition.value = payload.year; changed=true; }
    const fmtSel=Array.from(form.format.options).find(o=>o.value==='audiobook'); if(fmtSel){ form.format.value='audiobook'; changed=true; } if(changed) markDirty(); if(payload.artwork){ const hi=payload.artwork.replace(/100x100/,'600x600'); try{ const resp=await fetch(hi); if(resp.ok){ const blob=await resp.blob(); const b64=await blobToBase64(blob); coverPreview.src=b64; coverPreview.style.display='block'; coverPreview.dataset.b64=b64.split(',')[1]; coverPreview.dataset.mime=blob.type||'image/jpeg'; const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none'; markDirty(); } }catch(e){} } }
  function populateFromBasic(meta){ if(!meta) return; let changed=false; if(!form.title.value){ form.title.value=meta.title||''; changed=true; } if(!form.author.value && meta.author){ form.author.value=meta.author; changed=true; } if(changed) markDirty(); if(meta.cover_i) loadCoverById(meta.cover_i); }
  
  function applyEdition(){ if(!editions.length) return; const ed=editions[editionIndex]; let changed=false; if(ed.title){ form.title.value=ed.title; changed=true; } if(ed.authors&&ed.authors.length){ const names=ed.authors.map(a=> a.name || a.author && a.author.key || '').filter(Boolean); if(names.length){ form.author.value=names.join(', '); changed=true; } } if(ed.publish_date){ form.edition.value=ed.publish_date; changed=true; } else if(ed.edition_name){ form.edition.value=ed.edition_name; changed=true; } if(ed.physical_format){ const fmt=(ed.physical_format||'').toLowerCase(); const opts=Array.from(form.format.options).map(o=>o.value); const match=opts.find(o=>fmt.includes(o)); if(match){ form.format.value=match; changed=true; } } if(changed) markDirty(); if(ed.covers&&ed.covers.length) loadCoverById(ed.covers[0]); editionInfo.textContent=`Edition ${editionIndex+1} / ${editions.length}`; prevBtn.disabled=editionIndex===0; nextBtn.disabled=editionIndex===editions.length-1; }
  form && form.addEventListener('booksearch:applied', markDirty);
  async function loadCoverById(id){ try{ if(!id) return; const url=`https://covers.openlibrary.org/b/id/${id}-L.jpg`; const resp=await fetch(url); if(!resp.ok) return; const blob=await resp.blob(); const b64=await blobToBase64(blob); coverPreview.src=b64; coverPreview.style.display='block'; coverPreview.dataset.b64=b64.split(',')[1]; coverPreview.dataset.mime=blob.type||'image/jpeg'; markDirty(); }catch(e){} }
  function blobToBase64(blob){ return new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob); }); }
  input.addEventListener('input',()=>{ if(debounceTimer) clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>searchTitle(input.value),350); });
  resultsEl.addEventListener('click',e=>{ const div=e.target.closest('div.res'); if(!div) return; resultsEl.style.display='none'; const src=div.dataset.src; try{ const meta=JSON.parse(decodeURIComponent(div.dataset.json)); if(src==='ol') selectWork(meta); else if(src==='it') selectItunes(meta); }catch(err){} });
  prevBtn.addEventListener('click',()=>{ if(editionIndex>0){ editionIndex--; applyEdition(); }}); nextBtn.addEventListener('click',()=>{ if(editionIndex<editions.length-1){ editionIndex++; applyEdition(); }});
  if(controls){ controls.addEventListener('click',e=>{ const f=e.target.closest('.filter-btn'); const s=e.target.closest('.sort-btn'); if(f){ const val=f.dataset.filter; if(val && val!==activeFilter){ activeFilter=val; controls.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.filter===activeFilter)); renderCombined(); } }
    if(s){ const mode=s.dataset.mode; if(mode && mode!==sortMode){ sortMode=mode; controls.querySelectorAll('.sort-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===sortMode)); renderCombined(); } }
  }); }
  window.bookSearch={ handleModalOpen(isEdit){ showUI(isEdit); } };
})();
//# sourceMappingURL=book_search.js.map
