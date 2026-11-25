import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Lang } from './lib';

export type Tier = 'standard' | 'plus' | 'max';

const TIER: Record<Tier, { badge: { en: string; ar: string }; sub: { en: string; ar: string }; back: { en: string; ar: string }; footer: string }> = {
  standard: {
    badge: { en: 'STANDARD · 0 LYD', ar: 'الأساسية · 0 د.ل' },
    sub: { en: '0.5% MDR · 3 LYD delivery', ar: '0.5% عمولة · توصيل 3 د.ل' },
    back: { en: 'Synced to Miirra Pay wallet. 3.00 LYD starting delivery (100% to driver). Face/biometric check above 1,000.00 LYD.', ar: 'مرتبطة بمحفظة ميرا باي. التوصيل من 3.00 د.ل (100% للسائق). تحقق بيومتري فوق 1,000.00 د.ل.' },
    footer: 'LYD',
  },
  plus: {
    badge: { en: 'MIIRRA+ · 15 LYD/MO', ar: 'ميرا بلس · 15 د.ل/شهرياً' },
    sub: { en: '0 LYD basket · 2 free deliv.', ar: 'إعفاء السلة · توصيلان مجانيان' },
    back: { en: '0.00 LYD small-basket fee (<25 LYD), 9 PM–12 AM surplus & 3 LYD late-night drops, 2 free deliveries/mo, 1% tap cashback.', ar: 'إعفاء رسوم السلة (<25 د.ل)، عروض 9م–12ص وتوصيل 3 د.ل، توصيلان مجانيان شهرياً، واسترداد 1%.' },
    footer: 'MIIRRA+',
  },
  max: {
    badge: { en: 'MIIRRA MAX · 40 LYD/MO', ar: 'ميرا ماكس · 40 د.ل/شهرياً' },
    sub: { en: '4 free deliv. · 1.5% cashback', ar: '4 توصيلات مجانية · 1.5% استرداد' },
    back: { en: 'All Miirra+ perks plus 4 free deliveries/mo, 1.5% tap cashback, eSIM/data allowance & Miirra Mesh priority.', ar: 'جميع مزايا ميرا بلس + 4 توصيلات مجانية شهرياً، 1.5% استرداد، رصيد eSIM وأولوية ميرا ميش.' },
    footer: 'MIIRRA MAX',
  },
};

