/**
 * Події, якими обмінюються бізнес-модулі.
 *
 * Це єдина точка зв'язності між модулями: депозити не знають про казначейство,
 * але повідомляють, що прийняли готівку; казначейство не знає про депозити, але
 * бачить, що готівки в касі побільшало.
 */

import type { Money, SimEvent } from '@uabanksim/core';

export const BankEvents = {
  portfolioInherited: 'foundation:portfolio-inherited',
  depositsOpened: 'deposits:opened',
  depositsWithdrawn: 'deposits:withdrawn',
  depositRun: 'deposits:bank-run',
  loanIssued: 'lending:loan-issued',
  loanDefaulted: 'lending:loan-defaulted',
  loanWrittenOff: 'lending:written-off',
  cashDelivered: 'cash:delivered',
  cashCollected: 'cash:collected',
  liquidityBorrowed: 'treasury:borrowed',
  liquidityInvested: 'treasury:invested',
} as const;

/**
 * Банк придбано разом із клієнтами. Продуктові модулі підхоплюють успадковані
 * портфелі у свої структури: проводки вже зроблено, потрібно лише взяти їх
 * під управління — інакше успадковані вклади не коштували б банку нічого.
 */
export interface PortfolioInheritedEvent extends SimEvent {
  readonly type: typeof BankEvents.portfolioInherited;
  /** Строкові вклади населення, що перейшли разом із банком. */
  readonly termDeposits: Money;
  /** Середня ставка, за якою ці вклади були залучені попереднім менеджментом. */
  readonly termDepositRate: number;
  /** Максимальний строк, що лишився до погашення, у тижнях. */
  readonly maxRemainingWeeks: number;
}

export interface DepositsOpenedEvent extends SimEvent {
  readonly type: typeof BankEvents.depositsOpened;
  readonly amount: Money;
  /** Частина суми, що надійшла готівкою через касу відділення. */
  readonly cashPortion: Money;
  readonly rate: number;
  readonly termWeeks: number;
}

export interface DepositsWithdrawnEvent extends SimEvent {
  readonly type: typeof BankEvents.depositsWithdrawn;
  readonly amount: Money;
  /** Скільки готівки клієнти хотіли отримати. Це і є попит на інкасацію. */
  readonly requestedCash: Money;
  /** Скільки готівки каса реально видала. Різниця — черга і зіпсована репутація. */
  readonly cashPortion: Money;
  readonly reason: 'maturity' | 'attrition' | 'panic';
}

export interface BankRunEvent extends SimEvent {
  readonly type: typeof BankEvents.depositRun;
  readonly week: number;
  readonly intensity: number;
  readonly outflow: Money;
}

export interface LoanIssuedEvent extends SimEvent {
  readonly type: typeof BankEvents.loanIssued;
  readonly product: 'cash-loan' | 'credit-card';
  readonly amount: Money;
  readonly rate: number;
  readonly expectedLoss: number;
}

export interface LoanWrittenOffEvent extends SimEvent {
  readonly type: typeof BankEvents.loanWrittenOff;
  readonly amount: Money;
}

export interface LiquidityBorrowedEvent extends SimEvent {
  readonly type: typeof BankEvents.liquidityBorrowed;
  readonly amount: Money;
  readonly rate: number;
  readonly source: 'interbank' | 'nbu-refinancing';
}
