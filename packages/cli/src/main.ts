#!/usr/bin/env node
/**
 * Консольний запуск сценарію.
 *
 * Це не гра, а полігон: він проганяє сценарій на задану кількість тижнів і
 * друкує баланс, P&L та нормативи. Поки немає UI, саме тут видно, чи тримається
 * економіка — і чи сходиться Головна книга після десятків тисяч проводок.
 *
 *   npm run sim -- --scenario crisis-manager --weeks 96
 */

import { formatMoney } from '@uabanksim/core';
import { SCENARIOS, createSimulation, listScenarios, type ScenarioId } from '@uabanksim/data';
import { renderBalanceSheet, renderIncomeStatement, renderRatios, percent } from './format.ts';

interface CliOptions {
  readonly scenario: ScenarioId;
  readonly weeks: number;
  readonly seed: number;
  readonly quiet: boolean;
  /** Керувати банком референсною політикою замість пасивного режиму. */
  readonly autopilot: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let scenario: ScenarioId = 'sandbox';
  let weeks = 0;
  let seed = 20220224;
  let quiet = false;
  let autopilot = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--scenario':
      case '-s':
        if (!value || !(value in SCENARIOS)) {
          throw new Error(`Невідомий сценарій "${value ?? ''}". Доступні: ${Object.keys(SCENARIOS).join(', ')}`);
        }
        scenario = value as ScenarioId;
        i += 1;
        break;
      case '--weeks':
      case '-w':
        weeks = Number(value);
        if (!Number.isInteger(weeks) || weeks <= 0) throw new Error(`--weeks очікує додатне ціле, отримано "${value}"`);
        i += 1;
        break;
      case '--seed':
        seed = Number(value);
        if (!Number.isFinite(seed)) throw new Error(`--seed очікує число, отримано "${value}"`);
        i += 1;
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--passive':
        // Пасивний режим: жодних рішень. Показує, що станеться з банком, яким
        // ніхто не керує, — і саме тому він корисний для перевірки сценарію.
        autopilot = false;
        break;
      default:
        throw new Error(`Невідомий аргумент "${arg}"`);
    }
  }
  return { scenario, weeks: weeks || SCENARIOS[scenario].defaultWeeks, seed, quiet, autopilot };
}

function printHelp(): void {
  const lines = [
    'UABankSim — симулятор комерційного банку в Україні',
    '',
    'Використання: npm run sim -- [опції]',
    '',
    'Опції:',
    '  -s, --scenario <id>   сценарій старту (за замовчуванням sandbox)',
    '  -w, --weeks <n>       скільки тижнів прогнати',
    '      --seed <n>        зерно генератора випадковості',
    '  -q, --quiet           не друкувати стрічку подій',
    '      --passive         вимкнути автопілот: банк не приймає жодних рішень',
    '  -h, --help            ця довідка',
    '',
    'Сценарії:',
  ];
  for (const scenario of listScenarios()) {
    lines.push(`  ${scenario.id.padEnd(16)}${scenario.title}`);
    lines.push(`  ${' '.repeat(16)}${scenario.summary}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    printHelp();
    return;
  }

  const scenario = SCENARIOS[parsed.scenario];
  const simulation = createSimulation(parsed.scenario, {
    seed: parsed.seed,
    autopilot: parsed.autopilot,
  });

  const header = [
    '='.repeat(74),
    `  ${scenario.title}`,
    `  ${scenario.summary}`,
    '='.repeat(74),
    '',
    ...scenario.briefing.map((line) => `  • ${line}`),
    '',
    `  Старт: ${scenario.startYear}-${String(scenario.startMonth).padStart(2, '0')}, ` +
      `горизонт ${parsed.weeks} тижнів (${(parsed.weeks / 48).toFixed(1)} ігрових років), seed ${parsed.seed}`,
    `  Режим: ${parsed.autopilot ? 'автопілот (референсна політика)' : 'пасивний — рішення не приймаються'}`,
    '',
  ];
  process.stdout.write(`${header.join('\n')}\n`);

  const reports = simulation.run(parsed.weeks);

  if (!parsed.quiet) {
    process.stdout.write('СТРІЧКА ПОДІЙ\n\n');
    for (const record of simulation.logs) {
      const marker = { info: ' ', warning: '!', critical: 'X', success: '+' }[record.severity];
      process.stdout.write(
        `  ${marker} ${simulation.calendar.format(record.week).padEnd(22)}${record.message}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const last = reports[reports.length - 1];
  process.stdout.write(`${'='.repeat(74)}\n`);
  process.stdout.write(`  ПІДСУМОК на ${simulation.calendar.format(simulation.week)}\n`);
  process.stdout.write(`${'='.repeat(74)}\n\n`);
  process.stdout.write(`${renderBalanceSheet(simulation.balanceSheet())}\n\n`);
  process.stdout.write(`${renderIncomeStatement(simulation.latestIncomeStatement())}\n\n`);
  process.stdout.write(`${renderRatios(simulation.ratios())}\n\n`);

  if (last) {
    process.stdout.write(
      `  Макро: облікова ставка ${percent(last.macro.keyRate)}, ` +
        `курс ${last.macro.fx.USD.toFixed(2)} грн/дол., ` +
        `інфляція ${percent(last.macro.inflation)}, стрес ${percent(last.macro.stress, 0)}\n`,
    );
  }
  process.stdout.write(
    `  Репутація ${percent(simulation.state.reputation, 0)}, ` +
      `впізнаваність ${percent(simulation.state.brandAwareness, 0)}\n`,
  );
  process.stdout.write(`  Проводок у Головній книзі: ${simulation.journal.entryCount}\n`);

  const difference = simulation.journal.trialBalanceDifference();
  process.stdout.write(
    `  Контроль балансу: ${simulation.journal.isBalanced() ? 'зійшовся' : `РОЗБІЖНІСТЬ ${formatMoney(difference)}`}\n`,
  );

  if (!simulation.state.isAlive) {
    process.stdout.write(`\n  ГРУ ЗАВЕРШЕНО: ${simulation.state.gameOverReason}\n`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Помилка: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
