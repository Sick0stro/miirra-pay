/**
 * Miirra Pay ledger service — the high-level double-entry operations.
 *
 * This is the layer the Worker's route handlers call. It speaks "payments"
 * (principal, commission, fee, refundable amount) and translates them into
 * TigerBeetle's two-phase transfer choreography:
 *
 *   createPendingSplitChain  → one PENDING debit + N PENDING credits as a
 *                              `linked` chain, so a P2P/P2M/M2M initiation is
 *                              durably reserved before LYPay confirms.
 *   postPendingTransfers     → convert those pending legs to posted (success).
 *   voidPendingTransfers     → release the pending legs (decline/fail/expire).
 *   createPostedRefund       → a brand-new POSTED two-leg transfer moving funds
 *                              back, guarded by the refundable-amount invariant.
 *   postTopUpCredit          → POSTED PLATFORM_CLEARING → USER_ACCOUNT once an
 *                              inbound credit is matched to a deposit reference.
 *
 * The linked-chain rule (final leg omits `linked`) is what makes a split atomic:
 * TigerBeetle commits the whole chain or none of it, so you can never post the
 * principal and lose the commission.
 */

import type { LedgerClient, TbAccount, TbTransfer } from './ledger';
import {
  AccountFlags,
  LEDGER_LYD,
  SYSTEM,
  TransferFlags,
  accountIdFor,
  idStr,
  transferIdFor,
} from './ledger-codes';

/** A single leg of a split: who pays, who receives, how much (minor units). */
export type SplitLeg = {
  /** Platform id of the account to credit (a user or a merchant), or a system sentinel. */
  creditTo: { kind: 'user' | 'merchant'; id: string } | { kind: 'system'; id: bigint };
  /** Minor-unit amount for THIS leg. */
  amount: bigint;
  /** Ledger code for the leg (principal / commission / fee / etc.). */
  code: number;
};

/**
 * Ledger account codes. The ledger (1 = LYD) plus a per-purpose code keeps the
 * TigerBeetle statements readable: a query can isolate commission transfers from
 * principal by `code`.
 */
export const LedgerCode = {
  /** A user's personal wallet account. */
  USER_WALLET: 1,
  /** A merchant's settlement account. */
  MERCHANT_SETTLEMENT: 2,
  PLATFORM_CLEARING: 10,
  PLATFORM_REVENUE: 11,
  REFUND_SUSPENSE: 12,
  WITHDRAWAL_CLEARING: 13,
  SETTLEMENT_AGGREGATION: 14,
  CUSTOMER_SUB_AGGREGATION: 15,
  COMPANY_OPERATING: 16,
  /** Transfer codes. */
  TX_PRINCIPAL: 1000,
  TX_COMMISSION: 1001,
  TX_FEE: 1002,
  /** Wallet-to-wallet transfer legs. */
  TX_WALLET_PRINCIPAL: 1100,
  TX_WALLET_FEE: 1101,
  TX_WITHDRAWAL: 1200,
  TX_TOPUP: 2000,
  TX_REFUND: 3000,
  TX_REFUND_FEE_REVERSAL: 3001,
} as const;

/** Resolve a credit target to its TigerBeetle account id. */
export function resolveAccountId(
  target: SplitLeg['creditTo'] | { kind: 'user' | 'merchant'; id: string },
): bigint {
  if (target.kind === 'system') return target.id;
  return accountIdFor(target.kind, target.id);
}

/** True when the TigerBeetle item result represents success (null error or benign replay). */
export function isOk(r: { error: string | null } | undefined): boolean {
  if (!r) return false;
  return r.error === null || r.error === 'exists';
}

export class LedgerService {
  private pendingTimeoutNs: bigint;

  constructor(
    private tb: LedgerClient,
    opts?: { pendingTimeoutSeconds?: number },
  ) {
    // TigerBeetle pending transfers can carry a timeout (ns since epoch) after
    // which they auto-expire. Configurable so a deployment can bound how long a
    // reservation may sit between initiate and confirm.
    const secs = opts?.pendingTimeoutSeconds ?? 0;
    this.pendingTimeoutNs = secs > 0 ? pendingTimeoutNsFromNow(secs) : 0n;
  }

  /**
   * Ensure a user/merchant account exists. Idempotent: TigerBeetle rejects a
   * duplicate id with `exists`, which we treat as "already provisioned". A
   * DIFFERENT real error (e.g. linked_components_must_be_set) throws.
   */
  async ensureAccount(kind: 'user' | 'merchant', platformId: string): Promise<bigint> {
    const id = accountIdFor(kind, platformId);
    const code = kind === 'user' ? LedgerCode.USER_WALLET : LedgerCode.MERCHANT_SETTLEMENT;
    const account: TbAccount = {
      id,
      ledger: LEDGER_LYD,
      code,
      flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.credits_must_not_exceed_debits | AccountFlags.history,
      userData128: null,
      userData64: null,
    };
    await this.tb.createAccounts([account]);
    return id;
  }

