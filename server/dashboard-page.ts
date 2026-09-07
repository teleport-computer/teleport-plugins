// Your account dashboard — visit plugin-free in any browser. Signs in via /login
// (did:key / userKey / passkey / owner), then shows connected apps, synced sites,
// activity, and registered passkeys for YOUR subject. Relative API URLs so it works
// behind the daemon's /<project>/ path prefix. Session token lives in localStorage
// (the same 'oauth3_session' the login/approve pages set).
import { DESIGN_CSS } from "./design.ts";

export function dashboardPage(): string {
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>OAuth3 — your account</title>
<style>${DESIGN_CSS}
 /* dashboard page local — everything derives from the tokens above */
 body{max-width:60rem;margin:28px auto;padding:0 18px}
 header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-bottom:2.5px solid var(--ink1);padding-bottom:14px;margin-bottom:18px}
 .brand{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
 .brand .mark{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:var(--ink1);color:#fff;font:800 18px/1 var(--sans)}
 .brand .word{font:800 20px var(--sans);letter-spacing:-.01em;color:var(--text)}
 .brand .word b{color:var(--i2-text);font-weight:inherit}
 .brand .sub{color:var(--faint);font-size:13px}
 .tools{display:flex;align-items:center;gap:14px}
 #inst{font:500 12px var(--mono);color:var(--faint);display:inline-flex;align-items:center;gap:6px}
 #instText{white-space:nowrap}
 .cols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
 @media(max-width:680px){.cols{grid-template-columns:1fr}}
 section.card{margin-top:22px}
 section.card:first-of-type{margin-top:0}
 /* rows: name on the left, verifiable bits + actions on the right */
 .item{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--rule)}
 .item:first-of-type{border-top:0}
 .item .name{font-weight:700}
 .item .meta{margin-left:auto;text-align:right;display:inline-flex;align-items:center;gap:8px}
 /* compact danger action (revoke / unlink): ink2 bg, deep text, ink1 shadow */
 .btn.sm{padding:6px 12px;font:800 12px var(--cond);text-transform:uppercase;letter-spacing:.12em;box-shadow:2px 2px 0 var(--ink1)}
 /* site rows stack: name+pill on top, freshness meter below (only when a jar exists) */
 #sites .item{flex-direction:column;align-items:stretch;gap:6px}
 #sites .srow{display:flex;align-items:center;justify-content:space-between;gap:10px}
 #sites .meter{grid-template-columns:auto 1fr auto;width:100%}
 .m{font:12px var(--mono);color:var(--faint)}
 .empty{color:var(--faint);font-size:13px;padding:8px 0}
 /* danger note: ink2 wash + ink2 spine (no hardcoded red) */
 #err{background:var(--wash2);color:var(--i2-text);border-left:6px solid var(--ink2);padding:12px 14px;display:none;margin-bottom:14px;font-size:14px}
 /* activity feed: sans verb, verifiable values in mono/chips */
 .act{padding:7px 0;border-top:1px solid var(--rule);font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .act:first-child{border-top:0}
 .act .when{font:11px var(--mono);color:var(--faint);white-space:nowrap}
 .act .verb{color:var(--text)}
 .act .pts{display:inline-flex;gap:6px;flex-wrap:wrap}
 /* #120: a collapsed run is clickable; expand reveals the individual events */
 .act.run{cursor:pointer}
 .act .expand{margin-left:auto;font:800 11px var(--cond);text-transform:uppercase;letter-spacing:.12em;background:var(--wash1);color:var(--i1-text);border:0;padding:4px 10px;cursor:pointer;box-shadow:2px 2px 0 var(--ink1)}
 .rundetail{padding-left:14px}
 .rundetail .act{color:var(--faint);border-left:2px solid var(--rule);padding-left:10px;margin-left:0}
 .addrow{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
 .proposal{border-top:1px solid var(--rule);padding:14px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
 .proposal:first-child{border-top:0}
 .proposal .copy{flex:1 1 20rem}.proposal .copy b{display:block}.proposal .copy .m{display:block;margin-top:5px}
 .proposal .scope{margin-top:7px;color:var(--i1-text);font-size:13px}
 .appgroup{border-top:1px solid var(--rule);padding:12px 0}
 .appgroup:first-child{border-top:0}
 .apphead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:3px}
 .apphead .name{font-weight:800}
 .apphead .count{font:11px var(--mono);color:var(--faint)}
 .apphead .btn{padding:5px 9px;font-size:11px}
 .appgroup .item{padding:7px 0 7px 12px}
</style></head><body>
<header>
  <div class=brand>
    <span class=mark>∀</span>
    <span class=word>OAuth<b>3</b></span>
    <span class=sub id=acct>your account</span>
  </div>
  <div class=tools>
    <span id=inst><span class="dot warn" id=instDot></span><span id=instText>checking…</span></span>
    <button id=logout class="btn quiet">Sign out</button>
  </div>
</header>
<div id=err></div>
<div class=cols>
  <section class=card><b class=title>Sites</b><div id=sites></div></section>
  <section class=card><b class=title>Apps &amp; tokens</b><div id=apps></div></section>
</div>
<section class=card><b class=title>Contextual authorization</b><div id=promote><div class=empty>No tightening proposals yet.</div></div></section>
<section class=card><b class=title>Passkeys &amp; sign-in</b><div id=keys></div>
  <div id=links></div>
  <div class=addrow>
    <button id=addpk class="btn ghost">+ Add a passkey</button>
    <button id=linkgh class=btn style="display:none;background:#24292f">+ Link GitHub</button>
    <button id=linkgg class=btn style="display:none;background:#1a73e8">+ Link Google</button>
    <button id=linkok class=btn style="display:none;background:#7c3aed">+ Link OpenKey</button>
  </div>
</section>
<section id=activity class=card><b class=title>Activity</b><div id=acts></div></section>
<script>
 const SK='oauth3_session', $=(id)=>document.getElementById(id), FRESH=35*60*1000;
 const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const ago=ts=>{if(!ts)return'never';const s=(Date.now()-ts)/1000|0;return s<60?s+'s ago':s<3600?(s/60|0)+'m ago':s<86400?(s/3600|0)+'h ago':(s/86400|0)+'d ago'};
 const dur=ms=>{const s=(ms||0)/1000|0;return s<60?s+'s':s<3600?(s/60|0)+'m':s<86400?(s/3600|0)+'h':(s/86400|0)+'d'};
 const chips=d=>{const p=[];if(d&&d.plugin)p.push('<span class=chip>'+esc(d.plugin)+'</span>');if(d&&d.app)p.push('<span class=chip>'+esc(d.app)+'</span>');return p.length?'<span class=pts>'+p.join(' ')+'</span>':''};
 const tok=()=>localStorage.getItem(SK);
 const authH=()=>({Authorization:'Bearer '+tok()});
 const b64uDec=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
 const b64uEnc=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
 const showErr=m=>{$('err').textContent=m;$('err').style.display='block'};
 async function api(p){const r=await fetch(p,{headers:authH()});if(!r.ok)throw new Error(p+' -> '+r.status);return r.json();}
 let SUBJECT=null;let RUNS=[];const owner=()=>SUBJECT==='owner';

 function renderSites(ps){const el=$('sites');if(!ps.length){el.innerHTML='<div class="empty">No sites available.</div>';return;}
   el.innerHTML=ps.map(p=>{const j=p.jar||{};const name='<span class=name>'+esc(p.label)+'</span>';
     // #12: browser-path plugins are NOT connectable on this cookie-only instance — say so
     // plainly instead of a normal saved/not-saved row that reads as working.
     if(p.path==='browser'){return '<div class=item><div class=srow>'+name+'<span class="pill warn">browser-path</span></div>'
       + '<div class=m>browser-path — not available on this cookie-only instance (reads need the browser, #14)</div></div>';}
     if(!j.present){return '<div class=item><div class=srow>'+name+'<span class="pill bad">not saved</span></div></div>';}
     const age=j.updatedAt?Date.now()-j.updatedAt:Infinity;const stale=age>FRESH;
     const frac=stale?1:Math.max(.06,1-age/FRESH);const pct=(frac*100|0);
     const pill=stale?'<span class="pill warn">stale</span>':'<span class="pill ok">fresh</span>';
     const bar='<span class=track><i'+(stale?' class=warn':'')+' style="width:'+pct+'%"></i></span>';
     return '<div class=item><div class=srow>'+name+pill+'</div>'
       + '<div class=meter><span>'+j.count+' cookies</span>'+bar+'<span>'+ago(j.updatedAt)+'</span></div></div>';}).join('');}
 function renderApps(ts){const el=$('apps');const live=ts.filter(t=>!t.revokedAt);
   if(!live.length){el.innerHTML='<div class="empty">No apps connected yet.</div>';return;}
   const groups=new Map();live.forEach(t=>{const app=t.app||'(unnamed app)';if(!groups.has(app))groups.set(app,[]);groups.get(app).push(t);});
   el.innerHTML=[...groups.entries()].map(([app,items])=>'<div class=appgroup data-app-group>'+
     '<div class=apphead><span><span class=name>'+esc(app)+'</span> <span class=count>'+items.length+' token'+(items.length===1?'':'s')+'</span></span>'+
     '<button class="btn danger" data-revoke-app="'+esc(app)+'">revoke all</button></div>'+
     items.map(t=>'<div class=item><span class=name>'+esc(t.plugin)+'</span><span class=meta><span class=m>'+ago(t.createdAt)+'</span></span><button class="btn danger sm" data-token="'+esc(t.token)+'">revoke</button></div>').join('')+
     '</div>').join('');}
 function sameReads(a,b){return a.length===b.length&&[...a].sort().join('\0')===[...b].sort().join('\0');}
 function renderPromote(ps,scopes,ts){const el=$('promote');if(!ps.length){el.innerHTML='<div class="empty">No observed usage to tighten yet.</div>';return;}
   el.innerHTML=ps.map(p=>{const scope=scopes.find(s=>s.plugin===p.plugin&&sameReads(s.reads,p.proposed_ingredient.reads));
     const token=ts.filter(t=>!t.revokedAt&&t.plugin===p.plugin&&(t.app||'')===p.app).sort((a,b)=>b.createdAt-a.createdAt)[0];
     const granted=new Set();ts.filter(t=>!t.revokedAt&&t.plugin===p.plugin&&(t.app||'')===p.app).forEach(t=>{(t.caps||[]).forEach(c=>{const s=scopes.find(x=>x.id===c);(s?s.reads:p.read_universe).forEach(r=>granted.add(r));});if(!t.caps) p.read_universe.forEach(r=>granted.add(r));});
     const y=granted.size||p.read_universe.length;const tightened=!!scope&&!!token&&(token.caps||[]).includes(scope.id);const button=tightened?'<span class="pill ok">tightened ✓</span>':scope&&token?'<button class="btn sm" data-tighten-token="'+esc(token.token)+'" data-tighten-scope="'+esc(scope.id)+'">tighten to '+esc(scope.id)+'</button>':'<button class="btn quiet sm" disabled>awaiting reviewed scope</button>';
     return '<div class=proposal><div class=copy><b>'+esc(p.app)+' · '+esc(p.plugin)+'</b><span class=m>used '+p.observed_reads.length+' of '+y+' granted reads · '+p.observations+' observed uses</span>'+(scope?'<div class=scope>Enforced: '+esc(scope.label)+'</div>':'<div class=scope>Proposed: '+esc(p.proposed_ingredient.label)+'</div>')+'</div>'+button+'</div>';}).join('');}
 function renderKeys(ks){$('keys').innerHTML=ks.length?ks.map(k=>'<div class=item><span class=name>passkey</span><span class=meta><span class=m>'+esc(k.id.slice(0,12))+'…</span> <span class=m>'+ago(k.createdAt)+'</span></span></div>').join(''):'<div class="empty">No passkeys yet — add one to sign in on any device.</div>';}
 function renderActs(es){const el=$('acts');if(!es.length){el.innerHTML='<div class="empty">No activity yet.</div>';return;}
   // #120 — collapse a run of identical consecutive events into one row (count + time range).
   // View concern only: the full trail stays in es (and RUNS) and is revealed on expand.
   const runs=[];for(const e of es){const d=e.detail||{};const key=e.action+'|'+(d.plugin||'')+'|'+(d.app||'');const last=runs[runs.length-1];if(last&&last.key===key)last.events.push(e);else runs.push({key,events:[e]});}
   RUNS=runs;
   el.innerHTML=runs.slice(0,40).map((r,i)=>{
     if(r.events.length<2){const e=r.events[0],d=e.detail||{},c=d.count!=null?' <span class=m>('+d.count+')</span>':'';
       return '<div class=act><span class=when>'+ago(e.ts)+'</span><span class=verb>'+esc(e.action)+'</span>'+chips(d)+c+'</div>';
     }
     const n=r.events.length,newest=r.events[0].ts,oldest=r.events[n-1].ts,d=r.events[0].detail||{};
     return '<div class="act run" data-run="'+i+'"><span class=when>'+ago(newest)+'</span><span class=verb>'+esc(r.events[0].action)+'</span>'+chips(d)+'<span class=m>×'+n+' · last '+dur(newest-oldest)+'</span><button class=expand>expand</button></div><div class=rundetail data-rundetail="'+i+'" hidden></div>';
   }).join('');}

 $('apps').addEventListener('click',async e=>{const t=e.target.dataset&&e.target.dataset.token;if(!t)return;
   e.target.disabled=true;e.target.textContent='revoking…';
   try{const r=await fetch('api/tokens/'+encodeURIComponent(t),{method:'DELETE',headers:authH()});if(!r.ok)throw new Error('revoke '+r.status);await load();}
   catch(err){showErr(err.message);e.target.disabled=false;e.target.textContent='revoke';}});
 $('apps').addEventListener('click',async e=>{const app=e.target.dataset&&e.target.dataset.revokeApp;if(!app)return;
   const group=e.target.closest('[data-app-group]');const tokens=[...group.querySelectorAll('[data-token]')].map(x=>x.dataset.token);
   e.target.disabled=true;e.target.textContent='revoking…';
   try{for(const token of tokens){const r=await fetch('api/tokens/'+encodeURIComponent(token),{method:'DELETE',headers:authH()});if(!r.ok)throw new Error('revoke '+r.status);}await load();}
   catch(err){showErr(err.message);e.target.disabled=false;e.target.textContent='revoke all';}});
 $('promote').addEventListener('click',async e=>{const b=e.target.dataset;if(!b||!b.tightenToken)return;e.target.disabled=true;e.target.textContent='tightening…';
   try{const r=await fetch('api/tokens/'+encodeURIComponent(b.tightenToken)+'/tighten',{method:'POST',headers:{...authH(),'Content-Type':'application/json'},body:JSON.stringify({ingredient:b.tightenScope})});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'tighten '+r.status);}await load();}
   catch(err){showErr(err.message);e.target.disabled=false;e.target.textContent='tighten';}});

 // Enroll a passkey bound to this signed-in subject.
 $('addpk').addEventListener('click',async()=>{
   try{
     const o=await(await fetch('api/passkey/register/options',{method:'POST',headers:authH()})).json();
     if(o.error)throw new Error(o.error);
     const cred=await navigator.credentials.create({publicKey:{
       challenge:b64uDec(o.challenge),rp:{id:o.rpId,name:'OAuth3'},
       user:{id:new TextEncoder().encode(o.userId),name:o.userId,displayName:o.userId},
       pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'preferred',userVerification:'preferred'},timeout:60000}});
     const r=cred.response;
     const res=await(await fetch('api/passkey/register',{method:'POST',headers:{...authH(),'Content-Type':'application/json'},body:JSON.stringify({
       id:cred.id,clientDataJSON:b64uEnc(r.clientDataJSON),attestationObject:b64uEnc(r.attestationObject)})})).json();
     if(res.error)throw new Error(res.error);
     await load();
   }catch(e){showErr('passkey enroll failed: '+(e.message||e));}});

 $('logout').addEventListener('click',async()=>{try{await fetch('api/logout',{method:'POST',headers:authH()});}catch(e){} localStorage.removeItem(SK); location.href='login';});
 function linkLabel(id){ if(id.indexOf('gh:')===0) return 'GitHub · #'+id.slice(3); if(id.indexOf('google:')===0) return 'Google · '+id.slice(7,16)+'…'; if(id.indexOf('did:pkh:')===0){ const a=id.split(':').pop()||''; return 'OpenKey / Ethereum · '+(a.length>10?a.slice(0,6)+'…'+a.slice(-4):a); } return id; }
 function renderLinks(ls){$('links').innerHTML=ls.length?ls.map(l=>'<div class=item><span class=name>'+esc(linkLabel(l))+'</span><span class=meta><button class="btn danger sm" data-unlink="'+esc(l)+'">unlink</button></span></div>').join(''):'<div class="empty">No linked sign-ins yet — link GitHub or OpenKey below to sign in from any device.</div>';}
 $('links').addEventListener('click',async e=>{const id=e.target.dataset&&e.target.dataset.unlink;if(!id)return;e.target.disabled=true;e.target.textContent='unlinking…';try{const r=await(await fetch('api/links/unlink',{method:'POST',headers:{...authH(),'Content-Type':'application/json'},body:JSON.stringify({providerId:id})})).json();if(r.error)throw new Error(r.error);await load();}catch(err){showErr('unlink: '+(err.message||err));e.target.disabled=false;e.target.textContent='unlink';}});
 // #120 — expand a collapsed run to reveal its individual events (trail intact).
 $('acts').addEventListener('click',e=>{const run=e.target.closest&&e.target.closest('.act.run');if(!run)return;e.preventDefault();const i=+run.dataset.run;const det=$('acts').querySelector('[data-rundetail="'+i+'"]');const r=RUNS[i];if(!det||!r)return;const btn=run.querySelector('.expand');
   if(!det.hasChildNodes())det.innerHTML=r.events.map(function(ev){const dd=ev.detail||{},c=dd.count!=null?' <span class=m>('+dd.count+')</span>':'';return '<div class=act><span class=when>'+ago(ev.ts)+'</span><span class=verb>'+esc(ev.action)+'</span>'+chips(dd)+c+'</div>';}).join('');
   det.hidden=!det.hidden;if(btn)btn.textContent=det.hidden?'expand':'collapse';});
 $('linkgh').addEventListener('click',async()=>{try{const r=await(await fetch('api/login/github/link',{method:'POST',headers:authH()})).json();if(r.error)throw new Error(r.error);location.href=r.url;}catch(e){showErr('link github: '+(e.message||e));}});
 $('linkgg').addEventListener('click',async()=>{try{const r=await(await fetch('api/login/google/link',{method:'POST',headers:authH()})).json();if(r.error)throw new Error(r.error);location.href=r.url;}catch(e){showErr('link google: '+(e.message||e));}});
 $('linkok').addEventListener('click',async()=>{try{
   const mod=await import('https://esm.sh/@openkey/sdk@0.8');const OpenKey=mod.default||mod.OpenKey;
   const ok=new OpenKey({host:'https://openkey.so',appName:'OAuth3'});const auth=await ok.connect();
   const n=await(await fetch('api/login/openkey/nonce')).json();
   const message=n.domain+' wants you to sign in with your Ethereum account:\\n'+auth.address+'\\n\\nLink to OAuth3.\\n\\nURI: '+n.uri+'\\nVersion: 1\\nChain ID: 1\\nNonce: '+n.nonce+'\\nIssued At: '+new Date().toISOString();
   const sg=await ok.signMessage({message,keyId:auth.keyId});
   const r=await(await fetch('api/login/openkey/link',{method:'POST',headers:{...authH(),'Content-Type':'application/json'},body:JSON.stringify({message,signature:sg.signature||sg})})).json();
   if(r.error)throw new Error(r.error);await load();
 }catch(e){showErr('link openkey: '+(e.message||e));}});

 async function load(){
   const me=await api('api/me').catch(()=>({signedIn:false}));
   if(!me.signedIn){location.href='login?return='+encodeURIComponent(location.pathname);return;}
   SUBJECT=me.subject;$('acct').textContent=owner()?'owner':SUBJECT;
   renderLinks(me.links||[]);
   if(me.providers&&me.providers.github)$('linkgh').style.display='inline-block';
   if(me.providers&&me.providers.google)$('linkgg').style.display='inline-block';
   if(me.providers&&me.providers.openkey)$('linkok').style.display='inline-block';
   const h=await api('api/health').catch(()=>null);
   $('instDot').className='dot '+(h&&h.ready?'ok':'bad');
   let host='';try{host=location.host;}catch(e){}
   $('instText').textContent=(h&&h.ready?'instance ready':'instance unreachable')+' — '+host;
   const [pl,tk,au,pk,prom,scopeData]=await Promise.all([
     api('api/plugins').then(r=>r.plugins).catch(()=>[]),
     api('api/tokens').then(r=>r.tokens).catch(()=>[]),
     api('api/audit').then(r=>r.audit).catch(()=>[]),
     api('api/passkeys').then(r=>r.passkeys).catch(()=>[]),
     api('api/promote'),
     api('api/scopes')]);
   renderSites(pl);renderApps(tk);renderActs(au);renderKeys(pk);renderPromote(prom.proposals||[],scopeData.scopes||[],tk);
 }
 if(!tok())location.href='login?return='+encodeURIComponent(location.pathname);else load().catch(e=>showErr(String(e.message||e)));
</script></body></html>`;
}
