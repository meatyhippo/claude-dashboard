/**
 * BA-edition icons, drawn in the same outline style as Icons.tsx (24-unit grid,
 * 1.75 stroke, round caps, currentColor), so they sit next to Rein's own.
 */
import type { ReactNode } from "react";

function I({ children }: { children: ReactNode }) {
  return (
    <svg className="icon ba-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function CloudIcon() {
  return (
    <I>
      <path d="M17.5 19H7a5 5 0 1 1 .9-9.92A6 6 0 0 1 19.5 11a4 4 0 0 1-2 8Z" />
    </I>
  );
}

export function LaptopIcon() {
  return (
    <I>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </I>
  );
}

export function SparkIcon() {
  return (
    <I>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
    </I>
  );
}

export function BoltIcon() {
  return (
    <I>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </I>
  );
}
