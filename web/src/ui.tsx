import React, { useEffect, useRef, useState } from 'react';
import { fmtMinor, type Lang } from './lib';

// ── Icons (inline, stroke-based) ─────────────────────────────────────────────
export function Icon({ name, className = 'w-6 h-6' }: { name: string; className?: string }) {
  const p: Record<string, React.ReactNode> = {
    card: <><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M2.5 10h19" /></>,
    pay: <><path d="M12 19V5M5 12l7 7 7-7" /></>,
    activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
    plus: <path d="M12 5v14M5 12h14" />,
    up: <path d="M12 19V5M5 12l7-7 7 7" />,
    down: <path d="M12 5v14M5 12l7 7 7-7" />,
    send: <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></>,
    scan: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M20 20v.01M17 20h.01M20 17h.01" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
    camera: <><path d="M4 8h3l2-2h6l2 2h3v11H4z" /><circle cx="12" cy="13" r="3.2" /></>,
    torch: <path d="M12 2v6M8 8h8l-1 5H9zM10 13v7h4v-7" />,
    back: <path d="M15 5l-7 7 7 7" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    check: <path d="M4 12l5 5L20 6" />,
    face: <><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M9 10h.01M15 10h.01M9 15c1.5 1 4.5 1 6 0" /></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V8a4 4 0 0 1 8 0v2" /></>,
    wifi: <><path d="M2 8.5a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 15.5a6 6 0 0 1 7 0" /><path d="M12 19h.01" /></>,
    share: <><circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></>,
    chevron: <path d="M9 6l6 6-6 6" />,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
  };
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name] || null}
    </svg>
  );
}

// ── Money text ───────────────────────────────────────────────────────────────
export function Money({ minor, className = '', showCurrency = true }: { minor: number; className?: string; showCurrency?: boolean }) {
  return <span className={className}>{fmtMinor(minor)}{showCurrency && <span className="opacity-70 text-[0.7em] font-semibold ms-1">LYD</span>}</span>;
}

// ── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ className = 'w-5 h-5' }: { className?: string }) {
  return <span className={`${className} spin inline-block rounded-full border-2 border-white/30 border-t-white`} />;
}

// ── Sheet (bottom modal) ─────────────────────────────────────────────────────
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center fade-in" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-[460px] glass-dark rounded-t-[28px] px-5 pt-3 pb-[calc(22px+env(safe-area-inset-bottom))] sheet-up"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-white/30" />
        {title && <h3 className="mb-1 text-lg font-bold">{title}</h3>}
        {children}
      </div>
    </div>
  );
}

// ── Top bar (minimal — brand lives in the account area, not the header) ───────
export function TopBar() {
  return <header className="pt-[calc(6px+env(safe-area-inset-top))] pb-2" />;
}

// ── Bottom navigation (strictly 3, compact) ──────────────────────────────────
export function BottomBar({ tab, setTab, lang, onPay }: { tab: string; setTab: (t: any) => void; lang: Lang; onPay: () => void }) {
  const t = (k: string) => (lang === 'ar' ? ({ card: 'البطاقة', pay: 'ادفع', activity: 'النشاط' } as any)[k] : ({ card: 'Card', pay: 'Pay', activity: 'Activity' } as any)[k]);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[420px] items-center justify-around px-4 pb-[calc(8px+env(safe-area-inset-bottom))] pt-1"
      style={{ background: 'linear-gradient(to top, rgba(84,145,224,.92), rgba(84,145,224,0))' }}>
      <div className="grid w-full grid-cols-3 items-center rounded-full border border-white/25 bg-white/12 px-1.5 py-1.5 backdrop-blur-xl">
        <div className="flex justify-start">
          <NavBtn active={tab === 'card'} onClick={() => setTab('card')} icon="card" label={t('card')} />
        </div>
        <div className="flex justify-center">
          <button onClick={onPay} aria-label={t('pay')}
            className="-mt-6 grid h-14 w-14 place-items-center rounded-full bg-white text-brand-deep shadow-md active:scale-95 transition">
            <Icon name="send" className="w-6 h-6" />
          </button>
        </div>
        <div />
      </div>
    </nav>
  );
}
function NavBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button onClick={onClick} className={`flex w-16 flex-col items-center gap-0.5 rounded-xl py-1 text-[10px] font-semibold transition ${active ? 'text-white' : 'text-white/60'}`}>
      <Icon name={icon} className="w-5 h-5" />
      <span>{label}</span>
    </button>
  );
}

