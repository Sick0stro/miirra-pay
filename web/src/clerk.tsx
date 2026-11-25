import React, { useEffect, useState } from 'react';
import { SignIn, SignUp, useAuth } from '@clerk/react';
import { useApp } from './store';

/** True when a Clerk publishable key is configured (VITE_CLERK_PUBLISHABLE_KEY). */
export function clerkConfigured(): boolean {
  return !!(import.meta as any).env?.VITE_CLERK_PUBLISHABLE_KEY;
}

/**
 * Clerk phone sign-in / sign-up gate. Renders Clerk's prebuilt <SignIn>/<SignUp>
 * (phone OTP works once enabled in the Clerk dashboard). On success we pull the
 * short-lived session token and hand it to the app's auth, which sends it as the
 * Bearer token the worker verifies against Clerk's JWKS.
 */
function ClerkInner() {
  const { isSignedIn, getToken } = useAuth();
  const { signIn, lang } = useApp();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const token = await getToken();
        if (token && !cancelled) await signIn(token, '');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isSignedIn, getToken, signIn]);

  const appearance = {
    variables: { colorPrimary: '#5491e0' },
    elements: {
      rootBox: 'mx-auto w-full max-w-[380px]',
      card: 'bg-white/10 backdrop-blur-xl border border-white/25 rounded-[24px] text-white',
      headerTitle: 'text-white text-xl font-bold',
      headerSubtitle: 'text-white/70',
      formFieldLabel: 'text-white/80',
      formFieldInput: 'bg-white/10 border-white/30 text-white rounded-xl',
      footerButton: 'text-white/80',
      formButtonPrimary: 'bg-white text-brand-deep rounded-full font-bold',
      socialButtonsBlockButton: 'bg-white/10 border-white/25 text-white rounded-full',
      dividerLine: 'bg-white/20',
      dividerText: 'text-white/60',
      formFieldSuccessText: 'text-emerald-200',
      formFieldErrorText: 'text-red-200',
      alertText: 'text-red-200',
    },
  } as any;

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/30 bg-white/15 text-xl font-black">M</div>
            <div className="font-extrabold">Miirra Pay</div>
          </div>
          <div className="flex gap-1 rounded-full border border-white/25 bg-white/10 p-1">
            <button onClick={() => setMode('in')} className={`rounded-full px-3 py-1 text-[12px] font-semibold ${mode === 'in' ? 'bg-white text-brand-deep' : 'text-white/80'}`}>{lang === 'ar' ? 'دخول' : 'Sign in'}</button>
            <button onClick={() => setMode('up')} className={`rounded-full px-3 py-1 text-[12px] font-semibold ${mode === 'up' ? 'bg-white text-brand-deep' : 'text-white/80'}`}>{lang === 'ar' ? 'حساب' : 'Sign up'}</button>
          </div>
        </div>

        {mode === 'in'
          ? <SignIn routing="hash" appearance={appearance} fallbackRedirectUrl="/" />
          : <SignUp routing="hash" appearance={appearance} fallbackRedirectUrl="/" />}

        {busy && <div className="mt-3 text-center text-[13px] text-white/70">{lang === 'ar' ? 'جارٍ فتح المحفظة…' : 'Opening your wallet…'}</div>}
        <div className="mt-4 text-center text-[11px] text-white/50">
          {lang === 'ar' ? 'الدخول برقم الهاتف · رمز تحقق' : 'Phone number · one-time code'}
        </div>
      </div>
    </div>
  );
}

export function ClerkGate() {
  return <ClerkInner />;
}