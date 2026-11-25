import React, { useEffect, useState } from 'react';
import { SignIn, SignUp, useAuth } from '@clerk/react';
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

/**
 * Clerk phone sign-in / sign-up. No app header — Clerk's component already
 * renders the branding, the sign-in/sign-up switch, and the phone-OTP flow.
 * We only host it and forward the session token to the app's auth.
 */
function ClerkInner() {
  const { isSignedIn, getToken } = useAuth();
  const { signIn } = useApp();
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (token && !cancelled) await signIn(token, '');
      } catch {
        /* token refresh will retry on next render */
      }
    })();
    return () => { cancelled = true; };
  }, [isSignedIn, getToken, signIn]);

  const isSignUp = hash.includes('sign-up');

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      {isSignUp
        ? <SignUp routing="hash" signInUrl="#/sign-in" fallbackRedirectUrl="/" appearance={appearance} />
        : <SignIn routing="hash" signUpUrl="#/sign-up" fallbackRedirectUrl="/" appearance={appearance} />}
    </div>
  );
}

export function ClerkGate() {
  return <ClerkInner />;
}