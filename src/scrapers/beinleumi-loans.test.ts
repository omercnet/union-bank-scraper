import { LoanInterestTypes, LoanTypes } from '../transactions';
import { mapLoanRow, mapLoanRows, parseInterestRate, parseLoanNumber, type ScrapedLoanRow } from './beinleumi-loans';

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

  test('does not report a principal balance, since the table only shows the total debt', () => {
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
