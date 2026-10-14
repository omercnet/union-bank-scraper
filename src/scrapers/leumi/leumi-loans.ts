import moment from 'moment';
import { type Page } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../../constants';
import { getDebug } from '../../helpers/debug';
import { fetchGetWithinPage } from '../../helpers/fetch';
import { LoanInterestTypes, LoanLinkageTypes, LoanTypes, type Loan } from '../../transactions';

const debug = getDebug('leumi-loans');
const BASE_URL = 'https://hb2.bankleumi.co.il';
const MORTGAGE_DETAILS_URL = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/mortgageDetails`;
const getMortgageLoanInfoUrl = (mortgageKey: string) =>
  `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/${mortgageKey}/loanInfo`;
const SUMMARY_DATA_URL = `${BASE_URL}/UIApiProxy/v1/digital-retails/mobile/accounts/1/SummaryData`;
const LOAN_ACTIVITY_URL = `${BASE_URL}/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx`;

const DATE_FORMAT = 'DD.MM.YY';
const LOAN_PAGE_DATE_FORMAT = 'DD/MM/YY';

// the account type of regular loans in the summary data
const SUMMARY_LOAN_TYPE = 'LOAN';

const LOAN_SELECTOR = '#ddlAccounts_m_ddl';
// value of the "choose a loan" placeholder option
const LOAN_SELECTOR_PLACEHOLDER = '-1';
const LOAN_DETAILS_PANEL = '#pnlVariousData';
const LOAN_FIELD_LABEL_SELECTOR = 'td[class^="Summary_lable"]';

// labels of the loan details page fields, without the trailing colon
const LOAN_LABELS = {
  type: 'סוג',
  account: 'חשבון',
  loanNumber: 'מספר הלוואה',
  currency: 'מטבע',
  originalAmount: 'סכום הלוואה מקורי',
  principalBalance: 'יתרת קרן',
  nextPaymentAmount: 'סכום התשלום הבא',
  linkage: 'סוג הצמדה',
  interestRate: 'שיעור ריבית',
  startDate: 'תאריך העמדת הלוואה',
  endDate: 'תאריך סיום',
  nextPaymentDate: 'תאריך התשלום הבא',
};

const LOAN_PAGE_CURRENCIES: Record<string, string> = {
  '₪': SHEKEL_CURRENCY,
};

// linkage labels seen on the loan details page
const LOAN_PAGE_LINKAGES: Record<string, LoanLinkageTypes> = {
  'לא צמוד': LoanLinkageTypes.None,
};

// marks a fixed rate in the loan type label, e.g. "לא צמוד ר.קבועה"
const FIXED_RATE_LABEL = 'ר.קבועה';

// Leumi's internal currency codes
const LEUMI_CURRENCIES: Record<string, string> = {
  '080': SHEKEL_CURRENCY,
};

// labels of the linkage base field on mortgage tracks
const LINKAGE_NONE_LABEL = 'לא';
const LINKAGE_CPI_LABEL = 'הצמדה למדד';

export interface LeumiMortgageDetail {
  mortgageKey: string;
  currencyLeumi: string;
  clearingBalance: number;
  mortgageAmount: number;
  bookingDate: string;
  mortgageEndDate: string;
  mortgagePurpose?: string;
  portfolioAccountsItems?: { portfolioAccountNum: string }[];
  balanceItems?: { fundBalance: number; clearingBalance: number }[];
}

export interface LeumiMortgageDetailsResponse {
  loanMortgageItems?: { MortgageDetail: LeumiMortgageDetail }[] | null;
}

export interface LeumiMortgageTrack {
  loanId: string;
  productName?: string;
  currencyLeumi: string;
  loanAmount: number;
  fundBalance: number;
  clearingBalance: number;
  annualInterestPercent?: number | null;
  interestType?: string | null;
  linkageBase?: string | null;
  loanCreditDate?: string | null;
  calculateEndDate?: string | null;
  // the last payments made, newest first, with month-only dates ("MM.YYYY")
  paymentItems?: { paymentDate: string; paymentAmount: number }[] | null;
}

export interface LeumiLoanInfoResponse {
  MortgageDetails?: { loansItems?: LeumiMortgageTrack[] | null } | null;
}

function parseDate(value?: string | null, format = DATE_FORMAT): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = moment(value.trim(), format, true);
  return date.isValid() ? date.toISOString() : undefined;
}

function parseAmount(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const amount = parseFloat(value.replace(/[^\d.-]/g, ''));
  return Number.isNaN(amount) ? undefined : amount;
}

export function mapLeumiCurrency(code: string): string | undefined {
  return LEUMI_CURRENCIES[code];
}

/**
 * Converts a mortgage portfolio account ("10-BBB-AAAAASS") to the account number format
 * used by the transactions scraper ("BBB-AAAAA_SS"), so loans can be matched to accounts.
 */
export function mapPortfolioAccountNumber(portfolioAccountNum: string): string {
  const match = /^\d+-(\d+)-(\d+)(\d{2})$/.exec(portfolioAccountNum);
  if (!match) {
    return portfolioAccountNum;
  }
  const [, branch, account, suffix] = match;
  return `${branch}-${account}_${suffix}`;
}

export function mapLinkage(linkageBase?: string | null): LoanLinkageTypes | undefined {
  if (!linkageBase) {
    return undefined;
  }
  if (linkageBase.trim() === LINKAGE_NONE_LABEL) {
    return LoanLinkageTypes.None;
  }
  if (linkageBase.includes(LINKAGE_CPI_LABEL)) {
    return LoanLinkageTypes.Cpi;
  }
  return undefined;
}

export function mapInterestType(interestType?: string | null): LoanInterestTypes | undefined {
  switch (interestType) {
    case 'FIXED':
      return LoanInterestTypes.Fixed;
    case 'VARIABLE':
      return LoanInterestTypes.Variable;
    default:
      return undefined;
  }
}

export function mapMortgageTrack(track: LeumiMortgageTrack, accountNumber: string): Loan | null {
  const currency = mapLeumiCurrency(track.currencyLeumi);
  if (!currency) {
    debug('unknown currency code %s on mortgage track', track.currencyLeumi);
    return null;
  }

  return {
    type: LoanTypes.Mortgage,
    accountNumber,
    loanId: track.loanId,
    name: track.productName,
    currency,
    originalAmount: track.loanAmount,
    principalBalance: track.fundBalance,
    totalBalance: track.clearingBalance,
    startDate: parseDate(track.loanCreditDate),
    endDate: parseDate(track.calculateEndDate),
    lastPaymentAmount: track.paymentItems?.[0]?.paymentAmount,
    interestRate: track.annualInterestPercent ?? undefined,
    interestType: mapInterestType(track.interestType),
    linkage: mapLinkage(track.linkageBase),
  };
}

/**
 * Sums the tracks' most recent payments, only when every track reports a payment for the same month.
 */
function getMortgageLastPaymentAmount(tracks: LeumiMortgageTrack[]): number | undefined {
  const lastPayments = tracks.map(track => track.paymentItems?.[0]);
  if (!lastPayments.length || lastPayments.some(payment => payment?.paymentDate !== lastPayments[0]?.paymentDate)) {
    return undefined;
  }
  return lastPayments.reduce((sum, payment) => sum + (payment?.paymentAmount ?? 0), 0);
}

/**
 * Maps the tracks, or returns undefined if any of them can't be mapped, since a partial
 * list of tracks would misrepresent the mortgage.
 */
function mapMortgageTracks(tracks: LeumiMortgageTrack[] | undefined, accountNumber: string): Loan[] | undefined {
  if (!tracks) {
    return undefined;
  }
  const mapped = tracks.map(track => mapMortgageTrack(track, accountNumber));
  return mapped.every((track): track is Loan => !!track) ? mapped : undefined;
}

/**
 * @param tracks the mortgage tracks, or undefined if they could not be fetched
 */
export function mapMortgage(detail: LeumiMortgageDetail, tracks: LeumiMortgageTrack[] | undefined): Loan | null {
  const currency = mapLeumiCurrency(detail.currencyLeumi);
  if (!currency) {
    debug('unknown currency code %s on mortgage', detail.currencyLeumi);
    return null;
  }
  if (!detail.balanceItems?.length) {
    debug('mortgage has no balance items');
    return null;
  }

  const portfolioAccountNum = detail.portfolioAccountsItems?.[0]?.portfolioAccountNum;
  const accountNumber = portfolioAccountNum ? mapPortfolioAccountNumber(portfolioAccountNum) : '';

  return {
    type: LoanTypes.Mortgage,
    accountNumber,
    loanId: detail.mortgageKey,
    name: detail.mortgagePurpose,
    currency,
    originalAmount: detail.mortgageAmount,
    principalBalance: detail.balanceItems.reduce((sum, item) => sum + item.fundBalance, 0),
    totalBalance: detail.clearingBalance,
    startDate: parseDate(detail.bookingDate),
    endDate: parseDate(detail.mortgageEndDate),
    lastPaymentAmount: tracks ? getMortgageLastPaymentAmount(tracks) : undefined,
    tracks: mapMortgageTracks(tracks, accountNumber),
  };
}

async function fetchMortgageTracks(page: Page, mortgageKey: string): Promise<LeumiMortgageTrack[] | undefined> {
  try {
    const loanInfo = await fetchGetWithinPage<LeumiLoanInfoResponse>(page, getMortgageLoanInfoUrl(mortgageKey));
    const tracks = loanInfo?.MortgageDetails?.loansItems;
    return Array.isArray(tracks) ? tracks : undefined;
  } catch (error) {
    debug('error fetching mortgage tracks: %s', error);
    return undefined;
  }
}

/**
 * Maps the label/value pairs of a loan details page, e.g. { "מספר הלוואה": "123" }.
 */
export function mapLoanPageFields(fields: Record<string, string>): Loan | null {
  const currency = LOAN_PAGE_CURRENCIES[fields[LOAN_LABELS.currency]];
  const loanId = fields[LOAN_LABELS.loanNumber];
  const account = fields[LOAN_LABELS.account];
  const originalAmount = parseAmount(fields[LOAN_LABELS.originalAmount]);
  if (!currency || !loanId || !account || originalAmount === undefined) {
    debug('could not parse the loan currency, number, account or original amount');
    return null;
  }

  const name = fields[LOAN_LABELS.type];
  return {
    type: LoanTypes.Loan,
    accountNumber: account.replace('/', '_'),
    loanId,
    name,
    currency,
    originalAmount,
    principalBalance: parseAmount(fields[LOAN_LABELS.principalBalance]),
    startDate: parseDate(fields[LOAN_LABELS.startDate], LOAN_PAGE_DATE_FORMAT),
    endDate: parseDate(fields[LOAN_LABELS.endDate], LOAN_PAGE_DATE_FORMAT),
    nextPaymentAmount: parseAmount(fields[LOAN_LABELS.nextPaymentAmount]),
    nextPaymentDate: parseDate(fields[LOAN_LABELS.nextPaymentDate], LOAN_PAGE_DATE_FORMAT),
    interestRate: parseAmount(fields[LOAN_LABELS.interestRate]),
    interestType: name?.includes(FIXED_RATE_LABEL) ? LoanInterestTypes.Fixed : undefined,
    linkage: LOAN_PAGE_LINKAGES[fields[LOAN_LABELS.linkage]],
  };
}

interface LeumiSummaryData {
  multiCheckingFlag?: boolean;
  TotalPerTypeItems?: { accountType: string }[] | null;
}

/**
 * Tells from the account summary whether the customer has regular loans, so the loans page
 * is only required when there are loans to read from it. Returns undefined when it can't tell.
 */
export function hasRegularLoans(summary: LeumiSummaryData | null): boolean | undefined {
  // the summary is of a single account, so it can't rule out loans of other accounts
  if (!summary || !Array.isArray(summary.TotalPerTypeItems) || summary.multiCheckingFlag !== false) {
    return undefined;
  }
  return summary.TotalPerTypeItems.some(item => item.accountType === SUMMARY_LOAN_TYPE);
}

async function scrapeLoanPageFields(page: Page): Promise<Record<string, string>> {
  return page.$$eval(LOAN_FIELD_LABEL_SELECTOR, labels =>
    Object.fromEntries(
      labels.map(label => [
        (label.textContent ?? '').replace(':', '').trim(),
        (label.nextElementSibling?.textContent ?? '').trim(),
      ]),
    ),
  );
}

/**
 * Reads the loan details pages, one per loan in the loans dropdown.
 */
async function fetchRegularLoans(page: Page): Promise<Loan[] | undefined> {
  await page.goto(LOAN_ACTIVITY_URL, { waitUntil: 'networkidle2' });
  if (!(await page.$(LOAN_SELECTOR))) {
    debug('loans dropdown not found');
    return undefined;
  }

  const loanIndexes = await page.$$eval(
    `${LOAN_SELECTOR} option`,
    (options, placeholder) => options.map(option => option.value).filter(value => !!value && value !== placeholder),
    LOAN_SELECTOR_PLACEHOLDER,
  );
  debug('found %d regular loans', loanIndexes.length);

  // each loan is shown on its own page, so they must be fetched sequentially
  const loans: Loan[] = [];
  for (const loanIndex of loanIndexes) {
    await page.goto(`${LOAN_ACTIVITY_URL}?index=${encodeURIComponent(loanIndex)}`, { waitUntil: 'networkidle2' });
    if (!(await page.$(LOAN_DETAILS_PANEL))) {
      debug('loan details not found');
      return undefined;
    }
    const loan = mapLoanPageFields(await scrapeLoanPageFields(page));
    if (!loan) {
      return undefined;
    }
    loans.push(loan);
  }
  return loans;
}

async function fetchMortgages(page: Page): Promise<Loan[] | undefined> {
  const mortgageDetails = await fetchGetWithinPage<LeumiMortgageDetailsResponse>(page, MORTGAGE_DETAILS_URL);
  const mortgages = mortgageDetails?.loanMortgageItems;
  if (!Array.isArray(mortgages)) {
    debug('unexpected mortgage details response');
    return undefined;
  }
  debug('found %d mortgages', mortgages.length);

  const loans: Loan[] = [];
  for (const { MortgageDetail: detail } of mortgages) {
    const tracks = await fetchMortgageTracks(page, detail.mortgageKey);
    const mortgage = mapMortgage(detail, tracks);
    if (!mortgage) {
      return undefined;
    }
    loans.push(mortgage);
  }
  return loans;
}

/**
 * Returns undefined, rather than an empty or partial list, whenever the loans could not be
 * fully fetched, so consumers can tell "no loans" apart from "unknown".
 */
export async function fetchLeumiLoans(page: Page): Promise<Loan[] | undefined> {
  debug('========== FETCHING LOANS ==========');

  try {
    const mortgages = await fetchMortgages(page);
    if (!mortgages) {
      return undefined;
    }

    const summary = await fetchGetWithinPage<LeumiSummaryData>(page, SUMMARY_DATA_URL, true).catch(() => null);
    const regularLoans = hasRegularLoans(summary) === false ? [] : await fetchRegularLoans(page);
    if (!regularLoans) {
      return undefined;
    }

    const loans = [...mortgages, ...regularLoans];
    debug('returning %d loans', loans.length);
    return loans;
  } catch (error) {
    debug('error fetching loans: %s', error);
    return undefined;
  }
}
