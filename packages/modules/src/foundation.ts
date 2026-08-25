/**
 * Заснування банку: стартовий баланс сценарію.
 *
 * Модуль існує заради одного — щоб гра починалася зі справжнього балансу, а не
 * з чисел, які хтось "проставив". Статутний капітал, стартова готівка, куплений
 * кредитний портфель проблемного банку — усе це звичайні проводки, і трактуються
 * вони так само, як будь-яка операція на 200-му тижні.
 */

import {
  ACC,
  BaseModule,
  CoreEvents,
  PRIORITY,
  add,
  credit,
  debit,
  formatMoney,
  isPositive,
  scale,
  subtract,
  sum,
  zero,
  type Money,
  type PeriodEvent,
  type SimContext,
  type WeekEvent,
} from '@uabanksim/core';

import { BankEvents, type PortfolioInheritedEvent } from './events.ts';

export interface OpeningBalance {
  /** Статутний капітал, внесений акціонерами. */
  readonly shareCapital: Money;
  /** Скільки з капіталу одразу лежить готівкою в касі. */
  readonly cashInVault?: Money;
  /** Основні засоби, куплені разом із банком (приміщення, обладнання). */
  readonly fixedAssets?: Money;
  /** Успадкований портфель кредитів фізосіб. */
  readonly retailLoans?: Money;
  /** Яка частка успадкованого портфеля вже непрацююча. */
  readonly retailNplShare?: number;
  /** Успадковані строкові вклади населення. */
  readonly termDeposits?: Money;
  /** Успадковані кошти на поточних рахунках. */
  readonly currentAccounts?: Money;
}

export const FOUNDATION_SLICE = 'foundation';

export interface FoundationState {
  readonly openingBalance: OpeningBalance;
  /** Працююча частина успадкованого портфеля — вона поступово гаситься. */
  inheritedPerforming: Money;
  /** Успадкований NPL: доходу не дає, але тисне на нормативи, доки не списаний. */
  inheritedNpl: Money;
  /** Скільки місяців успадкований NPL уже на балансі. */
  monthsCarryingNpl: number;
}

/** За скільки місяців успадкований працюючий портфель гаситься повністю. */
export const INHERITED_RUNOFF_MONTHS = 24;

/** Через скільки місяців успадкований NPL списується за рахунок резерву. */
export const INHERITED_WRITE_OFF_MONTHS = 12;

export class FoundationModule extends BaseModule {
  readonly id = FOUNDATION_SLICE;
  readonly title = 'Заснування банку';
  readonly #opening: OpeningBalance;

  constructor(opening: OpeningBalance) {
    super();
    this.#opening = opening;
  }

  setup(ctx: SimContext): void {
    const opening = this.#opening;
    const cash = opening.cashInVault ?? zero('UAH');
    const fixedAssets = opening.fixedAssets ?? zero('UAH');
    const loans = opening.retailLoans ?? zero('UAH');
    const nplShare = opening.retailNplShare ?? 0;
    const termDeposits = opening.termDeposits ?? zero('UAH');
    const currentAccounts = opening.currentAccounts ?? zero('UAH');
    const npl = scale(loans, nplShare);

    // 1. Внесок акціонерів. Гроші заходять на кореспондентський рахунок в НБУ.
    ctx.post({
      narrative: 'Внесення статутного капіталу акціонерами',
      postings: [debit(ACC.nostroNbu, opening.shareCapital), credit(ACC.shareCapital, opening.shareCapital)],
    });

    // 2. Переведення частини коштів у касу.
    if (isPositive(cash)) {
      ctx.post({
        narrative: 'Отримання підкріплення готівкою до каси банку',
        postings: [debit(ACC.cashVault, cash), credit(ACC.nostroNbu, cash)],
      });
    }

    // 3. Купівля основних засобів.
    if (isPositive(fixedAssets)) {
      ctx.post({
        narrative: 'Придбання основних засобів (приміщення, обладнання)',
        postings: [debit(ACC.fixedAssets, fixedAssets), credit(ACC.nostroNbu, fixedAssets)],
      });
    }

    // 4. Успадковані пасиви: клієнти прийшли разом із банком, а з ними — гроші.
    const inheritedFunds = add(termDeposits, currentAccounts);
    if (isPositive(inheritedFunds)) {
      ctx.post({
        narrative: 'Прийняття зобов’язань перед клієнтами придбаного банку',
        postings: [
          debit(ACC.nostroNbu, inheritedFunds),
          ...(isPositive(termDeposits) ? [credit(ACC.termDepositsRetail, termDeposits)] : []),
          ...(isPositive(currentAccounts) ? [credit(ACC.currentAccountsRetail, currentAccounts)] : []),
        ],
      });
    }

    // 5. Успадкований кредитний портфель разом із уже сформованим резервом.
    if (isPositive(loans)) {
      const allowance = scale(npl, 0.5);
      ctx.post({
        narrative: 'Прийняття кредитного портфеля придбаного банку',
        postings: [debit(ACC.loansRetailCash, loans), credit(ACC.nostroNbu, loans)],
      });
      if (isPositive(allowance)) {
        ctx.post({
          narrative: 'Резерв під знецінення успадкованого кредитного портфеля',
          postings: [debit(ACC.provisionCharge, allowance), credit(ACC.loanLossAllowance, allowance)],
        });
      }
    }

    const state = ctx.state.registerSlice<FoundationState>(FOUNDATION_SLICE, {
      openingBalance: opening,
      inheritedPerforming: subtract(loans, npl),
      inheritedNpl: npl,
      monthsCarryingNpl: 0,
    });

    // Успадкований NPL враховується в нормативах, доки портфель не самортизується.
    ctx.contributeToRatios(() => ({ nonPerformingLoans: state.inheritedNpl }));

    if (isPositive(loans)) {
      ctx.bus.on<PeriodEvent>(CoreEvents.monthEnd, () => this.#runOff(ctx, state), {
        priority: PRIORITY.accrual,
        owner: this.id,
      });
    }

