// The made-up world of the demo: businesses (all invented: no real brand is shown), an agency, the
// staff who sign in, riders' names, and each brand's ads. Fixed, so every demo looks the same.
import type { AdTemplate } from '@recall/domain';

export interface DemoBrand {
  readonly brandId: string;
  readonly name: string;
  readonly legalName: string;
  readonly colour: string;
  readonly ads: readonly Pick<AdTemplate, 'headline' | 'offer' | 'code' | 'theme'>[];
}

export const BRANDS: readonly DemoBrand[] = [
  {
    brandId: 'masala-chai-co',
    name: 'Masala Chai Co',
    legalName: 'Masala Chai Company Pvt Ltd',
    colour: '#E8A33D',
    ads: [
      {
        headline: 'Cutting chai, 2 minutes away',
        offer: '₹20 off your first order',
        code: 'CHAI20',
        theme: 'midnight',
      },
      {
        headline: 'Rain outside? Chai inside.',
        offer: 'Free samosa with 2 chais',
        code: 'RAINY',
        theme: 'colour',
      },
    ],
  },
  {
    brandId: 'zippy-grocers',
    name: 'Zippy Grocers',
    legalName: 'Zippy Quick Commerce Pvt Ltd',
    colour: '#2BB673',
    ads: [
      {
        headline: 'Groceries in 12 minutes',
        offer: 'Flat ₹75 off above ₹499',
        code: 'ZIPPY75',
        theme: 'band',
      },
      {
        headline: 'Fresh vegetables every morning',
        offer: 'Free delivery today',
        code: '',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'fitzone-gyms',
    name: 'FitZone Gyms',
    legalName: 'FitZone Fitness LLP',
    colour: '#E5484D',
    ads: [
      {
        headline: 'Your first week is on us',
        offer: '7-day free trial',
        code: 'FIT7',
        theme: 'colour',
      },
      {
        headline: 'Open 5 am to 11 pm',
        offer: '20% off the yearly plan',
        code: '',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'biryani-house',
    name: 'Nawab Biryani House',
    legalName: 'Nawab Foods Pvt Ltd',
    colour: '#C2410C',
    ads: [
      {
        headline: 'Dum biryani since 1998',
        offer: 'Family pack ₹699',
        code: 'NAWAB',
        theme: 'band',
      },
      {
        headline: 'Late-night biryani till 2 am',
        offer: 'Free delivery after 11 pm',
        code: '',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'brightsmile-dental',
    name: 'BrightSmile Dental',
    legalName: 'BrightSmile Clinics Pvt Ltd',
    colour: '#0EA5E9',
    ads: [
      {
        headline: 'Free check-up this month',
        offer: 'Book in 30 seconds',
        code: '',
        theme: 'colour',
      },
      {
        headline: 'Painless cleaning, ₹499',
        offer: '6 clinics in Hyderabad',
        code: 'SMILE',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'quickfix-mobiles',
    name: 'QuickFix Mobiles',
    legalName: 'QuickFix Services Pvt Ltd',
    colour: '#7C3AED',
    ads: [
      {
        headline: 'Cracked screen? Fixed in 1 hr',
        offer: 'Doorstep pick-up',
        code: 'FIX100',
        theme: 'band',
      },
      {
        headline: 'Old phone, new cash',
        offer: 'Best price for your phone',
        code: '',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'lakeview-homes',
    name: 'Lakeview Homes',
    legalName: 'Lakeview Realty Pvt Ltd',
    colour: '#0F766E',
    ads: [
      {
        headline: '2 and 3 BHK near Hitech City',
        offer: 'Site visits every weekend',
        code: '',
        theme: 'midnight',
      },
      { headline: 'Move in by Diwali', offer: 'Zero brokerage', code: 'HOME0', theme: 'colour' },
    ],
  },
  {
    brandId: 'skillup-academy',
    name: 'SkillUp Academy',
    legalName: 'SkillUp Learning Pvt Ltd',
    colour: '#F59E0B',
    ads: [
      {
        headline: 'Learn to code in 12 weeks',
        offer: 'Free first class',
        code: 'SKILL',
        theme: 'band',
      },
      {
        headline: 'Weekend batches in Madhapur',
        offer: '₹2,000 off this month',
        code: '',
        theme: 'midnight',
      },
    ],
  },
  {
    brandId: 'pearl-jewellers',
    name: 'Pearl Jewellers',
    legalName: 'Pearl Gems and Jewellers Pvt Ltd',
    colour: '#BE185D',
    ads: [
      {
        headline: 'Hyderabad pearls, since 1960',
        offer: 'No making charges this week',
        code: '',
        theme: 'midnight',
      },
      {
        headline: 'Bridal collection is here',
        offer: 'Free gift with every set',
        code: 'PEARL',
        theme: 'colour',
      },
    ],
  },
  {
    brandId: 'cloudnine-cafe',
    name: 'CloudNine Café',
    legalName: 'CloudNine Hospitality LLP',
    colour: '#6366F1',
    ads: [
      {
        headline: 'Coffee and Wi-Fi till midnight',
        offer: 'Buy 1 get 1, 3–6 pm',
        code: 'CLOUD9',
        theme: 'colour',
      },
      { headline: 'Work from our café', offer: 'Free refills all day', code: '', theme: 'band' },
    ],
  },
];

/** An agency booking for two of the brands. */
export const AGENCY = {
  brandId: 'adwise-media',
  name: 'Adwise Media',
  legalName: 'Adwise Media Pvt Ltd',
};
export const AGENCY_CLIENTS = ['pearl-jewellers', 'cloudnine-cafe'];

/** Who signs in where. One password for every staff member in the demo. */
export const STAFF_PASSWORD = 'recall demo 2027';
export const STAFF = [
  {
    email: 'founder@recall.demo',
    name: 'Prateek (founder)',
    access: { role: 'super-admin' as const, areas: [] },
  },
  {
    email: 'sales@recall.demo',
    name: 'Sana (sales)',
    access: { role: 'admin' as const, areas: ['sales' as const, 'ad-review' as const] },
  },
  {
    email: 'ops@recall.demo',
    name: 'Omar (operations)',
    access: { role: 'admin' as const, areas: ['operations' as const, 'support' as const] },
  },
  {
    email: 'finance@recall.demo',
    name: 'Meena (finance)',
    access: { role: 'admin' as const, areas: ['finance' as const] },
  },
];
/** The brand owner's phone (Masala Chai Co) and the agency's email, for the brand portal. */
export const BRAND_PHONE = '+919000000001';
export const AGENCY_EMAIL = 'media@adwise.demo';

const FIRST = [
  'Ravi',
  'Suresh',
  'Mahesh',
  'Kiran',
  'Srinivas',
  'Venkat',
  'Raju',
  'Anil',
  'Prakash',
  'Naresh',
  'Imran',
  'Salman',
  'Arif',
  'Javed',
  'Rahul',
  'Vikram',
  'Sai',
  'Praveen',
  'Ramesh',
  'Ganesh',
  'Lakshmi',
  'Priya',
  'Swathi',
  'Anjali',
  'Divya',
  'Harish',
  'Sandeep',
  'Ashok',
  'Manoj',
  'Ajay',
];
const LAST = [
  'Kumar',
  'Reddy',
  'Rao',
  'Goud',
  'Naidu',
  'Yadav',
  'Khan',
  'Shaik',
  'Sharma',
  'Varma',
  'Chary',
  'Babu',
  'Patel',
  'Mohammed',
  'Singh',
  'Prasad',
  'Raju',
  'Achary',
];
const SERIES = ['TS09', 'TS07', 'TS08', 'TS10', 'TS13', 'TS11'];

/** Rider n (0-based): a name, a phone and a number plate, the same every time. */
export function riderOf(n: number) {
  const first = FIRST[n % FIRST.length] ?? 'Ravi';
  const last = LAST[Math.floor(n / FIRST.length) % LAST.length] ?? 'Kumar';
  const series = SERIES[n % SERIES.length] ?? 'TS09';
  const letters = String.fromCharCode(65 + (n % 26), 65 + (Math.floor(n / 26) % 26));
  return {
    riderId: `RD-${String(100001 + n).padStart(6, '0')}`,
    name: `${first} ${last}`,
    phone: `+9198${String(48000000 + n).padStart(8, '0')}`,
    plate: `${series}${letters}${String(1000 + ((n * 37) % 9000)).padStart(4, '0')}`,
  };
}
