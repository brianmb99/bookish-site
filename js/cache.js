// cache.js - IndexedDB based local cache & sync layer
(function(){
  const DB_NAME='bookish';
  const DB_VERSION=1;
  const ENTRY_STORE='entries';
  const OPS_STORE='ops'; // future use (queued mutations)

  function openDB(){
    return new Promise((res,rej)=>{
      const req=indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded=e=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(ENTRY_STORE)){
          const s=db.createObjectStore(ENTRY_STORE,{keyPath:'id'});
          s.createIndex('txid','txid',{unique:true});
          s.createIndex('contentHash','contentHash',{unique:false});
        }
        if(!db.objectStoreNames.contains(OPS_STORE)){
          db.createObjectStore(OPS_STORE,{keyPath:'id'});
        }
      };
      req.onsuccess=()=>res(req.result);
      req.onerror=()=>rej(req.error);
    });
  }

  async function withStore(mode, storeName, fn){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(storeName, mode);
      tx.onabort=()=>rej(tx.error);
      tx.onerror=()=>rej(tx.error);
      const store=tx.objectStore(storeName);
      Promise.resolve(fn(store)).then(val=>{ tx.oncomplete=()=>res(val); }).catch(rej);
    });
  }

  async function sha256Hex(str){ const enc=new TextEncoder().encode(str); const buf=await crypto.subtle.digest('SHA-256',enc); return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join(''); }
  async function computeContentHash(entry){ const base=(entry.title||'')+'|'+(entry.author||'')+'|'+(entry.edition||'')+'|'+(entry.format||'')+'|'+(entry.dateRead||''); return 'sha256-'+await sha256Hex(base); }
  async function ensureContentHash(e){ if(!e.contentHash || !e.contentHash.startsWith('sha256-')){ e.contentHash=await computeContentHash(e); } return e; }
  async function putEntry(e){ await ensureContentHash(e); return withStore('readwrite', ENTRY_STORE, store=> store.put(e)); }
  async function bulkPut(entries){ return withStore('readwrite', ENTRY_STORE, store=>{ entries.forEach(async e=>{ await ensureContentHash(e); store.put(e); }); }); }
  async function findByContentHash(h){ if(!h) return null; return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const idx=store.index('contentHash'); let found=null; const req=idx.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ if(cur.value.contentHash===h){ found=cur.value; r(found); return; } cur.continue(); } else r(found); }; })); }
  async function getAllActive(){
    return withStore('readonly', ENTRY_STORE, store=>{
      return new Promise(r=>{
        const entries=[]; const req=store.openCursor();
        req.onsuccess=e=>{ const cur=e.target.result; if(cur){ if(cur.value.status!=='tombstoned') entries.push(cur.value); cur.continue(); } else r(entries); };
      });
    });
  }
  async function markTombstoned(txid){ if(!txid) return; const rec=await findByTxid(txid); if(rec){ rec.status='tombstoned'; rec.tombstonedAt=Date.now(); await putEntry(rec); } }
  async function removeOldTombstones(days=7){
    const cutoff=Date.now()-days*86400000;
    return withStore('readwrite', ENTRY_STORE, store=> new Promise(r=>{
      const req=store.openCursor();
      req.onsuccess=e=>{ const cur=e.target.result; if(cur){ const v=cur.value; if(v.status==='tombstoned' && v.tombstonedAt && v.tombstonedAt<cutoff){ cur.delete(); } cur.continue(); } else r(); };
    }));
  }

  async function applyRemote(remoteList, tombstones){
    // tombstones: array of {txid, ref}
    const tombRefs = new Set((tombstones||[]).map(t=>t.ref).filter(Boolean));
    const localAll=await listAllRaw();
    const localMapByTx=new Map(localAll.filter(e=>e.txid).map(e=>[e.txid,e]));
    const remoteTxids=new Set(remoteList.map(r=>r.txid));
    const toAdd=[];
    for(const r of remoteList){
      if(tombRefs.has(r.txid)) continue; // shouldn't happen (server filters), defensive
      const existing=localMapByTx.get(r.txid);
      if(existing){
        let changed=false;
        if(existing.pending){ existing.pending=false; existing.status='confirmed'; changed=true; }
        if(!existing.seenRemote){ existing.seenRemote=true; changed=true; }
        if(changed) await putEntry(existing);
      } else {
        toAdd.push(await ensureContentHash({id:r.txid, txid:r.txid, title:r.title, author:r.author, edition:r.edition, format:r.format, dateRead:r.dateRead, coverImage:r.coverImage, mimeType:r.mimeType, createdAt:Date.now(), status:'confirmed', seenRemote:true}));
      }
    }
    // Remove (or tombstone) only if explicit tombstone present
    for(const e of localAll){
      if(e.txid && tombRefs.has(e.txid) && e.status!=='tombstoned'){
        e.status='tombstoned'; e.tombstonedAt=Date.now(); await putEntry(e);
      }
    }
    if(toAdd.length) await bulkPut(toAdd);
    return getAllActive();
  }
  async function detectDuplicate(payload){ const h=await computeContentHash(payload); const existing=await findByContentHash(h); return existing && existing.status!=='tombstoned' ? existing : null; }
  async function deleteById(id){ if(!id) return; return withStore('readwrite', ENTRY_STORE, store=> store.delete(id)); }
  async function compactDuplicates(){
    const all=await listAllRaw();
    const seenTx=new Map();
    for(const e of all){
      if(e.txid){
        if(!seenTx.has(e.txid)){ seenTx.set(e.txid,e); }
        else { // duplicate same txid: keep confirmed or latest
          const prev=seenTx.get(e.txid);
          const keep = (prev.status==='confirmed' && e.status!=='confirmed') ? prev : (e.status==='confirmed' && prev.status!=='confirmed') ? e : ( (e.createdAt||0) > (prev.createdAt||0) ? e : prev );
          const drop = keep===e? prev : e;
          if(drop.id!==keep.id) await deleteById(drop.id);
          seenTx.set(e.txid,keep);
        }
      }
    }
    // remove pending duplicates by contentHash if a confirmed exists
    const confirmedByHash=new Set(all.filter(e=>e.status==='confirmed').map(e=>e.contentHash));
    for(const e of all){ if(e.status!=='confirmed' && confirmedByHash.has(e.contentHash)){ await deleteById(e.id); } }
  }
  async function replaceProvisional(oldId, rec){ if(oldId && oldId!==rec.id){ await deleteById(oldId); } await putEntry(rec); }
  async function listAllRaw(){
    return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const out=[]; const req=store.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ out.push(cur.value); cur.continue(); } else r(out); }; }));
  }
  async function findByTxid(txid){ if(!txid) return null; return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const idx=store.index('txid'); const req=idx.get(txid); req.onsuccess=()=>r(req.result||null); req.onerror=()=>r(null); })); }
  async function initCache(){ await openDB(); }

  // --- Ops queue (minimal) ---
  async function queueOp(op){
    if(!op.id) op.id='op-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    op.createdAt=op.createdAt||Date.now();
    await withStore('readwrite', OPS_STORE, store=> store.put(op));
    return op.id;
  }
  async function listOps(){
    return withStore('readonly', OPS_STORE, store=> new Promise(r=>{ const out=[]; const req=store.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ out.push(cur.value); cur.continue(); } else { out.sort((a,b)=>a.createdAt-b.createdAt); r(out); } }; }));
  }
  async function removeOp(id){ if(!id) return; return withStore('readwrite', OPS_STORE, store=> store.delete(id)); }

  window.bookishCache={
    initCache,getAllActive,putEntry,bulkPut,applyRemote,findByTxid,markTombstoned,removeOldTombstones,listAllRaw,computeContentHash,detectDuplicate,deleteById,compactDuplicates,replaceProvisional,
    queueOp,listOps,removeOp
  };
})();