  /** Ensure the fixed institutional (system) accounts exist. */
  async ensureSystemAccounts(): Promise<void> {
    const defs: Array<{ id: bigint; code: number }> = [
      { id: SYSTEM.PLATFORM_CLEARING, code: LedgerCode.PLATFORM_CLEARING },
      { id: SYSTEM.PLATFORM_REVENUE, code: LedgerCode.PLATFORM_REVENUE },
      { id: SYSTEM.REFUND_SUSPENSE, code: LedgerCode.REFUND_SUSPENSE },
      { id: SYSTEM.WITHDRAWAL_CLEARING, code: LedgerCode.WITHDRAWAL_CLEARING },
      { id: SYSTEM.SETTLEMENT_AGGREGATION, code: LedgerCode.SETTLEMENT_AGGREGATION },
      { id: SYSTEM.CUSTOMER_SUB_AGGREGATION, code: LedgerCode.CUSTOMER_SUB_AGGREGATION },
      { id: SYSTEM.COMPANY_OPERATING, code: LedgerCode.COMPANY_OPERATING },
    ];
    await this.tb.createAccounts(
      defs.map((d) => ({
        id: d.id,
        ledger: LEDGER_LYD,
        code: d.code,
        flags: AccountFlags.history,
        userData128: null,
        userData64: null,
      })),
    );
  }

  /**
   * Create a pending split chain: debit the payer's account by the total, credit
   * each split leg. All legs are PENDING and `linked` (except the final leg) so
   * the whole reservation commits atomically or not at all.
   *
   * `debitFrom` is the payer's TigerBeetle account id (already ensured).
   * `legs` are the credits to make. The SUM of leg amounts is the debit amount.
   *
   * Returns the transfer ids so a later post/void can target them.
   */
  async createPendingSplitChain(params: {
    transactionId: string;
    debitFrom: bigint;
    legs: SplitLeg[];
  }): Promise<{ ids: bigint[]; total: bigint }> {
    const { transfers, ids, total } = this.buildPendingSplitChain(params);
    const results = await this.tb.createTransfers(transfers);
    const failed = results.find((r) => !isOk(r));
    if (failed) {
      throw new Error(`pending split chain failed at index ${failed.index}: ${failed.error}`);
    }
    return { ids, total };
  }

  /**
   * Same as createPendingSplitChain, but also returns the fully-typed transfer
   * objects. The route persists these (with full debit/credit routing) so a
   * later post/void in a different isolate replays the EXACT same TigerBeetle
   * transfers rather than reconstructing them lossily.
   */
  async createPendingSplitChainDetailed(params: {
    transactionId: string;
    debitFrom: bigint;
    legs: SplitLeg[];
  }): Promise<{ ids: bigint[]; total: bigint; transfers: TbTransfer[] }> {
    const { transfers, ids, total } = this.buildPendingSplitChain(params);
    const results = await this.tb.createTransfers(transfers);
    const failed = results.find((r) => !isOk(r));
    if (failed) {
      throw new Error(`pending split chain failed at index ${failed.index}: ${failed.error}`);
    }
    return { ids, total, transfers };
  }

  private buildPendingSplitChain(params: {
    transactionId: string;
    debitFrom: bigint;
    legs: SplitLeg[];
  }): { transfers: TbTransfer[]; ids: bigint[]; total: bigint } {
    const { transactionId, debitFrom, legs } = params;
    if (legs.length === 0) throw new Error('split chain needs at least one leg');
    const total = legs.reduce((s, l) => s + l.amount, 0n);

    const transfers: TbTransfer[] = [];
    const ids: bigint[] = [];

    // The debit leg: payer → PLATFORM_CLEARING, pending. Head of the chain, so
    // it carries `linked` too (every leg but the last does).
    const debitId = transferIdFor(transactionId, 'debit');
    ids.push(debitId);
    transfers.push({
      id: debitId,
      debit_account_id: debitFrom,
      credit_account_id: SYSTEM.PLATFORM_CLEARING,
      amount: total,
      flags: TransferFlags.pending | TransferFlags.linked,
      ledger: LEDGER_LYD,
      code: LedgerCode.TX_PRINCIPAL,
      // Bound the reservation: if confirm never arrives, the pending auto-expires.
      timeout_date: this.pendingTimeoutNs,
    });

    // The credit legs: PLATFORM_CLEARING → each destination, pending.
    legs.forEach((leg, i) => {
      const isLast = i === legs.length - 1;
      const legId = transferIdFor(transactionId, `credit:${i}`);
      ids.push(legId);
      transfers.push({
        id: legId,
        debit_account_id: SYSTEM.PLATFORM_CLEARING,
        credit_account_id: resolveAccountId(leg.creditTo),
        amount: leg.amount,
        // Final leg omits `linked` — that is what closes the chain.
        flags: isLast ? TransferFlags.pending : TransferFlags.pending | TransferFlags.linked,
        ledger: LEDGER_LYD,
        code: leg.code,
        timeout_date: this.pendingTimeoutNs,
      });
    });

    return { transfers, ids, total };
  }

