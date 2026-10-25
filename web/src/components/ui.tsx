import type { ReactNode } from 'react';
import { clamp01, severity } from '../format';

export const Card = ({
  title,
  meta,
  children,
  className = '',
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={`card ${className}`}>
    <header className="card-head">
      <h2>{title}</h2>
      {meta ? <div className="card-meta">{meta}</div> : null}
    </header>
    {children}
  </section>
);

export const Meter = ({
  label,
  value,
  cap,
  hint,
}: {
  label: string;
  value: number;
  cap: number;
  hint?: string;
}) => {
  const ratio = cap > 0 ? clamp01(value / cap) : 0;
  const tone = severity(ratio);
  return (
    <div className="meter">
      <div className="meter-row">
        <span className="meter-label">{label}</span>
        <span className="meter-value mono">
          {value.toFixed(value < 10 ? 2 : 0)}
          <span className="meter-cap"> / {cap}</span>
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${Math.max(ratio * 100, 1.5)}%` }} />
      </div>
      {hint ? <div className="meter-hint">{hint}</div> : null}
    </div>
  );
};

export const Sparkline = ({ series, height = 44 }: { series: number[]; height?: number }) => {
  if (series.length < 2) {
    return <div className="spark empty" style={{ height }}>awaiting ticks</div>;
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || max * 0.001 || 1;
  const width = 220;
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 6) - 3;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const up = series[series.length - 1] >= series[0];

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <polyline points={points} fill="none" stroke={up ? 'var(--ok)' : 'var(--danger)'} strokeWidth="1.6" />
    </svg>
  );
};

export const Chip = ({ tone, children }: { tone: 'ok' | 'danger' | 'muted' | 'warn' | 'accent'; children: ReactNode }) => (
  <span className={`chip ${tone}`}>{children}</span>
);

export const Hash = ({ value, label }: { value?: string; label?: string }) => (
  <span className="hash mono" title={value ?? ''}>
    {label ? <em>{label}</em> : null}
    {value ?? '—'}
  </span>
);
