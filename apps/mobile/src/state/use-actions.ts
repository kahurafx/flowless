import { useLayoutEffect, useMemo, useRef } from "react";

type Fns = Record<string, (...args: never[]) => unknown>;

/**
 * Actions that keep one identity across renders but always run the latest closure. A slice's actions
 * read the state of the render they were made in; wrapping them like this lets screens depend on the
 * actions without re-rendering when state elsewhere changes.
 */
export function useActions<T extends Fns>(fns: T): T {
  const latest = useRef(fns);
  useLayoutEffect(() => {
    latest.current = fns;
  });
  return useMemo(
    // The ref is read only when an action is called (from an event or effect), never while rendering.
    // eslint-disable-next-line react-hooks/refs
    () => Object.fromEntries(Object.keys(fns).map((key) => [key, (...args: never[]) => latest.current[key]!(...args)])) as T,
    // The set of action names never changes for a slice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