  /**
   * Post a set of pending transfers — converts pending reserves into posted
   * balances. Each post leg references the pending transfer id it settles.
   * Idempotent by transfer id.
   *
   * For a linked chain, the post legs are themselves a linked chain (each post
   * leg carries `linked` except the last), so posting is atomic too.
   *
   * SAFE ON RETRY: a re-delivered post returns `exists` /
   * `pending_transfer_not_pending` / `pending_transfer_expired` per leg — all of
   * which mean "already settled". Use `allSettled(results)` to treat those as
   * success and `realFailures(results)` to surface a genuine error.
   */
  async postPendingTransfers(params: {
    transactionId: string;
    pendingTransfers: TbTransfer[];
  }): Promise<TbItemResultAlias[]> {
    const { transactionId, pendingTransfers } = params;
    const posts: TbTransfer[] = [];
    pendingTransfers.forEach((orig, i) => {
      const isLast = i === pendingTransfers.length - 1;
      const postId = transferIdFor(transactionId, `post:${idStr(orig.id)}`);
      posts.push({
        id: postId,
        debit_account_id: orig.debit_account_id,
        credit_account_id: orig.credit_account_id,
        amount: orig.amount,
        pending_id: orig.id,
        flags: TransferFlags.post_pending_transfer | (isLast ? 0 : TransferFlags.linked),
        ledger: LEDGER_LYD,
        code: orig.code,
      });
    });
    return this.tb.createTransfers(posts);
  }

  /**
   * Void a set of pending transfers — releases the reservations without moving
   * posted balances. Linked-chain semantics apply just like posting.
   *
   * SAFE ON RETRY: like posting, an already-voided/expired/posted pending yields
   * `exists` / `pending_transfer_not_pending` / `pending_transfer_expired`, which
   * `allSettled(results)` treats as success.
   */
  async voidPendingTransfers(params: {
    transactionId: string;
    pendingTransfers: TbTransfer[];
  }): Promise<TbItemResultAlias[]> {
    const { transactionId, pendingTransfers } = params;
    const voids: TbTransfer[] = [];
    pendingTransfers.forEach((orig, i) => {
      const isLast = i === pendingTransfers.length - 1;
      const voidId = transferIdFor(transactionId, `void:${idStr(orig.id)}`);
      voids.push({
        id: voidId,
        debit_account_id: orig.debit_account_id,
        credit_account_id: orig.credit_account_id,
        amount: orig.amount,
        pending_id: orig.id,
        flags: TransferFlags.void_pending_transfer | (isLast ? 0 : TransferFlags.linked),
        ledger: LEDGER_LYD,
        code: orig.code,
      });
    });
    return this.tb.createTransfers(voids);
  }

  /**
   * Create a POSTED refund: move `amount` from PLATFORM_CLEARING (or the
   * merchant's settlement account) back to the original payer. Two legs —
   * a principal return and an optional fee reversal — linked for atomicity.
   *
   * The refundable-amount guard is enforced by the CALLER (it must have read
   * the original transaction's refundable balance); this method books the
   * transfer the caller has authorized.
   */
  async createPostedRefund(params: {
    transactionId: string;
    /** Where the refunded money comes from (usually the merchant's settlement account). */
    refundFrom: bigint;
    /** The original payer's account, to credit back. */
    refundTo: bigint;
    /** Principal amount to return (minor units). */
    principal: bigint;
    /** Optional fee amount to reverse (minor units). */
    fee?: bigint;
  }): Promise<{ ids: bigint[] }> {
    const { transactionId, refundFrom, refundTo, principal, fee = 0n } = params;
    const transfers: TbTransfer[] = [];
    const ids: bigint[] = [];

    const principalId = transferIdFor(transactionId, 'refund:principal');
    ids.push(principalId);
    transfers.push({
      id: principalId,
      debit_account_id: refundFrom,
      credit_account_id: refundTo,
      amount: principal,
      flags: fee > 0n ? TransferFlags.linked : 0,
      ledger: LEDGER_LYD,
      code: LedgerCode.TX_REFUND,
    });

    if (fee > 0n) {
      const feeId = transferIdFor(transactionId, 'refund:fee');
      ids.push(feeId);
      transfers.push({
        id: feeId,
        debit_account_id: SYSTEM.PLATFORM_REVENUE,
        credit_account_id: refundTo,
        amount: fee,
        flags: 0, // final leg
        ledger: LEDGER_LYD,
        code: LedgerCode.TX_REFUND_FEE_REVERSAL,
      });
    }

    const results = await this.tb.createTransfers(transfers);
    const failed = results.find((r) => !isOk(r));
    if (failed) throw new Error(`refund transfer failed at index ${failed.index}: ${failed.error}`);
    return { ids };
  }

