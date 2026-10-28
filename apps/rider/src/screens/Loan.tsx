// P4.7 Screen loan: the screen is his, bought with a bank loan. What the bank reports (amount, EMI,
// next due date, EMIs left, the EMI holiday) and the day-90 bonus toward it. RECALL never collects
// the EMI: the bank does.
import { formatRupees, paise, type RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ApiError, call } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color } from '../theme';
import { Alert, Label, LinkButton, Muted, Screen, Title, Words, s } from '../ui';

export interface LoanPage {
  readonly bank: string;
  readonly loan: {
    readonly bank: string;
    readonly amountPaise: number;
    readonly emiPaise: number;
    readonly months: number;
    readonly status: 'applied' | 'approved' | 'rejected' | 'disbursed' | 'closed' | 'defaulted';
    readonly nextEmi?: string;
    readonly emisLeft: number;
    readonly holidayUntil: string | null;
  } | null;
  readonly day90: { readonly paise: number; readonly given: boolean } | null;
}

const rupees = (p: number) => formatRupees(paise(p)).replace(/\.00$/, '');
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function Line({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={[s.row, { justifyContent: 'space-between', minHeight: 30 }]}>
      <Words style={{ color: color.text, fontSize: 15, flexShrink: 1 }}>{label}</Words>
      <Words style={[s.figures, { fontSize: 15 }]}>{value}</Words>
    </View>
  );
}

export function Loan({
  lang,
  token,
  onSignOut,
  onBack,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
  /** Back to the Screen tab. */
  readonly onBack?: () => void;
}) {
  const [page, setPage] = useState<LoanPage>();
  const [error, setError] = useState('');
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;
  const load = useCallback(async () => {
    try {
      setPage(await call<LoanPage>('/rider/loan', { token }));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut.current();
      else
        setError(
          e instanceof ApiError && e.why ? sayError(lang, e.why, e.n) : say(lang, 'err.other'),
        );
    }
  }, [token, lang]);
  useEffect(() => {
    void load();
  }, [load]);

  const l = page?.loan;
  return (
    <Screen>
      {onBack && (
        <View style={{ alignSelf: 'flex-start' }}>
          <LinkButton label={say(lang, 'back')} onPress={onBack} />
        </View>
      )}
      <Title>{say(lang, 'loanTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}
      {!page && error === '' && <Muted>{say(lang, 'loading')}</Muted>}
      {page && !l && (
        <View style={s.card}>
          <Muted>{say(lang, 'loanNone', { bank: page.bank })}</Muted>
        </View>
      )}
      {l && (
        <View style={s.card}>
          <Label>{l.bank}</Label>
          <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
            {say(lang, `loan.${l.status}` as Key)}
          </Words>
          <Line label={say(lang, 'loanAmount')} value={rupees(l.amountPaise)} />
          <Line label={say(lang, 'loanEmi', { months: l.months })} value={rupees(l.emiPaise)} />
          {l.holidayUntil && <Muted>{say(lang, 'loanHoliday', { d: dmy(l.holidayUntil) })}</Muted>}
          {l.nextEmi && <Line label={say(lang, 'loanNext')} value={dmy(l.nextEmi)} />}
          {(l.status === 'disbursed' || l.status === 'defaulted') && (
            <Line label={say(lang, 'loanLeft')} value={String(l.emisLeft)} />
          )}
        </View>
      )}
      {page?.day90 && (
        <View style={s.card}>
          <Label>{say(lang, 'day90Title')}</Label>
          <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
            {rupees(page.day90.paise)}
          </Words>
          <Muted small>{say(lang, page.day90.given ? 'day90Given' : 'day90Later')}</Muted>
        </View>
      )}
      <View style={[s.card, { borderColor: color.volt }]}>
        <Muted>{say(lang, 'loanBankCollects')}</Muted>
      </View>
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
