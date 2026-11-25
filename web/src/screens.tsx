import React, { useMemo, useState } from 'react';
import { useApp, CONTACTS } from './store';
import { api, fmt, fmtMinor, makeT, newIdem, toMinor, FACE_VERIFY_LYD, type Activity } from './lib';
import { Icon, Money, SlideToPay, Spinner } from './ui';
import { MiirraCard, type Tier } from './MiirraCard';

const DEPOSIT_IBAN = 'LY00 0000 0000 0000 0000 0000'; // platform receiving IBAN (demo)

// ── 1. Card home ─────────────────────────────────────────────────────────────
export function CardHome() {
  const { lang, balance, cardTier, setCardTier, frozen, setFrozen, go, setTab, showToast } = useApp();
  const t = makeT(lang);
  const [showMax, setShowMax] = useState(false);
  const avail = balance?.availableMinor ?? 0;
  return (
    <div className="px-1 pb-28">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="text-[13px] text-white/70">{t('available')}</div>
          <Money minor={avail} className="text-[40px] font-extrabold leading-none tracking-tight text-shadow-soft" />
          {!!balance?.pendingMinor && <div className="mt-1 text-[12px] text-white/70">{t('pending')}: <Money minor={balance.pendingMinor} /></div>}
        </div>
        <button onClick={() => go('manageCard')} className="rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-semibold backdrop-blur">
          {t('manage')}
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <button onClick={() => go('topup')} className="pill-white flex items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold active:scale-[.99]">
          <Icon name="plus" className="h-5 w-5" /> {t('addCash')}
        </button>
        <button onClick={() => go('withdraw')} className="flex items-center justify-center gap-2 rounded-full border border-white/40 bg-white/10 py-3.5 text-[15px] font-semibold backdrop-blur active:scale-[.99]">
          <Icon name="up" className="h-5 w-5" /> {t('cashOut')}
        </button>
      </div>

      <MiirraCard tier={cardTier} holder="SAMI ABDALLA" frozen={frozen} lang={lang} />

      <div className="mt-3 flex items-center justify-center gap-2">
        <button onClick={() => setFrozen(!frozen)} className="flex items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-semibold backdrop-blur">
          <Icon name="lock" className="h-4 w-4" /> {frozen ? t('unfreeze') : t('freeze')}
        </button>
        <button onClick={() => go('manageCard')} className="flex items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-semibold backdrop-blur">
          <Icon name="qr" className="h-4 w-4" /> {t('manage')}
        </button>
      </div>

      {/* Tier selector */}
      <div className="mt-6">
        <div className="mb-2 px-1 text-[13px] font-semibold text-white/80">{lang === 'ar' ? 'اختر خطتك' : 'Your plan'}</div>
        <div className="grid grid-cols-2 gap-3">
          <TierCard tier="standard" active={cardTier === 'standard'} onClick={() => setCardTier('standard')} lang={lang} />
          <TierCard tier="plus" active={cardTier === 'plus'} onClick={() => setCardTier('plus')} lang={lang} />
        </div>
        <button onClick={() => setShowMax((s) => !s)} className="mt-2 flex w-full items-center justify-between rounded-2xl border border-white/25 bg-white/10 px-4 py-3 text-[13px] font-semibold backdrop-blur">
          <span>{t('needMore')}</span><Icon name="chevron" className={`h-4 w-4 transition ${showMax ? 'rotate-90' : ''}`} />
        </button>
        {showMax && <div className="mt-2"><TierCard tier="max" active={cardTier === 'max'} onClick={() => setCardTier('max')} lang={lang} /></div>}
      </div>
    </div>
  );
}

