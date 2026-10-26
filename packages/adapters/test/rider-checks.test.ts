// P3.11.2: the fakes for identity, e-sign and the bank check behave like the providers will.
import { describe, expect, it } from 'vitest';
import { fakeBankCheck, fakeEsign, fakeKyc } from '../src/rider-checks.js';

describe('rider checks (P3.11.2)', () => {
  it('identity: pending until finished; only the name and last 4 kept; an unknown check fails', async () => {
    const kyc = fakeKyc();
    const s = await kyc.start({ riderId: 'RD-000001', name: 'Ravi Kumar', phone: '+919848012345' });
    expect(s.link).toBe(`https://kyc.example/${s.ref}`);
    expect(await kyc.status(s.ref)).toEqual({ state: 'pending' });
    kyc.finish(s.ref, { state: 'verified', nameOnId: 'RAVI KUMAR', idLast4: '1234' });
    expect(await kyc.status(s.ref)).toEqual({
      state: 'verified',
      nameOnId: 'RAVI KUMAR',
      idLast4: '1234',
    });
    expect((await kyc.status('kyc_nothing')).state).toBe('failed');
    const auto = fakeKyc({ auto: true });
    const a = await auto.start({
      riderId: 'RD-000001',
      name: 'Ravi Kumar',
      phone: '+919848012345',
    });
    expect(await auto.status(a.ref)).toMatchObject({ state: 'verified', nameOnId: 'RAVI KUMAR' });
  });

  it('e-sign and the bank check', async () => {
    const sign = fakeEsign({ auto: true, clock: () => 1_800_000_000 });
    const s = await sign.send({
      riderId: 'RD-000001',
      name: 'Ravi',
      phone: '+919848012345',
      agreement: 'rider-v1',
    });
    expect(await sign.status(s.ref)).toEqual({
      state: 'signed',
      signedAt: 1_800_000_000,
      signerName: 'RAVI',
    });
    const bank = fakeBankCheck({ failFor: new Map([['000111222333', 'account closed']]) });
    expect(await bank.check({ kind: 'upi', vpa: 'ravi@okaxis', name: 'Ravi Kumar' })).toMatchObject(
      { state: 'passed', nameAtBank: 'RAVI KUMAR' },
    );
    expect(
      await bank.check({
        kind: 'bank',
        accountNumber: '000111222333',
        ifsc: 'HDFC0001234',
        name: 'Ravi',
      }),
    ).toMatchObject({ state: 'failed', reason: 'account closed' });
  });
});
