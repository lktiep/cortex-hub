// Task file paths: normalisation and conflict tests for the dispatcher's file locks (spec §6.4).

/** `\` → `/`, runs of `/` collapsed, leading `./` removed. A trailing `/` (a directory) is kept. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

/** Normalises every path; globs are refused because a lock must name real paths. */
export function normalizeFiles(paths: string[]): string[] {
  return paths.map((p) => {
    if (/[*?[]/.test(p)) throw new Error(`globs are not supported: ${p}`)
    return normalizePath(p)
  })
}

function under(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}

/** True when a path of one list equals a path of the other, or lies under it as a directory. */
export function pathsConflict(a: string[], b: string[]): boolean {
  const left = a.map(normalizePath)
  const right = b.map(normalizePath)
  return left.some((x) => right.some((y) => x === y || under(x, y) || under(y, x)))
}
