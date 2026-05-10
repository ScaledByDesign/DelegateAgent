// Minimal local ambient module for js-yaml v4. Replaced at runtime by the
// installed @types/js-yaml once `npm install` runs. We ship this shim so a
// fresh checkout typechecks cleanly even before deps are installed.
declare module 'js-yaml' {
  export function load(input: string, options?: unknown): unknown;
  export function dump(input: unknown, options?: unknown): string;
  const def: { load: typeof load; dump: typeof dump };
  export default def;
}