// ── Slide to pay ─────────────────────────────────────────────────────────────
export function SlideToPay({ onComplete, label, dir = 'ltr', disabled }: { onComplete: () => void; label: string; dir?: 'ltr' | 'rtl'; disabled?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(0); // thumb translate in px
  const [done, setDone] = useState(false);
  const dragging = useRef(false);
  const THUMB = 56;
  const PAD = 4;

  useEffect(() => { setPx(0); setDone(false); }, [label]);

  const maxTravel = () => (trackRef.current ? trackRef.current.clientWidth - THUMB - PAD * 2 : 0);

  const onDown = (e: React.PointerEvent) => {
    if (disabled || done) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    move(e);
  };
  const move = (e: React.PointerEvent) => {
    if (!dragging.current || !trackRef.current) return;
    const r = trackRef.current.getBoundingClientRect();
    let p = (e.clientX - r.left - PAD - THUMB / 2) / maxTravel();
    if (dir === 'rtl') p = 1 - p;
    p = Math.max(0, Math.min(1, p));
    setPx(p * maxTravel());
    if (p >= 0.985) {
      dragging.current = false;
      setDone(true);
      onComplete();
    }
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (!done) setPx(0); // spring back
  };

  const translate = dir === 'rtl' ? -px : px;
  return (
    <div ref={trackRef} onPointerDown={onDown} onPointerMove={move} onPointerUp={onUp} onPointerCancel={onUp}
      className={`slide-track relative h-[64px] w-full select-none overflow-hidden rounded-full glass-strong ${disabled ? 'opacity-50' : ''}`}
      dir={dir} style={{ touchAction: 'none' }}>
      <div className="pointer-events-none absolute inset-y-0 bg-white/15" style={{ width: px + THUMB / 2, [dir === 'rtl' ? 'right' : 'left']: 0 } as any} />
      <div className="absolute inset-0 flex items-center justify-center ps-16 pe-16">
        <span className="truncate text-[15px] font-semibold text-white/85">{done ? '✓' : label}</span>
      </div>
      <div className="slide-thumb absolute top-1 grid place-items-center rounded-full bg-white text-brand-deep shadow"
        style={{ width: THUMB, height: THUMB, top: 4, [dir === 'rtl' ? 'right' : 'left']: PAD, transform: `translateX(${translate}px)` } as any}>
        <Icon name="send" className="w-6 h-6" />
      </div>
    </div>
  );
}

// ── Biometric / Face verification modal ──────────────────────────────────────
export function BiometricModal({ open, amountMinor, recipientName, onConfirm, onCancel, lang }: {
  open: boolean; amountMinor: number; recipientName: string; onConfirm: () => void; onCancel: () => void; lang: Lang;
}) {
  if (!open) return null;
  const ar = lang === 'ar';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6 fade-in">
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-md" />
      <div className="relative w-full max-w-[360px] glass-dark rounded-[28px] p-6 text-center sheet-up">
        <div className="relative mx-auto mb-5 grid h-28 w-28 place-items-center">
          <span className="absolute inset-0 rounded-full border-2 border-brand/60 pulse-ring" />
          <span className="absolute inset-3 rounded-full border border-white/25" />
          <Icon name="face" className="w-16 h-16 text-white" />
        </div>
        <h3 className="text-lg font-bold">{ar ? 'التحقق بالوجه' : 'Face verification'}</h3>
        <p className="mt-1 text-sm text-white/70">{ar ? 'أكد هذه العملية بأمان' : 'Confirm this payment securely'}</p>
        <div className="my-4 rounded-2xl bg-white/10 p-4">
          <Money minor={amountMinor} className="text-2xl font-extrabold" />
          <div className="mt-1 text-sm text-white/70">{ar ? 'إلى' : 'to'} {recipientName}</div>
        </div>
        <button onClick={onConfirm} className="pill-white h-13 w-full rounded-full py-3.5 text-[15px] font-bold active:scale-[.99]">
          {ar ? 'تأكيد بالبصمة' : 'Confirm with biometrics'}
        </button>
        <button onClick={onCancel} className="mt-2 w-full rounded-full py-2.5 text-sm font-semibold text-white/70">
          {ar ? 'إلغاء' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────────────────────
export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(14px+env(safe-area-inset-top))] z-[60] mx-auto w-fit max-w-[90%] rounded-full bg-slate-900/85 px-4 py-2 text-sm font-semibold text-white shadow-lg fade-in">
      {msg}
    </div>
  );
}