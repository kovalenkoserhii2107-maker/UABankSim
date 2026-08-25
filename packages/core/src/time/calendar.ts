/**
 * Ігровий календар.
 *
 * Такт симуляції — один тиждень. Чотири тижні складають фінансовий місяць
 * (закриття періоду, нарахування резервів, звітність НБУ, виплата зарплат),
 * три місяці — квартал, дванадцять — фінансовий рік із 48 тижнів.
 *
 * Ігровий рік навмисно коротший за календарний: гравець проходить рік за 48
 * рішень, а не за 52, і кожен місяць має однакову вагу. Історичні дані НБУ
 * прив'язуються до пари (рік, місяць), тому розбіжність у чотири тижні не
 * впливає на макроекономіку.
 */

export const WEEKS_IN_MONTH = 4;
export const MONTHS_IN_QUARTER = 3;
export const MONTHS_IN_YEAR = 12;
export const WEEKS_IN_QUARTER = WEEKS_IN_MONTH * MONTHS_IN_QUARTER;
export const WEEKS_IN_YEAR = WEEKS_IN_MONTH * MONTHS_IN_YEAR;

export interface GameDate {
  /** Календарний рік, напр. 2014. */
  readonly year: number;
  /** Місяць 1..12. */
  readonly month: number;
  /** Тиждень усередині місяця, 1..4. */
  readonly weekOfMonth: number;
  /** Абсолютний номер тижня від початку сценарію, з нуля. */
  readonly absoluteWeek: number;
  /** Квартал 1..4. */
  readonly quarter: number;
}

export class CalendarError extends Error {}

/** Календар, прив'язаний до дати старту сценарію. */
export class GameCalendar {
  readonly startYear: number;
  readonly startMonth: number;

  constructor(startYear: number, startMonth = 1) {
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > MONTHS_IN_YEAR) {
      throw new CalendarError(`Місяць старту має бути в діапазоні 1..12, отримано ${startMonth}`);
    }
    this.startYear = startYear;
    this.startMonth = startMonth;
  }

  /** Дата за абсолютним номером тижня. */
  dateAt(absoluteWeek: number): GameDate {
    if (!Number.isInteger(absoluteWeek) || absoluteWeek < 0) {
      throw new CalendarError(`Номер тижня має бути невід'ємним цілим, отримано ${absoluteWeek}`);
    }
    const monthsElapsed = Math.floor(absoluteWeek / WEEKS_IN_MONTH);
    const absoluteMonth = this.startMonth - 1 + monthsElapsed;
    const year = this.startYear + Math.floor(absoluteMonth / MONTHS_IN_YEAR);
    const month = (absoluteMonth % MONTHS_IN_YEAR) + 1;
    const weekOfMonth = (absoluteWeek % WEEKS_IN_MONTH) + 1;
    return {
      year,
      month,
      weekOfMonth,
      absoluteWeek,
      quarter: Math.floor((month - 1) / MONTHS_IN_QUARTER) + 1,
    };
  }

  /** Останній тиждень фінансового місяця — момент закриття періоду. */
  isMonthEnd(absoluteWeek: number): boolean {
    return absoluteWeek % WEEKS_IN_MONTH === WEEKS_IN_MONTH - 1;
  }

  isQuarterEnd(absoluteWeek: number): boolean {
    return this.isMonthEnd(absoluteWeek) && this.dateAt(absoluteWeek).month % MONTHS_IN_QUARTER === 0;
  }

  isYearEnd(absoluteWeek: number): boolean {
    return this.isMonthEnd(absoluteWeek) && this.dateAt(absoluteWeek).month === MONTHS_IN_YEAR;
  }

  /** Перший тиждень фінансового місяця. */
  isMonthStart(absoluteWeek: number): boolean {
    return absoluteWeek % WEEKS_IN_MONTH === 0;
  }

  /** Абсолютний номер тижня, з якого починається заданий (рік, місяць). */
  weekOfMonthStart(year: number, month: number): number {
    const months = (year - this.startYear) * MONTHS_IN_YEAR + (month - this.startMonth);
    if (months < 0) {
      throw new CalendarError(`${year}-${month} передує старту сценарію ${this.startYear}-${this.startMonth}`);
    }
    return months * WEEKS_IN_MONTH;
  }

  /** Форматування для логів та UI: `2022-03 (тиждень 2)`. */
  format(absoluteWeek: number): string {
    const d = this.dateAt(absoluteWeek);
    return `${d.year}-${String(d.month).padStart(2, '0')} (тиждень ${d.weekOfMonth})`;
  }
}
