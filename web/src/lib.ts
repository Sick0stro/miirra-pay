// Shared library: types, money (LYD), API client, and i18n (EN/AR).
// Money convention matches the worker: 1 LYD = 100 minor units (2 dp).

export type Lang = 'en' | 'ar';

// ── money ──────────────────────────────────────────────────────────────────
export const MINOR_PER_LYD = 100;
export const FACE_VERIFY_LYD = 1000; // > this → native biometric

export function toMinor(lyd: number): number {
  return Math.round(lyd * MINOR_PER_LYD);
}
export function fromMinor(minor: number): number {
  return minor / MINOR_PER_LYD;
}
/** 12.5 → "12.50"; 1250 → "1,250.00" */
export function fmt(lyd: number): string {
  const neg = lyd < 0;
  const s = Math.abs(lyd).toFixed(2);
  const [w, f] = s.split('.');
  const withCommas = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withCommas + '.' + f;
}
export function fmtMinor(minor: number): string {
  return fmt(fromMinor(minor));
}

// ── API types ────────────────────────────────────────────────────────────────
export interface Balance {
  currency: string;
  availableMinor: number;
  pendingMinor: number;
  source: 'tigerbeetle' | 'database_projection';
  mismatch: boolean | null;
}
export interface Rail {
  id: string;
  label: string;
  status: 'integrated' | 'coming_soon' | 'disabled';
  note?: string;
}
export interface Activity {
  id: string;
  kind: string;
  direction: 'in' | 'out';
  amountMinor: number;
  feeMinor: number;
  status: string;
  pending: boolean;
  counterparty: { userId: string; name: string } | null;
  reference: string;
  createdAt: number;
}
export interface Contact {
  userId: string;
  name: string;
  handle: string;
}

// ── API client ───────────────────────────────────────────────────────────────
const TOKEN_KEY = 'mp_token';
const DEV_KEY = 'mp_devuser';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function getDevUser(): string {
  return localStorage.getItem(DEV_KEY) || '';
}
export function setAuth(token: string, devUser: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  if (devUser) localStorage.setItem(DEV_KEY, devUser);
  else localStorage.removeItem(DEV_KEY);
}
export function isAuthed(): boolean {
  return !!(getToken() || getDevUser());
}
function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const t = getToken();
  if (t) h['authorization'] = 'Bearer ' + t;
  else if (getDevUser()) h['x-dev-user'] = getDevUser();
  return h;
}

export class ApiError extends Error {
  code?: string;
  status: number;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j as any)?.error;
    throw new ApiError(r.status, e?.code, e?.message || 'Something went wrong');
  }
  return j as T;
}

export const api = {
  me: () => req<{ id: string; name: string | null; email: string | null }>('GET', '/v1/me'),
  balance: () => req<Balance>('GET', '/api/wallets/balance'),
  activity: (limit = 50) => req<{ activity: Activity[] }>('GET', `/api/wallets/activity?limit=${limit}`),
  rails: () => req<{ rails: Rail[] }>('GET', '/api/topups/rails'),
  transfer: (p: { idempotencyKey: string; receiver: { userId?: string; raw?: string }; amountMinor: number; note?: string }) =>
    req<{ id: string; status: string; amountMinor: number }>('POST', '/api/wallets/transfer', { tier: 'EDD', diditSessionId: 'dev-biometric-approved', ...p }),
  topup: (p: { idempotencyKey: string; amountMinor: number; rail: string }) =>
    req<{ id: string; depositReference?: string }>('POST', '/api/topups/initiate', { tier: 'EDD', ...p }),
  withdraw: (p: {
    idempotencyKey: string;
    amountMinor: number;
    debtorAccount: { schemeName: string; identification: string; name: string };
    creditorInstitution: { name: string; code: string };
    description: string;
  }) => req<{ id: string; status: string }>('POST', '/api/withdrawals/initiate', { tier: 'EDD', diditSessionId: 'dev-biometric-approved', ...p }),
};

