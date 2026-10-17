// String helpers. Task A2 of plan.json adds titleCase() here.

/** Lowercase words joined by '-', everything else dropped: "Hello, World!" → "hello-world". */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
