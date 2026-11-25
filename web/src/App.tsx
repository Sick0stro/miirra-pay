import React, { useEffect, useState } from 'react';
import { AppProvider, useApp } from './store';
import { api } from './lib';
import { TopBar, BottomBar, BiometricModal, Toast } from './ui';
import {
  CardHome, TopUp, ScanIban, ManageCard, Withdraw, KeypadHome, ScanQr,
  Recipient, Review, Confirm, ActivityFeed, Receipt, Checkout,
} from './screens';

function Gate() {
  const { lang, setLang, signIn } = useApp();
  const [token, setToken] = useState('');
  const [dev, setDev] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!token && !dev) return setErr('Enter a token or dev user id');
    setBusy(true); setErr('');
    try { await signIn(token.trim(), dev.trim()); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <div className="w-full max-w-[380px] rounded-[28px] glass-dark p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/30 bg-white/15 text-xl font-black">M</div>
            <div className="font-extrabold">Miirra Pay</div>
          </div>
          <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} className="rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-semibold">{lang === 'ar' ? 'English' : 'العربية'}</button>
        </div>
        <p className="mb-4 text-[13px] text-white/70">{lang === 'ar' ? 'سجّل الدخول لفتح محفظتك بالدينار الليبي.' : 'Sign in to open your LYD wallet.'}</p>
        <div className="mb-3">
          <label className="mb-1 block text-[12px] font-semibold text-white/75">{lang === 'ar' ? 'رمز الجلسة' : 'Session token'}</label>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="bearer token"
            className="w-full rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 text-[15px] outline-none placeholder:text-white/40" />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-[12px] font-semibold text-white/75">{lang === 'ar' ? 'معرّف مستخدم التطوير' : 'Dev user id'}</label>
          <input value={dev} onChange={(e) => setDev(e.target.value)} placeholder="test-alice"
            className="w-full rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 text-[15px] outline-none placeholder:text-white/40" />
        </div>
        <button onClick={submit} disabled={busy} className="pill-white w-full rounded-full py-3.5 text-[15px] font-bold disabled:opacity-60">{busy ? '…' : (lang === 'ar' ? 'فتح المحفظة' : 'Open wallet')}</button>
        {err && <div className="mt-3 rounded-xl bg-red-500/20 px-3 py-2 text-[13px] text-red-100">{err}</div>}
        <div className="mt-3 text-center text-[11px] text-white/50">test-alice · test-bob · test-carol · test-dina</div>
      </div>
    </div>
  );
}

function Shell() {
  const { lang, setLang, tab, setTab, route, go } = useApp();
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const screen = (() => {
    if (route === 'home') {
      if (tab === 'card') return <CardHome />;
      if (tab === 'activity') return <ActivityFeed />;
      return <KeypadHome />;
    }
    switch (route) {
      case 'topup': return <TopUp />;
      case 'scanIban': return <ScanIban />;
      case 'manageCard': return <ManageCard />;
      case 'withdraw': return <Withdraw />;
      case 'scanQr': return <ScanQr />;
      case 'recipient': return <Recipient />;
      case 'review': return <Review />;
      case 'biometric': return <Review />;
      case 'confirm': return <Confirm />;
      case 'receipt': return <Receipt />;
      case 'checkout': return <Checkout />;
      default: return <CardHome />;
    }
  })();

  const showBar = route === 'home';
  return (
    <div className="mx-auto min-h-full max-w-[460px] px-4">
      <TopBar lang={lang} onToggleLang={() => setLang(lang === 'ar' ? 'en' : 'ar')} />
      <div key={route + tab} className="fade-in">{screen}</div>
      {showBar && <BottomBar tab={tab} setTab={(t) => { setTab(t); go('home'); }} lang={lang} onPay={() => { setTab('pay'); go('home'); }} />}
    </div>
  );
}

function Inner() {
  const { authed, flow, confirmBiometric, cancelFlow, lang, toast } = useApp();
  if (!authed) return <Gate />;
  return (
    <>
      <Shell />
      <BiometricModal open={route_isBiometric(flow.step)} amountMinor={flow.amountMinor}
        recipientName={(flow.recipient as any)?.name || ''} onConfirm={confirmBiometric} onCancel={cancelFlow} lang={lang} />
      <Toast msg={toast} />
    </>
  );
}

// The biometric modal shows whenever the flow reaches the biometric step,
// regardless of the underlying route, so the gate is impossible to skip.
function route_isBiometric(step: string): boolean { return step === 'biometric'; }

export default function App() {
  return (
    <AppProvider>
      <Inner />
    </AppProvider>
  );
}