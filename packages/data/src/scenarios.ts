/**
 * Сценарії старту з технічного завдання.
 *
 * Сценарій — це не окремий код, а конфігурація: стартовий баланс, набір
 * модулів, дата входу в історію та цілі акціонерів. Три сценарії з ТЗ
 * відрізняються саме параметрами, а не механікою, і це головна перевірка того,
 * що архітектура тримається: якщо для "кризового менеджера" довелося б писати
 * окремий рушій, значить рушій зроблено неправильно.
 */

import { Simulation, money, type Money, type SimModule, type SimulationOptions } from '@uabanksim/core';
import {
  createAutopilot,
  createFoundation,
  createOverheads,
  createRetailDeposits,
  createRetailLending,
  createShareholders,
  createTreasury,
  type OpeningBalance,
  type ShareholderTargets,
} from '@uabanksim/modules';
import { HistoricalMacroProvider } from './macro-provider.ts';

export type ScenarioId = 'sandbox' | 'crisis-manager' | 'career';

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly title: string;
  readonly summary: string;
  /** Що конкретно доведеться робити гравцю — текст брифінгу. */
  readonly briefing: readonly string[];
  readonly startYear: number;
  readonly startMonth: number;
  readonly bankName: string;
  readonly reputation: number;
  readonly brandAwareness: number;
  readonly opening: OpeningBalance;
  readonly targets: ShareholderTargets;
  readonly branches: number;
  /** Скільки перших кварталів рада директорів не вимагає виконання KPI. */
  readonly gracePeriodQuarters?: number;
  /** Множник стресу: наскільки гостро сценарій відчуває історичні шоки. */
  readonly stressMultiplier: number;
  /** Скільки тижнів триває сценарій за замовчуванням. */
  readonly defaultWeeks: number;
  readonly economics: ScenarioEconomics;
}

/**
 * Економічний масштаб сценарію.
 *
 * Ці числа — і є ігровий баланс. Вони задаються явно, а не виводяться з
 * кількості відділень: банк із двома точками і банк із мережею на двадцять
 * чотири відрізняються не пропорційно, а якісно, і головний офіс коштує
 * однаково в обох випадках.
 */
export interface ScenarioEconomics {
  /** Скільки пасиву населення ринок готовий принести за тиждень за ринковою ставкою. */
  readonly weeklyDepositInflow: Money;
  /** Тижневий попит на роздрібні кредити за ринковою ставкою. */
  readonly weeklyLoanDemand: Money;
  readonly payrollPerBranch: Money;
  readonly headOfficePayroll: Money;
  readonly occupancyPerBranch: Money;
  readonly itCostPerMonth: Money;
  readonly marketingPerMonth: Money;
  readonly depreciationPerMonth: Money;
  /** Цільовий залишок на коррахунку, який казначейство тримає про запас. */
  readonly operationalBuffer: Money;
}

