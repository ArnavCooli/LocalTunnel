import React from 'react';

/**
 * The LocalTunnel mark: a tunnel mouth seen head-on, with the light at the far
 * end. Two rings rather than one — the inner arch is dimmer and stops short of
 * the floor, which is what makes it read as depth instead of concentric stripes.
 *
 * The same geometry is drawn by scripts/make-icon.mjs for the app icon, so the
 * numbers here and there must stay in step.
 */
export function LocalTunnelMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label="LocalTunnel"
    >
      {/* Mouth and floor, as one closed path. */}
      <path
        d="M4.8 19.44V11.28a7.2 7.2 0 0 1 14.4 0v8.16Z"
        stroke="#5C93FF"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {/* The ring further in. */}
      <path
        d="M8.04 18.6v-6.24a3.96 3.96 0 0 1 7.92 0v6.24"
        stroke="#365FC4"
        strokeWidth="1.32"
        strokeLinecap="round"
      />
      {/* The light at the end. */}
      <circle cx="12" cy="11.04" r="1.2" fill="#FAFAFA" />
    </svg>
  );
}
