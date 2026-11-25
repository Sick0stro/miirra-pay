import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, isAuthed, setAuth, toMinor, FACE_VERIFY_LYD, newIdem,
  type Balance, type Activity, type Rail, type Contact, type Lang,
} from './lib';

export type Tab = 'card' | 'pay' | 'activity';
export type Route =
  | 'home' | 'topup' | 'scanIban' | 'manageCard' | 'keypad'
  | 'scanQr' | 'recipient' | 'review' | 'biometric' | 'confirm'
  | 'receipt' | 'checkout' | 'withdraw';

export type FlowStep = 'idle' | 'review' | 'biometric' | 'settling' | 'done';
export interface Flow {
  step: FlowStep;
  amountMinor: number;
  recipient: Contact | { userId?: string; raw?: string; name: string };
  note: string;
  source: 'keypad' | 'qr' | 'checkout' | 'withdraw' | 'request';
  txId?: string;
  error?: string;
}

// Demo contacts (the seeded test accounts). A real build would fetch these.
export const CONTACTS: Contact[] = [
  { userId: 'test-alice', name: 'Alice', handle: '@alice' },
  { userId: 'test-bob', name: 'Bob', handle: '@bob' },
  { userId: 'test-carol', name: 'Carol', handle: '@carol' },
  { userId: 'test-dina', name: 'Dina', handle: '@dina' },
];

interface AppState {
  lang: Lang;
  setLang: (l: Lang) => void;
  authed: boolean;
  signIn: (token: string, devUser: string) => Promise<void>;
  signOut: () => void;

  balance: Balance | null;
  activity: Activity[];
  rails: Rail[];
  loading: boolean;
  refresh: () => Promise<void>;

  tab: Tab;
  setTab: (t: Tab) => void;
  route: Route;
  go: (r: Route) => void;
  back: () => void;

  cardTier: 'standard' | 'plus' | 'max';
  setCardTier: (t: 'standard' | 'plus' | 'max') => void;
  frozen: boolean;
  setFrozen: (b: boolean) => void;

  // Registered bank account (bound on first bank top-up; withdrawals must match).
  linkedIban: string | null;
  setLinkedIban: (iban: string | null) => void;

  flow: Flow;
  initiatePayment: (p: { amountMinor: number; recipient: Flow['recipient']; note?: string; source: Flow['source'] }) => void;
  completeSwipe: () => void;
  confirmBiometric: () => void;
  cancelFlow: () => void;
  lastReceipt: Flow | null;
  openReceipt: (f: Flow) => void;

  toast: string | null;
  showToast: (msg: string) => void;

  // A pending amount carried from the keypad/QR into the recipient picker.
  draftAmountMinor: number;
  setDraftAmountMinor: (n: number) => void;
}

const Ctx = createContext<AppState | null>(null);

