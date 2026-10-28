// Small charts the portals share (P7.7.7): columns, a line (or area), a sparkline and a meter. No
// chart library and no hooks, so they render on the server and in the browser alike. Colours come
// from the design tokens (packages/design/charts.css), so light and dark both work. Each chart has
// one accent colour, light gridlines, a value on hover (pure CSS) and, for screen readers, a label
// with the key numbers and a hidden table of every value.
import type { CSSProperties, ReactNode } from 'react';
import { labelEvery, niceTicks, peak, position } from './chart-math';

export interface ChartPoint {
  /** Short label under the axis ("8am", "28 Oct"). */
  readonly label: string;
  /** Longer label for the hover and the table ("Tue 28 Oct, 8–9pm"); defaults to `label`. */
  readonly full?: string;
  readonly value: number;
  /** A second, lighter amount behind the bar (booked, promised); bars only. */
  readonly target?: number;
}

interface ChartBase {
  /** What is plotted ("Plays per hour, today"). */
  readonly title: string;
  /** The key numbers in a few words, shown under the title ("1,240 plays, busiest 7pm"). */
  readonly summary?: ReactNode;
  /** The same in plain text for screen readers (defaults to `summary` when it is a string). */
  readonly summaryText?: string;
  readonly points: readonly ChartPoint[];
  /** A value as people read it ("₹1,35,000", "1,240"). */
  readonly format?: (value: number) => string;
  /** A value on the axis, short ("₹1.4L"). Defaults to `format`. */
  readonly axisFormat?: (value: number) => string;
  /** Names for the value and the target in the legend, hover and table. */
  readonly valueName?: string;
  readonly targetName?: string;
  /** Plot height in pixels (the axis labels come on top of it). */
  readonly height?: number;
  /** Values are whole (counts, paise): axis steps are whole too. Default true. */
  readonly whole?: boolean;
  /** At most this many labels under the axis. */
  readonly maxLabels?: number;
  /** Shown instead of the plot when there are no points, or all are 0. */
  readonly empty?: string;
}

const plain = (v: number) => v.toLocaleString('en-IN');

/** "Plays per hour, today: 1,240 plays. 8am 12, 9am 40, …" — the numbers for a screen reader. */
function ariaText(p: ChartBase, fmt: (v: number) => string): string {
  const said = p.summaryText ?? (typeof p.summary === 'string' ? p.summary : '');
  const top = peak(p.points);
  const most = top ? `Highest ${fmt(top.value)} at ${top.full ?? top.label}.` : '';
  return [`${p.title}.`, said && `${said}.`, most].filter(Boolean).join(' ');
}

function Head({ title, summary }: Pick<ChartBase, 'title' | 'summary'>) {
  return (
    <figcaption className="rc-chart__head">
      <span className="rc-chart__title">{title}</span>
      {summary !== undefined && <span className="rc-chart__sum">{summary}</span>}
    </figcaption>
  );
}

function Legend({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <ul className="rc-chart__legend" aria-hidden="true">
      {items.map(([name, kind]) => (
        <li key={name}>
          <i className={`rc-chart__key rc-chart__key--${kind}`} />
          {name}
        </li>
      ))}
    </ul>
  );
}

