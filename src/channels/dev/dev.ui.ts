/** Minimal single-file chat UI for local development (served at /dev/chat when DEV_CHANNEL=1). */
export const DEV_CHAT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRM Bee — dev chat</title>
<style>
:root{--bg:#f4f1ea;--card:#fff;--ink:#1c1b19;--mut:#6b675f;--me:#ffe9a8;--bot:#fff;--ac:#c58a00;--line:#e3ded2}
@media(prefers-color-scheme:dark){:root{--bg:#1b1a17;--card:#25231f;--ink:#f1eee6;--mut:#a39f94;--me:#5a4710;--bot:#2d2a25;--ac:#f5b301;--line:#3a362f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
header b{font-size:16px} input,button,select{font:inherit;color:inherit} header input{padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);width:170px}
#log{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.m{max-width:min(720px,88%);padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;border:1px solid var(--line)}
.me{align-self:flex-end;background:var(--me)}.bot{align-self:flex-start;background:var(--bot)}
.btns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.btns button{padding:5px 12px;border:1px solid var(--ac);background:transparent;color:var(--ink);border-radius:999px;cursor:pointer}.btns button:hover{background:var(--ac);color:#000}
footer{padding:10px 14px;border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
footer input[type=text]{flex:1;min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
footer button,label.up{padding:8px 12px;border:1px solid var(--line);background:var(--card);border-radius:10px;cursor:pointer}footer button.go{background:var(--ac);border-color:var(--ac);color:#000;font-weight:600}
small{color:var(--mut)}
</style></head><body>
<header><b>🐝 CRM Bee · dev chat</b><small>phone</small><input id="phone" value="+919800000001"><small id="st"></small></header>
<div id="log"></div>
<footer>
<input id="t" type="text" placeholder="Message… (try: help)" autocomplete="off">
<button class="go" id="send">Send</button>
<label class="up">📇 Card<input type="file" id="card" accept="image/jpeg,image/png" hidden></label>
<label class="up">🎙 Voice<input type="file" id="voice" accept="audio/*" hidden></label>
</footer>
<script>
const $=id=>document.getElementById(id);let last=null,phone=$('phone').value;
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmt=s=>esc(s).replace(/\\*([^*\\n]+)\\*/g,'<b>$1</b>').replace(/_([^_\\n]+)_/g,'<i>$1</i>').replace(/(https?:\\/\\/[^\\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
function add(cls,html,btns){const d=document.createElement('div');d.className='m '+cls;d.innerHTML=html;if(btns&&btns.length){const b=document.createElement('div');b.className='btns';btns.forEach(x=>{const e=document.createElement('button');e.textContent=x.title;e.onclick=()=>post('button',{phone,id:x.id},'['+x.title+']');b.appendChild(e)});d.appendChild(b)}$('log').appendChild(d);$('log').scrollTop=1e9}
async function post(path,body,echo){if(echo)add('me',esc(echo));const r=await fetch('/dev/chat/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)add('bot','⚠️ '+r.status+' '+esc(await r.text()))}
async function poll(){try{const u='/dev/chat/messages?phone='+encodeURIComponent(phone)+(last?'&after='+last:'');const j=await (await fetch(u)).json();j.messages.forEach(m=>{last=m.id;add('bot',fmt(m.text),m.buttons)});$('st').textContent='connected'}catch(e){$('st').textContent='offline'}setTimeout(poll,1200)}
$('phone').onchange=()=>{phone=$('phone').value;last=null;$('log').innerHTML=''};
const send=()=>{const v=$('t').value.trim();if(!v)return;$('t').value='';post('send',{phone,text:v},v)};$('send').onclick=send;$('t').onkeydown=e=>{if(e.key==='Enter')send()};
function up(id,kind,label){$(id).onchange=async e=>{const f=e.target.files[0];if(!f)return;const buf=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=0x8000)s+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));add('me',label+' '+esc(f.name));await post('upload',{phone,kind,mimeType:f.type||(kind==='image'?'image/jpeg':'audio/ogg'),base64:btoa(s),filename:f.name});e.target.value=''}}
up('card','image','📇');up('voice','audio','🎙');poll();
</script></body></html>`;