const EMPTY_FLOW: Flow = { step: 'idle', amountMinor: 0, recipient: { name: '' }, note: '', source: 'keypad' };

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem('mp_lang') as Lang) || 'en');
  const [authed, setAuthed] = useState(isAuthed());
  const [balance, setBalance] = useState<Balance | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [rails, setRails] = useState<Rail[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('card');
  const [route, setRoute] = useState<Route>('home');
  const [cardTier, setCardTier] = useState<'standard' | 'plus' | 'max'>('standard');
  const [frozen, setFrozen] = useState(false);
  const [linkedIban, setLinkedIbanState] = useState<string | null>(localStorage.getItem('mp_linked_iban'));
  const [flow, setFlow] = useState<Flow>(EMPTY_FLOW);
  const [lastReceipt, setLastReceipt] = useState<Flow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draftAmountMinor, setDraftAmountMinor] = useState(0);
  const toastTimer = useRef<number | undefined>(undefined);

  const setLang = (l: Lang) => { setLangState(l); localStorage.setItem('mp_lang', l); };
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const refresh = useCallback(async () => {
    if (!isAuthed()) return;
    setLoading(true);
    try {
      const [b, a] = await Promise.all([api.balance(), api.activity(50)]);
      setBalance(b);
      setActivity(a.activity || []);
    } catch (e) {
      // 401/403 → drop back to the gate.
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { api.rails().then((r) => setRails(r.rails || [])).catch(() => {}); }, []);
  useEffect(() => { if (authed) refresh(); }, [authed, refresh]);

  const signIn = async (token: string, devUser: string) => {
    setAuth(token, devUser);
    await api.me(); // throws on bad creds
    setAuthed(true);
  };
  const signOut = () => { setAuth('', ''); setAuthed(false); setBalance(null); setActivity([]); };

  const go = (r: Route) => setRoute(r);
  const back = () => setRoute((r) => (r === 'home' ? r : 'home'));

  const setLinkedIban = (iban: string | null) => {
    setLinkedIbanState(iban);
    if (iban) localStorage.setItem('mp_linked_iban', iban);
    else localStorage.removeItem('mp_linked_iban');
  };

  // ── The ONE payment state machine every path runs through ──────────────────
  const initiatePayment: AppState['initiatePayment'] = useCallback((p) => {
    setFlow({ step: 'review', amountMinor: p.amountMinor, recipient: p.recipient, note: p.note || '', source: p.source });
    setRoute('review');
  }, []);

  const settle = useCallback(async (f: Flow) => {
    setFlow({ ...f, step: 'settling' });
    try {
      let txId: string;
      if (f.source === 'withdraw') {
        const r = await api.withdraw({
          idempotencyKey: newIdem('wd'),
          amountMinor: f.amountMinor,
          debtorAccount: { schemeName: 'iban', identification: (f.recipient as any).raw || '', name: 'Wallet' },
          creditorInstitution: { name: 'Bank', code: '000' },
          description: f.note || 'Wallet withdrawal',
        });
        txId = r.id;
      } else {
        const r = await api.transfer({
          idempotencyKey: newIdem('pay'),
          receiver: 'userId' in f.recipient && (f.recipient as any).userId
            ? { userId: (f.recipient as any).userId }
            : { raw: (f.recipient as any).raw },
          amountMinor: f.amountMinor,
          note: f.note || undefined,
        });
        txId = r.id;
      }
      setFlow({ ...f, step: 'done', txId });
      setLastReceipt({ ...f, step: 'done', txId });
      setRoute('confirm');
      refresh();
    } catch (e: any) {
      setFlow({ ...f, step: 'review', error: e?.message || 'Payment failed' });
      showToast(e?.message || 'Payment failed');
    }
  }, [refresh, showToast]);

  const completeSwipe = useCallback(() => {
    setFlow((f) => {
      if (f.amountMinor > FACE_VERIFY_LYD * 100) {
        setRoute('biometric');
        return { ...f, step: 'biometric' };
      }
      void settle(f);
      return f;
    });
  }, [settle]);

  const confirmBiometric = useCallback(() => { setFlow((f) => { void settle(f); return f; }); }, [settle]);
  const cancelFlow = useCallback(() => { setFlow(EMPTY_FLOW); setRoute('home'); }, []);
  const openReceipt = useCallback((f: Flow) => { setLastReceipt(f); setRoute('receipt'); }, []);

  const value = useMemo<AppState>(() => ({
    lang, setLang, authed, signIn, signOut,
    balance, activity, rails, loading, refresh,
    tab, setTab, route, go, back,
    cardTier, setCardTier, frozen, setFrozen,
    linkedIban, setLinkedIban,
    flow, initiatePayment, completeSwipe, confirmBiometric, cancelFlow, lastReceipt, openReceipt,
    toast, showToast,
    draftAmountMinor, setDraftAmountMinor,
  }), [lang, authed, balance, activity, rails, loading, tab, route, cardTier, frozen, linkedIban, flow, lastReceipt, toast, draftAmountMinor]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}