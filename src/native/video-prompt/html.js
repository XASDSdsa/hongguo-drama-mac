'use strict';
// 一集的「分镜头脚本」页面：深色三栏分镜卡片，一个独立的 HTML 文件。
// 版式对照用户给的分镜头脚本模板：左 = 视频预览 + 四宫格关键帧，中 = 提示词/台词音效/参数，右 = 台词原文/画面观察/素材库/记录。
// 页面里只放真实数据：没有数据来源的项（渲染状态、一致性分数、匹配率、重试/生成按钮等）不显示。
// 纯函数，不碰文件和网络；关键帧和参考图由调用方抽好后以 data URI 传进来。

const { libraryEntries } = require('./compose');

const QUIET = /^(无|没有|无声|看不清|听不清|不详)$/;
const KIND_TEXT = { character: '角色', scene: '场景', prop: '道具' };
const FRAME_LABELS = ['起幅', '动作A', '动作B', '落幅'];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function clock(value) {
  const total = Math.max(0, Math.round(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function clockPrecise(value) {
  const v = Math.max(0, value);
  const whole = Math.floor(v / 60);
  return `${whole}:${(v - whole * 60).toFixed(1).padStart(4, '0')}`;
}
function seconds(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}秒`;
}
function pad2(value) {
  return String(value).padStart(2, '0');
}
function localStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function json(value) {
  // 放进 <script> 里：把 < 转义，避免提前结束标签。
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 每个分镜抽四张关键帧的时间点：起幅、动作A、动作B、落幅。避开切点本身，免得抽到相邻分镜。 */
function keyframeTimes(row) {
  const pad = Math.min(0.12, row.dur * 0.1);
  const a = row.start + pad;
  const d = Math.max(a, row.end - pad);
  return [a, a + (d - a) / 3, a + ((d - a) * 2) / 3, d];
}

const CSS = `
:root{--bg:#080d16;--panel:#0c131f;--panel2:#0f1827;--line:#1b2536;--line2:#233047;--text:#d5deec;--muted:#7a879c;--teal:#1f9d83;--teal2:#27c4a2;--blue:#3b82f6;--green:#3ddc97;--amber:#e8a33d;--red:#ff5d73;--violet:#8b6cf0}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif}
button{font:inherit;color:inherit;cursor:pointer}
.top{height:42px;display:flex;align-items:center;gap:22px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:20}
.brand{font-size:17px;font-weight:700;color:#fff;height:42px;display:flex;align-items:center;border-bottom:2px solid var(--blue);cursor:pointer}
.top nav{display:flex;gap:22px;color:var(--muted)}
.top nav a{cursor:pointer;color:var(--text)}
.top nav a.on{color:#fff}
.top .sp{flex:1}
.pill{border:1px solid var(--line2);border-radius:6px;padding:4px 12px;color:var(--text);background:var(--panel)}
.stat{color:var(--muted);display:flex;align-items:center;gap:6px}
.stat i{width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block}
.stat i.warn{background:var(--amber)}
.sub{height:52px;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--line)}
.sub h1{margin:0;font-size:14px;font-weight:600;color:#fff}
.btn{border:1px solid var(--line2);background:var(--panel2);border-radius:6px;padding:5px 14px;color:var(--text)}
.btn:hover{border-color:#34486b}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}
.btn.sm{padding:3px 10px;font-size:12px}
.filter{display:flex;align-items:center;gap:12px;padding:12px 18px}
.filter input{flex:0 1 270px;height:32px;background:var(--panel);border:1px solid var(--line2);border-radius:6px;padding:0 12px;color:var(--text);font:inherit}
.filter input::placeholder{color:#55627a}
.filter .sp{flex:1}
.stylebar{margin:0 18px 12px;padding:9px 14px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);color:var(--text);display:none}
.stylebar.on{display:block}
.stylebar b{color:var(--teal2);margin-right:8px}
main{padding:0 14px 40px}
.seg{margin-bottom:14px}
.seghead{display:flex;align-items:center;gap:12px;min-height:46px;padding:0 16px;border:1px solid var(--line);border-left:3px solid var(--teal);border-radius:8px;background:var(--panel)}
.seghead .dots{cursor:pointer;color:var(--muted);letter-spacing:2px;user-select:none}
.seghead b{color:#fff}
.seghead .meta{color:var(--muted)}
.seghead .sp{flex:1}
.chip{display:inline-block;padding:1px 9px;border-radius:5px;font-size:12px;border:1px solid transparent;white-space:nowrap}
.chip.g{background:#0f3a2c;color:var(--green);border-color:#17533f}
.chip.a{background:#3a2a0e;color:var(--amber);border-color:#58411a}
.chip.b{background:#10305a;color:#6aa7ff;border-color:#1a4686}
.chip.v{background:#2b2150;color:#ab97ff;border-color:#3d2f75}
.chip.r{background:#451a25;color:var(--red);border-color:#6a2636}
.chip.m{background:#141c2b;color:var(--muted);border-color:#232f44}
.seg.collapsed .shots{display:none}
.shot{display:grid;grid-template-columns:598fr 515fr 330fr;margin-top:12px;border:1px solid var(--teal);border-radius:8px;background:var(--panel);overflow:hidden}
.shot[hidden]{display:none}
.c1{padding:14px;min-width:0}
.c2{padding:14px 14px 14px;border-left:1px solid var(--line);border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.c3{padding:14px;min-width:0}
.vbox{position:relative;aspect-ratio:570/337;background:#000;border-radius:6px;overflow:hidden}
.vbox img.poster,.vbox video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.vbox video{display:none}
.vbox.on video{display:block}
.vbox.on img.poster{display:none}
.vbox:fullscreen video{object-fit:contain}
.vtag{position:absolute;left:10px;top:10px;background:rgba(10,16,28,.78);border:1px solid rgba(255,255,255,.16);border-radius:5px;padding:1px 9px;font-size:12px;color:#fff;z-index:2}
.vbar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;padding:20px 14px 10px;background:linear-gradient(transparent,rgba(0,0,0,.72));z-index:2;color:#fff}
.vbar button{background:none;border:0;padding:0;color:#fff;font-size:15px;line-height:1}
.vtime{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.vtrack{flex:1;height:4px;background:rgba(255,255,255,.28);border-radius:2px;cursor:pointer;position:relative}
.vtrack i{position:absolute;left:0;top:0;bottom:0;width:0;background:#fff;border-radius:2px}
.vmsg{position:absolute;left:0;right:0;top:44%;text-align:center;color:#ffd7a0;font-size:12px;z-index:2;display:none;padding:0 20px}
.vbox.err .vmsg{display:block}
.gridhead{margin:11px 0 7px;font-size:13px;color:var(--text)}
.gridhead small{color:var(--muted);font:11px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;margin-left:6px}
.kf{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kf button{position:relative;aspect-ratio:280/110;border:2px solid transparent;border-radius:4px;padding:0;background:#05080e;overflow:hidden}
.kf button.on{border-color:var(--teal2)}
.kf img{width:100%;height:100%;object-fit:cover;display:block}
.kf .none{display:flex;align-items:center;justify-content:center;height:100%;color:#3b475c;font-size:12px}
.kf span{position:absolute;left:0;right:0;bottom:0;padding:10px 8px 3px;text-align:left;font-size:11px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.7))}
.kfnote{margin-top:8px;color:var(--muted);font-size:11.5px}
.tagrow{border:1px solid var(--line2);border-radius:6px;background:var(--panel2);padding:5px 12px;margin-bottom:10px;display:flex;gap:12px;align-items:center;white-space:nowrap;overflow:hidden}
.tagrow b{font-weight:600;color:#fff}
.tagrow span{color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.title{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;margin-bottom:10px}
.title h2{margin:0 6px 0 0;font-size:17px;color:#fff}
.title .sp{flex:1}
.title .sec{color:var(--muted)}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line2);margin-bottom:12px}
.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:6px 12px;color:var(--muted);margin-bottom:-1px}
.tabs button.on{color:#fff;font-weight:600;border-bottom-color:var(--blue)}
.pane{display:none;flex:1;min-height:150px;font-size:13px}
.pane.on{display:block}
.kv{margin:0 0 7px;line-height:1.7}
.kv b{color:#fff}
.mono{white-space:pre-wrap;word-break:break-all;font:12.5px/1.7 ui-monospace,Menlo,Consolas,"PingFang SC",monospace;margin:0}
.imglist{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px}
.imglist li{display:flex;gap:8px;align-items:center;border:1px solid var(--line2);border-radius:6px;padding:4px 8px 4px 4px;background:var(--panel2);font-size:12px}
.imglist img{width:34px;height:34px;object-fit:cover;border-radius:4px}
.snd{margin:12px 0 10px;padding-top:12px;border-top:1px solid var(--line);font-size:12.5px}
.snd div{margin:4px 0;display:flex;gap:8px;align-items:baseline}
.snd em{font-style:normal;flex:none;padding:0 7px;border-radius:4px;font-size:12px;border:1px solid}
.snd .t1{color:var(--amber);background:#3a2a0e;border-color:#58411a}
.snd .t2{color:var(--green);background:#0f3a2c;border-color:#17533f}
.snd .t3{color:#ab97ff;background:#2b2150;border-color:#3d2f75}
.snd .no{color:var(--muted)}
.params{border-top:1px solid var(--line);padding-top:10px}
.params h3,.blk h3{margin:0 0 6px;font-size:13px;color:#fff;border-left:3px solid var(--blue);padding-left:8px;line-height:1.2}
.ptable{display:grid;grid-template-columns:1fr 1fr;column-gap:26px}
.ptable div{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed #19243a;font-size:12.5px}
.ptable span{color:var(--muted);flex:none}
.ptable b{font-weight:500;color:var(--text);text-align:right;overflow:hidden;text-overflow:ellipsis}
.acts{display:flex;justify-content:center;gap:10px;margin-top:12px;flex-wrap:wrap}
.blk{margin-bottom:18px}
.blk.head{display:flex;justify-content:space-between;align-items:baseline}
.blk.head h3{border:0;padding:0;font-size:13.5px;margin:0}
.blk.head small{color:var(--amber);font-weight:600;font-size:13px}
.say{color:#b9c4d8;font-size:12.5px;line-height:1.85;margin:6px 0 0}
.say time{color:var(--muted);margin-right:6px;font-variant-numeric:tabular-nums}
.obs{font-size:12.5px;line-height:1.8;color:#b9c4d8}
.obs b{color:var(--green);font-weight:500;margin-right:4px}
.asset{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);padding:7px 9px;margin-bottom:7px;font-size:12px;line-height:1.6;color:#b9c4d8}
.asset img,.asset .ph{width:38px;height:38px;border-radius:5px;object-fit:cover;flex:none;background:#142033}
.asset .ph{display:flex;align-items:center;justify-content:center;color:#5b6b86;font-size:15px}
.asset em{font-style:normal;color:var(--muted);margin-left:4px}
.hist{font-size:12px;color:#b9c4d8}
.hist div{display:flex;gap:8px;align-items:center;margin:5px 0}
.hist i{font-style:normal;background:#12315a;color:#6aa7ff;border-radius:4px;padding:0 6px;font-size:11px}
.hist i.x{background:#451a25;color:var(--red)}
.empty{color:var(--muted)}
.libgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:6px 4px}
.libgrid .asset{margin:0;padding:10px;font-size:12.5px}
.libgrid .asset img,.libgrid .asset .ph{width:64px;height:64px}
.view{display:none}.view.on{display:block}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#12315a;border:1px solid #1a4686;color:#fff;border-radius:6px;padding:7px 16px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:50}
.toast.on{opacity:1}
.none-msg{padding:40px;text-align:center;color:var(--muted);display:none}
@media (max-width:860px){.shot{grid-template-columns:1fr}.c2{border:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.top{flex-wrap:wrap;height:auto;padding:6px 14px}}
`;

const SCRIPT = `
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
var toastEl=$('.toast'),tt;
function toast(m){toastEl.textContent=m;toastEl.classList.add('on');clearTimeout(tt);tt=setTimeout(function(){toastEl.classList.remove('on')},1400)}
function copy(text){
  var done=function(){toast('已复制')};
  if(navigator.clipboard&&window.isSecureContext!==false){navigator.clipboard.writeText(text).then(done,function(){fallback(text);done()});return}
  fallback(text);done();
}
function fallback(text){var t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;opacity:0';document.body.appendChild(t);t.select();try{document.execCommand('copy')}catch(e){}t.remove()}
function fmt(t){t=Math.max(0,Math.floor(t));return (t<600?'0':'')+Math.floor(t/60)+':'+(t%60<10?'0':'')+(t%60)}
document.addEventListener('click',function(e){
  var c=e.target.closest('[data-copy]');
  if(c){var p=c.getAttribute('data-copy').split(':');
    if(p[0]==='all')copy(D.all);
    else if(p[0]==='seg')copy(D.segments[+p[1]].prompt);
    else if(p[0]==='shot')copy(D.segments[+p[1]].shots[+p[2]].line);
    else if(p[0]==='say')copy(D.segments[+p[1]].shots[+p[2]].say||'');
    return}
  var tab=e.target.closest('.tabs button');
  if(tab){var card=tab.closest('.shot');$$('.tabs button',card).forEach(function(b){b.classList.toggle('on',b===tab)});
    $$('.pane',card).forEach(function(x){x.classList.toggle('on',x.getAttribute('data-pane')===tab.getAttribute('data-tab'))});return}
  var dots=e.target.closest('.dots');if(dots){dots.closest('.seg').classList.toggle('collapsed');return}
  var nav=e.target.closest('[data-view]');
  if(nav){$$('[data-view]').forEach(function(a){a.classList.toggle('on',a===nav&&a.tagName==='A')});
    $$('.view').forEach(function(v){v.classList.toggle('on',v.id==='view-'+nav.getAttribute('data-view'))});
    var f=$('.filter');f.style.display=nav.getAttribute('data-view')==='shots'?'':'none';return}
  if(e.target.closest('#styleBtn')){$('.stylebar').classList.toggle('on');return}
  var kf=e.target.closest('.kf button');
  if(kf){var box=kf.closest('.c1').querySelector('.vbox');$$('.kf button',kf.closest('.kf')).forEach(function(b){b.classList.toggle('on',b===kf)});
    seek(box,parseFloat(kf.getAttribute('data-t')),false);return}
  var vp=e.target.closest('.vplay');if(vp){var b=vp.closest('.vbox');toggle(b);return}
  var vf=e.target.closest('.vfull');if(vf){var b2=vf.closest('.vbox');(b2.requestFullscreen||b2.webkitRequestFullscreen||function(){}).call(b2);return}
  var tr=e.target.closest('.vtrack');
  if(tr){var b3=tr.closest('.vbox'),r=tr.getBoundingClientRect(),s=+b3.dataset.start,en=+b3.dataset.end;seek(b3,s+(en-s)*Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),false);return}
  var vb=e.target.closest('.vbox');if(vb&&!e.target.closest('.vbar'))toggle(vb);
});
function video(box){
  var v=$('video',box);
  if(!v.getAttribute('src')){
    v.addEventListener('error',function(){box.classList.add('err');box.classList.remove('on')});
    v.addEventListener('timeupdate',function(){
      var s=+box.dataset.start,en=+box.dataset.end;
      if(v.currentTime>=en-0.03&&!v.paused){v.pause();v.currentTime=s}
      var p=Math.min(1,Math.max(0,(v.currentTime-s)/(en-s)));
      $('.vtrack i',box).style.width=(p*100)+'%';
      $('.vtime',box).textContent=fmt(Math.max(0,v.currentTime-s))+' / '+fmt(en-s);
    });
    v.addEventListener('play',function(){$('.vplay',box).textContent='❚❚'});
    v.addEventListener('pause',function(){$('.vplay',box).textContent='▶'});
    v.preload='metadata';
    v.src=box.dataset.src;
    v.load();
  }
  return v;
}
function seek(box,t,play){
  var v=video(box);box.classList.remove('err');box.classList.add('on');
  var go=function(){v.currentTime=t;if(play)v.play().catch(function(){})};
  if(v.readyState>=1)go();else v.addEventListener('loadedmetadata',go,{once:true});
}
function toggle(box){
  var v=video(box),s=+box.dataset.start,en=+box.dataset.end;
  if(!box.classList.contains('on')||v.currentTime<s-0.05||v.currentTime>=en-0.05){seek(box,s,true);return}
  if(v.paused)v.play().catch(function(){});else v.pause();
}
var q=$('#q');
q.addEventListener('input',function(){
  var k=q.value.trim().toLowerCase(),total=0;
  $$('.seg').forEach(function(seg){
    var n=0;$$('.shot',seg).forEach(function(s){var ok=!k||s.getAttribute('data-q').indexOf(k)>=0;s.hidden=!ok;if(ok)n++});
    seg.style.display=n?'':'none';total+=n});
  $('.none-msg').style.display=total?'none':'block';
});
})();
`;

function assetBlock(item, thumbs) {
  const thumb = thumbs[item.id];
  const head = thumb ? `<img src="${esc(thumb)}" alt="">` : `<div class="ph">${esc((item.name || '?').slice(0, 1))}</div>`;
  return `<div class="asset">${head}<div><b>${esc(item.name)}</b><em>#${esc(item.id)} · ${KIND_TEXT[item.kind] || ''}</em><br>${esc(item.desc || '（无描述）')}</div></div>`;
}

function shotCard({ segment, segIndex, row, shot, shotIndex, library, byId, frames, thumbs, videoRel, size, segCount, shotTotal, stamp, failedMessage }) {
  const frame = frames?.[row.no] || {};
  const times = keyframeTimes(row);
  const assets = (shot?.assets || []).map((id) => byId.get(id)).filter(Boolean);
  const people = assets.filter((item) => item.kind === 'character');
  const scenes = assets.filter((item) => item.kind === 'scene');
  const props = assets.filter((item) => item.kind === 'prop');
  const hasPrompt = Boolean(shot) && !failedMessage;
  const soundText = shot && !QUIET.test(shot.sound || '') ? shot.sound : '';
  const musicText = shot && !QUIET.test(shot.music || '') ? shot.music : '';
  const expression = shot && !QUIET.test(shot.expression || '') ? shot.expression : '';
  const sayText = row.dialogue.join(' ');
  const search = [
    `镜头${pad2(row.no)}`,
    sayText,
    shot?.camera,
    shot?.action,
    expression,
    soundText,
    musicText,
    ...assets.map((item) => `${item.name} ${item.id}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const kv = (label, value) => (value ? `<p class="kv"><b>${label}：</b>${esc(value)}</p>` : '');
  const list = (items) => items.map((item) => `${item.name}${item.desc ? `（${item.desc}）` : ''}`).join('；');
  const promptPane = hasPrompt
    ? [
        kv('出场角色', list(people)),
        kv('场景', list(scenes)),
        kv('道具', list(props)),
        kv('景别运镜', shot.camera),
        kv('画面动作', shot.action),
        kv('可见表现', expression),
        kv('结束状态', shot.end_state),
      ].join('')
    : `<p class="empty">${esc(failedMessage ? `本段没有生成成功：${failedMessage}` : '没有提示词')}</p>`;

  const lineText = hasPrompt ? segment.shotLines?.[shotIndex] || '' : '';
  const refList = (segment.images || []).length
    ? `<ul class="imglist">${segment.images
        .map((image) => {
          const thumb = thumbs[image.id];
          const item = byId.get(image.id);
          return `<li>${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}<span>图片${image.index} = ${esc(item?.name || image.id)}</span></li>`;
        })
        .join('')}</ul>`
    : '';

  const soundPane = [
    `<p class="kv"><b>台词：</b>${row.dialogue.length ? esc(row.dialogue.join('　')) : '<span class="empty">无</span>'}</p>`,
    `<p class="kv"><b>环境音：</b>${soundText ? esc(soundText) : '<span class="empty">无</span>'}</p>`,
    `<p class="kv"><b>配乐：</b>${musicText ? esc(musicText) : '<span class="empty">无</span>'}</p>`,
  ].join('');

  // 这个分镜自己用到的、带参考图的素材（不是整段所有分镜加起来的）
  const shotImages = (segment.images || []).filter((image) => (shot?.assets || []).includes(image.id)).length;
  const params = [
    ['目标模型', 'Seedance 2.5'],
    ['原片画幅', size ? `${size.width}×${size.height}` : '—'],
    ['时长', seconds(row.dur)],
    ['所属片段', `第 ${segment.index}/${segCount} 段`],
    ['段内时间', `${seconds(row.start - segment.start).replace('秒', '')}–${seconds(row.end - segment.start)}`],
    ['整集位置', `${clockPrecise(row.start)}–${clockPrecise(row.end)}`],
    ['参考图', `${shotImages} 张`],
    ['本集镜头', `第 ${row.no}/${shotTotal} 镜`],
  ];
  const ptable = `<div class="ptable">${params.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>`;

  const chips = [
    hasPrompt ? '<span class="chip g">提示词已生成</span>' : '<span class="chip r">本段未生成</span>',
    frame.grid?.some(Boolean) ? '<span class="chip b">有关键帧</span>' : '',
    row.dialogue.length ? '<span class="chip v">有台词</span>' : '<span class="chip m">无台词</span>',
  ].join('');

  const kfHtml = FRAME_LABELS.map((label, i) => {
    const src = frame.grid?.[i];
    return `<button type="button" data-t="${times[i].toFixed(2)}"${i === 0 ? ' class="on"' : ''}>${
      src ? `<img src="${esc(src)}" alt="${label}">` : '<div class="none">无画面</div>'
    }<span>${label}</span></button>`;
  }).join('');

  const poster = frame.poster || frame.grid?.[0] || '';
  const vbox = `<div class="vbox" data-start="${row.start.toFixed(3)}" data-end="${row.end.toFixed(3)}" data-src="${esc(videoRel || '')}">${
    poster ? `<img class="poster" src="${esc(poster)}" alt="">` : ''
  }<video playsinline preload="none"></video><span class="vtag">视频预览</span><div class="vmsg">原片不在这个文件夹里，无法预览（关键帧不受影响）</div><div class="vbar"><button type="button" class="vplay" aria-label="播放">▶</button><span class="vtime">00:00 / ${clock(row.dur).padStart(5, '0')}</span><div class="vtrack"><i></i></div><button type="button" class="vfull" aria-label="全屏">⛶</button></div></div>`;

  const observe = [
    expression ? `<div><b>表现</b>${esc(expression)}</div>` : '',
    shot?.end_state ? `<div><b>结束</b>${esc(shot.end_state)}</div>` : '',
    soundText ? `<div><b>声音</b>${esc(soundText)}</div>` : '',
  ].join('');

  const lines = row.dialogue.length
    ? row.dialogue.map((text) => `<p class="say">${esc(text)}</p>`).join('')
    : '<p class="say empty">本镜没有台词。</p>';

  const assetsHtml = assets.length ? assets.map((item) => assetBlock(item, thumbs)).join('') : '<p class="empty">本镜没有标注素材。</p>';

  return `<article class="shot" data-q="${esc(search)}">
<div class="c1">${vbox}<div class="gridhead">四宫格参考<small>KEYFRAMES</small></div><div class="kf">${kfHtml}</div><div class="kfnote">关键帧取自原片 ${times.map(clockPrecise).join(' / ')}，点击可跳到该处</div></div>
<div class="c2">
<div class="tagrow"><b>片段 ${segment.index}</b><span>整集 ${clockPrecise(row.start)} – ${clockPrecise(row.end)}　·　${seconds(row.dur)}</span></div>
<div class="title"><h2>镜头 ${pad2(row.no)}</h2>${chips}<span class="sp"></span><span class="sec">秒数 ${seconds(row.dur)}</span></div>
<div class="tabs"><button type="button" class="on" data-tab="p">提示词</button><button type="button" data-tab="s">台词与音效</button><button type="button" data-tab="r">本镜原文</button><button type="button" data-tab="g">整段原文</button></div>
<div class="pane on" data-pane="p">${promptPane}</div>
<div class="pane" data-pane="s">${soundPane}</div>
<div class="pane" data-pane="r"><pre class="mono">${esc(lineText || '（没有）')}</pre></div>
<div class="pane" data-pane="g"><pre class="mono">${esc(segment.prompt || '')}</pre>${refList}</div>
<div class="snd">
<div><em class="t1">台词</em>${row.dialogue.length ? `<span>${esc(row.dialogue.join('；'))}</span>` : '<span class="no">无</span>'}</div>
<div><em class="t2">环境音</em>${soundText ? `<span>${esc(soundText)}</span>` : '<span class="no">无</span>'}</div>
<div><em class="t3">配乐</em>${musicText ? `<span>${esc(musicText)}</span>` : '<span class="no">无</span>'}</div>
</div>
<div class="params"><h3>生成参数</h3>${ptable}</div>
<div class="acts"><button type="button" class="btn primary sm" data-copy="seg:${segIndex}">复制整段提示词</button><button type="button" class="btn sm" data-copy="shot:${segIndex}:${shotIndex}"${hasPrompt ? '' : ' disabled'}>复制本镜</button><button type="button" class="btn sm" data-copy="say:${segIndex}:${shotIndex}"${row.dialogue.length ? '' : ' disabled'}>复制台词</button></div>
</div>
<div class="c3">
<div class="blk head"><h3>台词原文</h3><small>${row.dialogue.length} 句</small></div>
<div class="blk" style="margin-top:-12px">${lines}</div>
<div class="blk"><h3>画面观察</h3><div class="obs">${observe || '<span class="empty">没有可记录的内容</span>'}</div></div>
<div class="blk"><h3>角色资产库</h3>${assetsHtml}</div>
<div class="blk"><h3>生成记录</h3><div class="hist"><div><i${hasPrompt ? '' : ' class="x"'}>v1</i><span>${hasPrompt ? '视频反推提示词' : '本段未生成'}${stamp ? ` · ${esc(stamp)}` : ''}</span></div></div></div>
</div>
</article>`;
}

/**
 * @param {object} p
 * @param {string} p.title       剧名（可空）
 * @param {string} p.episodeName 页头显示的集名，如「第3集」（没有就用 label）
 * @param {string} p.label       集名
 * @param {number} p.duration    整集秒数
 * @param {number} p.maxSeconds  每段上限
 * @param {object} p.library     素材库
 * @param {object[]} p.segments  每段：{index,start,end,dur,rows,prompt,images,shotLines,shots,failedMessage,overlong}
 * @param {object} p.frames      镜号 → { poster, grid:[4 个 data URI 或 null] }
 * @param {object} p.thumbs      素材编号 → 缩略图 data URI
 * @param {string} p.videoRel    成品视频相对这个 HTML 的路径
 * @param {{width:number,height:number}} p.size 原片画幅
 * @param {string|Date} p.generatedAt
 */
function renderEpisodeHtml({ title = '', label, episodeName = '', duration, maxSeconds, library, segments, frames = {}, thumbs = {}, videoRel = '', size = null, generatedAt = new Date(), allText = '' }) {
  const byId = new Map(libraryEntries(library).map((item) => [item.id, item]));
  const stamp = localStamp(generatedAt);
  const shotTotal = segments.reduce((sum, segment) => sum + segment.rows.length, 0);
  const okShots = segments.reduce((sum, segment) => sum + (segment.failedMessage ? 0 : segment.rows.length), 0);
  const badShots = shotTotal - okShots;

  const segHtml = segments
    .map((segment, segIndex) => {
      const good = segment.failedMessage ? 0 : segment.rows.length;
      const cards = segment.rows
        .map((row, shotIndex) =>
          shotCard({
            segment,
            segIndex,
            row,
            shot: segment.shots?.[shotIndex],
            shotIndex,
            library,
            byId,
            frames,
            thumbs,
            videoRel,
            size,
            segCount: segments.length,
            shotTotal,
            stamp,
            failedMessage: segment.failedMessage,
          }),
        )
        .join('\n');
      return `<section class="seg">
<div class="seghead"><span class="dots" title="收起/展开">•••</span><b>第${segment.index}段</b><span class="meta">${clock(segment.start)}–${clock(segment.end)} · ${segment.rows.length}个镜头${
        segment.overlong ? ` · 单个分镜超过 ${maxSeconds} 秒，没有切开` : ''
      }</span><span class="sp"></span><span class="chip g">已生成 ${good}</span><span class="chip a">未生成 ${segment.rows.length - good}</span><span class="meta">${seconds(segment.dur)}</span><button type="button" class="btn sm" data-copy="seg:${segIndex}">复制整段提示词</button></div>
<div class="shots">${cards}</div>
</section>`;
    })
    .join('\n');

  const libraryHtml = libraryEntries(library).length
    ? `<div class="libgrid">${libraryEntries(library)
        .map((item) => assetBlock(item, thumbs))
        .join('')}</div>`
    : '<p class="empty" style="padding:30px">素材库是空的。</p>';

  const data = {
    all: allText,
    segments: segments.map((segment) => ({
      prompt: segment.prompt || '',
      shots: segment.rows.map((row, i) => ({
        line: segment.failedMessage ? '' : segment.shotLines?.[i] || '',
        say: row.dialogue.join(' '),
      })),
    })),
  };

  const headTitle = [title, episodeName || label].filter(Boolean).join(' • ');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分镜头脚本 · ${esc(headTitle)}</title><style>${CSS}</style></head><body>
<header class="top"><div class="brand" data-view="shots">分镜头脚本</div><nav><a data-view="library">素材库</a></nav><span class="sp"></span>${
    title ? `<span class="pill">▣ ${esc(title)}</span>` : ''
  }${
    badShots ? `<span class="stat"><i class="warn"></i>${badShots} 镜没有生成提示词</span>` : '<span class="stat"><i></i>提示词已生成</span>'
  }<span class="stat">整集 ${Math.round(duration)} 秒</span><span class="stat">${segments.length} 段 · ${shotTotal} 镜</span>${
    stamp ? `<span class="stat">${esc(stamp)}</span>` : ''
  }</header>
<div class="sub"><h1>${esc(headTitle)}</h1><span class="pill">目标模型 Seedance 2.5</span><span class="pill">每段 ≤ ${esc(maxSeconds)} 秒</span><span style="flex:1"></span><button type="button" class="btn primary" data-copy="all">复制全部提示词</button></div>
<div class="filter"><input id="q" type="search" placeholder="⌕  筛选分镜、角色、场景…" autocomplete="off"><span class="chip g">已生成 ${okShots}</span><span class="chip a">未生成 ${badShots}</span><span class="sp"></span><button type="button" class="btn" id="styleBtn">风格参考</button></div>
<div class="stylebar"><b>画风</b>${esc(library.style || '（没有识别出画风）')}</div>
<main>
<div class="view on" id="view-shots">${segHtml}<div class="none-msg">没有匹配的分镜</div></div>
<div class="view" id="view-library">${libraryHtml}</div>
</main>
<div class="toast"></div>
<script type="application/json" id="data">${json(data)}</script>
<script>${SCRIPT}</script>
</body></html>
`;
}

/** 读 JPEG 头里的宽高（用来得到原片画幅，不需要 ffprobe）。 */
function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

module.exports = { renderEpisodeHtml, keyframeTimes, jpegSize, FRAME_LABELS };