const MILLION = 1_000_000;

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  /**
   * Сценарій А. Чиста ліцензія, майже немає клієнтів, чужий процесинг, два
   * відділення. Спокійний 2017 рік — гравець вчиться механіці без шоків.
   */
  sandbox: {
    id: 'sandbox',
    title: 'Пісочниця: власна ліцензія',
    summary:
      'Ви купили невеликий кептивний банк із чистою ліцензією. Клієнтів майже немає, ' +
      'процесинг чужий, два відділення. Завдання — вийти в прибуток і не порушити нормативи.',
    briefing: [
      'Капітал 300 млн грн — саме на межі мінімальних вимог НБУ.',
      'Ставка за депозитами і поріг скорингу — два повзунки, якими ви керуєте зростанням.',
      'Вільну гривню казначейство паркує в депозитні сертифікати НБУ: це базовий, безризиковий дохід.',
    ],
    startYear: 2017,
    startMonth: 1,
    bankName: 'Банк "Перший Столичний"',
    reputation: 0.5,
    brandAwareness: 0.08,
    opening: {
      shareCapital: money(300 * MILLION),
      cashInVault: money(15 * MILLION),
      fixedAssets: money(40 * MILLION),
    },
    targets: { returnOnEquity: 0.1, costIncomeRatio: 0.75, assetGrowth: 0.2 },
    gracePeriodQuarters: 4,
    branches: 2,
    stressMultiplier: 1,
    defaultWeeks: 96,
    economics: {
      weeklyDepositInflow: money(160 * MILLION),
      weeklyLoanDemand: money(120 * MILLION),
      payrollPerBranch: money(0.5 * MILLION),
      headOfficePayroll: money(2.5 * MILLION),
      occupancyPerBranch: money(0.3 * MILLION),
      itCostPerMonth: money(1.2 * MILLION),
      marketingPerMonth: money(1 * MILLION),
      depreciationPerMonth: money(0.5 * MILLION),
      operationalBuffer: money(30 * MILLION),
    },
  },

  /**
   * Сценарій Б. Вхід у банк із величезним NPL напередодні історичної кризи.
   * Старт — кінець 2021 року: у гравця є кілька місяців, щоб підготуватись.
   */
  'crisis-manager': {
    id: 'crisis-manager',
    title: 'Кризовий менеджер: 2022',
    summary:
      'Вас поставили головою правління банку з портфелем, третина якого не обслуговується, ' +
      'за кілька місяців до 24 лютого 2022 року. Утримати Н2 і не впасти в касовий розрив.',
    briefing: [
      'Успадкований портфель: 2 млрд грн, з них 32% — непрацюючі кредити.',
      'Резерв сформовано лише наполовину: інспекція НБУ змусить доформувати решту.',
      'Паніка вкладників живиться низькою репутацією — кожен день затримки платежів подвоює відтік.',
      'Ваша перевага перед конкурентами — готівка в касі, коли в них порожні банкомати.',
    ],
    startYear: 2021,
    startMonth: 10,
    bankName: 'Банк "Індустріальний Кредит"',
    reputation: 0.35,
    brandAwareness: 0.32,
    opening: {
      shareCapital: money(1200 * MILLION),
      cashInVault: money(120 * MILLION),
      fixedAssets: money(260 * MILLION),
      retailLoans: money(2000 * MILLION),
      retailNplShare: 0.32,
      termDeposits: money(1400 * MILLION),
      currentAccounts: money(900 * MILLION),
    },
    targets: { returnOnEquity: 0.05, costIncomeRatio: 0.85, assetGrowth: 0 },
    branches: 24,
    stressMultiplier: 1.15,
    defaultWeeks: 144,
    economics: {
      weeklyDepositInflow: money(240 * MILLION),
      weeklyLoanDemand: money(150 * MILLION),
      payrollPerBranch: money(0.35 * MILLION),
      headOfficePayroll: money(6 * MILLION),
      occupancyPerBranch: money(0.15 * MILLION),
      itCostPerMonth: money(4 * MILLION),
      marketingPerMonth: money(3 * MILLION),
      depreciationPerMonth: money(2.2 * MILLION),
      operationalBuffer: money(180 * MILLION),
    },
  },

  /**
   * Сценарій В. Гравець керує роздрібним напрямом: обмежений капітал, вузький
   * набір продуктів, жорсткий план від правління. Далі — зростання до CEO.
   */
  career: {
    id: 'career',
    title: 'Кар’єра: начальник управління роздрібу',
    summary:
      'Ви очолили управління роздрібного бізнесу у великому банку. Ваш P&L рахують окремо, ' +
      'план по ROE жорсткий, а бюджет на маркетинг доведеться відвойовувати результатами.',
    briefing: [
      'Ви відповідаєте лише за роздріб: депозити населення і кредити фізособам.',
      'Правління дало 500 млн грн внутрішнього капіталу і план ROE 15% річних.',
      'Три провалені квартали поспіль — і на вашому місці буде інша людина.',
    ],
    startYear: 2019,
    startMonth: 1,
    bankName: 'Управління роздрібного бізнесу',
    reputation: 0.6,
    brandAwareness: 0.45,
    opening: {
      shareCapital: money(500 * MILLION),
      cashInVault: money(40 * MILLION),
      fixedAssets: money(60 * MILLION),
      currentAccounts: money(300 * MILLION),
    },
    targets: { returnOnEquity: 0.15, costIncomeRatio: 0.65, assetGrowth: 0.25 },
    branches: 8,
    stressMultiplier: 1,
    defaultWeeks: 96,
    economics: {
      weeklyDepositInflow: money(130 * MILLION),
      weeklyLoanDemand: money(95 * MILLION),
      payrollPerBranch: money(0.5 * MILLION),
      // Управління всередині великого банку не утримує весь бек-офіс — воно
      // платить за нього внутрішнім трансфертом, тому головний офіс тут дешевший.
      headOfficePayroll: money(3 * MILLION),
      occupancyPerBranch: money(0.3 * MILLION),
      itCostPerMonth: money(2.5 * MILLION),
      marketingPerMonth: money(3 * MILLION),
      depreciationPerMonth: money(1 * MILLION),
      operationalBuffer: money(70 * MILLION),
    },
  },
};

