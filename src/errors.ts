// What went wrong, from anything thrown: host calls reject with an
// `ElbertError` (an Error with a `code`), Orchard calls with `OrchardError`.

/** The message to show. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The error's `code` (`timeout`, `not_found`, `station_not_playable`…), when it has one. */
export function errorCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}