  /**
   * Create a PENDING wallet-to-wallet transfer chain (the two-phase first half).
   *
   * Debits the SENDER's account by `principal + fee`, credits the RECEIVER
   * `principal`, and credits the platform `fee` (if any) — as a linked chain so
   * all legs commit atomically or none do. All legs are PENDING and carry the
   * configured timeout so an abandoned transfer auto-expires.
   *
   * Returns the fully-typed transfer objects (persisted by the caller) so a
   * later post/void in any isolate replays the exact same TigerBeetle transfers.
   * The caller POSTS on delivery, VOIDS on failure/expiry.
   */
  async createWalletTransfer(params: {
    transactionId: string;
    senderAccount: bigint;
    receiverAccount: bigint;
    principal: bigint;
    fee?: bigint;
  }): Promise<{ ids: bigint[]; transfers: TbTransfer[]; total: bigint }> {
    const { transactionId, senderAccount, receiverAccount, principal, fee = 0n } = params;
    const total = principal + fee;

    const transfers: TbTransfer[] = [];
    const ids: bigint[] = [];

    // Leg 1: sender → receiver (principal). Linked if a fee leg follows.
    const principalId = transferIdFor(transactionId, 'wallet:principal');
    ids.push(principalId);
    transfers.push({
      id: principalId,
      debit_account_id: senderAccount,
      credit_account_id: receiverAccount,
      amount: principal,
      flags: fee > 0n ? TransferFlags.pending | TransferFlags.linked : TransferFlags.pending,
      ledger: LEDGER_LYD,
      code: LedgerCode.TX_WALLET_PRINCIPAL,
      timeout_date: this.pendingTimeoutNs,
    });

    // Leg 2 (optional): sender → platform (fee). Final leg, no linked.
    if (fee > 0n) {
      const feeId = transferIdFor(transactionId, 'wallet:fee');
      ids.push(feeId);
      transfers.push({
        id: feeId,
        debit_account_id: senderAccount,
        credit_account_id: SYSTEM.PLATFORM_REVENUE,
        amount: fee,
        flags: TransferFlags.pending,
        ledger: LEDGER_LYD,
        code: LedgerCode.TX_WALLET_FEE,
        timeout_date: this.pendingTimeoutNs,
      });
    }

    const results = await this.tb.createTransfers(transfers);
    const failed = results.find((r) => !isOk(r));
    if (failed) throw new Error(`wallet transfer chain failed at index ${failed.index}: ${failed.error}`);
    return { ids, transfers, total };
  }

