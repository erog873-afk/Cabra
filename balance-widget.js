/* Баланс + окно пополнения. Подключение на любой странице:
   <script src="balance-widget.js"></script>   (рядом должен лежать topup-sheet.html)
   Число баланса: window.setBalance(123) */
(function(){
  if(window.__apexBalance) return; window.__apexBalance = true;
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || location.href;
  var STAR = "data:image/png;base64,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";
  var CSS = ".top-balance{\n  position:fixed;\n  top:calc(env(safe-area-inset-top, 0px) + var(--tg-content-safe-top, 0px) + 64px);\n  right:16px; z-index:50;\n  display:flex; align-items:center; gap:5px;\n  height:44px; padding:0 8px 0 12px; border-radius:22px;\n  border:1px solid var(--separator, rgba(0,0,0,.10));\n  background:rgba(255,255,255,.92); color:#111;\n  backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);\n  box-shadow:0 2px 16px rgba(0,0,0,.08);\n  font-family:Montserrat, sans-serif; cursor:pointer;\n  -webkit-tap-highlight-color:transparent; transition:opacity .15s;\n}\n.top-balance:active{ opacity:.8; }\n.top-balance img{ width:20px; height:20px; display:block; flex:0 0 20px; }\n.top-balance p{ margin:0; color:#111; font-size:15px; font-weight:600; white-space:nowrap; line-height:1; }\n.top-balance-chip{\n  height:28px; padding:0 10px; border-radius:14px; flex:0 0 auto;\n  background:#296eff; color:#fff;\n  font-size:12px; font-weight:600; white-space:nowrap; line-height:1;\n  display:flex; align-items:center;\n}\n\n.topup-overlay{\n  position:fixed; inset:0; z-index:100;\n  visibility:hidden; pointer-events:none;\n  background:rgba(0,0,0,0);\n  -webkit-backdrop-filter:blur(0px); backdrop-filter:blur(0px);\n  transition:background .4s ease, -webkit-backdrop-filter .4s ease, backdrop-filter .4s ease, visibility 0s linear .45s;\n}\n.topup-overlay.open{\n  visibility:visible; pointer-events:auto;\n  background:rgba(0,0,0,.4);\n  -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px);\n  transition-delay:0s;\n}\n.topup-frame{\n  position:absolute; inset:0; width:100%; height:100%;\n  border:0; background:transparent; color-scheme:light;\n  transform:translate3d(0,100%,0); will-change:transform;\n  transition:transform .35s cubic-bezier(.4,0,1,1);\n}\n.topup-overlay.open .topup-frame{\n  transform:translate3d(0,0,0);\n  transition:transform .5s cubic-bezier(.22,1,.36,1);\n}\n@media (prefers-reduced-motion:reduce){ .topup-overlay,.topup-frame{ transition:none !important; } }\n";

  var st = document.createElement('style'); st.id = 'topup-style'; st.textContent = CSS;
  document.head.appendChild(st);

  function init(){
    var btn = document.createElement('div');
    btn.className = 'top-balance'; btn.id = 'topBalance';
    btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0'); btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = '<img src="' + STAR + '" alt=""><p id="topBalanceCount">' + (window.APEX_BALANCE != null ? Number(window.APEX_BALANCE) : 17) + '</p><span class="top-balance-chip" id="topBalanceChip">Пополнить</span>';

    var overlay = document.createElement('div');
    overlay.className = 'topup-overlay'; overlay.id = 'topupOverlay';
    var frame = document.createElement('iframe');
    frame.className = 'topup-frame'; frame.id = 'topupFrame'; frame.title = 'Пополнение баланса';
    overlay.appendChild(frame);
    document.body.appendChild(btn); document.body.appendChild(overlay);

    var loaded = false;
    function load(){
      if(loaded) return; loaded = true;
      frame.addEventListener('load', function(){
        try{
          var d = frame.contentDocument;
          d.addEventListener('click', function(e){
            if(e.target.closest('.settings-sheet-handle') || e.target.classList.contains('settings-overlay')) close();
          });
          d.addEventListener('keydown', function(e){ if(e.key === 'Escape') close(); });
        }catch(err){}
      });
      frame.src = new URL('topup-sheet.html', SCRIPT_SRC).href;
    }
    function open(){ load(); overlay.classList.add('open'); }
    function close(){ overlay.classList.remove('open'); }

    btn.addEventListener('click', open);
    btn.addEventListener('keydown', function(e){ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(); } });
    overlay.addEventListener('click', function(e){ if(e.target === overlay) close(); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') close(); });

  /* ---- Язык: подхватываем переключатель из настроек ---- */
  var PAIRS = [
    ['Пополнить', 'Top up'],
    ['Пополнение баланса', 'Top up balance'],
    ['Звезды', 'Stars'],
    ['Подарки', 'Gifts'],
    ['Введите сумму', 'Enter amount'],
    ['Пополните баланс подарком', 'Top up with a gift'],
    ['За него автоматически придут звезды на баланс', 'Stars will be added to your balance automatically'],
    ['Отправить', 'Send'],
    ['Сумма звёзд', 'Stars amount'],
    ['Выбрано звёзд:', 'Stars selected:']
  ];
  function curLang(){ return localStorage.getItem('apex_lang') === 'en' ? 'en' : 'ru'; }
  function tr(s, lang){
    if(!s) return s;
    var t = s.trim(); if(!t) return s;
    var m;
    if(lang === 'en'){
      if((m = t.match(/^Вы получите ~ (.+?) звёзд$/)) || (m = t.match(/^Вы получите ~ (.+?) звезд$/))) return s.replace(t, 'You will get ~ ' + m[1] + ' stars');
      if((m = t.match(/^(.+?) звёзд$/))) return s.replace(t, m[1] + ' stars');
    } else {
      if((m = t.match(/^You will get ~ (.+?) stars$/))) return s.replace(t, 'Вы получите ~ ' + m[1] + ' звёзд');
      if((m = t.match(/^(.+?) stars$/))) return s.replace(t, m[1] + ' звёзд');
    }
    for(var k = 0; k < PAIRS.length; k++){
      var from = lang === 'en' ? PAIRS[k][0] : PAIRS[k][1];
      var to = lang === 'en' ? PAIRS[k][1] : PAIRS[k][0];
      if(t === from) return s.replace(t, to);
      if(t.indexOf(from) === 0 && lang === 'en' && from.slice(-1) === ':') return s.replace(from, to);
    }
    return s;
  }
  function translateDoc(d){
    if(!d || !d.body) return;
    var lang = curLang();
    var w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT, null), n, list = [];
    while((n = w.nextNode())){
      var p = n.parentNode && n.parentNode.nodeName;
      if(p === 'SCRIPT' || p === 'STYLE') continue;
      list.push(n);
    }
    list.forEach(function(node){
      var v = tr(node.nodeValue, lang);
      if(v !== node.nodeValue) node.nodeValue = v;
    });
    d.querySelectorAll('[aria-label]').forEach(function(el){
      var v = tr(el.getAttribute('aria-label'), lang);
      if(v !== el.getAttribute('aria-label')) el.setAttribute('aria-label', v);
    });
  }
  var observer = null;
  function watchDoc(d){
    try{
      if(observer) observer.disconnect();
      observer = new MutationObserver(function(){ translateDoc(d); });
      observer.observe(d.body, { childList:true, characterData:true, subtree:true });
      translateDoc(d);
    }catch(err){}
  }
  function applyLang(){
    var lang = curLang();
    var chip = document.getElementById('topBalanceChip');
    if(chip) chip.textContent = lang === 'en' ? 'Top up' : 'Пополнить';
    btn.setAttribute('aria-label', lang === 'en' ? 'Top up balance' : 'Пополнить баланс');
    frame.title = lang === 'en' ? 'Top up balance' : 'Пополнение баланса';
    try{ if(frame.contentDocument && frame.contentDocument.body) translateDoc(frame.contentDocument); }catch(err){}
  }
  frame.addEventListener('load', function(){
    try{ watchDoc(frame.contentDocument); }catch(err){}
    applyLang();
  });
  document.querySelectorAll('[data-lang]').forEach(function(b){
    b.addEventListener('click', function(){ setTimeout(applyLang, 0); });
  });
  applyLang();


    window.addEventListener('storage', function(e){ if(e.key === 'apex_lang') applyLang(); });
    if('requestIdleCallback' in window) requestIdleCallback(load); else setTimeout(load, 800);
    window.setBalance = function(n){ document.getElementById('topBalanceCount').textContent = Number(n) || 0; };
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
