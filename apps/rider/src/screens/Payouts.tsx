// P4.6 Payouts: when he is paid next (every Monday) and about how much, where it goes, each payout
// and how it went, and the tax (TDS) held back each quarter for his certificate.
import { formatRupees, paise, type RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ApiError, call } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color } from '../theme';
import { Alert, Label, LinkButton, Muted, Screen, Title, Words, s } from '../ui';

type State = 'sending' | 'paid' | 'retrying' | 'next-run' | 'held';

export interface PayoutsPage {
  readonly nextDate: string;
  readonly owedPaise: number;
  readonly account: string | null;
  readonly history: readonly {
    readonly date: string;
    readonly amountPaise: number;
    readonly state: State;
  }[];
  readonly tds: readonly { readonly quarter: string; readonly paise: number }[];
}

const rupees = (p: number) => formatRupees(paise(p)).replace(/\.00$/, '');
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const STATE_COLOR: Record<State, string> = {
  paid: color.done,
  sending: '#9AA3FF',
  retrying: '#F5B83D',
  'next-run': '#F5B83D',
  held: color.error,
};

export function Payouts({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<PayoutsPage>();
  const [error, setError] = useState('');
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;

  const load = useCallback(async () => {
    try {
      setPage(await call<PayoutsPage>('/rider/payouts', { token }));
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

  return (
    <Screen>
      <Title>{say(lang, 'payoutsTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}
      {!page && error === '' && <Muted>{say(lang, 'loading')}</Muted>}
      {page && (
        <>
          <View style={[s.card, { borderColor: color.volt }]}>
            <Label>{say(lang, 'nextPayout', { d: dmy(page.nextDate) })}</Label>
            <Words weight="extrabold" style={{ color: color.text, fontSize: 34, lineHeight: 42 }}>
              {rupees(page.owedPaise)}
            </Words>
            <Muted small>{say(lang, 'nextPayoutNote')}</Muted>
            {page.account ? (
              <Muted small>{say(lang, 'paidTo', { account: page.account })}</Muted>
            ) : (
              <Alert>{say(lang, 'noAccount')}</Alert>
            )}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'payoutHistory')}</Label>
            {page.history.length === 0 && <Muted small>{say(lang, 'noPayoutsYet')}</Muted>}
            {page.history.map((h) => (
              <View key={h.date} style={{ gap: 2, paddingVertical: 6 }}>
                <View style={[s.row, { justifyContent: 'space-between' }]}>
                  <Words style={[s.figures, { fontSize: 15 }]}>{dmy(h.date)}</Words>
                  <Words style={[s.figures, { fontSize: 15 }]}>{rupees(h.amountPaise)}</Words>
                </View>
                <Words weight="semibold" style={{ color: STATE_COLOR[h.state], fontSize: 13 }}>
                  {say(lang, `payout.${h.state}` as Key)}
                </Words>
              </View>
            ))}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'tdsTitle')}</Label>
            {page.tds.length === 0 && <Muted small>{say(lang, 'noTdsYet')}</Muted>}
            {page.tds.map((t) => (
              <View
                key={t.quarter}
                style={[s.row, { justifyContent: 'space-between', minHeight: 30 }]}
              >
                <Words style={{ color: color.text, fontSize: 15 }}>{t.quarter}</Words>
                <Words style={[s.figures, { fontSize: 15 }]}>{rupees(t.paise)}</Words>
              </View>
            ))}
            <Muted small>{say(lang, 'tdsNote')}</Muted>
          </View>
        </>
      )}
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