export function newIdem(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── i18n ─────────────────────────────────────────────────────────────────────
type Dict = Record<string, { en: string; ar: string }>;
export const STR: Dict = {
  card: { en: 'Card', ar: 'البطاقة' },
  pay: { en: 'Pay', ar: 'ادفع' },
  activity: { en: 'Activity', ar: 'النشاط' },
  manage: { en: 'Manage', ar: 'إدارة' },
  received: { en: 'Received', ar: 'مستلم' },
  sent: { en: 'Sent', ar: 'مرسل' },
  available: { en: 'Available', ar: 'المتاح' },
  pending: { en: 'Pending', ar: 'قيد الانتظار' },
  addCash: { en: 'Add cash', ar: 'إضافة رصيد' },
  cashOut: { en: 'Cash out', ar: 'سحب' },
  freeze: { en: 'Freeze', ar: 'تجميد' },
  unfreeze: { en: 'Unfreeze', ar: 'إلغاء التجميد' },
  frozen: { en: 'Frozen', ar: 'مجمدة' },
  tapToFlip: { en: 'Tap to flip', ar: 'اضغط للقلب' },
  standard: { en: 'Miirra Standard', ar: 'ميرا الأساسية' },
  plus: { en: 'Miirra+', ar: 'ميرا بلس' },
  max: { en: 'Miirra Max', ar: 'ميرا ماكس' },
  perMonth: { en: '/mo', ar: '/شهرياً' },
  free: { en: 'Free', ar: 'مجاني' },
  needMore: { en: 'Need more? View Miirra Max', ar: 'تحتاج المزيد؟ عرض ميرا ماكس' },
  topUp: { en: 'Top up', ar: 'شحن الرصيد' },
  bankTransfer: { en: 'Bank transfer', ar: 'تحويل بنكي' },
  lypayInstant: { en: 'LYPay Instant', ar: 'LYPay فوري' },
  fromUser: { en: 'From another Miirra user', ar: 'من مستخدم ميرا آخر' },
  copyIban: { en: 'Copy IBAN', ar: 'نسخ الآيبان' },
  depositQr: { en: 'Deposit QR', ar: 'رمز الإيداع' },
  scanIban: { en: 'Scan IBAN', ar: 'مسح الآيبان' },
  scanIbanCamera: { en: 'Scan IBAN with camera', ar: 'مسح الآيبان بالكاميرا' },
  copied: { en: 'Copied', ar: 'تم النسخ' },
  withdraw: { en: 'Withdraw', ar: 'سحب' },
  sameAccount: { en: 'Same account as top-up', ar: 'نفس حساب الشحن' },
  typeIban: { en: 'Type your IBAN to confirm', ar: 'اكتب الآيبان للتأكيد' },
  ibanMismatch: { en: 'IBAN does not match your registered account', ar: 'الآيبان لا يطابق حسابك المسجل' },
  amount: { en: 'Amount', ar: 'المبلغ' },
  request: { en: 'Request', ar: 'اطلب' },
  qr: { en: 'QR', ar: 'QR' },
  payNow: { en: 'Pay', ar: 'ادفع' },
  scanQr: { en: 'Scan QR', ar: 'مسح QR' },
  myQr: { en: 'My QR', ar: 'رمزي' },
  recipient: { en: 'Recipient', ar: 'المستلم' },
  note: { en: 'Note', ar: 'ملاحظة' },
  search: { en: 'Search name, @handle, phone', ar: 'ابحث بالاسم أو @المعرّف أو الهاتف' },
  slideToPay: { en: 'Slide to pay', ar: 'اسحب للدفع' },
  swipeHint: { en: 'Swipe right to confirm', ar: 'اسحب لليمين للتأكيد' },
  review: { en: 'Review', ar: 'مراجعة' },
  fee: { en: 'Fee', ar: 'الرسوم' },
  total: { en: 'Total', ar: 'الإجمالي' },
  confirm: { en: 'Confirm', ar: 'تأكيد' },
  cancel: { en: 'Cancel', ar: 'إلغاء' },
  verifyFace: { en: 'Verify with Face / Biometrics', ar: 'تحقق بالوجه / البصمة' },
  verifySub: { en: 'Confirm this payment securely', ar: 'أكد هذه العملية بأمان' },
  faceTitle: { en: 'Face verification', ar: 'التحقق بالوجه' },
  done: { en: 'Done', ar: 'تم' },
  success: { en: 'Payment sent', ar: 'تم الإرسال' },
  queued: { en: 'Queued on Mesh', ar: 'في قائمة ميش' },
  all: { en: 'All', ar: 'الكل' },
  cardTaps: { en: 'Card taps', ar: 'مسح البطاقة' },
  transfers: { en: 'Transfers', ar: 'التحويلات' },
  requests: { en: 'Requests', ar: 'الطلبات' },
  meshOnline: { en: 'Mesh online', ar: 'ميش متصل' },
  meshOffline: { en: 'Mesh offline', ar: 'ميش غير متصل' },
  receipt: { en: 'Receipt', ar: 'الإيصال' },
  share: { en: 'Share', ar: 'مشاركة' },
  close: { en: 'Close', ar: 'إغلاق' },
  checkout: { en: 'Checkout', ar: 'الدفع' },
  payOrder: { en: 'Pay order', ar: 'ادفع الطلب' },
  signIn: { en: 'Sign in', ar: 'تسجيل الدخول' },
  devUser: { en: 'Dev user id', ar: 'معرّف مستخدم التطوير' },
  token: { en: 'Session token', ar: 'رمز الجلسة' },
  openWallet: { en: 'Open wallet', ar: 'فتح المحفظة' },
  gateSub: { en: 'Sign in to open your LYD wallet.', ar: 'سجّل الدخول لفتح محفظتك بالدينار الليبي.' },
  noActivity: { en: 'No activity yet', ar: 'لا يوجد نشاط بعد' },
  today: { en: 'Today', ar: 'اليوم' },
};

export function makeT(lang: Lang) {
  return (k: string): string => STR[k]?.[lang] ?? STR[k]?.en ?? k;
}