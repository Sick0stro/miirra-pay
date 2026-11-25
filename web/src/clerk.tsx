import React, { useEffect, useState } from 'react';
import { SignIn, SignUp, CreateOrganization, useAuth, useOrganization } from '@clerk/react';
import { useApp } from './store';

/** True when a Clerk publishable key is configured (VITE_CLERK_PUBLISHABLE_KEY). */
export function clerkConfigured(): boolean {
  return !!(import.meta as any).env?.VITE_CLERK_PUBLISHABLE_KEY;
}

const appearance = {
  variables: { colorPrimary: '#5491e0' },
  elements: {
    rootBox: 'mx-auto w-full max-w-[400px]',
    card: 'bg-white/10 backdrop-blur-xl border border-white/25 rounded-[24px] text-white shadow-2xl',
    headerTitle: 'text-white text-xl font-bold',
    headerSubtitle: 'text-white/70',
    formFieldLabel: 'text-white/80',
    formFieldInput: 'bg-white/10 border-white/30 text-white rounded-xl',
    formButtonPrimary: 'bg-white text-brand-deep rounded-full font-bold',
    socialButtonsBlockButton: 'bg-white/10 border-white/25 text-white rounded-full',
    footer: 'bg-transparent',
    footerAction: 'text-white/80',
    footerActionText: 'text-white/70',
    dividerLine: 'bg-white/20',
    dividerText: 'text-white/60',
    formFieldSuccessText: 'text-emerald-200',
    formFieldErrorText: 'text-red-200',
    alertText: 'text-red-200',
    identityPreviewText: 'text-white/80',
    formFieldInputShowPasswordButton: 'text-white/70',
  },
} as any;

type Acct = 'individual' | 'organization';
type View = 'choose' | 'signup' | 'signin';

/**
 * Clerk auth with an explicit account-type choice:
 *   Individual  → personal Clerk <SignUp>
 *   Organization→ <SignUp> then <CreateOrganization>
 * The app header is intentionally absent — Clerk renders its own branding.
 */
function ClerkInner() {
  const { isSignedIn, getToken } = useAuth();
  const { organization } = useOrganization();
  const { signIn, lang } = useApp();
  const [view, setView] = useState<View>('choose');
  const [acct, setAcct] = useState<Acct | null>(null);

  // Signed in → create the org first if that was the choice, else hand the
  // session token to the app.
  useEffect(() => {
    if (!isSignedIn) return;
    if (acct === 'organization' && !organization) return; // CreateOrganization renders below
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (token && !cancelled) await signIn(token, '');
      } catch { /* retry next render */ }
    })();
    return () => { cancelled = true; };
  }, [isSignedIn, organization, acct, getToken, signIn]);

  if (isSignedIn) {
    if (acct === 'organization' && !organization) {
      return (
        <div className="flex min-h-full items-center justify-center px-6 py-10">
          <CreateOrganization routing="hash" afterCreateOrganizationUrl="/" appearance={appearance} />
        </div>
      );
    }
    return <Splash />;
  }

  const ar = lang === 'ar';

  if (view === 'signin') {
    return (
      <Shell onBack={() => setView('choose')}>
        <SignIn routing="hash" signUpUrl="#/sign-up" fallbackRedirectUrl="/" appearance={appearance} />
      </Shell>
    );
  }

  if (view === 'signup' && acct) {
    return (
      <Shell onBack={() => setView('choose')}>
        <div className="mb-3 flex items-center justify-center gap-2 text-[12px] font-semibold text-white/70">
          <span className="rounded-full bg-white/15 px-3 py-1">{acct === 'organization' ? (ar ? 'منظمة' : 'Organization') : (ar ? 'فرد' : 'Individual')}</span>
        </div>
        <SignUp routing="hash" signInUrl="#/sign-in" fallbackRedirectUrl="/" appearance={appearance} />
      </Shell>
    );
  }

  // Chooser
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-white/30 bg-white/15 text-2xl font-black">M</div>
          <h1 className="text-2xl font-extrabold">{ar ? 'إنشاء حساب ميرا باي' : 'Create your Miirra Pay account'}</h1>
          <p className="mt-1 text-[13px] text-white/70">{ar ? 'اختر نوع الحساب للمتابعة' : 'Choose an account type to continue'}</p>
        </div>

        <div className="space-y-3">
          <button onClick={() => { setAcct('individual'); setView('signup'); }}
            className="flex w-full items-center gap-4 rounded-2xl glass p-5 text-start active:bg-white/20">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/20 text-2xl">👤</div>
            <div className="flex-1">
              <div className="text-[16px] font-bold">{ar ? 'حساب فردي' : 'Individual'}</div>
              <div className="text-[12px] text-white/70">{ar ? 'للأشخاص والعملاء الشخصيين' : 'For people — everyday wallet & payments'}</div>
            </div>
            <span className="text-white/60">›</span>
          </button>

          <button onClick={() => { setAcct('organization'); setView('signup'); }}
            className="flex w-full items-center gap-4 rounded-2xl glass p-5 text-start active:bg-white/20">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/20 text-2xl">🏢</div>
            <div className="flex-1">
              <div className="text-[16px] font-bold">{ar ? 'حساب منظمة' : 'Organization'}</div>
              <div className="text-[12px] text-white/70">{ar ? 'للشركات والأعمال والمتاجر' : 'For businesses, shops & merchants'}</div>
            </div>
            <span className="text-white/60">›</span>
          </button>
        </div>

        <div className="mt-6 text-center text-[13px] text-white/70">
          {ar ? 'لديك حساب بالفعل؟' : 'Already have an account?'}{' '}
          <button onClick={() => setView('signin')} className="font-bold text-white underline">{ar ? 'تسجيل الدخول' : 'Sign in'}</button>
        </div>
      </div>
    </div>
  );
}

function Shell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[400px]">
        <button onClick={onBack} className="mb-3 text-[12px] font-semibold text-white/70">‹ {''}</button>
        {children}
      </div>
    </div>
  );
}
function Splash() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="h-10 w-10 spin rounded-full border-2 border-white/30 border-t-white" />
    </div>
  );
}

export function ClerkGate() {
  return <ClerkInner />;
}