import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, ApiDetector, LatLon, RoutePlan, ServerMeta } from '../api';

interface State {
  plan: RoutePlan | null;
  loading: boolean;
  error: string | null;
}

/**
 * Route planning state.
 *
 * Requests are debounced and the previous one aborted, because the slider fires
 * continuously while it is being dragged and a routing call is not cheap. The
 * last successful plan is kept on screen while a new one is in flight, so
 * dragging the slider does not blank the map.
 */
export function useRoutePlan(client: ApiClient) {
  const [state, setState] = useState<State>({ plan: null, loading: false, error: null });
  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestPlan = useCallback(
    (from: LatLon, to: LatLon, privacyBias: number, ignoreKinds: string[] = []) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        inFlight.current?.abort();
        const controller = new AbortController();
        inFlight.current = controller;
        setState((s) => ({ ...s, loading: true, error: null }));

        client
          .planRoute({
            from,
            to,
            privacyBias,
            ignoreKinds: ignoreKinds as never,
            signal: controller.signal,
          })
          .then((result) => {
            if (controller.signal.aborted) return;
            setState({ plan: result, loading: false, error: null });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setState((s) => ({
              ...s,
              loading: false,
              error: error instanceof Error ? error.message : 'Could not reach the routing server',
            }));
          });
      }, 250);
    },
    [client],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      inFlight.current?.abort();
    },
    [],
  );

  // Named `requestPlan`, not `plan`: spreading state alongside a field of the
  // same name silently replaced the plan with the function that fetches it.
  return { ...state, requestPlan };
}

export function useServerMeta(client: ApiClient) {
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .meta()
      .then((result) => {
        if (!cancelled) setMeta(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Server unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { meta, error };
}

/**
 * Devices for the current viewport.
 *
 * Fetched per visible area rather than downloaded wholesale: a national
 * dataset is far too big for a phone, and the bbox request is capped server
 * side so this cannot become a scraper.
 */
export function useDetectors(client: ApiClient) {
  const [detectors, setDetectors] = useState<ApiDetector[]>([]);
  const lastBBox = useRef<string>('');

  const load = useCallback(
    (bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }) => {
      // Ignore viewports too wide to be useful; the server rejects them anyway.
      if (bbox.maxLat - bbox.minLat > 1.5 || bbox.maxLon - bbox.minLon > 1.5) return;
      const key = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon]
        .map((n) => n.toFixed(2))
        .join(',');
      if (key === lastBBox.current) return;
      lastBBox.current = key;
      client
        .detectors(bbox)
        .then((result) => setDetectors(result.detectors))
        .catch(() => {
          /* the overlay is optional; a failure here must not break routing */
        });
    },
    [client],
  );

  return { detectors, load };
}
