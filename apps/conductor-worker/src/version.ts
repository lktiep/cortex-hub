declare const __WORKER_VERSION__: string | undefined;

/** Replaced by esbuild `define` in the bundle; `0.0.0-dev` when run from source or tests. */
export const WORKER_VERSION: string =
  typeof __WORKER_VERSION__ === 'string' ? __WORKER_VERSION__ : '0.0.0-dev';
