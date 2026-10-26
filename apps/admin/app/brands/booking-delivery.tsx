'use client';
// P3.10: one booking's lines and where each stands (refunds are decided on the Delivery page).
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { DeliveryLine, DeliveryList } from '../../lib/delivery';
import DeliveryLines from '../delivery/delivery-lines';

export default function BookingDelivery({ bookingId }: { readonly bookingId: string }) {
  const [lines, setLines] = useState<readonly DeliveryLine[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<DeliveryList>(`/delivery/booking/${bookingId}`)
      .then((x) => {
        if (live) setLines(x.lines);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof ApiError ? e.message : 'Could not load delivery.');
      });
    return () => {
      live = false;
    };
  }, [bookingId]);
  return (
    <section className="stack" aria-label="Delivery">
      <h4 style={{ margin: 0 }}>Delivery</h4>
      {error && <p className="error">{error}</p>}
      {lines && (
        <DeliveryLines lines={lines} showBooking={false} canDecide={false} onChanged={() => {}} />
      )}
    </section>
  );
}
