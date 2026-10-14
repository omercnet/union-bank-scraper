import { type Page } from 'puppeteer';
import { LoanInterestTypes, LoanLinkageTypes, LoanTypes } from '../../transactions';
import {
  fetchLeumiLoans,
  mapInterestType,
  mapLinkage,
  mapMortgage,
  mapMortgageTrack,
  mapPortfolioAccountNumber,
  type LeumiMortgageDetail,
  type LeumiMortgageTrack,
} from './leumi-loans';

const fixedTrack: LeumiMortgageTrack = {
  loanId: '111',
  productName: 'ריבית קבועה לא צמודה',
  currencyLeumi: '080',
  loanAmount: 300000,
  fundBalance: 250000,
  clearingBalance: 251000,
  annualInterestPercent: 4.5,
  interestType: 'FIXED',
  linkageBase: 'לא',
  loanCreditDate: '15.03.22',
  calculateEndDate: '10.03.47',
  paymentItems: [
    { paymentDate: '10.2026', paymentAmount: 1510 },
    { paymentDate: '09.2026', paymentAmount: 1500 },
  ],
};

const primeTrack: LeumiMortgageTrack = {
  ...fixedTrack,
  loanId: '222',
  productName: 'ריבית פריים',
  loanAmount: 200000,
  fundBalance: 150000,
  clearingBalance: 150500,
  annualInterestPercent: 5.25,
  interestType: 'VARIABLE',
  paymentItems: [
    { paymentDate: '10.2026', paymentAmount: 990 },
    { paymentDate: '09.2026', paymentAmount: 1000 },
  ],
};

const mortgageDetail: LeumiMortgageDetail = {
  mortgageKey: '1234567890123',
  currencyLeumi: '080',
  clearingBalance: 401500,
  mortgageAmount: 500000,
  bookingDate: '15.03.22',
  mortgageEndDate: '10.03.47',
  mortgagePurpose: 'לווה פרטי-מגורים',
  portfolioAccountsItems: [{ portfolioAccountNum: '10-123-4567890' }],
  balanceItems: [{ fundBalance: 400000, clearingBalance: 401500 }],
};

describe('mapPortfolioAccountNumber', () => {
  test('converts the portfolio format to the transactions account number format', () => {
    expect(mapPortfolioAccountNumber('10-123-4567890')).toBe('123-45678_90');
  });

  test('returns the input unchanged when it does not match the expected format', () => {
    expect(mapPortfolioAccountNumber('unexpected')).toBe('unexpected');
  });
});

describe('mapLinkage', () => {
  test('maps the "no linkage" label', () => {
    expect(mapLinkage('לא')).toBe(LoanLinkageTypes.None);
  });

  test('maps CPI linkage', () => {
    expect(mapLinkage('100% הצמדה למדד')).toBe(LoanLinkageTypes.Cpi);
  });

  test('returns undefined for unknown or missing labels', () => {
    expect(mapLinkage('הצמדה לדולר')).toBeUndefined();
    expect(mapLinkage(null)).toBeUndefined();
  });
});

describe('mapInterestType', () => {
  test('maps known interest types', () => {
    expect(mapInterestType('FIXED')).toBe(LoanInterestTypes.Fixed);
    expect(mapInterestType('VARIABLE')).toBe(LoanInterestTypes.Variable);
  });

  test('returns undefined for unknown types', () => {
    expect(mapInterestType('OTHER')).toBeUndefined();
    expect(mapInterestType(undefined)).toBeUndefined();
  });
});

describe('mapMortgageTrack', () => {
  test('maps a track, taking the newest payment as the last payment', () => {
    expect(mapMortgageTrack(fixedTrack, '123-45678_90')).toEqual({
      type: LoanTypes.Mortgage,
      accountNumber: '123-45678_90',
      loanId: '111',
      name: 'ריבית קבועה לא צמודה',
      currency: 'ILS',
      originalAmount: 300000,
      principalBalance: 250000,
      totalBalance: 251000,
      startDate: expect.stringMatching(/^2022-03-1[45]T/),
      endDate: expect.stringMatching(/^2047-03-(09|10)T/),
      lastPaymentAmount: 1510,
      interestRate: 4.5,
      interestType: LoanInterestTypes.Fixed,
      linkage: LoanLinkageTypes.None,
    });
  });

  test('returns null for an unknown currency rather than guessing', () => {
    expect(mapMortgageTrack({ ...fixedTrack, currencyLeumi: '999' }, '123-45678_90')).toBeNull();
  });

  test('leaves dates undefined when they are missing or malformed', () => {
    const track = mapMortgageTrack({ ...fixedTrack, loanCreditDate: null, calculateEndDate: '2047-03-10' }, '');
    expect(track?.startDate).toBeUndefined();
    expect(track?.endDate).toBeUndefined();
  });

  test('leaves the last payment undefined when there is no payment history', () => {
    expect(mapMortgageTrack({ ...fixedTrack, paymentItems: [] }, '')?.lastPaymentAmount).toBeUndefined();
  });
});

