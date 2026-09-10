import * as React from 'react';

export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * A debounced search term with surrounding whitespace removed.
 *
 * A padded term is not merely untidy: searches become ILIKE '%<term>%' on the
 * server, so a trailing space from a paste or a phone keyboard matches nothing
 * and reads as "no results" rather than as a typo.
 *
 * Trimming before the debounce rather than after also means typing a trailing
 * space produces no new value, so it costs no request at all — where trimming
 * afterwards would still fire one for a term that had not really changed.
 *
 * Kept separate from useDebounce, which is generic and must not silently alter
 * whatever it is given.
 */
export function useDebouncedSearch(value: string, delay = 300): string {
  return useDebounce(value.trim(), delay);
}
