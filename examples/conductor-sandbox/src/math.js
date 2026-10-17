// Number helpers. Task A1 of plan.json adds clamp() here.

/** The sum of a list of numbers: 0 for an empty list. */
export function sum(values) {
  return values.reduce((total, v) => total + v, 0)
}

/** The arithmetic mean: NaN for an empty list. */
export function mean(values) {
  return values.length === 0 ? NaN : sum(values) / values.length
}
