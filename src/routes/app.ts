import { Hono } from 'hono';

import type { AppEnv } from '../env';

/**
 * Miirra Pay — the wallet front end.
 *
 * A single self-contained page (no build step, no framework) served by the
 * payments worker itself. It talks ONLY to this worker's own JSON API, so it
 * can never bypass a server-side control: every limit, tier cap, face gate and
 * AML screen still runs on the server. The UI is a view, not a rule-maker.
 *
 * Auth: the page stores a Better Auth bearer token in localStorage and sends it
 * as `Authorization: Bearer …`. In dev (AUTH_DEV_MODE=1) it falls back to an
 * `x-dev-user` identity so the page is usable with no identity server.
 *
 * Everything money is LYD. Amounts are entered in major units (e.g. 12.50) and
 * converted to minor units (1250) at the edge, because the API speaks minor
 * units — the conversion lives in one place (`toMinor`) and is never inlined.
 */
export const appRoute = new Hono<AppEnv>();

appRoute.get('/app', (c) => c.html(PAGE));

// Root → the wallet (health lives at /health).
appRoute.get('/', (c) => c.redirect('/app'));

const PAGE = String.raw`<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0f14" />
<title>Miirra Pay — LYD Wallet</title>
<style>
  :root{
    --bg:#0b0f14; --bg2:#111721; --card:#151c27; --card2:#1b2431;
    --line:#243041; --ink:#eaf0f7; --muted:#8a97a8; --faint:#5b6675;
    --brand:#3b82f6; --brand2:#22d3ee; --good:#22c55e; --bad:#ef4444;
    --warn:#f59e0b; --radius:18px; --shadow:0 12px 40px rgba(0,0,0,.45);
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0}
  body{
    background:radial-gradient(1200px 600px at 50% -10%,#16233a 0%,var(--bg) 55%) fixed;
    color:var(--ink);font-family:var(--font);min-height:100vh;
    padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:460px;margin:0 auto;padding:18px 16px 120px}
  header.top{display:flex;align-items:center;justify-content:space-between;margin:6px 2px 18px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
  .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--brand),var(--brand2));
    display:grid;place-items:center;color:#031018;font-weight:900;box-shadow:0 6px 18px rgba(59,130,246,.35)}
  .brand small{display:block;font-weight:500;color:var(--muted);font-size:11px;letter-spacing:.4px}
  .langbtn,.iconbtn{background:var(--card);border:1px solid var(--line);color:var(--ink);
    border-radius:12px;padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer}
  .iconbtn{padding:8px;width:38px;height:38px;display:grid;place-items:center}

  /* Balance card */
  .balance{
    position:relative;border-radius:24px;padding:22px;color:#fff;overflow:hidden;
    background:linear-gradient(135deg,#1d4ed8 0%,#0ea5e9 60%,#22d3ee 100%);
    box-shadow:var(--shadow);
  }
  .balance::after{content:"";position:absolute;width:220px;height:220px;border-radius:50%;
    background:rgba(255,255,255,.12);top:-90px;right:-60px}
  .balance .lbl{font-size:13px;opacity:.85;letter-spacing:.3px}
  .balance .amt{font-size:40px;font-weight:800;margin-top:6px;letter-spacing:-1px;line-height:1}
  .balance .amt .cur{font-size:18px;font-weight:600;opacity:.8;margin-inline-start:6px}
  .balance .sub{display:flex;gap:16px;margin-top:14px;font-size:13px;opacity:.9}
  .balance .sub b{font-weight:700}
  .balance .pending{color:#fde68a}

  /* Quick actions */
  .actions{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0 8px}
  .action{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 6px;
    display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;transition:.15s;font-size:12px;color:var(--ink);font-weight:600}
  .action:active{transform:scale(.96);background:var(--card2)}
  .action .ic{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;
    background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid var(--line)}
  .action .ic svg{width:20px;height:20px;stroke:var(--brand2);fill:none;stroke-width:2}

  /* Section */
  .section{margin-top:22px}
  .section h2{font-size:15px;margin:0 2px 12px;display:flex;align-items:center;justify-content:space-between}
  .section h2 a{font-size:12px;color:var(--muted);font-weight:500;text-decoration:none}

  /* Rails */
  .rails{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}
  .rails::-webkit-scrollbar{display:none}
  .rail{flex:0 0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:11px 14px;min-width:120px}
  .rail .rn{font-weight:700;font-size:13px}
  .rail .rs{font-size:11px;margin-top:3px;font-weight:600}
  .rail.live .rs{color:var(--good)}
  .rail.soon .rs{color:var(--warn)}
  .rail.soon{opacity:.75}

  /* Activity */
  .list{display:flex;flex-direction:column;gap:8px}
  .tx{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);
    border-radius:16px;padding:12px 14px}
  .tx .dot{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:0 0 auto;font-size:18px}
  .tx.in .dot{background:rgba(34,197,94,.14);color:var(--good)}
  .tx.out .dot{background:rgba(239,68,68,.14);color:var(--bad)}
  .tx .mid{flex:1;min-width:0}
  .tx .mid .t1{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tx .mid .t2{font-size:12px;color:var(--muted);margin-top:2px}
  .tx .amt{font-weight:800;font-size:15px;white-space:nowrap}
  .tx.in .amt{color:var(--good)}
  .tx.out .amt{color:var(--ink)}
  .pill{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;margin-inline-start:6px}
  .pill.pending{background:rgba(245,158,11,.16);color:var(--warn)}
  .pill.completed{background:rgba(34,197,94,.14);color:var(--good)}
  .pill.failed,.pill.declined{background:rgba(239,68,68,.14);color:var(--bad)}
  .empty{text-align:center;color:var(--faint);padding:30px;font-size:13px}

  /* Bottom nav */
  nav.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;
    display:flex;max-width:460px;margin:0 auto;justify-content:space-around;
    background:rgba(17,23,33,.86);backdrop-filter:blur(14px);border-top:1px solid var(--line);
    padding:8px 6px calc(8px + env(safe-area-inset-bottom))}
  nav.tabbar button{background:none;border:0;color:var(--muted);font-size:11px;font-weight:600;
    display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer}
  nav.tabbar button.on{color:var(--brand2)}
  nav.tabbar svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2}

  /* Sheet / modal */
  .scrim{position:fixed;inset:0;background:rgba(2,6,12,.6);backdrop-filter:blur(3px);z-index:40;
    display:none;align-items:flex-end;justify-content:center}
  .scrim.open{display:flex}
  .sheet{width:100%;max-width:460px;background:var(--bg2);border-radius:24px 24px 0 0;
    border:1px solid var(--line);padding:18px 18px calc(22px + env(safe-area-inset-bottom));
    box-shadow:0 -10px 40px rgba(0,0,0,.5);animation:up .22s ease}
  @keyframes up{from{transform:translateY(30px);opacity:.4}to{transform:none;opacity:1}}
  .sheet .grab{width:42px;height:4px;border-radius:4px;background:var(--line);margin:0 auto 16px}
  .sheet h3{margin:0 0 4px;font-size:18px}
  .sheet p.s{color:var(--muted);font-size:13px;margin:0 0 16px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:600}
  .field input,.field select{width:100%;background:var(--card);border:1px solid var(--line);color:var(--ink);
    border-radius:14px;padding:14px;font-size:16px;font-family:var(--font)}
  .field input:focus,.field select:focus{outline:2px solid var(--brand);border-color:transparent}
  .amtwrap{position:relative}
  .amtwrap .suffix{position:absolute;inset-inline-end:14px;top:50%;transform:translateY(-50%);
    color:var(--muted);font-weight:700;font-size:14px}
  .btn{width:100%;border:0;border-radius:14px;padding:15px;font-size:15px;font-weight:800;cursor:pointer;
    background:linear-gradient(135deg,var(--brand),var(--brand2));color:#031018;margin-top:4px}
  .btn:active{transform:scale(.99)}
  .btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
  .msg{font-size:13px;margin-top:12px;padding:11px 13px;border-radius:12px;display:none}
  .msg.show{display:block}
  .msg.ok{background:rgba(34,197,94,.12);color:#86efac}
  .msg.err{background:rgba(239,68,68,.12);color:#fca5a5}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(3,16,24,.35);
    border-top-color:#031018;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-inline-end:8px}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* Login gate */
  .gate{position:fixed;inset:0;z-index:60;background:var(--bg);display:none;
    align-items:center;justify-content:center;padding:24px}
  .gate.open{display:flex}
  .gate .box{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
    border-radius:22px;padding:24px;box-shadow:var(--shadow)}
  .gate h2{margin:0 0 6px}
  .gate p{color:var(--muted);font-size:13px;margin:0 0 18px}

  [dir=rtl] .balance::after{right:auto;left:-60px}
  [dir=rtl] .amtwrap .suffix{inset-inline-end:14px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo">M</div>
      <div>Miirra Pay<small>LYD WALLET</small></div>
    </div>
    <button class="langbtn" id="langBtn">العربية</button>
  </header>

  <section class="balance" id="balanceCard">
    <div class="lbl" data-i18n="available">Available balance</div>
    <div class="amt"><span id="balInt">0</span><span class="cur">LYD</span></div>
    <div class="sub">
      <span><b id="balPending">0.000</b> <span data-i18n="pending">pending</span></span>
      <span id="balSource" style="opacity:.7"></span>
    </div>
  </section>

  <div class="actions">
    <div class="action" data-act="send">
      <div class="ic"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg></div>
      <span data-i18n="send">Send</span>
    </div>
    <div class="action" data-act="topup">
      <div class="ic"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div>
      <span data-i18n="topup">Top up</span>
    </div>
    <div class="action" data-act="withdraw">
      <div class="ic"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7 7 7-7"/></svg></div>
      <span data-i18n="withdraw">Withdraw</span>
    </div>
    <div class="action" data-act="scan">
      <div class="ic"><svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg></div>
      <span data-i18n="scan">Scan</span>
    </div>
  </div>

  <div class="section">
    <h2 data-i18n="rails">Top-up rails</h2>
    <div class="rails" id="rails"></div>
  </div>

  <div class="section">
    <h2><span data-i18n="activity">Activity</span><a href="#" id="refreshBtn" data-i18n="refresh">Refresh</a></h2>
    <div class="list" id="activity"><div class="empty" data-i18n="loading">Loading…</div></div>
  </div>
</div>

<nav class="tabbar">
  <button class="on" data-tab="home"><svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg><span data-i18n="home">Home</span></button>
  <button data-tab="activity"><svg viewBox="0 0 24 24"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg><span data-i18n="activity">Activity</span></button>
  <button data-tab="send"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg><span data-i18n="send">Send</span></button>
  <button data-tab="account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg><span data-i18n="account">Account</span></button>
</nav>

<!-- Action sheet -->
<div class="scrim" id="scrim">
  <div class="sheet">
    <div class="grab"></div>
    <h3 id="sheetTitle">Send money</h3>
    <p class="s" id="sheetSub"></p>
    <div id="sheetBody"></div>
    <div class="msg" id="sheetMsg"></div>
  </div>
</div>

<!-- Login gate -->
<div class="gate" id="gate">
  <div class="box">
    <h2>Miirra Pay</h2>
    <p data-i18n="gateSub">Sign in with your Miirra session token to open your LYD wallet.</p>
    <div class="field">
      <label data-i18n="token">Session token</label>
      <input id="tokenInput" placeholder="Paste bearer token" autocomplete="off" />
    </div>
    <div class="field" id="devUserField" style="display:none">
      <label data-i18n="devuser">Dev user id</label>
      <input id="devUserInput" placeholder="e2e-user" autocomplete="off" />
    </div>
    <button class="btn" id="gateBtn" data-i18n="openWallet">Open wallet</button>
    <div class="msg" id="gateMsg"></div>
  </div>
</div>

<script>
(function(){
  "use strict";
  // ── i18n ──────────────────────────────────────────────────────────────────
  var I18N = {
    en:{available:"Available balance",pending:"pending",send:"Send",topup:"Top up",withdraw:"Withdraw",scan:"Scan",
      rails:"Top-up rails",activity:"Activity",refresh:"Refresh",loading:"Loading…",home:"Home",account:"Account",
      gateSub:"Sign in with your Miirra session token to open your LYD wallet.",token:"Session token",
      devuser:"Dev user id",openWallet:"Open wallet",you:"You",received:"Received",sent:"Sent",
      noActivity:"No activity yet — your money moves will show here.",live:"Live",soon:"Soon",
      sendTitle:"Send money",sendSub:"Transfer LYD to another Miirra user.",
      recipient:"Recipient user id",amount:"Amount",note:"Note (optional)",submitSend:"Send",
      topupTitle:"Top up",topupSub:"Add LYD from a bank transfer or another Miirra user.",
      topupRail:"Rail",submitTopup:"Create top-up",withdrawTitle:"Withdraw",
      withdrawSub:"Move LYD to your bank account via LYPay.",iban:"IBAN",submitWithdraw:"Withdraw",
      scanTitle:"Scan to pay",scanSub:"Point at a Miirra QR or paste an IBAN / alias.",
      scanPlaceholder:"NUMO|… or IBAN",submitScan:"Continue",
      sending:"Sending…",working:"Working…",errGeneric:"Something went wrong.",
      okSend:"Sent",okTopup:"Top-up created — quote the reference on your transfer.",
      copied:"Reference copied",copy:"Copy"},
    ar:{available:"الرصيد المتاح",pending:"قيد الانتظار",send:"إرسال",topup:"شحن",withdraw:"سحب",scan:"مسح",
      rails:"قنوات الشحن",activity:"النشاط",refresh:"تحديث",loading:"جارٍ التحميل…",home:"الرئيسية",account:"الحساب",
      gateSub:"سجّل الدخول برمز جلسة Miirra لفتح محفظتك بالدينار الليبي.",token:"رمز الجلسة",
      devuser:"معرّف المستخدم (تطوير)",openWallet:"فتح المحفظة",you:"أنت",received:"مستلم",sent:"مرسل",
      noActivity:"لا يوجد نشاط بعد — ستظهر حركة أموالك هنا.",live:"مباشر",soon:"قريباً",
      sendTitle:"إرسال أموال",sendSub:"تحويل دينار ليبي إلى مستخدم Miirra آخر.",
      recipient:"معرّف المستلم",amount:"المبلغ",note:"ملاحظة (اختياري)",submitSend:"إرسال",
      topupTitle:"شحن الرصيد",topupSub:"أضف ديناراً ليبراً من تحويل بنكي أو من مستخدم.",
      topupRail:"القناة",submitTopup:"إنشاء شحن",withdrawTitle:"سحب الأموال",
      withdrawSub:"اسحب الدينار الليبي إلى حسابك المصرفي عبر LYPay.",iban:"الآيبان",submitWithdraw:"سحب",
      scanTitle:"مسح للدفع",scanSub:"وجّه الكاميرا إلى رمز Miirra أو الصق آيبان / لقب.",
      scanPlaceholder:"NUMO|… أو آيبان",submitScan:"متابعة",
      sending:"جارٍ الإرسال…",working:"جارٍ العمل…",errGeneric:"حدث خطأ ما.",
      okSend:"تم الإرسال",okTopup:"تم إنشاء الشحن — اذكر المرجع عند التحويل.",
      copied:"تم نسخ المرجع",copy:"نسخ"}
  };
  var lang = localStorage.getItem('mp_lang') || 'en';
  function t(k){ return (I18N[lang]||I18N.en)[k] || (I18N.en)[k] || k; }
  function applyLang(){
    document.documentElement.lang = lang;
    document.documentElement.dir = lang==='ar' ? 'rtl' : 'ltr';
    document.getElementById('langBtn').textContent = lang==='ar' ? 'English' : 'العربية';
    document.querySelectorAll('[data-i18n]').forEach(function(el){
      var k=el.getAttribute('data-i18n'); if(I18N[lang] && I18N[lang][k]) el.textContent=I18N[lang][k];
    });
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  var TOKEN = localStorage.getItem('mp_token') || '';
  var DEVUSER = localStorage.getItem('mp_devuser') || '';
  function authHeaders(){
    var h = {'content-type':'application/json'};
    if(TOKEN) h['authorization'] = 'Bearer '+TOKEN;
    else if(DEVUSER) h['x-dev-user'] = DEVUSER;
    return h;
  }
  function authed(){ return !!(TOKEN || DEVUSER); }

  // ── money: the ONLY place major<->minor conversion happens ────────────────
  var MINOR = 100;
  function toMinor(majorStr){
    var s = String(majorStr).trim();
    if(!/^\d+(\.\d{0,3})?$/.test(s)) throw new Error('bad amount');
    var parts = s.split('.');
    var whole = parts[0]||'0';
    var frac = ((parts[1]||'')+'000').slice(0,3);
    return BigInt(whole)*1000n + BigInt(frac); // 3-dp minor (LYP rail precision)
  }
  function fmtMinor(minor){
    var n = BigInt(minor);
    var neg = n<0n; if(neg) n=-n;
    var whole = n/1000n, frac = (n%1000n).toString().padStart(3,'0');
    var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
    return (neg?'-':'')+w+'.'+frac;
  }

  // ── api ───────────────────────────────────────────────────────────────────
  function api(method,path,body){
    return fetch(path,{method:method,headers:authHeaders(),body:body?JSON.stringify(body):undefined})
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(j){
        if(!r.ok){ var e=new Error((j.error&&j.error.message)||t('errGeneric')); e.code=j.error&&j.error.code; e.status=r.status; throw e; }
        return j; }); });
  }

  // ── render ────────────────────────────────────────────────────────────────
  function renderBalance(b){
    document.getElementById('balInt').textContent = fmtMinor(b.availableMinor);
    document.getElementById('balPending').textContent = fmtMinor(b.pendingMinor||0);
    var src = document.getElementById('balSource');
    src.textContent = b.source==='tigerbeetle' ? '' : '≈';
    if(b.mismatch) src.textContent = '⚠';
  }
  function kindLabel(tx){
    if(tx.kind==='wallet_transfer') return tx.direction==='in'?t('received'):t('sent');
    if(tx.kind==='refund') return 'Refund';
    if(tx.kind==='merchant_payment') return 'Payment';
    return 'Payment';
  }
  function renderActivity(list){
    var box = document.getElementById('activity');
    if(!list.length){ box.innerHTML='<div class="empty">'+t('noActivity')+'</div>'; return; }
    box.innerHTML = list.map(function(tx){
      var who = tx.counterparty ? (tx.counterparty.name||tx.counterparty.userId) : (tx.kind==='topup'?'Bank / top-up':'Miirra');
      var amt = (tx.direction==='in'?'+':'−')+fmtMinor(tx.amountMinor);
      var cls = tx.status==='completed'?'completed':tx.status;
      return '<div class="tx '+tx.direction+'">'+
        '<div class="dot">'+(tx.direction==='in'?'↓':'↑')+'</div>'+
        '<div class="mid"><div class="t1">'+esc(who)+'</div>'+
        '<div class="t2">'+esc(kindLabel(tx))+' · '+timeAgo(tx.createdAt)+
        '<span class="pill '+cls+'">'+esc(tx.status)+'</span></div></div>'+
        '<div class="amt">'+amt+'</div></div>';
    }).join('');
  }
  function renderRails(rails){
    var box = document.getElementById('rails');
    box.innerHTML = rails.map(function(r){
      return '<div class="rail '+(r.status==='integrated'?'live':'soon')+'">'+
        '<div class="rn">'+esc(r.label)+'</div>'+
        '<div class="rs">'+(r.status==='integrated'?t('live'):t('soon'))+'</div></div>';
    }).join('');
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function timeAgo(ms){
    var d=Date.now()-Number(ms); if(d<0)d=0;
    var m=Math.floor(d/60000); if(m<1)return 'now';
    if(m<60)return m+'m'; var h=Math.floor(m/60); if(h<24)return h+'h';
    return Math.floor(h/24)+'d';
  }

  function loadAll(){
    if(!authed()){ openGate(); return; }
    api('GET','/api/wallets/balance').then(renderBalance).catch(showGateIfAuth);
    api('GET','/api/wallets/activity?limit=50').then(function(j){renderActivity(j.activity||[]);}).catch(function(){});
    api('GET','/api/topups/rails').then(function(j){renderRails(j.rails||[]);}).catch(function(){});
  }
  function showGateIfAuth(e){ if(e.status===401||e.status===403) openGate(); }

  // ── sheets ────────────────────────────────────────────────────────────────
  var scrim=document.getElementById('scrim');
  function openSheet(title,sub,bodyHtml){
    document.getElementById('sheetTitle').textContent=title;
    document.getElementById('sheetSub').textContent=sub;
    document.getElementById('sheetBody').innerHTML=bodyHtml;
    var m=document.getElementById('sheetMsg'); m.className='msg'; m.textContent='';
    scrim.classList.add('open');
  }
  function closeSheet(){ scrim.classList.remove('open'); }
  scrim.addEventListener('click',function(e){ if(e.target===scrim) closeSheet(); });
  function sheetMsg(kind,text){ var m=document.getElementById('sheetMsg');
    m.className='msg show '+(kind==='ok'?'ok':'err'); m.textContent=text; }
  function busy(btn,on,label){
    if(on){ btn.dataset._h=btn.innerHTML; btn.innerHTML='<span class="spinner"></span>'+(label||t('working')); btn.disabled=true; }
    else{ btn.innerHTML=btn.dataset._h||label; btn.disabled=false; }
  }

  function sendSheet(prefill){
    openSheet(t('sendTitle'),t('sendSub'),
      '<div class="field"><label>'+t('recipient')+'</label><input id="fRecipient" placeholder="user id / IBAN" value="'+esc(prefill||'')+'"></div>'+
      '<div class="field"><label>'+t('amount')+'</label><div class="amtwrap"><input id="fAmount" type="text" inputmode="decimal" placeholder="0.000"><span class="suffix">LYD</span></div></div>'+
      '<div class="field"><label>'+t('note')+'</label><input id="fNote" placeholder=""></div>'+
      '<button class="btn" id="sendGo">'+t('submitSend')+'</button>');
    document.getElementById('sendGo').onclick=function(){
      var btn=this, r=document.getElementById('fRecipient').value.trim();
      var amt; try{ amt=toMinor(document.getElementById('fAmount').value); }catch(e){ return sheetMsg('err','Enter a valid amount'); }
      if(!r) return sheetMsg('err','Recipient required');
      if(amt<=0n) return sheetMsg('err','Amount must be positive');
      busy(btn,true,t('sending'));
      api('POST','/api/wallets/transfer',{
        idempotencyKey:'ui-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
        receiver:{ raw:r }, amountMinor:Number(amt), note:document.getElementById('fNote').value||undefined
      }).then(function(j){ sheetMsg('ok',t('okSend')+' · '+fmtMinor(j.amountMinor)+' LYD');
        loadAll(); setTimeout(closeSheet,1100); })
      .catch(function(e){ sheetMsg('err',e.message); })
      .finally(function(){ busy(btn,false,t('submitSend')); });
    };
  }
  function topupSheet(){
    var rails='<div class="field"><label>'+t('topupRail')+'</label><select id="fRail">'+
      '<option value="bank_transfer">Bank transfer (IBAN)</option>'+
      '<option value="peer_mesh_receive">Miirra user (Mesh)</option></select></div>';
    openSheet(t('topupTitle'),t('topupSub'),
      rails+
      '<div class="field"><label>'+t('amount')+'</label><div class="amtwrap"><input id="fAmount" type="text" inputmode="decimal" placeholder="0.000"><span class="suffix">LYD</span></div></div>'+
      '<button class="btn" id="topupGo">'+t('submitTopup')+'</button>');
    document.getElementById('topupGo').onclick=function(){
      var btn=this, amt; try{ amt=toMinor(document.getElementById('fAmount').value); }catch(e){ return sheetMsg('err','Enter a valid amount'); }
      if(amt<=0n) return sheetMsg('err','Amount must be positive');
      busy(btn,true);
      api('POST','/api/topups/initiate',{
        idempotencyKey:'ui-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
        amountMinor:Number(amt), rail:document.getElementById('fRail').value
      }).then(function(j){
        var ref=j.depositReference||j.id;
        sheetMsg('ok',t('okTopup')+' — '+ref);
        loadAll();
      }).catch(function(e){ sheetMsg('err',e.message); })
      .finally(function(){ busy(btn,false,t('submitTopup')); });
    };
  }
  function withdrawSheet(){
    openSheet(t('withdrawTitle'),t('withdrawSub'),
      '<div class="field"><label>'+t('iban')+'</label><input id="fIban" placeholder="LY…"></div>'+
      '<div class="field"><label>'+t('amount')+'</label><div class="amtwrap"><input id="fAmount" type="text" inputmode="decimal" placeholder="0.000"><span class="suffix">LYD</span></div></div>'+
      '<button class="btn" id="wdGo">'+t('submitWithdraw')+'</button>');
    document.getElementById('wdGo').onclick=function(){
      var btn=this, amt; try{ amt=toMinor(document.getElementById('fAmount').value); }catch(e){ return sheetMsg('err','Enter a valid amount'); }
      var iban=document.getElementById('fIban').value.trim();
      if(!iban) return sheetMsg('err','IBAN required');
      if(amt<=0n) return sheetMsg('err','Amount must be positive');
      busy(btn,true);
      api('POST','/api/withdrawals/initiate',{
        idempotencyKey:'ui-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
        amountMinor:Number(amt),
        debtorAccount:{ schemeName:'iban', identification:iban, name:iban },
        creditorInstitution:{ name:'Bank', code:'000' },
        description:'Wallet withdrawal'
      }).then(function(j){ sheetMsg('ok',(j.id||'Withdrawal')+' initiated'); loadAll(); })
      .catch(function(e){ sheetMsg('err',e.message); })
      .finally(function(){ busy(btn,false,t('submitWithdraw')); });
    };
  }
  function scanSheet(){
    openSheet(t('scanTitle'),t('scanSub'),
      '<div class="field"><label>'+t('scanPlaceholder')+'</label><input id="fScan" placeholder="'+t('scanPlaceholder')+'"></div>'+
      '<button class="btn" id="scanGo">'+t('submitScan')+'</button>');
    document.getElementById('scanGo').onclick=function(){
      var v=document.getElementById('fScan').value.trim(); if(!v) return;
      closeSheet(); sendSheet(v);
    };
  }

  // ── gate ──────────────────────────────────────────────────────────────────
  function openGate(){
    document.getElementById('gate').classList.add('open');
    // show dev field when the worker is in dev mode (no token needed)
    document.getElementById('devUserField').style.display = TOKEN?'none':'block';
  }
  function closeGate(){ document.getElementById('gate').classList.remove('open'); }
  document.getElementById('gateBtn').onclick=function(){
    var tok=document.getElementById('tokenInput').value.trim();
    var du=document.getElementById('devUserInput').value.trim();
    TOKEN=tok; DEVUSER=du;
    if(tok)localStorage.setItem('mp_token',tok);
    if(du)localStorage.setItem('mp_devuser',du);
    var m=document.getElementById('gateMsg');
    if(!TOKEN&&!DEVUSER){ m.className='msg show err'; m.textContent='Enter a token or dev user id'; return; }
    api('GET','/v1/me').then(function(){ closeGate(); loadAll(); })
      .catch(function(e){ m.className='msg show err'; m.textContent=e.message; });
  };

  // ── wire ──────────────────────────────────────────────────────────────────
  document.getElementById('langBtn').onclick=function(){ lang=lang==='ar'?'en':'ar'; localStorage.setItem('mp_lang',lang); applyLang(); renderRails(window._rails||[]); loadAll(); };
  document.getElementById('refreshBtn').onclick=function(e){ e.preventDefault(); loadAll(); };
  document.querySelectorAll('.action').forEach(function(el){
    el.onclick=function(){ var a=el.getAttribute('data-act');
      if(a==='send')sendSheet(''); else if(a==='topup')topupSheet();
      else if(a==='withdraw')withdrawSheet(); else if(a==='scan')scanSheet(); }; });
  document.querySelectorAll('nav.tabbar button').forEach(function(b){
    b.onclick=function(){ var tab=b.getAttribute('data-tab');
      if(tab==='send')return sendSheet('');
      if(tab==='home'){window.scrollTo({top:0,behavior:'smooth'});return;}
      if(tab==='activity'){document.getElementById('activity').scrollIntoView({behavior:'smooth'});return;}
      if(tab==='account'){ openSheet('Account', 'Miirra Pay LYD', '<div class="field"><label>Token</label><input value="'+esc((TOKEN||DEVUSER).slice(0,6))+'…" disabled></div><button class="btn ghost" id="logoutBtn">Sign out</button>');
        document.getElementById('logoutBtn').onclick=function(){ localStorage.removeItem('mp_token'); localStorage.removeItem('mp_devuser'); location.reload(); }; return; } };
  });

  // capture rails for re-render on lang switch
  var _origRenderRails = renderRails;
  renderRails = function(r){ window._rails=r; _origRenderRails(r); };

  applyLang();
  if(authed()) loadAll(); else openGate();
})();
</script>
</body>
</html>`;