  /**
   * Create a PENDING withdrawal hold: debit the user's account by
   * `amount + fee`, credit WITHDRAWAL_CLEARING `amount`, credit the platform
   * `fee` (if any) — a linked chain, all pending, with the configured timeout.
   *
   * The hold is POSTED when the LYPay withdrawal completes (money left to the
   * bank) and VOIDED if LYPay declines/fails/expires — releasing the user's
   * balance. Returns the typed transfers so a post/void in any isolate replays
   * the exact same TigerBeetle objects.
   */
  async createWithdrawalHold(params: {
    transactionId: string;
    userAccount: bigint;
    amount: bigint;
    fee?: bigint;
  }): Promise<{ ids: bigint[]; transfers: TbTransfer[]; total: bigint }> {
    const { transactionId, userAccount, amount, fee = 0n } = params;
    const total = amount + fee;

    const transfers: TbTransfer[] = [];
    const ids: bigint[] = [];

    // Leg 1: user → WITHDRAWAL_CLEARING (amount). Linked if a fee leg follows.
    const amountId = transferIdFor(transactionId, 'withdraw:amount');
    ids.push(amountId);
    transfers.push({
      id: amountId,
      debit_account_id: userAccount,
      credit_account_id: SYSTEM.WITHDRAWAL_CLEARING,
      amount,
      flags: fee > 0n ? TransferFlags.pending | TransferFlags.linked : TransferFlags.pending,
      ledger: LEDGER_LYD,
      code: LedgerCode.TX_WITHDRAWAL,
      timeout_date: this.pendingTimeoutNs,
    });

    // Leg 2 (optional): user → platform (fee). Final leg, no linked.
    if (fee > 0n) {
      const feeId = transferIdFor(transactionId, 'withdraw:fee');
      ids.push(feeId);
      transfers.push({
        id: feeId,
        debit_account_id: userAccount,
        credit_account_id: SYSTEM.PLATFORM_REVENUE,
        amount: fee,
        flags: TransferFlags.pending,
        ledger: LEDGER_LYD,
        code: LedgerCode.TX_WALLET_FEE,
        timeout_date: this.pendingTimeoutNs,
      });
    }

    const results = await this.tb.createTransfers(transfers);
    const failed = results.find((r) => !isOk(r));
    if (failed) throw new Error(`withdrawal hold failed at index ${failed.index}: ${failed.error}`);
    return { ids, transfers, total };
  }

  /**
   * Post a top-up credit: PLATFORM_CLEARING → the user's account, POSTED, once
   * and only once an inbound credit has been matched to this deposit reference.
   * Idempotent by the deposit reference embedded in the transfer id, so a
   * replayed webhook credits exactly once.
   */
  async postTopUpCredit(params: {
    depositReference: string;
    userId: string;
    amount: bigint;
  }): Promise<{ transferId: bigint; credited: boolean }> {
    const { depositReference, userId, amount } = params;
    await this.ensureAccount('user', userId);
    const userAccount = accountIdFor('user', userId);
    const id = transferIdFor(`topup:${depositReference}`, 'credit');
    const results = await this.tb.createTransfers([
      {
        id,
        debit_account_id: SYSTEM.PLATFORM_CLEARING,
        credit_account_id: userAccount,
        amount,
        flags: 0, // posted, not pending — a top-up is a completed credit
        ledger: LEDGER_LYD,
        code: LedgerCode.TX_TOPUP,
      },
    ]);
    const r = results[0];
    // `exists` means it was already credited — that is the "once" guarantee.
    return { transferId: id, credited: isOk(r) && r?.error !== 'exists' };
  }

  /** Read balances for a set of account ids (for receipts / reconciliation). */
  async balances(ids: bigint[]) {
    return this.tb.lookupAccounts(ids);
  }
}

// Local alias to avoid importing the full result type in every signature.
type TbItemResultAlias = { id: string; error: string | null; index: number };

/**
 * Compute a TigerBeetle `timeout_date` (ns since Unix epoch) `seconds` in the
 * future. Used to stamp pending transfers so an abandoned reservation
 * auto-expires rather than locking funds forever.
 */
function pendingTimeoutNsFromNow(seconds: number): bigint {
  const nowMs = Date.now();
  const nowNs = BigInt(nowMs) * 1_000_000n;
  return nowNs + BigInt(Math.round(seconds)) * 1_000_000_000n;
}

/**
 * Classify a TigerBeetle per-item error for a post/void of a pending transfer.
 *
 * The whole point of a two-phase ledger is that post/void can be RETRIED (a
 * webhook redelivered, a confirm replayed after a crash). TigerBeetle reports
 * several outcomes that are, for our purposes, success:
 *
 *   null                          → applied now
 *   'exists'                      → this post/void transfer was already applied
 *   'pending_transfer_not_pending'→ already posted/voided (the race we wanted)
 *   'pending_transfer_expired'    → the timeout elapsed; nothing left to settle
 *
 * Only a genuinely unexpected error (e.g. 'linked_components_must_be_set',
 * 'debit_account_not_found') should surface as a failure.
 */
export function isSettledOutcome(error: string | null): boolean {
  if (error === null) return true;
  return (
    error === 'exists' ||
    error === 'pending_transfer_not_pending' ||
    error === 'pending_transfer_expired'
  );
}

/** True when every item in a post/void result is an acceptable settled outcome. */
export function allSettled(results: TbItemResultAlias[]): boolean {
  return results.every((r) => isSettledOutcome(r.error));
}

/** Collect the genuinely-failed items (for logging/alerting). */
export function realFailures(results: TbItemResultAlias[]): TbItemResultAlias[] {
  return results.filter((r) => !isSettledOutcome(r.error));
}