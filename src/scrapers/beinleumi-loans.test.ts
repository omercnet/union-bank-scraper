import { LoanInterestTypes, LoanTypes } from '../transactions';
import {
  mapLoanRow,
  mapLoanRows,
  parseInterestRate,
  parseLoanNumber,
  parseScheduleArgs,
  parseScheduleUrl,
  type ScrapedLoanRow,
} from './beinleumi-loans';

const loanRow: ScrapedLoanRow = {
  cells: [
    'הלוואה לכל מטרה\n123-456',
    '50,000.00',
    '15/03/24',
    'P-0.50 %\n( 5.50% )',
    '32,345.67',
    '15/03/29',
    '1,012.34',
    '15/11/26',
    '',
  ],
  scheduleHref: 'javascript:luachSilukin(105,20240315,456);',
};

describe('parseInterestRate', () => {
  test('takes the current rate in parentheses for prime based loans', () => {
    expect(parseInterestRate('P-0.50 %\n( 5.50% )')).toEqual({
      interestRate: 5.5,
      interestType: LoanInterestTypes.Variable,
    });
  });

  test('parses a plain rate without guessing its type', () => {
    expect(parseInterestRate('4.25 %')).toEqual({ interestRate: 4.25, interestType: undefined });
  });

  test('returns an undefined rate for unparsable text', () => {
    expect(parseInterestRate('').interestRate).toBeUndefined();
  });
});

describe('parseLoanNumber', () => {
  test('reads the loan number from the payment schedule link', () => {
    expect(parseLoanNumber('javascript:luachSilukin(105,20240315,456);')).toBe('456');
  });

  test('returns undefined for an unexpected link', () => {
    expect(parseLoanNumber('javascript:somethingElse();')).toBeUndefined();
  });
});

describe('parseScheduleArgs', () => {
  test('reads all the payment schedule link arguments', () => {
    expect(parseScheduleArgs('javascript:luachSilukin(105,20240315,456);')).toEqual({
      accountType: 105,
      loanDate: 20240315,
      loanNumber: '456',
    });
  });

  test('returns undefined for an unexpected link', () => {
    expect(parseScheduleArgs('javascript:luachSilukin(105);')).toBeUndefined();
  });
});

describe('parseScheduleUrl', () => {
  const baseUrl = 'https://online.example.co.il';
  const scheduleUrl = 'https://apps.example.co.il/Resources/loan-repayments?code=abc&X-FIBI-Transaction-ID=1';

  test('accepts a URL returned as a JSON string', () => {
    expect(parseScheduleUrl(JSON.stringify(scheduleUrl), baseUrl)).toBe(scheduleUrl);
  });

  test('accepts a URL returned as plain text', () => {
    expect(parseScheduleUrl(` ${scheduleUrl} `, baseUrl)).toBe(scheduleUrl);
  });

  test('rejects a URL without a code', () => {
    expect(parseScheduleUrl('https://apps.example.co.il/Resources/loan-repayments', baseUrl)).toBeUndefined();
  });

  test('rejects an error object or an empty response', () => {
    expect(parseScheduleUrl('{"error":"failed"}', baseUrl)).toBeUndefined();
    expect(parseScheduleUrl('', baseUrl)).toBeUndefined();
  });
});

describe('mapLoanRow', () => {
  test('maps a loans table row', () => {
    expect(mapLoanRow(loanRow, '123456')).toEqual({
      type: LoanTypes.Loan,
      accountNumber: '123456',
      loanId: '456',
      name: 'הלוואה לכל מטרה',
      currency: 'ILS',
      originalAmount: 50000,
      totalBalance: 32345.67,
      startDate: expect.stringMatching(/^2024-03-1[45]T/),
      endDate: expect.stringMatching(/^2029-03-1[45]T/),
      nextPaymentAmount: 1012.34,
      nextPaymentDate: expect.stringMatching(/^2026-11-1[45]T/),
      interestRate: 5.5,
      interestType: LoanInterestTypes.Variable,
    });
  });

  test('leaves the principal balance to the payment schedule, since the table only shows the total debt', () => {
    expect(mapLoanRow(loanRow, '123456')?.principalBalance).toBeUndefined();
  });

  test('returns null when the row has an unexpected number of cells', () => {
    expect(mapLoanRow({ ...loanRow, cells: loanRow.cells.slice(1) }, '123456')).toBeNull();
  });

  test('returns null when the loan number cannot be read', () => {
    expect(mapLoanRow({ ...loanRow, scheduleHref: '' }, '123456')).toBeNull();
  });
});

describe('mapLoanRows', () => {
  test('returns an empty list for a table without rows', () => {
    expect(mapLoanRows([], '123456')).toEqual([]);
  });

  test('returns undefined when any row cannot be mapped, rather than a partial list', () => {
    expect(mapLoanRows([loanRow, { ...loanRow, scheduleHref: '' }], '123456')).toBeUndefined();
  });
});
