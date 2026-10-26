// Money on the admin site (P3.13.1): the shapes the API sends, and their words.

export const PAYMENT_NAMES = {
  paid: 'Paid',
  'paid-late': 'Paid after it was cancelled: owed back',
  'wrong-amount': 'Wrong amount: owed back',
} as const;

export const E_INVOICE = {
  'not needed': 'not needed yet',
  'getting close': 'needed soon: get it set up',
  needed: 'needed now',
} as const;

interface GstTotals {
  readonly count: number;
  readonly taxable: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
}

export interface MoneyMonth {
  readonly at: number;
  readonly month: string;
  readonly position: {
    readonly heldForCampaignsPaise: number;
    readonly owedBack: readonly { brandId: string; brandName: string; paise: number }[];
    readonly owedToAgenciesPaise: number;
    readonly owedToAggregatorsPaise: number;
    readonly owedToRidersPaise: number;
    readonly tdsPaise: number;
    readonly gstPaise: number;
  };
  readonly payments: readonly {
    paymentId: string;
    at: number;
    bookingId: string;
    brandId: string;
    brandName: string;
    amountPaise: number;
    state: keyof typeof PAYMENT_NAMES;
  }[];
  readonly paymentsTruncated: boolean;
  readonly documents: readonly {
    docNo: string;
    kind: 'invoice' | 'credit-note';
    issuedAt: number;
    againstDoc: string | null;
    bookingId: string;
    legalName: string;
    gstin: string | null;
    taxablePaise: number;
    gstPaise: number;
    totalPaise: number;
  }[];
  readonly documentsTruncated: boolean;
  readonly gst: {
    readonly month: string;
    readonly invoices: GstTotals;
    readonly creditNotes: GstTotals;
    readonly inputTaxCredit: number;
    readonly inputGstAwaitingInvoices: number;
    readonly netGstPayable: number;
    readonly tds: { riders: number; partners: number };
    readonly yearTurnover: number;
    readonly eInvoice: keyof typeof E_INVOICE;
    readonly missingTaxDetails: readonly string[];
  };
  readonly unknownPayments: readonly {
    linkId: string;
    paymentId: string | null;
    receivedAt: number;
  }[];
}

/** P3.13.2: an amount owed back to a brand, and where it stands. */
export type MoneyBackState = 'owed' | 'pending' | 'failed' | 'given up' | 'refunded' | 'by-hand';

export const BACK_NAMES: Record<MoneyBackState, string> = {
  owed: 'Owed',
  pending: 'Sent, waiting for the provider',
  failed: 'Failed, can be sent again',
  'given up': 'Provider cannot: pay by bank transfer',
  refunded: 'Sent back',
  'by-hand': 'Paid by bank transfer',
};

export const BACK_CHIP: Record<MoneyBackState, string> = {
  owed: 'rc-chip--paused',
  pending: 'rc-chip--paused',
  failed: 'rc-chip--stop',
  'given up': 'rc-chip--stop',
  refunded: 'rc-chip--go',
  'by-hand': 'rc-chip--go',
};

export interface OwedBackItem {
  readonly owedEntry: string;
  readonly kind: 'refund' | 'payment back';
  readonly bookingId: string | null;
  readonly brandName: string;
  readonly amountPaise: number;
  readonly owedAt: number;
  readonly why: string;
  readonly paymentId: string | null;
  readonly state: MoneyBackState;
  readonly reason: string | null;
  readonly tries: number;
  readonly history: readonly { at: number; by: string; text: string }[];
}

export interface OwedBackList {
  readonly items: readonly OwedBackItem[];
  readonly canPay: boolean;
  readonly canSend: boolean;
}
