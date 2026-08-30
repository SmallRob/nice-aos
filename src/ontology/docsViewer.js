// docs.html 自包含文档浏览器生成器（v0.38，output docs --format all 的浏览端）
// 设计借鉴 nice-today-2.0/display-web 的 knowledge-graph/doc-viewer.html：
//   左侧目录树侧边栏（搜索 + 统计）+ 主内容区（md 渲染 + frontmatter 卡片 + 面包屑）
//   + 右侧浮动 TOC（scroll-spy）+ 暗色科技风 CSS 变量主题 + 响应式抽屉。
// 与其差异（教训吸收）：
//   - md 解析器强化：表格（含对齐与 \| 转义）、嵌套列表、任务列表、代码围栏 language class
//   - tree.json 路径统一为相对 context 根（display-web 存在两种前缀不一致的 bug）
//   - 中文路径 fetch 按 / 分段 encodeURIComponent
//   - 内部 .md 链接拦截为站内导航；?doc=<path> 走 pushState，可分享/前进后退
// 零依赖、数据不内嵌：运行时按需 fetch ./tree.json 与 ./<path>.md，任意静态服务器可跑。

const DOCS_CSS = `
:root{--bg:#0a0e1a;--bg2:#0d1424;--bg3:#121b30;--border:#1d2a47;--fg:#dbe4f5;--muted:#7e8db0;
--accent:#22d3ee;--accent2:#818cf8;--good:#34d399;--mono:ui-monospace,'JetBrains Mono',SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.75 system-ui,-apple-system,'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;overflow:hidden}
button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
/* ── 顶栏 ── */
#topbar{position:fixed;inset:0 0 auto 0;height:52px;display:flex;align-items:center;gap:12px;padding:0 16px;
background:linear-gradient(90deg,rgba(13,20,36,.92),rgba(10,14,26,.85));backdrop-filter:blur(8px);border-bottom:1px solid var(--border);z-index:30}
#menuBtn{display:none;font-size:18px;padding:4px 8px;border:1px solid var(--border);border-radius:8px}
.brand{font-weight:700;font-size:15px;white-space:nowrap;display:flex;align-items:center;gap:8px}
.brand .proj{color:var(--accent);font-family:var(--mono);font-size:13px;max-width:220px;overflow:hidden;text-overflow:ellipsis}
#searchWrap{flex:1;max-width:420px;margin-left:auto;position:relative}
#searchInput{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--fg);padding:7px 12px;font-size:13px;outline:none}
#searchInput:focus{border-color:var(--accent)}
#copyBtn{font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:6px 12px;white-space:nowrap}
#copyBtn:hover{color:var(--accent);border-color:var(--accent)}
/* ── 布局 ── */
#layout{position:fixed;inset:52px 0 0 0;display:flex}
#sidebar{width:300px;flex:none;display:flex;flex-direction:column;background:var(--bg2);border-right:1px solid var(--border)}
#stats{padding:10px 16px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)}
#tree{flex:1;overflow-y:auto;padding:8px 6px 24px}
#tree ul{list-style:none}
#tree li{margin:1px 0}
.tdir{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;cursor:pointer;color:var(--fg);font-size:13.5px;user-select:none}
.tdir:hover{background:var(--bg3)}
.tdir .arrow{display:inline-block;width:12px;color:var(--muted);transition:transform .15s;font-size:10px}
.tdir.open .arrow{transform:rotate(90deg)}
.tdir .cnt{margin-left:auto;font-size:11px;color:var(--muted)}
.tdir .kids{display:none;margin-left:14px;border-left:1px solid var(--border);padding-left:6px}
.tdir.open>.kids{display:block}
.tfile{display:flex;gap:6px;padding:4px 8px;border-radius:7px;color:var(--muted);font-size:13px;cursor:pointer}
.tfile:hover{background:var(--bg3);color:var(--fg)}
.tfile.active{background:rgba(34,211,238,.12);color:var(--accent)}
#emptyTree{padding:24px 16px;color:var(--muted);font-size:13px;line-height:1.9}
#emptyTree code{background:var(--bg3);padding:1px 6px;border-radius:5px;font-family:var(--mono);font-size:12px;color:var(--accent)}
/* ── 主区 ── */
#main{flex:1;overflow-y:auto;scroll-behavior:smooth;position:relative}
#docWrap{max-width:860px;margin:0 auto;padding:28px 32px 40vh 24px}
#crumb{font-size:12px;color:var(--muted);margin-bottom:14px;font-family:var(--mono)}
#crumb b{color:var(--accent2)}
#doc h1{font-size:26px;margin:6px 0 18px;color:#fff;letter-spacing:.3px}
#doc h2{font-size:20px;margin:30px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border);color:#fff}
#doc h3{font-size:16.5px;margin:22px 0 10px;color:var(--accent)}
#doc h4,#doc h5,#doc h6{font-size:14.5px;margin:16px 0 8px;color:var(--accent2)}
#doc p{margin:10px 0}
#doc ul,#doc ol{margin:8px 0;padding-left:24px}
#doc li{margin:3px 0}
#doc blockquote{margin:12px 0;padding:8px 16px;border-left:3px solid var(--accent2);background:var(--bg3);border-radius:0 8px 8px 0;color:var(--muted)}
#doc code{background:var(--bg3);border:1px solid var(--border);padding:1px 6px;border-radius:5px;font-family:var(--mono);font-size:12.5px;color:#a5f3fc}
#doc pre{background:#0b1120;border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:14px 0}
#doc pre code{background:none;border:none;padding:0;color:#c9d6f2;font-size:13px;line-height:1.6}
#doc table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}
#doc th,#doc td{border:1px solid var(--border);padding:7px 12px;text-align:left}
#doc th{background:var(--bg3);color:#fff;white-space:nowrap}
#doc td:first-child{white-space:normal}
#doc tr:hover td{background:rgba(34,211,238,.05)}
#doc hr{border:none;border-top:1px solid var(--border);margin:20px 0}
#doc img{max-width:100%;border-radius:8px}
#doc input[type=checkbox]{accent-color:var(--accent);margin-right:6px}
/* frontmatter 卡片 */
.fm{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.fm span{font-size:12px;padding:3px 10px;border-radius:20px;border:1px solid var(--border);color:var(--muted);background:var(--bg3)}
.fm span b{color:var(--accent);font-weight:600;margin-right:4px}
.fm span.layer-L1{border-color:rgba(34,211,238,.5);color:var(--accent)}
.fm span.layer-L2{border-color:rgba(129,140,248,.5);color:var(--accent2)}
.fm span.layer-L3{border-color:rgba(52,211,153,.5);color:var(--good)}
/* 三态 */
.state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;color:var(--muted);text-align:center;gap:14px}
.state h2{border:none!important;color:var(--fg)!important;margin:0!important}
.state .hint{font-size:13px;line-height:2}
.state .hint code{background:var(--bg3);padding:2px 8px;border-radius:5px;font-family:var(--mono);color:var(--accent)}
.spinner{width:34px;height:34px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.state button{border:1px solid var(--accent);color:var(--accent);border-radius:8px;padding:7px 20px}
/* TOC */
#toc{position:fixed;right:18px;top:96px;width:220px;max-height:calc(100vh - 160px);overflow-y:auto;font-size:12px;
padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:rgba(13,20,36,.85);backdrop-filter:blur(6px)}
#toc:empty{display:none}
#toc .cap{color:var(--muted);letter-spacing:2px;font-size:10px;margin-bottom:6px}
#toc a{display:block;color:var(--muted);padding:3px 0;border-left:2px solid transparent;padding-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#toc a.l3{padding-left:18px}
#toc a.l4{padding-left:28px}
#toc a.on{color:var(--accent);border-left-color:var(--accent)}
@media(max-width:1280px){#toc{display:none}}
/* 响应式抽屉 */
#mask{display:none;position:fixed;inset:52px 0 0 0;background:rgba(0,0,0,.5);z-index:18}
@media(max-width:768px){
 #menuBtn{display:block}
 #sidebar{position:fixed;left:0;top:52px;bottom:0;z-index:20;transform:translateX(-100%);transition:transform .2s}
 #sidebar.open{transform:none}
 #mask.show{display:block}
 #docWrap{padding:20px 18px 30vh}
}
`;

