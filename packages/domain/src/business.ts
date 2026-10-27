// P5.2: a business sets itself up on the brand portal: its GST number (the legal name, state and
// address then come from the GST record), the name shown on its campaigns, brand or agency, what
// kind of business it is, the email invoices go to and a mobile number for WhatsApp messages. A
// business with no GST number gives its legal name and state itself (invoices then carry no GSTIN).

/** What kind of business it is (for RECALL's sales and the ad reviewer; never priced on). */
export const BUSINESS_TYPES = [
  ['food', 'Food and drink'],
  ['retail', 'Shops and retail'],
  ['apps', 'Apps and online services'],
  ['education', 'Education and coaching'],
  ['health', 'Health, fitness and beauty'],
  ['real-estate', 'Real estate'],
  ['finance', 'Banking, insurance and finance'],
  ['auto', 'Vehicles and travel'],
  ['events', 'Events, films and entertainment'],
  ['other', 'Something else'],
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number][0];
export const isBusinessType = (x: unknown): x is BusinessType =>
  BUSINESS_TYPES.some(([k]) => k === x);

/** GST state codes and names (the GSTIN's first two digits). */
export const GST_STATES: readonly (readonly [string, string])[] = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
];
export const stateName = (code: string): string | undefined =>
  GST_STATES.find(([c]) => c === code)?.[1];

/** A GSTIN as typed ("36aabcu 9603r1zm") in capitals with no spaces. */
export const typedGstin = (typed: string): string => typed.replace(/[\s-]/g, '').toUpperCase();

/** An account id made from a name: "Chai Co (Hitech City)" → "chai-co-hitech-city". */
export function accountIdFrom(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
  return /^[a-z0-9]/.test(id) ? id : `business${id ? `-${id}` : ''}`.slice(0, 56);
}
