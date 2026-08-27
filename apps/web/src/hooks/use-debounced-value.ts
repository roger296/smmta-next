import { useEffect, useState } from 'react';

/**
 * Delays propagating a rapidly-changing value.
 *
 * Used by the entity pickers so typing a SKU issues one search request rather
 * than one per keystroke — the catalogue can run to tens of thousands of rows,
 * and each search is a database LIKE across name, stock code and EAN.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