function TierCard({ tier, active, onClick, lang }: { tier: Tier; active: boolean; onClick: () => void; lang: 'en' | 'ar' }) {
  const t = makeT(lang);
  const name = tier === 'standard' ? t('standard') : tier === 'plus' ? t('plus') : t('max');
  const price = tier === 'standard' ? t('free') : tier === 'plus' ? '15.00 ' + t('perMonth') : '40.00 ' + t('perMonth');
  const perks = tier === 'standard'
    ? (lang === 'ar' ? 'توصيل 3 د.ل · رسوم سلة 2 د.ل' : '3 LYD delivery · 2 LYD basket fee')
    : tier === 'plus'
    ? (lang === 'ar' ? 'إعفاء السلة · توصيلان مجانيان · 1% كاش باك' : 'No basket fee · 2 free deliv · 1% cashback')
    : (lang === 'ar' ? 'كل مزايا بلس · 4 توصيلات · 1.5% كاش باك' : 'All Plus · 4 free deliv · 1.5% cashback');
  return (
    <button onClick={onClick} className={`rounded-2xl border p-4 text-start backdrop-blur transition ${active ? 'border-white bg-white/20' : 'border-white/25 bg-white/10'}`}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold">{name}</span>
        {active && <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-brand-deep"><Icon name="check" className="h-3.5 w-3.5" /></span>}
      </div>
      <div className="mt-1 text-[15px] font-extrabold">{price}</div>
      <div className="mt-1 text-[11px] leading-snug text-white/75">{perks}</div>
    </button>
  );
}

// ── 2. Top up ────────────────────────────────────────────────────────────────
export function TopUp() {
  const { lang, go, showToast, setLinkedIban } = useApp();
  const t = makeT(lang);
  const [mode, setMode] = useState<'bank' | 'user'>('bank');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [iban, setIban] = useState('');
  const [result, setResult] = useState<{ ref: string; minor: number } | null>(null);

  const quick = [20, 50, 100, 250];
  const doTopup = async () => {
    const minor = toMinor(parseFloat(amount || '0'));
    if (minor <= 0) return showToast(t('amount'));
    setBusy(true);
    try {
      const r = await api.topup({ idempotencyKey: newIdem('topup'), amountMinor: minor, rail: mode === 'bank' ? 'bank_transfer' : 'peer_mesh_receive' });
      if (mode === 'bank' && iban) setLinkedIban(iban);
      // Real bank top-up: show the deposit reference the user must quote on the
      // transfer. The credit lands when LYPay matches the inbound payment.
      setResult({ ref: r.depositReference || r.id, minor });
    } catch (e: any) { showToast(e.message); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <ScreenHeader title={t('topUp')} onBack={() => go('home')}>
        <div className="rounded-3xl glass p-6 text-center">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-emerald-400/25 text-emerald-50"><Icon name="check" className="h-9 w-9" /></div>
          <div className="text-[15px] font-semibold">{lang === 'ar' ? 'تم إنشاء طلب الشحن' : 'Top-up created'}</div>
          <Money minor={result.minor} className="mt-1 block text-[34px] font-extrabold tracking-tight" />
          <div className="mt-4 rounded-2xl bg-white/10 p-4">
            <div className="text-[12px] text-white/70">{lang === 'ar' ? 'اكتب هذا المرجع عند التحويل' : 'Quote this reference on your transfer'}</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[15px] font-bold" dir="ltr">{result.ref}</span>
              <button onClick={() => { navigator.clipboard?.writeText(result.ref); showToast(t('copied')); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15"><Icon name="copy" className="h-4 w-4" /></button>
            </div>
            <div className="mt-2 text-[11px] text-white/60" dir="ltr">{DEPOSIT_IBAN}</div>
          </div>
          <p className="mt-3 text-[12px] text-white/70">{lang === 'ar' ? 'يُضاف الرصيد تلقائياً عند مطابقة التحويل البنكي الوارد.' : 'Your balance is credited automatically when the bank transfer is matched.'}</p>
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={() => { setResult(null); setAmount(''); }} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-white/40 bg-white/10 py-3 text-[14px] font-semibold"><Icon name="plus" className="h-4 w-4" />{lang === 'ar' ? 'شحن آخر' : 'New top-up'}</button>
          <button onClick={() => go('home')} className="pill-white flex-1 rounded-full py-3 text-[14px] font-bold">{t('done')}</button>
        </div>
      </ScreenHeader>
    );
  }

  return (
    <ScreenHeader title={t('topUp')} onBack={() => go('home')}>
      <div className="mb-4 grid grid-cols-2 gap-2 rounded-full bg-white/10 p-1 backdrop-blur">
        <Seg active={mode === 'bank'} onClick={() => setMode('bank')} label={t('bankTransfer')} />
        <Seg active={mode === 'user'} onClick={() => setMode('user')} label={t('fromUser')} />
      </div>

      {mode === 'bank' ? (
        <div className="space-y-3">
          <div className="rounded-2xl glass p-4">
            <div className="text-[12px] text-white/70">{t('bankTransfer')} · LYPay / IBAN</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[15px] font-bold" dir="ltr">{DEPOSIT_IBAN}</span>
              <button onClick={() => { navigator.clipboard?.writeText(DEPOSIT_IBAN); showToast(t('copied')); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15"><Icon name="copy" className="h-4 w-4" /></button>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => go('scanQr')} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/30 bg-white/10 py-2 text-[12px] font-semibold"><Icon name="qr" className="h-4 w-4" />{t('depositQr')}</button>
              <button onClick={() => go('scanIban')} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/30 bg-white/10 py-2 text-[12px] font-semibold"><Icon name="camera" className="h-4 w-4" />{t('scanIban')}</button>
            </div>
          </div>
          <Field label={lang === 'ar' ? 'آيبان البنك الذي تموّل منه (يُسجَّل للسحب)' : 'Your funding bank IBAN (saved for withdrawals)'}>
            <input value={iban} onChange={(e) => setIban(e.target.value)} placeholder="LY…" dir="ltr"
              className="w-full rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 text-[15px] outline-none placeholder:text-white/40" />
          </Field>
        </div>
      ) : (
        <div className="rounded-2xl glass p-5 text-center">
          <div className="mx-auto mb-2 h-40 w-40 rounded-2xl bg-white p-3"><QrBlock /></div>
          <div className="text-[13px] text-white/75">{lang === 'ar' ? 'شارك رمزك أو @المعرّف' : 'Share your QR or @handle'}</div>
          <div className="mt-1 font-bold" dir="ltr">@sami</div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-2 flex gap-2">
          {quick.map((q) => <button key={q} onClick={() => setAmount(String(q))} className="flex-1 rounded-full border border-white/30 bg-white/10 py-2 text-[13px] font-semibold">{q}</button>)}
        </div>
        <div className="relative">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00"
            className="w-full rounded-2xl border border-white/30 bg-white/10 px-4 py-4 text-3xl font-extrabold outline-none placeholder:text-white/40" />
          <span className="absolute end-4 top-1/2 -translate-y-1/2 text-sm font-bold text-white/70">LYD</span>
        </div>
      </div>

      <button onClick={doTopup} disabled={busy} className="pill-white mt-4 flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-bold disabled:opacity-60">
        {busy && <Spinner className="h-4 w-4" />} {t('topUp')}
      </button>
    </ScreenHeader>
  );
}

// ── 3. Camera IBAN scanner ───────────────────────────────────────────────────
export function ScanIban() {
  const { lang, go, showToast } = useApp();
  const t = makeT(lang);
  const [detected, setDetected] = useState('');
  const [torch, setTorch] = useState(false);
  const sample = 'LY21 0009 0000 1234 5678 9012';
  return (
    <ScreenHeader title={t('scanIbanCamera')} onBack={() => go('topup')}>
      <div className="relative mx-auto aspect-[3/4] w-full max-w-[320px] overflow-hidden rounded-3xl border border-white/25 bg-slate-900/70">
        <div className="absolute inset-0 opacity-40" style={{ background: 'radial-gradient(circle at 50% 40%, #1e293b, #020617)' }} />
        <div className="absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-brand/80">
          <div className="scanline absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-brand/50 to-transparent" />
        </div>
        <button onClick={() => setTorch((v) => !v)} className="absolute end-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-white/15 backdrop-blur"><Icon name="torch" className="h-5 w-5" /></button>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-900/90 to-transparent p-4">
          <div className="text-[12px] text-white/70">{lang === 'ar' ? 'وجّه الكاميرا إلى الآيبان' : 'Point at an IBAN to scan'}</div>
          <div className="mt-1 truncate font-mono text-[15px] font-bold" dir="ltr">{detected || '—'}</div>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={() => { setDetected(sample); showToast(lang === 'ar' ? 'تم المسح' : 'IBAN detected'); }} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/30 bg-white/10 py-2.5 text-[13px] font-semibold">
          <Icon name="scan" className="h-4 w-4" /> {lang === 'ar' ? 'محاكاة المسح' : 'Simulate scan'}
        </button>
        <button disabled={!detected} onClick={() => { if (detected) { showToast(t('copied')); go('topup'); } }} className="pill-white flex-1 rounded-full py-2.5 text-[13px] font-bold disabled:opacity-50">
          {lang === 'ar' ? 'تعبئة تلقائية' : 'Auto-fill'}
        </button>
      </div>
      <Field label={lang === 'ar' ? 'أو الصق الآيبان يدوياً' : 'Or paste IBAN manually'}>
        <input value={detected} onChange={(e) => setDetected(e.target.value)} dir="ltr" placeholder="LY…"
          className="w-full rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 font-mono text-[14px] outline-none placeholder:text-white/40" />
      </Field>
    </ScreenHeader>
  );
}

// ── 4. Manage card ───────────────────────────────────────────────────────────
export function ManageCard() {
  const { lang, setLang, go, frozen, setFrozen, cardTier } = useApp();
  const t = makeT(lang);
  return (
    <ScreenHeader title={lang === 'ar' ? 'إدارة البطاقة' : 'Manage card'} onBack={() => go('home')}>
      <div className="rounded-2xl glass p-5 text-center">
        <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-white/15"><Icon name="card" className="h-8 w-8" /></div>
        <div className="text-[13px] text-white/70">{lang === 'ar' ? 'اربط بطاقة فعلية' : 'Pair a physical card'}</div>
        <div className="mt-3 flex gap-2">
          <button className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/30 bg-white/10 py-2.5 text-[13px] font-semibold"><Icon name="wifi" className="h-4 w-4" /> NFC</button>
          <button onClick={() => go('scanQr')} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/30 bg-white/10 py-2.5 text-[13px] font-semibold"><Icon name="qr" className="h-4 w-4" /> QR</button>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-2xl glass p-4">
        <div>
          <div className="text-[14px] font-semibold">{lang === 'ar' ? 'حالة البطاقة' : 'Card status'}</div>
          <div className="text-[12px] text-white/70">{frozen ? t('frozen') : (lang === 'ar' ? 'نشطة' : 'Active')}</div>
        </div>
        <button onClick={() => setFrozen(!frozen)} className={`relative h-8 w-14 rounded-full transition ${frozen ? 'bg-white/30' : 'bg-brand'}`}>
          <span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-all ${frozen ? 'start-1' : 'end-1'}`} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Info label={lang === 'ar' ? 'الحد اليومي' : 'Daily limit'} value="5,000.00 LYD" />
        <Info label={lang === 'ar' ? 'الخطة' : 'Plan'} value={cardTier === 'standard' ? t('standard') : cardTier === 'plus' ? t('plus') : t('max')} />
      </div>

      {/* Language / account setting (moved out of the app header) */}
      <div className="mt-3 flex items-center justify-between rounded-2xl glass p-4">
        <div className="text-[14px] font-semibold">{lang === 'ar' ? 'اللغة' : 'Language'}</div>
        <div className="flex gap-1 rounded-full border border-white/25 bg-white/10 p-1">
          <button onClick={() => setLang('en')} className={`rounded-full px-3 py-1 text-[12px] font-semibold ${lang === 'en' ? 'bg-white text-brand-deep' : 'text-white/80'}`}>English</button>
          <button onClick={() => setLang('ar')} className={`rounded-full px-3 py-1 text-[12px] font-semibold ${lang === 'ar' ? 'bg-white text-brand-deep' : 'text-white/80'}`}>العربية</button>
        </div>
      </div>
    </ScreenHeader>
  );
}

// ── 4b. Withdraw (same account as top-up + typed IBAN match) ─────────────────
export function Withdraw() {
  const { lang, go, linkedIban, initiatePayment, showToast } = useApp();
  const t = makeT(lang);
  const [amount, setAmount] = useState('');
  const [typed, setTyped] = useState('');
  const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  const matches = !!linkedIban && norm(typed) === norm(linkedIban);
  const amountMinor = toMinor(parseFloat(amount || '0'));

  if (!linkedIban) {
    return (
      <ScreenHeader title={t('withdraw')} onBack={() => go('home')}>
        <div className="rounded-3xl glass p-6 text-center">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-white/15"><Icon name="lock" className="h-8 w-8" /></div>
          <div className="text-[15px] font-semibold">{lang === 'ar' ? 'لا يوجد حساب بنكي مرتبط' : 'No linked bank account yet'}</div>
          <p className="mt-1 text-[13px] text-white/70">{lang === 'ar' ? 'أضف رصيداً عبر تحويل بنكي أولاً لربط حسابك.' : 'Top up via bank transfer first to link your account.'}</p>
          <button onClick={() => go('topup')} className="pill-white mt-4 w-full rounded-full py-3 text-[15px] font-bold">{t('topUp')}</button>
        </div>
      </ScreenHeader>
    );
  }

  return (
    <ScreenHeader title={t('withdraw')} onBack={() => go('home')}>
      <div className="rounded-2xl glass p-4">
        <div className="text-[12px] text-white/70">{t('sameAccount')}</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[15px] font-bold" dir="ltr">{linkedIban}</span>
          <Icon name="lock" className="h-4 w-4 text-white/60" />
        </div>
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-[12px] font-semibold text-white/75">{t('amount')}</label>
        <div className="relative">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00"
            className="w-full rounded-2xl border border-white/30 bg-white/10 px-4 py-4 text-3xl font-extrabold outline-none placeholder:text-white/40" />
          <span className="absolute end-4 top-1/2 -translate-y-1/2 text-sm font-bold text-white/70">LYD</span>
        </div>
      </div>

      <Field label={t('typeIban')}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} dir="ltr" placeholder="LY…"
          className={`w-full rounded-xl border bg-white/10 px-3 py-2.5 font-mono text-[14px] outline-none placeholder:text-white/40 ${typed && !matches ? 'border-red-300/70' : matches ? 'border-emerald-300/70' : 'border-white/30'}`} />
        {typed && !matches && <div className="mt-1 text-[12px] text-red-100">{t('ibanMismatch')}</div>}
        {matches && <div className="mt-1 flex items-center gap-1 text-[12px] text-emerald-100"><Icon name="check" className="h-3.5 w-3.5" />{lang === 'ar' ? 'مطابق' : 'Matches'}</div>}
      </Field>

      <div className="mt-6">
        <SlideToPay dir={lang === 'ar' ? 'rtl' : 'ltr'} label={t('slideToPay')} disabled={!matches || amountMinor <= 0}
          onComplete={() => {
            if (amountMinor <= 0) return showToast(t('amount'));
            initiatePayment({ amountMinor, recipient: { name: 'Bank', raw: linkedIban! }, note: 'Withdrawal', source: 'withdraw' });
          }} />
      </div>
    </ScreenHeader>
  );
}

// ── 5. Keypad home (Pay) ─────────────────────────────────────────────────────
export function KeypadHome() {
  const { lang, go, showToast, setDraftAmountMinor } = useApp();
  const t = makeT(lang);
  const [entry, setEntry] = useState('');
  const press = (k: string) => {
    if (k === '⌫') return setEntry((e) => e.slice(0, -1));
    if (k === '.') return setEntry((e) => (e.includes('.') ? e : (e || '0') + '.'));
    setEntry((e) => (e.length < 9 ? e + k : e));
  };
  const amount = parseFloat(entry || '0');
  const pay = () => {
    if (amount <= 0) return showToast(t('amount'));
    setDraftAmountMinor(toMinor(amount));
    go('recipient');
  };
  return (
    <div className="flex min-h-[70vh] flex-col px-1 pb-28">
      <div className="mb-2 flex items-center justify-end">
        <button onClick={() => go('manageCard')} aria-label={lang === 'ar' ? 'الحساب' : 'Account'}
          className="grid h-10 w-10 place-items-center rounded-full border border-white/30 bg-white/15 backdrop-blur active:scale-95">
          <Icon name="user" className="w-5 h-5" />
        </button>
      </div>

      <div className="my-6 text-center">
        <div className="text-[54px] font-extrabold leading-none tracking-tight">{entry ? fmt(amount) : '0.00'}<span className="ms-2 align-top text-lg font-bold text-white/70">LYD</span></div>
      </div>

      <div className="mx-auto grid w-full max-w-[320px] grid-cols-3 gap-3">
        {['1','2','3','4','5','6','7','8','9','.','0','⌫'].map((k) => (
          <button key={k} onClick={() => press(k)} className="grid h-16 place-items-center rounded-2xl glass text-2xl font-bold active:bg-white/25">{k}</button>
        ))}
      </div>

      <div className="mx-auto mt-5 grid w-full max-w-[320px] grid-cols-3 gap-2">
        <button onClick={() => { setEntry(''); showToast(lang === 'ar' ? 'تم نسخ رابط الطلب' : 'Request link copied'); }} className="flex flex-col items-center gap-1 rounded-2xl border border-white/30 bg-white/10 py-2.5 text-[12px] font-semibold"><Icon name="down" className="h-5 w-5" />{t('request')}</button>
        <button onClick={() => go('scanQr')} className="flex flex-col items-center gap-1 rounded-2xl border border-white/30 bg-white/10 py-2.5 text-[12px] font-semibold"><Icon name="qr" className="h-5 w-5" />{t('qr')}</button>
        <button onClick={pay} className="pill-white flex flex-col items-center gap-1 rounded-2xl py-2.5 text-[12px] font-bold"><Icon name="send" className="h-5 w-5" />{t('payNow')}</button>
      </div>
    </div>
  );
}

// ── 6. Scan QR ───────────────────────────────────────────────────────────────
export function ScanQr() {
  const { lang, go, setDraftAmountMinor, showToast } = useApp();
  const t = makeT(lang);
  const [mode, setMode] = useState<'scan' | 'my'>('scan');
  const simulate = () => { setDraftAmountMinor(toMinor(12.5)); showToast(lang === 'ar' ? 'تم قراءة الرمز' : 'QR read · 12.50 LYD'); go('recipient'); };
  return (
    <ScreenHeader title={t('qr')} onBack={() => go('keypad')}>
      <div className="mb-4 grid grid-cols-2 gap-2 rounded-full bg-white/10 p-1 backdrop-blur">
        <Seg active={mode === 'scan'} onClick={() => setMode('scan')} label={t('scanQr')} />
        <Seg active={mode === 'my'} onClick={() => setMode('my')} label={t('myQr')} />
      </div>
      {mode === 'scan' ? (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-3xl border border-white/25 bg-slate-900/70">
            <div className="absolute inset-10 rounded-2xl border-2 border-brand/80">
              <div className="scanline absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-brand/50 to-transparent" />
            </div>
          </div>
          <button onClick={simulate} className="pill-white mt-4 w-full rounded-full py-3.5 text-[15px] font-bold">
            {lang === 'ar' ? 'محاكاة مسح الرمز' : 'Simulate scan'}
          </button>
        </>
      ) : (
        <div className="rounded-3xl glass p-6 text-center">
          <div className="mx-auto mb-3 h-56 w-56 rounded-2xl bg-white p-4"><QrBlock /></div>
          <div className="font-bold" dir="ltr">@sami</div>
          <div className="text-[12px] text-white/70">{lang === 'ar' ? 'امسح لإرسال الأموال لي' : 'Scan to send me money'}</div>
        </div>
      )}
    </ScreenHeader>
  );
}

// ── 7. Recipient & note ──────────────────────────────────────────────────────
export function Recipient() {
  const { lang, go, initiatePayment, draftAmountMinor, showToast } = useApp();
  const t = makeT(lang);
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const list = CONTACTS.filter((c) => (c.name + c.handle + c.userId).toLowerCase().includes(q.toLowerCase()));
  const pick = (c: (typeof CONTACTS)[number]) => initiatePayment({ amountMinor: draftAmountMinor, recipient: c, note, source: 'keypad' });
  return (
    <ScreenHeader title={t('recipient')} onBack={() => go('keypad')}>
      <div className="mb-3 flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 py-2.5 backdrop-blur">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')}
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-white/50" />
        <button onClick={() => go('scanIban')} className="text-brand-100"><Icon name="scan" className="h-5 w-5" /></button>
      </div>
      <div className="space-y-2">
        {list.map((c) => (
          <button key={c.userId} onClick={() => pick(c)} className="flex w-full items-center gap-3 rounded-2xl glass px-4 py-3 text-start active:bg-white/20">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-white/20 font-bold">{c.name[0]}</div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{c.name}</div>
              <div className="text-[12px] text-white/70" dir="ltr">{c.handle}</div>
            </div>
            <Icon name="chevron" className="h-4 w-4 text-white/60" />
          </button>
        ))}
        {list.length === 0 && <div className="py-8 text-center text-white/60">{t('noActivity')}</div>}
      </div>
      <Field label={t('note')}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="🍽️ …"
          className="w-full rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 text-[15px] outline-none placeholder:text-white/40" />
      </Field>
      {draftAmountMinor > 0 && <div className="mt-2 text-center text-[13px] text-white/70">{t('amount')}: <Money minor={draftAmountMinor} /></div>}
    </ScreenHeader>
  );
}

// ── 8. Review + Slide to Pay ─────────────────────────────────────────────────
export function Review() {
  const { lang, flow, completeSwipe, go } = useApp();
  const t = makeT(lang);
  const r = flow.recipient as any;
  const name = r?.name || r?.raw || '—';
  const fee = 0;
  return (
    <ScreenHeader title={t('review')} onBack={() => go('keypad')}>
      <div className="rounded-3xl glass p-6 text-center">
        <div className="text-[13px] text-white/70">{t('recipient')}</div>
        <div className="mt-1 text-lg font-bold">{name}</div>
        <Money minor={flow.amountMinor} className="mt-3 block text-[44px] font-extrabold leading-none tracking-tight" />
        {flow.note && <div className="mt-2 text-[13px] text-white/70">{flow.note}</div>}
      </div>
      <div className="mt-4 space-y-2 rounded-2xl glass p-4 text-[14px]">
        <Row label={t('fee')} value={<Money minor={fee} />} />
        <div className="my-1 border-t border-white/15" />
        <Row label={t('total')} value={<Money minor={flow.amountMinor + fee} className="font-bold" />} strong />
      </div>
      {flow.error && <div className="mt-3 rounded-xl bg-red-500/20 px-3 py-2 text-[13px] text-red-100">{flow.error}</div>}
      <div className="mt-6">
        <SlideToPay onComplete={completeSwipe} dir={lang === 'ar' ? 'rtl' : 'ltr'}
          label={flow.amountMinor > FACE_VERIFY_LYD * 100 ? t('slideToPay') + ' · ' + t('faceTitle') : t('swipeHint')} />
      </div>
    </ScreenHeader>
  );
}

// ── 10. Confirmation ─────────────────────────────────────────────────────────
export function Confirm() {
  const { lang, lastReceipt, go, setTab } = useApp();
  const t = makeT(lang);
  const r = lastReceipt?.recipient as any;
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-2 text-center">
      <div className="relative mb-5 grid h-24 w-24 place-items-center">
        <span className="absolute inset-0 rounded-full bg-white/15 pulse-ring" />
        <span className="grid h-20 w-20 place-items-center rounded-full bg-white text-brand-deep"><Icon name="check" className="h-11 w-11" /></span>
      </div>
      <h2 className="text-2xl font-extrabold">{t('success')}</h2>
      <Money minor={lastReceipt?.amountMinor ?? 0} className="mt-2 text-[40px] font-extrabold tracking-tight" />
      <div className="mt-1 text-[14px] text-white/75">{lang === 'ar' ? 'إلى' : 'to'} {r?.name || '—'}</div>
      <div className="mt-3 flex items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-semibold backdrop-blur">
        <Icon name="wifi" className="h-4 w-4" /> {t('queued')}
      </div>
      <button onClick={() => { setTab('card'); go('home'); }} className="pill-white mt-8 w-full max-w-[320px] rounded-full py-3.5 text-[15px] font-bold">{t('done')}</button>
    </div>
  );
}

// ── 11. Activity ─────────────────────────────────────────────────────────────
export function ActivityFeed() {
  const { lang, activity, openReceipt } = useApp();
  const t = makeT(lang);
  const [filter, setFilter] = useState<'all' | 'card' | 'transfers' | 'requests'>('all');
  const [q, setQ] = useState('');
  const rows = activity.filter((a) => {
    if (q && !(a.counterparty?.name || a.reference).toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'transfers') return a.kind === 'wallet_transfer';
    if (filter === 'requests') return false;
    if (filter === 'card') return a.kind === 'card_tap';
    return true;
  });
  return (
    <div className="px-1 pb-28">
      <div className="mb-3 flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 py-2.5 backdrop-blur">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="w-full bg-transparent text-[15px] outline-none placeholder:text-white/50" />
      </div>
      <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
        {([['all', t('all')], ['card', t('cardTaps')], ['transfers', t('transfers')], ['requests', t('requests')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k as any)} className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${filter === k ? 'bg-white text-brand-deep' : 'border border-white/30 bg-white/10'}`}>{label}</button>
        ))}
      </div>
      <div className="space-y-2">
        {rows.map((a) => <ActivityRow key={a.id} a={a} lang={lang} onClick={() => openReceipt({ step: 'done', amountMinor: a.amountMinor, recipient: { name: a.counterparty?.name || a.reference }, note: '', source: 'keypad' })} />)}
        {rows.length === 0 && <div className="py-10 text-center text-white/60">{t('noActivity')}</div>}
      </div>
    </div>
  );
}
function ActivityRow({ a, lang, onClick }: { a: Activity; lang: 'en' | 'ar'; onClick: () => void }) {
  const t = makeT(lang);
  const label = a.kind === 'wallet_transfer' ? (a.direction === 'in' ? t('received') : t('sent'))
    : a.kind === 'topup' ? t('topUp') : a.kind === 'refund' ? (lang === 'ar' ? 'استرداد' : 'Refund') : (lang === 'ar' ? 'دفع' : 'Payment');
  const who = a.counterparty?.name || (a.kind === 'topup' ? (lang === 'ar' ? 'بنك / شحن' : 'Bank / top-up') : 'Miirra');
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl glass px-4 py-3 text-start active:bg-white/20">
      <div className={`grid h-10 w-10 place-items-center rounded-full ${a.direction === 'in' ? 'bg-emerald-400/25 text-emerald-50' : 'bg-white/15'}`}><Icon name={a.direction === 'in' ? 'down' : 'up'} className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{who} <span className="text-[11px] font-medium text-white/60">· {label}</span></div>
        <div className="text-[12px] text-white/60">{timeAgo(a.createdAt)} · {a.status}{a.pending ? ' · ' + t('pending') : ''}</div>
      </div>
      <div className={`text-[15px] font-extrabold ${a.direction === 'in' ? 'text-emerald-100' : ''}`}>{a.direction === 'in' ? '+' : '−'}{fmtMinor(a.amountMinor)}</div>
    </button>
  );
}

// ── 12. Receipt / mesh sync ──────────────────────────────────────────────────
export function Receipt() {
  const { lang, lastReceipt, go, showToast, setTab } = useApp();
  const t = makeT(lang);
  const r = lastReceipt?.recipient as any;
  return (
    <ScreenHeader title={t('receipt')} onBack={() => { setTab('activity'); go('home'); }}>
      <div className="rounded-3xl glass p-6 text-center">
        <div className="text-[13px] text-white/70">{t('total')}</div>
        <Money minor={lastReceipt?.amountMinor ?? 0} className="mt-1 block text-[40px] font-extrabold tracking-tight" />
        <div className="mt-1 text-[14px] text-white/75">{r?.name}</div>
      </div>
      <div className="mt-4 space-y-2 rounded-2xl glass p-4 text-[14px]">
        <Row label={lang === 'ar' ? 'المبلغ' : 'Amount'} value={<Money minor={lastReceipt?.amountMinor ?? 0} />} />
        <Row label={t('fee')} value={<Money minor={0} />} />
        <div className="my-1 border-t border-white/15" />
        <Row label={lang === 'ar' ? 'الحالة' : 'Status'} value={<span className="font-semibold text-emerald-100">{t('queued')}</span>} />
        <Row label="Mesh" value={<span className="font-semibold">{lang === 'ar' ? 'متزامن' : 'Synced'}</span>} />
      </div>
      <div className="mt-5 flex gap-3">
        <button onClick={() => { navigator.clipboard?.writeText(JSON.stringify(lastReceipt)); showToast(t('copied')); }} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-white/40 bg-white/10 py-3 text-[14px] font-semibold"><Icon name="share" className="h-4 w-4" />{t('share')}</button>
        <button onClick={() => go('home')} className="pill-white flex-1 rounded-full py-3 text-[14px] font-bold">{t('close')}</button>
      </div>
    </ScreenHeader>
  );
}

// ── 13. Checkout approval (pay.miirra.com) ───────────────────────────────────
export function Checkout() {
  const { lang, initiatePayment, go } = useApp();
  const t = makeT(lang);
  const amountMinor = toMinor(128.5);
  return (
    <ScreenHeader title={t('checkout')} onBack={() => go('home')}>
      <div className="rounded-3xl glass p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/15 text-xl">🍜</div>
          <div className="min-w-0 flex-1">
            <div className="font-bold">Nour's Kitchen</div>
            <div className="text-[12px] text-white/70">{lang === 'ar' ? 'طلب #4821 · استلام' : 'Order #4821 · pickup'}</div>
          </div>
          <Money minor={amountMinor} className="font-extrabold" />
        </div>
        <div className="mt-4 space-y-1.5 text-[13px] text-white/80">
          <Row label={lang === 'ar' ? 'المجموع الفرعي' : 'Subtotal'} value={<Money minor={amountMinor - 300} />} />
          <Row label={lang === 'ar' ? 'التوصيل' : 'Delivery'} value={<Money minor={300} />} />
        </div>
      </div>
      <div className="mt-6">
        <SlideToPay dir={lang === 'ar' ? 'rtl' : 'ltr'} label={t('slideToPay')}
          onComplete={() => initiatePayment({ amountMinor, recipient: { name: "Nour's Kitchen" }, note: 'Order #4821', source: 'checkout' })} />
      </div>
    </ScreenHeader>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
export function ScreenHeader({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="px-1 pb-28">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-full border border-white/30 bg-white/10 backdrop-blur"><Icon name="back" className="h-5 w-5" /></button>
        <h2 className="text-lg font-bold">{title}</h2>
      </div>
      {children}
    </div>
  );
}
function Seg({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button onClick={onClick} className={`rounded-full py-2 text-[13px] font-semibold transition ${active ? 'bg-white text-brand-deep' : 'text-white/80'}`}>{label}</button>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mt-3"><label className="mb-1 block text-[12px] font-semibold text-white/75">{label}</label>{children}</div>;
}
function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return <div className="flex items-center justify-between"><span className="text-white/70">{label}</span><span className={strong ? 'text-[15px]' : ''}>{value}</span></div>;
}
function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl glass p-4"><div className="text-[12px] text-white/70">{label}</div><div className="mt-0.5 text-[15px] font-bold">{value}</div></div>;
}
function QrBlock() {
  return <div className="h-full w-full rounded" style={{ backgroundImage: 'linear-gradient(45deg,#0f172a 25%,transparent 25%),linear-gradient(-45deg,#0f172a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#0f172a 75%),linear-gradient(-45deg,transparent 75%,#0f172a 75%)', backgroundSize: '14px 14px', backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0' }} />;
}
function timeAgo(ms: number): string {
  const d = Math.max(0, Date.now() - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}