const DOCS_JS = `
(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var state={tree:[],totalFiles:0,current:null,raw:null};
/* ── 工具 ── */
function encPath(p){return p.split('/').map(encodeURIComponent).join('/')}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
/* ── Markdown 渲染（强化版：表格对齐/嵌套列表/任务列表/代码围栏） ── */
function inline(s){
 return s
  .replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g,function(_,t,u){return '<img src="'+u+'" alt="'+t+'" loading="lazy">'})
  .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,function(_,t,u){return '<a href="'+u+'">'+t+'</a>'})
  .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
  .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
  .replace(/(^|[^\\w*])\\*([^*\\s][^*]*)\\*/g,'$1<em>$2</em>')
  .replace(/~~([^~]+)~~/g,'<del>$1</del>');
}
function splitRow(line){
 var cells=[],cur='',i=0;
 for(;i<line.length;i++){
  var c=line[i];
  if(c==='\\\\'&&line[i+1]==='|'){cur+='|';i++;continue}
  if(c==='|'){cells.push(cur.trim());cur='';continue}
  cur+=c;
 }
 cells.push(cur.trim());
 if(cells.length&&cells[0]==='')cells.shift();
 if(cells.length&&cells[cells.length-1]==='')cells.pop();
 return cells;
}
function parseMd(src){
 var fm=null,m=[];
 src=src.replace(/\\r\\n/g,'\\n');
 var fmv=src.match(/^---\\n([\\s\\S]*?)\\n---\\n?/);
 if(fmv){fm={};fmv[1].split('\\n').forEach(function(l){var mm=l.match(/^([\\w-]+):\\s*(.*)$/);if(mm)fm[mm[1]]=mm[2]});src=src.slice(fmv[0].length)}
 var codes=[];
 src=src.replace(/\`\`\`(\\w*)[\\s\\S]*?\`\`\`/g,function(match,lang){
  var nl=match.indexOf('\\n');
  var body=match.slice(nl+1,match.length-3).replace(/\\n$/,'');
  codes.push({lang:lang||'plaintext',body:body});
  return '\\u0000C'+(codes.length-1)+'\\u0000';
 });
 src=esc(src);
 var lines=src.split('\\n'),out=[],i=0,headingN=0,toc=[];
 function flushP(buf){if(buf.length)out.push('<p>'+inline(buf.join('<br>'))+'</p>')}
 var pbuf=[];
 while(i<lines.length){
  var L=lines[i];
  if(/^\\s*$/.test(L)){flushP(pbuf);pbuf=[];i++;continue}
  var h=L.match(/^(#{1,6})\\s+(.*)$/);
  if(h){
   flushP(pbuf);pbuf=[];
   var lv=h[1].length;headingN++;
   var id='h-'+headingN;
   if(lv>=2&&lv<=4)toc.push({id:id,text:h[2].replace(/[#*\\x60]/g,''),lv:lv});
   out.push('<h'+lv+' id="'+id+'">'+inline(h[2])+'</h'+lv+'>');
   i++;continue;
  }
  if(/^(---+|\\*\\*\\*+|___+)\\s*$/.test(L)){flushP(pbuf);pbuf=[];out.push('<hr>');i++;continue}
  if(/^\\s*&gt;\\s?/.test(L)){
   flushP(pbuf);pbuf=[];
   var q=[];
   while(i<lines.length&&/^\\s*&gt;\\s?/.test(lines[i])){q.push(lines[i].replace(/^\\s*&gt;\\s?/,''));i++}
   out.push('<blockquote>'+inline(q.join('<br>'))+'</blockquote>');
   continue;
  }
  /* 表格：当前行含 | 且下一行是分隔行 */
  if(L.indexOf('|')>=0&&i+1<lines.length&&/^\\s*\\|?\\s*:?-{2,}/.test(lines[i+1])&&lines[i+1].indexOf('|')>=0){
   flushP(pbuf);pbuf=[];
   var head=splitRow(L.replace(/^\\s*\\|/,''));
   var aligs=splitRow(lines[i+1].replace(/^\\s*\\|/,'')).map(function(c){
    var a=c.trim();return /^:-+:$/.test(a)?'center':(/-+:$/.test(a)?'right':'left')});
   i+=2;
   var rows=[];
   while(i<lines.length&&lines[i].indexOf('|')>=0&&!/^\\s*$/.test(lines[i])){rows.push(splitRow(lines[i].replace(/^\\s*\\|/,'')));i++}
   var t='<table><thead><tr>';
   head.forEach(function(c,j){t+='<th'+(aligs[j]&&aligs[j]!=='left'?' style="text-align:'+aligs[j]+'"':'')+'>'+inline(c)+'</th>'});
   t+='</tr></thead><tbody>';
   rows.forEach(function(r){
    t+='<tr>';
    head.forEach(function(_,j){t+='<td'+(aligs[j]&&aligs[j]!=='left'?' style="text-align:'+aligs[j]+'"':'')+'>'+inline(r[j]||'')+'</td>'});
    t+='</tr>';
   });
   out.push(t+'</tbody></table>');
   continue;
  }
  /* 列表（含嵌套 2 空格层级与任务列表） */
  var li=L.match(/^(\\s*)([-*]|\\d+[.)])\\s+(.*)$/);
  if(li){
   flushP(pbuf);pbuf=[];
   var baseIndent=li[1].length;
   var stack=[];
   function closeTo(depth){while(stack.length>depth){out.push(stack.pop()==='ol'?'</ol>':'</ul>')}}
   while(i<lines.length){
    var mm=lines[i].match(/^(\\s*)([-*]|\\d+[.)])\\s+(.*)$/);
    if(!mm)break;
    var ind=mm[1].length;
    var ordered=/^\\d/.test(mm[2]);
    var depth=Math.min(Math.floor((ind-baseIndent)/2)+1,4);
    if(!stack.length){stack.push(ordered?'ol':'ul');out.push('<'+stack[0]+'>')}
    while(stack.length>depth){out.push(stack.pop()==='ol'?'</ol>':'</ul>')}
    while(stack.length<depth){var t2=ordered?'ol':'ul';stack.push(t2);out.push('<'+t2+'>')}
    var item=mm[3],task='';
    var tk=item.match(/^\\[( |x|X)\\]\\s+(.*)$/);
    if(tk){task='<input type="checkbox" disabled'+(tk[1]!==' '?' checked':'')+'>';item=tk[2]}
    out.push('<li>'+task+inline(item)+'</li>');
    i++;
   }
   closeTo(0);
   continue;
  }
  /* 代码块占位 */
  var ph=L.match(/\\u0000C(\\d+)\\u0000/);
  if(ph&&L.trim()===ph[0]){
   flushP(pbuf);pbuf=[];
   var cd=codes[+ph[1]];
   out.push('<pre><code class="language-'+esc(cd.lang)+'">'+esc(cd.body)+'</code></pre>');
   i++;continue;
  }
  pbuf.push(L);i++;
 }
 flushP(pbuf);
 /* 恢复行内占位（段落中被 esc 过的占位符不会出现——占位符本身无特殊字符，但 esc 不影响 \\u0000） */
 out.forEach(function(seg,ix){out[ix]=seg.replace(/\\u0000C(\\d+)\\u0000/g,function(_,n){var cd=codes[+n];return '<pre><code class="language-'+esc(cd.lang)+'">'+esc(cd.body)+'</code></pre>'})});
 return {html:out.join('\\n'),frontmatter:fm,toc:toc};
}
/* ── 树渲染 ── */
function label(p){return p.replace(/\\.md$/,'')}
function nodeHtml(n){
 if(n.type==='file'){
  return '<div class="tfile" data-path="'+esc(n.path)+'">'+esc(label(n.name))+'</div>';
 }
 return '<div class="tdir" data-open="0"><span class="arrow">▶</span>'+esc(n.name)+'<span class="cnt">'+(n.count||'')+'</span>'+
  '<div class="kids">'+(n.children||[]).map(nodeHtml).join('')+'</div></div>';
}
function renderTree(){
 var el=$('#tree');
 if(!state.tree.length){
  el.innerHTML='<div id="emptyTree">尚未生成文档。<br>在项目根目录执行：<br><code>nice-aos output docs</code><br>然后刷新本页。</div>';
  $('#stats').textContent='0 篇文档';
  return;
 }
 el.innerHTML=state.tree.map(nodeHtml).join('');
 el.querySelectorAll('.tdir').forEach(function(d){
  d.addEventListener('click',function(e){
   if(e.target.closest('.tfile'))return;
   d.classList.toggle('open');
   d.dataset.open=d.classList.contains('open')?'1':'0';
  });
 });
 var first=el.querySelector('.tdir');if(first)first.classList.add('open');
 el.querySelectorAll('.tfile').forEach(function(f){
  f.addEventListener('click',function(){openDoc(f.dataset.path);closeDrawer()});
 });
 $('#stats').textContent=state.totalFiles+' 篇文档';
}
function filterTree(q){
 q=q.trim().toLowerCase();
 $('#tree').querySelectorAll('.tfile').forEach(function(f){
  var hit=!q||(f.dataset.path.toLowerCase().indexOf(q)>=0);
  f.style.display=hit?'':'none';
 });
 $('#tree').querySelectorAll('.tdir').forEach(function(d){
  var any=[].slice.call(d.querySelectorAll('.tfile')).some(function(f){return f.style.display!=='none'});
  d.style.display=any?'':'none';
  if(q&&any)d.classList.add('open');else if(!q){/* 保持用户展开态 */ }
 });
}
/* ── TOC / scroll-spy ── */
function renderToc(toc){
 var el=$('#toc');
 if(!toc.length){el.innerHTML='';return}
 el.innerHTML='<div class="cap">目录</div>'+toc.map(function(t){
  return '<a class="l'+t.lv+'" href="#'+t.id+'">'+esc(t.text)+'</a>';
 }).join('');
}
function spyInit(){
 var main=$('#main'),heads=[].slice.call($('#doc').querySelectorAll('h2,h3,h4'));
 var links={};$('#toc').querySelectorAll('a').forEach(function(a){links[a.getAttribute('href').slice(1)]=a});
 function onScroll(){
  var cur=null;
  for(var i=0;i<heads.length;i++){
   if(heads[i].getBoundingClientRect().top<100)cur=heads[i].id;else break;
  }
  Object.keys(links).forEach(function(k){links[k].classList.toggle('on',k===cur)});
 }
 main.onscroll=onScroll;onScroll();
}
/* ── 文档加载 ── */
function setState(kind,msg){
 var w=$('#doc');
 if(kind==='loading')w.innerHTML='<div class="state"><div class="spinner"></div>加载中…</div>';
 else if(kind==='error')w.innerHTML='<div class="state"><h2>加载失败</h2><div class="hint">'+esc(msg||'')+'</div><button id="retry">重试</button></div>',bindRetry();
 else if(kind==='welcome')w.innerHTML='<div class="state"><h2>📚 项目文档</h2><div class="hint">从左侧目录选择一篇文档开始浏览<br>本页由 <code>nice-aos output docs</code> 生成 · <code>nice-aos serve</code> 提供 /docs 入口</div></div>';
}
function bindRetry(){var r=$('#retry');if(r)r.addEventListener('click',function(){openDoc(state.current||'index.md')})}
function crumbHtml(path){
 var parts=path.split('/'),out=[],acc=[];
 parts.forEach(function(p,ix){
  acc.push(p);
  var name=ix===parts.length-1?label(p):p;
  out.push(ix===parts.length-1?'<b>'+esc(name)+'</b>':'<span>'+esc(p)+'</span>');
  if(ix<parts.length-1)out.push('<span> / </span>');
 });
 return out.join('');
}
function openDoc(path,hash){
 state.current=path;
 history.pushState(null,'','?doc='+encodeURIComponent(path));
 $('#tree').querySelectorAll('.tfile').forEach(function(f){f.classList.toggle('active',f.dataset.path===path)});
 $('#crumb').innerHTML=crumbHtml(path);
 setState('loading');
 fetch('./'+encPath(path)).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}).then(function(text){
  state.raw=text;
  var parsed=parseMd(text);
  var fmHtml='';
  if(parsed.frontmatter){
   fmHtml='<div class="fm">'+Object.entries(parsed.frontmatter).map(function(kv){
    var cls=kv[0]==='layer'?' class="layer-'+esc(kv[1])+'"':'';
    return '<span'+cls+'><b>'+esc(kv[0])+'</b>'+esc(kv[1])+'</span>';
   }).join('')+'</div>';
  }
  $('#doc').innerHTML=fmHtml+parsed.html;
  renderToc(parsed.toc);
  $('#main').scrollTop=0;
  spyInit();
  if(hash){
   var el=document.getElementById(hash);
   if(el)el.scrollIntoView({behavior:'smooth'});
  }
 }).catch(function(e){
  setState('error','文档 <code style="font-family:var(--mono)">'+esc(path)+'</code> 加载失败：'+esc(e.message)+'<br>若刚生成，请刷新页面重试。');
 });
}
/* 站内 .md 链接拦截：相对「当前文档目录」解析（与磁盘相对语义一致），#/http#/mailto 直放 */
function resolveRel(baseDir,rel){
 var parts=baseDir?baseDir.split('/').filter(Boolean):[];
 String(rel).split('/').forEach(function(seg){
  if(seg===''||seg==='.')return;
  if(seg==='..')parts.pop();else parts.push(seg);
 });
 return parts.join('/');
}
document.addEventListener('click',function(e){
 var a=e.target&&e.target.closest?e.target.closest('a'):null;
 if(!a)return;
 var href=a.getAttribute('href')||'';
 if(!href||/^(https?:|mailto:)/i.test(href))return;
 var hashIdx=href.indexOf('#');
 var filePart=hashIdx>=0?href.slice(0,hashIdx):href;
 var hash=hashIdx>=0?href.slice(hashIdx+1):'';
 if(hashIdx===0){return} /* 纯页内锚点交给浏览器 */
 if(!/\\.md$/i.test(filePart))return;
 e.preventDefault();
 var baseDir=state.current?state.current.split('/').slice(0,-1).join('/'):'';
 openDoc(resolveRel(baseDir,filePart),hash||undefined);
},true);
/* ── 抽屉 ── */
function closeDrawer(){$('#sidebar').classList.remove('open');$('#mask').classList.remove('show')}
/* ── 启动 ── */
function boot(){
 $('#menuBtn').addEventListener('click',function(){$('#sidebar').classList.toggle('open');$('#mask').classList.toggle('show')});
 $('#mask').addEventListener('click',closeDrawer);
 $('#searchInput').addEventListener('input',function(e){filterTree(e.target.value)});
 $('#copyBtn').addEventListener('click',function(){
  if(!state.raw)return;
  (navigator.clipboard?navigator.clipboard.writeText(state.raw):Promise.reject()).then(function(){
   $('#copyBtn').textContent='✓ 已复制';setTimeout(function(){$('#copyBtn').textContent='复制源码'},1500);
  }).catch(function(){$('#copyBtn').textContent='复制失败'});
 });
 window.addEventListener('popstate',function(){boot2()});
 boot2();
}
function boot2(){
 fetch('./tree.json').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(tj){
  state.tree=tj.tree||[];state.totalFiles=tj.totalFiles||0;
  renderTree();
  var want=new URLSearchParams(location.search).get('doc');
  var paths=collectPaths(state.tree);
  openDoc(want&&paths.indexOf(want)>=0?want:'index.md');
 }).catch(function(){
  $('#tree').innerHTML='<div id="emptyTree">未找到 <code>tree.json</code>。<br>请先在项目根目录执行：<br><code>nice-aos output docs</code></div>';
  setState('welcome');
 });
}
function collectPaths(nodes,out){
 out=out||[];
 (nodes||[]).forEach(function(n){if(n.type==='file')out.push(n.path);else collectPaths(n.children,out)});
 return out;
}
document.addEventListener('DOMContentLoaded',boot);
/* 测试钩子：Node 单测经最小 DOM stub 执行本脚本后可直取解析器 */
window.__docsParser={parseMd:parseMd};
})();
`;

export function renderDocsHtml({ title = '项目文档', projectName = '' } = {}) {
  const safeTitle = String(title).replace(/</g, '&lt;');
  const safeProj = String(projectName).replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title><style>${DOCS_CSS}</style></head>
<body>
<header id="topbar">
  <button id="menuBtn" title="目录">☰</button>
  <div class="brand">📚 项目文档${safeProj ? ` <span class="proj">${safeProj}</span>` : ''}</div>
  <div id="searchWrap"><input id="searchInput" placeholder="搜索文档路径…" autocomplete="off"></div>
  <button id="copyBtn" title="复制本页 Markdown 源码">复制源码</button>
</header>
<div id="layout">
  <aside id="sidebar"><div id="stats"></div><nav id="tree"></nav></aside>
  <div id="mask"></div>
  <main id="main"><div id="docWrap"><div id="crumb"></div><div id="doc"></div></div></main>
</div>
<aside id="toc"></aside>
<script>${DOCS_JS}</script>
</body></html>`;
}