export interface ScenarioOverrides {
  readonly seed?: number;
  readonly weeks?: number;
  readonly modules?: readonly SimModule[];
  /**
   * Підключити референсну політику, яка щотижня приймає рішення замість гравця.
   * Без неї банк повністю пасивний: ставка не змінюється, скоринг не реагує на
   * NPL — і будь-який сценарій із кризою закінчується однаково.
   */
  readonly autopilot?: boolean;
}

/**
 * Складає набір модулів під сценарій. Масштаб бізнес-параметрів прив'язаний до
 * розміру банку: банк із двома відділеннями не збирає стільки ж пасиву, скільки
 * мережа на 24 точки.
 */
export function buildModules(
  scenario: ScenarioDefinition,
  options: { readonly autopilot?: boolean } = {},
): SimModule[] {
  const economics = scenario.economics;
  const modules: SimModule[] = [
    createFoundation(scenario.opening),
    createOverheads({
      branches: scenario.branches,
      payrollPerBranch: economics.payrollPerBranch,
      headOfficePayroll: economics.headOfficePayroll,
      occupancyPerBranch: economics.occupancyPerBranch,
      itCostPerMonth: economics.itCostPerMonth,
      marketingPerMonth: economics.marketingPerMonth,
      depreciationPerMonth: economics.depreciationPerMonth,
    }),
    createRetailDeposits({
      baseWeeklyInflow: economics.weeklyDepositInflow,
      termWeeks: 12,
      cashShare: 0.45,
    }),
    createRetailLending({
      baseWeeklyDemand: economics.weeklyLoanDemand,
      initialScoringCutoff: 0.55,
      cardShare: 0.35,
    }),
    createTreasury({
      operationalBuffer: economics.operationalBuffer,
      cashBufferWeeks: 2,
    }),
    createShareholders({
      targets: scenario.targets,
      ...(scenario.gracePeriodQuarters !== undefined
        ? { gracePeriodQuarters: scenario.gracePeriodQuarters }
        : {}),
    }),
  ];
  if (options.autopilot) modules.push(createAutopilot());
  return modules;
}

/** Створює готову до запуску симуляцію за сценарієм. */
export function createSimulation(
  scenarioId: ScenarioId,
  overrides: ScenarioOverrides = {},
): Simulation {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`Невідомий сценарій "${scenarioId}"`);
  const options: SimulationOptions = {
    seed: overrides.seed ?? 20220224,
    startYear: scenario.startYear,
    startMonth: scenario.startMonth,
    macro: new HistoricalMacroProvider({ stressMultiplier: scenario.stressMultiplier }),
    state: {
      bankName: scenario.bankName,
      reputation: scenario.reputation,
      brandAwareness: scenario.brandAwareness,
    },
    modules:
      overrides.modules ?? buildModules(scenario, { autopilot: overrides.autopilot ?? false }),
  };
  return new Simulation(options);
}

export function listScenarios(): readonly ScenarioDefinition[] {
  return Object.values(SCENARIOS);
}