describe('mapMortgage', () => {
  test('maps the mortgage and nests its tracks', () => {
    const mortgage = mapMortgage(mortgageDetail, [fixedTrack, primeTrack]);

    expect(mortgage).toMatchObject({
      type: LoanTypes.Mortgage,
      accountNumber: '123-45678_90',
      loanId: '1234567890123',
      name: 'לווה פרטי-מגורים',
      currency: 'ILS',
      originalAmount: 500000,
      principalBalance: 400000,
      totalBalance: 401500,
      lastPaymentAmount: 2500,
    });
    expect(mortgage?.tracks?.map(track => track.loanId)).toEqual(['111', '222']);
    expect(mortgage?.tracks?.every(track => track.accountNumber === '123-45678_90')).toBe(true);
  });

  test('does not sum last payments from different months', () => {
    const lateTrack = { ...primeTrack, paymentItems: [{ paymentDate: '09.2026', paymentAmount: 1000 }] };
    expect(mapMortgage(mortgageDetail, [fixedTrack, lateTrack])?.lastPaymentAmount).toBeUndefined();
  });

  test('leaves tracks undefined when they could not be fetched, not empty', () => {
    const mortgage = mapMortgage(mortgageDetail, undefined);
    expect(mortgage?.tracks).toBeUndefined();
    expect(mortgage?.lastPaymentAmount).toBeUndefined();
  });

  test('leaves tracks undefined when any track cannot be mapped, rather than returning a partial list', () => {
    expect(mapMortgage(mortgageDetail, [fixedTrack, { ...primeTrack, currencyLeumi: '999' }])?.tracks).toBeUndefined();
  });

  test('returns null for an unknown currency', () => {
    expect(mapMortgage({ ...mortgageDetail, currencyLeumi: '999' }, [fixedTrack])).toBeNull();
  });

  test('returns null when the principal balance is missing, rather than reporting zero', () => {
    expect(mapMortgage({ ...mortgageDetail, balanceItems: [] }, [fixedTrack])).toBeNull();
  });
});

describe('fetchLeumiLoans', () => {
  // fetchGetWithinPage resolves `page.evaluate` to [responseText, status]
  function mockPage(responses: Record<string, unknown>): Page {
    return {
      evaluate: jest.fn((_fn: unknown, url: string) => {
        const key = Object.keys(responses).find(suffix => url.endsWith(suffix));
        if (!key) {
          return Promise.reject(new Error(`unexpected url ${url}`));
        }
        const response = responses[key];
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve([typeof response === 'string' ? response : JSON.stringify(response), 200]);
      }),
    } as unknown as Page;
  }

  const mortgageDetailsResponse = { loanMortgageItems: [{ MortgageDetail: mortgageDetail }] };
  const loanInfoResponse = { MortgageDetails: { loansItems: [fixedTrack, primeTrack] } };

  test('fetches mortgages and their tracks', async () => {
    const page = mockPage({ '/mortgageDetails': mortgageDetailsResponse, '/loanInfo': loanInfoResponse });
    const loans = await fetchLeumiLoans(page);
    expect(loans).toHaveLength(1);
    expect(loans?.[0].tracks).toHaveLength(2);
  });

  test('returns an empty list when the customer has no mortgages', async () => {
    const page = mockPage({ '/mortgageDetails': { loanMortgageItems: [] } });
    expect(await fetchLeumiLoans(page)).toEqual([]);
  });

  test('returns undefined, not an empty list, when the response is not the expected shape', async () => {
    const page = mockPage({ '/mortgageDetails': { error: 'something' } });
    expect(await fetchLeumiLoans(page)).toBeUndefined();
  });

  test('returns undefined when the response is not JSON, e.g. a login page', async () => {
    const page = mockPage({ '/mortgageDetails': '<html>login</html>' });
    expect(await fetchLeumiLoans(page)).toBeUndefined();
  });

  test('returns undefined when the request fails', async () => {
    const page = mockPage({ '/mortgageDetails': new Error('network') });
    expect(await fetchLeumiLoans(page)).toBeUndefined();
  });

  test('keeps the mortgage without tracks when only the tracks request fails', async () => {
    const page = mockPage({ '/mortgageDetails': mortgageDetailsResponse, '/loanInfo': new Error('network') });
    const loans = await fetchLeumiLoans(page);
    expect(loans).toHaveLength(1);
    expect(loans?.[0].tracks).toBeUndefined();
  });

  test('returns undefined when any mortgage cannot be mapped, rather than a partial list', async () => {
    const page = mockPage({
      '/mortgageDetails': {
        loanMortgageItems: [
          { MortgageDetail: mortgageDetail },
          { MortgageDetail: { ...mortgageDetail, mortgageKey: '999', currencyLeumi: '999' } },
        ],
      },
      '/loanInfo': loanInfoResponse,
    });
    expect(await fetchLeumiLoans(page)).toBeUndefined();
  });
});