    if (isPositive(termDeposits)) {
      // Подію публікуємо на першому такті, а не в `setup`: на момент нашого
      // `setup` продуктові модулі ще не підписались на шину.
      ctx.bus.once<WeekEvent>(
        CoreEvents.weekBegin,
        () => {
          const event: PortfolioInheritedEvent = {
            type: BankEvents.portfolioInherited,
            termDeposits,
            // Попередній менеджмент збирав пасив дорого — звідси й проблеми банку.
            termDepositRate: ctx.macro.marketDepositRate * 1.15,
            maxRemainingWeeks: 24,
          };
          ctx.emit(event);
        },
        { priority: PRIORITY.macro, owner: this.id },
      );
    }

    const assets = sum(
      [
        ctx.journal.balance(ACC.nostroNbu, 'UAH'),
        ctx.journal.balance(ACC.cashVault, 'UAH'),
        ctx.journal.balance(ACC.fixedAssets, 'UAH'),
        subtract(ctx.journal.balance(ACC.loansRetailCash, 'UAH'), ctx.journal.balance(ACC.loanLossAllowance, 'UAH')),
      ],
      'UAH',
    );
    ctx.log(
      `Банк "${ctx.state.bankName}" відкрито. Активи ${formatMoney(assets)}, ` +
        `капітал ${formatMoney(opening.shareCapital)}` +
        (isPositive(npl) ? `, успадкований NPL ${formatMoney(npl)}` : ''),
      'success',
    );
  }

  /**
   * Розсмоктування успадкованого портфеля. Працююча частина гаситься рівномірно
   * і приносить відсотки; проблемна лежить мертвим вантажем і через рік
   * списується за рахунок резерву. Саме цей годинник тисне на гравця у сценарії
   * кризового менеджера: капітал з'їдає не ринок, а те, що він купив.
   */
  #runOff(ctx: SimContext, state: FoundationState): void {
    if (isPositive(state.inheritedPerforming)) {
      const repaid = scale(state.inheritedPerforming, 1 / INHERITED_RUNOFF_MONTHS);
      const interest = scale(state.inheritedPerforming, ctx.macro.marketLoanRate / 12);
      state.inheritedPerforming = subtract(state.inheritedPerforming, repaid);
      ctx.post({
        narrative: 'Погашення успадкованого кредитного портфеля',
        postings: [debit(ACC.nostroNbu, repaid), credit(ACC.loansRetailCash, repaid)],
      });
      if (isPositive(interest)) {
        ctx.post({
          narrative: 'Процентні доходи за успадкованим кредитним портфелем',
          postings: [debit(ACC.nostroNbu, interest), credit(ACC.interestIncomeRetail, interest)],
        });
      }
    }

    if (!isPositive(state.inheritedNpl)) return;
    state.monthsCarryingNpl += 1;
    if (state.monthsCarryingNpl < INHERITED_WRITE_OFF_MONTHS) return;

    const amount = state.inheritedNpl;
    const allowance = ctx.journal.balance(ACC.loanLossAllowance, 'UAH');
    const covered = allowance.minor >= amount.minor ? amount : allowance;
    const uncovered = subtract(amount, covered);
    ctx.post({
      narrative: 'Списання успадкованої безнадійної заборгованості',
      postings: [
        ...(isPositive(covered) ? [debit(ACC.loanLossAllowance, covered)] : []),
        ...(isPositive(uncovered) ? [debit(ACC.provisionCharge, uncovered)] : []),
        credit(ACC.loansRetailCash, amount),
      ],
    });
    state.inheritedNpl = zero('UAH');
    ctx.log(`Списано успадкований проблемний портфель на ${formatMoney(amount)}`, 'warning');
  }
}

export function createFoundation(opening: OpeningBalance): FoundationModule {
  return new FoundationModule(opening);
}

/** Сумарний обсяг успадкованих проблемних кредитів — для сценарного балансу. */
export function inheritedNpl(state: FoundationState): Money {
  return state.inheritedNpl;
}
