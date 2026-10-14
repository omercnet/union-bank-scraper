import moment from 'moment';
import { type Frame, type Page } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../constants';
import { getDebug } from '../helpers/debug';
import { elementPresentOnPage } from '../helpers/elements-interactions';
import { sleep } from '../helpers/waiting';
import { LoanInterestTypes, LoanTypes, type Loan } from '../transactions';

const debug = getDebug('beinleumi-loans');

const LOANS_PATH = '/wps/myportal/FibiMenu/Online/OnLoansMortgageMenu/OnLoans/AuthLoansDetails';
// the table of shekel loans; foreign currency loans are not supported
const LOANS_TABLE = 'table#HalvaaNewMerged';
const DATE_FORMAT = 'DD/MM/YY';
// the page is loaded into an iframe of the portal shell, which may take a few seconds to render
const FIND_TABLE_ATTEMPTS = 5;
const FIND_TABLE_INTERVAL_MS = 2000;

// column layout of the loans table
const COLUMN_NAME = 0;
const COLUMN_ORIGINAL_AMOUNT = 1;
const COLUMN_START_DATE = 2;
const COLUMN_INTEREST_RATE = 3;
const COLUMN_TOTAL_BALANCE = 4;
const COLUMN_END_DATE = 5;
const COLUMN_NEXT_PAYMENT_AMOUNT = 6;
const COLUMN_NEXT_PAYMENT_DATE = 7;
const COLUMN_SCHEDULE = 8;
const COLUMN_COUNT = 9;

export interface ScrapedLoanRow {
  /**
   * the text of each cell, in table order
   */
  cells: string[];
  /**
   * the href of the payment schedule link, e.g. "javascript:luachSilukin(accountType,loanDate,loanNumber);"
   */
  scheduleHref: string;
}

function parseDate(value: string): string | undefined {
  const date = moment(value.trim(), DATE_FORMAT, true);
  return date.isValid() ? date.toISOString() : undefined;
}

function parseAmount(value: string): number | undefined {
  const amount = parseFloat(value.replace(/[^\d.-]/g, ''));
  return Number.isNaN(amount) ? undefined : amount;
}

/**
 * Parses the rate cell, e.g. "P-1.25 % ( 4.75% )" for prime based loans,
 * where the value in parentheses is the current annual rate.
 */
export function parseInterestRate(value: string): { interestRate?: number; interestType?: LoanInterestTypes } {
  const text = value.replace(/\s+/g, ' ').trim();
  const effectiveRate = /\(\s*(-?[\d.]+)\s*%\s*\)/.exec(text);
  const interestRate = parseAmount(effectiveRate ? effectiveRate[1] : text);
  const interestType = text.startsWith('P') ? LoanInterestTypes.Variable : undefined;
  return { interestRate, interestType };
}

export function parseLoanNumber(scheduleHref: string): string | undefined {
  const match = /luachSilukin\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*\)/.exec(scheduleHref);
  return match ? match[1] : undefined;
}

export function mapLoanRow(row: ScrapedLoanRow, accountNumber: string): Loan | null {
  const { cells } = row;
  if (cells.length !== COLUMN_COUNT) {
    debug('unexpected loans table row with %d cells', cells.length);
    return null;
  }

  const loanId = parseLoanNumber(row.scheduleHref);
  const originalAmount = parseAmount(cells[COLUMN_ORIGINAL_AMOUNT]);
  if (!loanId || originalAmount === undefined) {
    debug('could not parse the loan number or original amount');
    return null;
  }

  return {
    type: LoanTypes.Loan,
    accountNumber,
    loanId,
    name: cells[COLUMN_NAME].split('\n')[0].trim(),
    currency: SHEKEL_CURRENCY,
    originalAmount,
    totalBalance: parseAmount(cells[COLUMN_TOTAL_BALANCE]),
    startDate: parseDate(cells[COLUMN_START_DATE]),
    endDate: parseDate(cells[COLUMN_END_DATE]),
    nextPaymentAmount: parseAmount(cells[COLUMN_NEXT_PAYMENT_AMOUNT]),
    nextPaymentDate: parseDate(cells[COLUMN_NEXT_PAYMENT_DATE]),
    ...parseInterestRate(cells[COLUMN_INTEREST_RATE]),
  };
}

/**
 * Maps all rows, or returns undefined if any of them can't be mapped, since a partial
 * list would misrepresent the customer's debt.
 */
export function mapLoanRows(rows: ScrapedLoanRow[], accountNumber: string): Loan[] | undefined {
  const loans = rows.map(row => mapLoanRow(row, accountNumber));
  return loans.every((loan): loan is Loan => !!loan) ? loans : undefined;
}

async function scrapeLoanRows(frame: Page | Frame): Promise<ScrapedLoanRow[]> {
  return frame.$$eval(
    `${LOANS_TABLE} > tbody > tr`,
    (rows, scheduleColumn) =>
      rows.map(row => {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        return {
          // innerText keeps <br> as a line break, so the name can be separated from the loan id below it
          cells: cells.map(cell => (cell as HTMLElement).innerText.trim()),
          scheduleHref: cells[scheduleColumn]?.querySelector('a')?.getAttribute('href') ?? '',
        };
      }),
    COLUMN_SCHEDULE,
  );
}

async function findLoansTableFrame(page: Page): Promise<Frame | null> {
  for (let attempt = 0; attempt < FIND_TABLE_ATTEMPTS; attempt++) {
    for (const frame of page.frames()) {
      if (await elementPresentOnPage(frame, LOANS_TABLE)) {
        return frame;
      }
    }
    await sleep(FIND_TABLE_INTERVAL_MS);
  }
  return null;
}

/**
 * Returns undefined, rather than an empty or partial list, whenever the loans could not be
 * fully fetched, so consumers can tell "no loans" apart from "unknown".
 *
 * The loans page shows the account currently selected in the session, so this must only be used
 * for customers with a single account.
 */
export async function fetchBeinleumiLoans(
  page: Page,
  baseUrl: string,
  getAccountNumber: (frame: Page | Frame) => Promise<string>,
): Promise<Loan[] | undefined> {
  debug('========== FETCHING LOANS ==========');

  try {
    await page.goto(new URL(LOANS_PATH, baseUrl).toString(), { waitUntil: 'networkidle2' });

    const frame = await findLoansTableFrame(page);
    if (!frame) {
      // the page shown to customers without loans hasn't been seen yet, so this can't be told apart from an error
      debug('loans table not found');
      return undefined;
    }

    const accountNumber = await getAccountNumber(frame);
    const rows = await scrapeLoanRows(frame);
    debug('found %d loans', rows.length);
    return mapLoanRows(rows, accountNumber);
  } catch (error) {
    debug('error fetching loans: %s', error);
    return undefined;
  }
}
