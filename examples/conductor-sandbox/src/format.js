// Formatting helpers. Tasks B1 and B2 of plan.json both edit this file, so the hub runs them one
// at a time (a file lock). Each adds its function under its own marker.

/** Two digits, zero-padded: 7 → "07". */
export function pad2(n) {
  return String(n).padStart(2, '0')
}

// B1: formatBytes() goes below this line.

/** A comma every three digits: 1234567 → "1,234,567". */
export function groupDigits(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// B2: formatDuration() goes below this line.
