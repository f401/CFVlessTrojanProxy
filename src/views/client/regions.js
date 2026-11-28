(function(){
  var result=document.getElementById('result');
  var timer=0;
  // 草稿仅保存本用户的选择差量；不保存口令，30 分钟过期，存储不可用时仍可提交表单。
  var form=document.getElementById('saveForm');
  var draftKey='regions-draft:'+location.pathname;
  var draft={nodes:{},regions:{},fields:{},at:Date.now()};
  var dirty=false,submitting=false,paging=false;
  var baseline=signature();
  function selectedValues(name){
    var values=[];
    form.querySelectorAll('input[name="'+name+'"]').forEach(function(input){if(input.type==='hidden'||input.checked)values.push(input.value);});
    return Array.from(new Set(values)).sort();
  }
  function signature(){return JSON.stringify([selectedValues('pinnedNodes'),selectedValues('regions'),document.getElementById('topN').value,document.getElementById('targetHost').value]);}
  function updateDirty(){
    dirty=signature()!==baseline;
    document.getElementById('saveState').textContent=dirty?'有未保存的更改':'选择已保存';
    document.querySelector('.savebar').setAttribute('data-dirty',dirty?'true':'false');
  }
  function persistDraft(){
    draft.at=Date.now();updateDirty();
    try{if(dirty)sessionStorage.setItem(draftKey,JSON.stringify(draft));else sessionStorage.removeItem(draftKey);}catch(ignore){}
  }
  function restoreDraft(){
    try{
      var raw=sessionStorage.getItem(draftKey),stored=raw&&JSON.parse(raw);
      if(!stored||Date.now()-stored.at>1800000)return;
      if(!stored.nodes||!stored.regions||!stored.fields)return;
      draft=stored;
      [['pinnedNodes',draft.nodes],['regions',draft.regions]].forEach(function(pair){
        Object.keys(pair[1]).forEach(function(value){
          var found=false;
          form.querySelectorAll('input[name="'+pair[0]+'"]').forEach(function(input){
            if(input.value!==value)return;found=true;
            if(input.type==='hidden'){if(!pair[1][value])input.remove();}else input.checked=!!pair[1][value];
          });
          if(!found&&pair[1][value]){var input=document.createElement('input');input.type='hidden';input.name=pair[0];input.value=value;document.getElementById('preservedSelection').appendChild(input);}
        });
      });
      ['topN','targetHost'].forEach(function(id){if(typeof draft.fields[id]==='string')document.getElementById(id).value=draft.fields[id];});
      persistDraft();
    }catch(ignore){}
  }
  form.addEventListener('change',function(event){
    var input=event.target;
    if(input.name==='pinnedNodes')draft.nodes[input.value]=input.checked;
    if(input.name==='regions')draft.regions[input.value]=input.checked;
    if(input.id==='topN'||input.id==='targetHost')draft.fields[input.id]=input.value;
    persistDraft();
  });
  form.addEventListener('input',function(event){var input=event.target;if(input.id==='topN'||input.id==='targetHost'){draft.fields[input.id]=input.value;persistDraft();}});
  form.addEventListener('submit',function(){submitting=true;});
  window.addEventListener('beforeunload',function(event){if(dirty&&!submitting&&!paging){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pageshow',function(){submitting=false;paging=false;});
  document.querySelectorAll('#pager a').forEach(function(link){link.addEventListener('click',function(event){if(!event.ctrlKey&&!event.metaKey&&event.button===0)paging=true;});});
  // 请求结束才解除在途状态；成功后的本地冷却与服务端 60 秒节流保持同一口径。
  function runProbe(button,action,extra,json,site){
    var label=button.textContent;button.disabled=true;button.textContent='探测中…';button.setAttribute('aria-busy','true');
    probe(action,extra,json,site).then(function(){
      button.setAttribute('aria-busy','false');var remaining=60;
      function tick(){button.textContent=label+'（'+remaining+'s）';if(remaining-- > 0)setTimeout(tick,1000);else{button.disabled=false;button.textContent=label;}}
      tick();
    }).catch(function(){button.disabled=false;button.textContent=label;button.setAttribute('aria-busy','false');});
  }
  function show(t,err){
    clearTimeout(timer);
    result.textContent=t;
    result.className='show'+(err?' err':'');
    if(!err)timer=setTimeout(function(){result.className='';},4200);
  }
  // 未探测节点（data-probed=0）默认折叠，点开关切换
  var folded=true;
  function applyFold(){
    document.querySelectorAll('table tr[data-node]').forEach(function(tr){
      var tb=tr.closest('.tw');
      var open=!tb||!tb.classList.contains('folded');
      var unprobed=tr.matches('tr[data-probed="0"]');
      var matched=matchFilter(tr);
      var ok=matched&&open&&(!folded||!unprobed);
      tr.style.display=ok?'':'none';
      tr.classList.toggle('hide',!matched);
    });
  }
  // 分页链接按 data-show 显隐
  document.querySelectorAll('#pager a[data-show]').forEach(function(a){if(a.getAttribute('data-show')==='1')a.style.display='';});
  // 探测后带 site 重载，从 sessionStorage 恢复结果文本
  try{var saved=sessionStorage.getItem('rgProbeResult');if(saved){show(saved);sessionStorage.removeItem('rgProbeResult');}}catch(ignore){}
  function checkedNodes(){
    var out=[];
    form.querySelectorAll('input[name="pinnedNodes"]').forEach(function(c){if(c.type==='hidden'||c.checked)out.push(c.value);});
    return out;
  }
  // 顶部统计与筛选：所有过滤都在本地收窄可见行，不发请求
  var filter='all';
  function rows(){return Array.prototype.slice.call(document.querySelectorAll('table tr[data-node]'));}
  function isSel(tr){var c=tr.querySelector('input[name="pinnedNodes"]');return !!(c&&c.checked);}
  function matchFilter(tr){
    if(filter==='sel'&&!isSel(tr))return false;
    if(filter==='ok'&&tr.getAttribute('data-reach')!=='1')return false;
    if(filter==='no'&&tr.getAttribute('data-reach')!=='-1')return false;
    var q=(document.getElementById('q').value||'').trim().toLowerCase();
    if(!q)return true;
    return (tr.getAttribute('data-search')||tr.textContent||'').toLowerCase().indexOf(q)>=0;
  }
  function refresh(){
    var all=rows(),shown=0,sel=checkedNodes().length;
    applyFold();
    all.forEach(function(tr){
      if(tr.style.display!=='none')shown++;
      if(isSel(tr)){tr.classList.add('sel');}
      else tr.classList.remove('sel');
    });
    document.getElementById('cntShown').textContent=shown;
    document.getElementById('cntAll').textContent=all.length;
    document.getElementById('cntSel').textContent=sel;
    document.getElementById('cntSel2').textContent=sel;
    document.getElementById('cntCc').textContent=selectedValues('regions').length;
    // 组头显示该组被筛掉多少，避免「组还在但行全没了」的困惑
    document.querySelectorAll('h2.cgroup').forEach(function(h){
      var tb=h.nextElementSibling&&h.nextElementSibling.classList.contains('tw')?h.nextElementSibling:null;
      if(!tb)return;
      var trs=Array.prototype.slice.call(tb.querySelectorAll('tr[data-node]'));
      var live=trs.filter(function(t){return !t.classList.contains('hide');}).length;
      h.style.opacity=live?'':'0.45';
      var toggle=h.querySelector('.group-toggle');if(toggle)toggle.setAttribute('aria-expanded',tb.classList.contains('folded')?'false':'true');
    });
  }
  restoreDraft();
  refresh();
  document.addEventListener('input',function(ev){if(ev.target&&ev.target.id==='q')refresh();});
  document.addEventListener('change',function(ev){if(ev.target&&ev.target.name==='pinnedNodes')refresh();if(ev.target&&ev.target.name==='regions')refresh();});
  function probe(action,extra,json,reloadSite){
    var fd=new FormData();
    fd.set('op',action);
    if(extra)for(var k in extra)fd.set(k,extra[k]);
    show('探测中…');
    return fetch(document.getElementById('saveForm').action,{method:'POST',body:fd}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return json?r.json():r.text();})
      .then(function(data){
        if(json&&data&&data.ok&&data.key){
          // 重探结果回填对应表格行：质量徽章 / 类型 / 组织 / 来源
          var row=document.querySelector('tr[data-node="'+data.key.replace(/"/g,'')+'"]');
          if(row){
            var lv=row.querySelector('td[data-cell="level"]');if(lv)lv.innerHTML=data.badge||'';
            var kd=row.querySelector('td[data-cell="kind"]');if(kd)kd.innerHTML=data.kindHtml||'';
            var og=row.querySelector('td[data-cell="org"]');if(og)og.textContent=data.org||'—';
            var sc=row.querySelector('td[data-cell="source"]');if(sc)sc.textContent='重探 '+(data.cc||'')+(data.label||'')+(data.reachable===true?' · 可用':data.reachable===false?' · 黑洞':'');
            if(data.reachable===true)row.setAttribute('data-reach','1');
            else if(data.reachable===false)row.setAttribute('data-reach','-1');
            row.setAttribute('data-probed','1');
            refresh();
          }
          show('重探 '+(data.cc||'')+data.key+'：'+(data.label||''));
        }else show(typeof data==='string'?data:JSON.stringify(data));
        if(reloadSite){try{sessionStorage.setItem('rgProbeResult',typeof data==='string'?data:JSON.stringify(data));}catch(ignore){}setTimeout(function(){var next=new URL(location.href);next.searchParams.set('site',reloadSite);location.href=next.href;},500);}
      })
      .catch(function(e){show('请求失败（'+e.message+'），请检查网络后重试',1);throw e;});
  }
  document.addEventListener('click',function(ev){
    // 组头点击折叠该组；点勾选框本身不触发
    var h=ev.target.closest('h2.cgroup');
    if(h&&!ev.target.matches('input')){
      ev.preventDefault();
      var tb=h.nextElementSibling;
      if(tb&&tb.classList.contains('tw')){var hid=tb.classList.toggle('folded');h.classList.toggle('closed',hid);applyFold();refresh();}
      return;
    }
    var b=ev.target.closest('button');if(!b)return;
    if(b.dataset.filter){
      ev.preventDefault();
      filter=b.dataset.filter;
      document.querySelectorAll('button[data-filter]').forEach(function(x){x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',x===b?'true':'false');});
      refresh();return;
    }
    if(b.dataset.act==='expand'||b.dataset.act==='collapse'){
      ev.preventDefault();
      var open=b.dataset.act==='expand';
      document.querySelectorAll('h2.cgroup').forEach(function(x){
        var tb=x.nextElementSibling;
        if(tb&&tb.classList.contains('tw')){tb.classList.toggle('folded',!open);x.classList.toggle('closed',!open);}
      });
      applyFold();refresh();
      return;
    }
    if(b.dataset.act==='site-probe'){
      ev.preventDefault();
      var site=document.getElementById('probeSite').value.trim();
      if(!site){show('请先填写要探测的网站',1);return;}
      // 只对勾选的节点探测；没勾则服务端回退全池自动挑
      var nodes=checkedNodes();
      runProbe(b,'probe',{site:site,nodes:nodes.join(',')},false,site);return;
    }
    if(b.dataset.act==='toggle-unprobed'){ev.preventDefault();folded=!folded;applyFold();refresh();b.textContent=folded?'显示未探测节点':'隐藏未探测节点';return;}
    if(b.dataset.probe==='1'){
      ev.preventDefault();
      var op=b.getAttribute('value')||'';
      if(op.indexOf('nodecheck:')===0){
        var site2=document.getElementById('checkSite').value.trim();
        if(!site2){show('请先填写节点连通测试的网站',1);return;}
        runProbe(b,op,{checkSite:site2});
      }else if(op==='requality'){
        // 按钮自带 key + json=1，结果回填对应行，不跳转
        runProbe(b,'requality',{key:b.dataset.key||'',json:'1'},true);
      }
    }
  });
})();
