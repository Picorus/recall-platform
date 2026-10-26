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