export function MiirraCard({ tier, holder, frozen, lang, qrValue }: { tier: Tier; holder: string; frozen: boolean; lang: Lang; qrValue?: string }) {
  const [flipped, setFlipped] = useState(false);
  const ar = lang === 'ar';
  const cfg = TIER[tier];
  return (
    <div className="flip-scene mx-auto w-full max-w-[428px] cursor-pointer select-none" style={{ aspectRatio: '85.6 / 53.98' }}
      onClick={() => setFlipped((f) => !f)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); } }}
      aria-label={ar ? 'بطاقة ميرا باي — اضغط للقلب' : 'Miirra Pay card — tap to flip'}>
      <div className={`flip-inner ${flipped ? 'is-flipped' : ''}`} style={{ filter: frozen ? 'grayscale(0.75) brightness(0.85)' : undefined }}>
        {/* FRONT */}
        <div className="flip-face" style={{ background: '#0d3b7a' }}>
          <CardArt tier={tier} />
          <div className="relative z-[2] flex h-full flex-col justify-between p-5 text-white">
            <div className="flex items-center justify-between">
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide backdrop-blur ${frozen ? 'border-white/40 bg-black/30' : tier === 'max' ? 'border-amber-200/60 bg-amber-500/30 text-amber-50' : tier === 'plus' ? 'border-cyan-200/50 bg-sky-600/40' : 'border-white/30 bg-black/25'}`}>
                {frozen ? (ar ? 'مجمدة · FROZEN' : 'FROZEN') : cfg.badge[lang]}
              </span>
              <NfcIcon />
            </div>
            <div className="flex items-center justify-between">
              <div className="h-8 w-11 rounded-md border border-white/50" style={{ background: 'linear-gradient(135deg,#f3e7c3,#c8a96e 50%,#e8d5a7)' }} />
              <span className="rounded-full bg-black/25 px-2 py-1 text-[10px] font-semibold backdrop-blur">{ar ? 'اضغط للقلب ↻' : 'Tap to flip ↻'}</span>
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-bold tracking-wider">{holder}</div>
                <div className="truncate text-[10px] opacity-90">{cfg.sub[lang]}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-sm font-extrabold tracking-wide" dir="ltr">
                <Starburst /> <span>MIIRRA PAY</span>
              </div>
            </div>
          </div>
        </div>
        {/* BACK */}
        <div className="flip-face flip-back" style={{ background: 'linear-gradient(145deg,#132238,#0b1320)' }}>
          <div className="mt-[18px] h-11 w-full border-y border-white/10"
            style={{ background: 'repeating-linear-gradient(90deg,#05070b 0 14px,#0f172a 14px 28px,#05070b 28px 42px)' }} />
          <div className="flex items-center gap-3.5 px-5 pt-3.5 text-white">
            <div className="h-[74px] w-[74px] shrink-0 rounded-[10px] bg-white p-1.5">
              {qrValue ? <QRCodeSVG value={qrValue} size={60} bgColor="#ffffff" fgColor="#0f172a" level="M" /> : <QrGrid />}
            </div>
            <div className="min-w-0">
              <div className={`text-[10px] font-bold tracking-wide ${tier === 'max' ? 'text-amber-400' : 'text-sky-400'}`}>{cfg.badge[lang]}</div>
              <div className="text-[11px] font-bold tracking-wide text-slate-200" dir="ltr">MR-{tier === 'plus' ? 'PLUS' : tier === 'max' ? 'MAX' : '0001'}-LYD</div>
              <p className="mt-0.5 text-[9.5px] leading-snug text-slate-300">{cfg.back[lang]}</p>
            </div>
          </div>
          <div className="absolute inset-x-5 bottom-3.5 flex items-center justify-between border-t border-white/10 pt-2 text-[9.5px] tracking-wide text-slate-400" dir="ltr">
            <span>pay.miirra.com · mesh.miirra.com</span><span>{cfg.footer}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CardArt({ tier }: { tier: Tier }) {
  const cyan = tier === 'max'
    ? 'radial-gradient(circle at 30% 30%, #2563eb 0%, #111827 72%, #05070c 100%)'
    : tier === 'plus'
    ? 'radial-gradient(circle at 30% 30%, #22d3ee 0%, #1652b8 65%, #091e42 100%)'
    : 'radial-gradient(circle at 35% 35%, #56ccf2 0%, #1d70d8 68%, #0d3b7a 100%)';
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]">
      <div className="absolute" style={{ width: '115%', height: '150%', top: '-28%', left: '-18%', borderRadius: 999, background: cyan }} />
      <div className="absolute" style={{ width: '72%', height: '120%', top: '-12%', right: '-12%', borderRadius: 999, background: 'linear-gradient(160deg,#f7b733,#e08e1b 70%,#9a5b0c)', opacity: 0.88 }} />
      <div className="absolute" style={{ inset: '-15%', borderRadius: '45%', border: '9px solid transparent', borderTopColor: 'rgba(241,245,249,.78)', borderLeftColor: 'rgba(203,213,225,.55)', transform: 'rotate(-18deg) translate(-6%,8%)' }} />
      <div className="absolute" style={{ inset: '-15%', borderRadius: '45%', border: '9px solid transparent', borderRightColor: 'rgba(226,232,240,.65)', borderBottomColor: 'rgba(148,163,184,.45)', transform: 'rotate(14deg) translate(8%,12%)' }} />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(118deg, rgba(255,255,255,.24), rgba(255,255,255,.04) 42%, rgba(255,255,255,0) 60%)' }} />
    </div>
  );
}

function NfcIcon() {
  return <svg className="h-[22px] w-[22px] opacity-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6.5 15.5a6.5 6.5 0 0 1 0-7" /><path d="M10.5 18a11 11 0 0 1 0-12" /><path d="M14.5 20.5a15.5 15.5 0 0 1 0-17" /></svg>;
}
function Starburst() {
  return <svg className="h-[18px] w-[18px]" viewBox="0 0 32 32" fill="currentColor"><rect x="14.5" y="2" width="3" height="28" rx="1.5" /><rect x="2" y="14.5" width="28" height="3" rx="1.5" /><rect x="14.5" y="2" width="3" height="28" rx="1.5" transform="rotate(45 16 16)" /><rect x="14.5" y="2" width="3" height="28" rx="1.5" transform="rotate(-45 16 16)" /></svg>;
}
function QrGrid() {
  return <div className="h-full w-full rounded" style={{
    backgroundImage: 'linear-gradient(45deg,#0f172a 25%,transparent 25%),linear-gradient(-45deg,#0f172a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#0f172a 75%),linear-gradient(-45deg,transparent 75%,#0f172a 75%)',
    backgroundSize: '12px 12px', backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
  }} />;
}