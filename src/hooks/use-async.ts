import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "@/services/errors";

/**
 * Runs an async loader and tracks loading / error / data.
 *
 * The loader is a dependency of the effect rather than of the hook, so callers
 * pass their own `deps` exactly as they would with `useEffect`.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Which run of the loader has finished. Deriving `isLoading` from this avoids
  // a synchronous setState inside the effect.
  const [settledRun, setSettledRun] = useState(-1);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;

    loader()
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(friendlyError(err));
      })
      .finally(() => {
        if (active) setSettledRun(nonce);
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, isLoading: settledRun !== nonce, error, reload };
}