/** Every value, for screen readers (the chart's table view). */
function Table({ p, fmt }: { p: ChartBase; fmt: (v: number) => string }) {
  const hasTarget = p.points.some((x) => x.target !== undefined);
  return (
    <table className="rc-chart__table" aria-label={`${p.title} (numbers)`}>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">{p.valueName ?? 'Value'}</th>
          {hasTarget && <th scope="col">{p.targetName ?? 'Target'}</th>}
        </tr>
      </thead>
      <tbody>
        {p.points.map((x, i) => (
          <tr key={i}>
            <th scope="row">{x.full ?? x.label}</th>
            <td>{fmt(x.value)}</td>
            {hasTarget && <td>{x.target === undefined ? '' : fmt(x.target)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The y axis numbers and the hairlines across the plot. */
function Grid({ ticks, fmt }: { ticks: readonly number[]; fmt: (v: number) => string }) {
  const t = { min: ticks[0] ?? 0, max: ticks.at(-1) ?? 1 };
  return (
    <>
      {ticks.map((v) => (
        <span
          key={`l${v}`}
          className="rc-chart__ytick"
          style={{ bottom: `${position(v, t)}%` }}
          aria-hidden="true"
        >
          {fmt(v)}
        </span>
      ))}
      {ticks.map((v) => (
        <i
          key={`g${v}`}
          className={`rc-chart__grid${v === 0 ? ' rc-chart__grid--zero' : ''}`}
          style={{ bottom: `${position(v, t)}%` }}
        />
      ))}
    </>
  );
}

/** Which side the hover note opens to, so it never leaves the chart at either end. */
const edge = (i: number, n: number) =>
  n > 4 && i < n * 0.2 ? ' is-start' : n > 4 && i >= n * 0.8 ? ' is-end' : '';

function Tip({ x, fmt, p }: { x: ChartPoint; fmt: (v: number) => string; p: ChartBase }) {
  return (
    <span className="rc-chart__tip" aria-hidden="true">
      <b>{fmt(x.value)}</b>
      {p.valueName && x.target !== undefined && ` ${p.valueName.toLowerCase()}`}
      {x.target !== undefined && (
        <span>
          of {fmt(x.target)} {(p.targetName ?? 'target').toLowerCase()}
        </span>
      )}
      <span>{x.full ?? x.label}</span>
    </span>
  );
}

function XLabels({ points, most }: { points: readonly ChartPoint[]; most: number }) {
  const every = labelEvery(points.length, most);
  return (
    <div className="rc-chart__x" aria-hidden="true">
      {points.map((x, i) => (
        <span key={i}>{i % every === 0 || i === points.length - 1 ? x.label : ''}</span>
      ))}
    </div>
  );
}

function Empty({ p }: { p: ChartBase }) {
  return (
    <figure className="rc-chart">
      <Head title={p.title} summary={p.summary} />
      <p className="rc-chart__empty">{p.empty ?? 'Nothing to show yet.'}</p>
    </figure>
  );
}

const isEmpty = (p: ChartBase) =>
  p.points.length === 0 || p.points.every((x) => x.value === 0 && !x.target);

/**
 * Columns, one per point, growing from 0 (below it for a negative amount). With `target`, a light
 * column behind each shows the amount booked or promised: one accent, one wash.
 */
export function BarChart(p: ChartBase) {
  if (isEmpty(p)) return <Empty p={p} />;
  const fmt = p.format ?? plain;
  const axis = p.axisFormat ?? fmt;
  const t = niceTicks(
    p.points.flatMap((x) => (x.target === undefined ? [x.value] : [x.value, x.target])),
    4,
    p.whole ?? true,
  );
  const zero = position(0, t);
  const hasTarget = p.points.some((x) => x.target !== undefined);
  const n = p.points.length;
  return (
    <figure className="rc-chart rc-chart--bars">
      <Head title={p.title} summary={p.summary} />
      {hasTarget && (
        <Legend
          items={[
            [p.valueName ?? 'Value', 'value'],
            [p.targetName ?? 'Target', 'target'],
          ]}
        />
      )}
      <div
        className="rc-chart__frame"
        role="img"
        aria-label={ariaText(p, fmt)}
        style={{ '--rc-chart-h': `${p.height ?? 160}px`, '--rc-chart-n': n } as CSSProperties}
      >
        <div className="rc-chart__plot">
          <Grid ticks={t.ticks} fmt={axis} />
          <div className="rc-chart__cols">
            {p.points.map((x, i) => {
              const at = position(x.value, t);
              return (
                <div key={i} className={`rc-chart__col${edge(i, n)}`}>
                  {x.target !== undefined && (
                    <span
                      className="rc-chart__bar rc-chart__bar--target"
                      style={{ bottom: `${zero}%`, height: `${position(x.target, t) - zero}%` }}
                    />
                  )}
                  <span
                    className={`rc-chart__bar${x.value < 0 ? ' is-neg' : ''}`}
                    style={{
                      bottom: `${Math.min(at, zero)}%`,
                      height: `${Math.abs(at - zero)}%`,
                    }}
                  />
                  <Tip x={x} fmt={fmt} p={p} />
                </div>
              );
            })}
          </div>
        </div>
        <XLabels points={p.points} most={p.maxLabels ?? 7} />
      </div>
      <Table p={p} fmt={fmt} />
    </figure>
  );
}

/**
 * A line over time (with a light wash under it when `area`), its last point marked. Hovering
 * anywhere over a point's slot shows a crosshair and the value.
 */
export function LineChart(p: ChartBase & { readonly area?: boolean }) {
  if (isEmpty(p)) return <Empty p={p} />;
  const fmt = p.format ?? plain;
  const axis = p.axisFormat ?? fmt;
  const t = niceTicks(
    p.points.map((x) => x.value),
    4,
    p.whole ?? true,
  );
  const n = p.points.length;
  const xs = p.points.map((_, i) => ((i + 0.5) / n) * 100);
  const ys = p.points.map((x) => 100 - position(x.value, t));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${ys[i]?.toFixed(3)}`).join(' ');
  const base = 100 - position(0, t);
  const wash = `${line} L${xs.at(-1)?.toFixed(3)} ${base} L${xs[0]?.toFixed(3)} ${base} Z`;
  return (
    <figure className="rc-chart rc-chart--line">
      <Head title={p.title} summary={p.summary} />
      <div
        className="rc-chart__frame"
        role="img"
        aria-label={ariaText(p, fmt)}
        style={{ '--rc-chart-h': `${p.height ?? 160}px`, '--rc-chart-n': n } as CSSProperties}
      >
        <div className="rc-chart__plot">
          <Grid ticks={t.ticks} fmt={axis} />
          <svg
            className="rc-chart__svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {p.area && <path className="rc-chart__area" d={wash} />}
            {n > 1 && <path className="rc-chart__line" d={line} />}
          </svg>
          <div className="rc-chart__cols">
            {p.points.map((x, i) => (
              <div
                key={i}
                className={`rc-chart__col rc-chart__col--line${edge(i, n)}${
                  i === n - 1 ? ' is-last' : ''
                }`}
              >
                <span className="rc-chart__dot" style={{ bottom: `${position(x.value, t)}%` }} />
                <Tip x={x} fmt={fmt} p={p} />
              </div>
            ))}
          </div>
        </div>
        <XLabels points={p.points} most={p.maxLabels ?? 7} />
      </div>
      <Table p={p} fmt={fmt} />
    </figure>
  );
}

/** A tiny trend line for a tile or a table row; the last value marked. */
export function Sparkline({
  values,
  label,
  className,
}: {
  readonly values: readonly number[];
  /** What it shows, with the key numbers ("Earnings, last 14 days: ₹4,200 in all"). */
  readonly label: string;
  readonly className?: string;
}) {
  const t = niceTicks(values, 2, false);
  const n = values.length;
  const pts = values.map((v, i) => [
    n > 1 ? (i / (n - 1)) * 100 : 50,
    100 - position(v, { min: Math.min(0, ...values), max: t.max }),
  ]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x?.toFixed(2)} ${y?.toFixed(2)}`).join(' ');
  const last = pts.at(-1);
  return (
    <span className={`rc-spark${className ? ` ${className}` : ''}`} role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="rc-spark__area" d={`${d} L100 100 L0 100 Z`} />
        <path className="rc-spark__line" d={d} />
      </svg>
      {last && <i className="rc-spark__dot" style={{ left: `${last[0]}%`, top: `${last[1]}%` }} />}
    </span>
  );
}

/** How far along one amount is against another (delivered of booked, paid of owed). */
export function Meter({
  label,
  value,
  max,
  format = plain,
  note,
  tone = 'data',
}: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly format?: (value: number) => string;
  /** Shown on the right ("of 1,200 booked"). */
  readonly note?: string;
  /** go: done or on track; stop: short (with words saying so, never the colour alone). */
  readonly tone?: 'data' | 'go' | 'stop';
}) {
  const share = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="rc-meter">
      <div className="rc-meter__words">
        <span>{label}</span>
        <span>
          <b>{format(value)}</b>
          {note && ` ${note}`}
        </span>
      </div>
      <div
        className={`rc-meter__track rc-meter--${tone}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={`${format(value)}${note ? ` ${note}` : ''}`}
      >
        <span style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}
