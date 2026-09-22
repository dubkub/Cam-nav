import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OVERPASS_ENDPOINTS, runOverpassQuery } from '../sources/overpass.js';

const okPayload = { elements: [], osm3s: { timestamp_osm_base: '2026-09-21T00:00:00Z' } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('overpass client', () => {
  it('identifies itself, since Overpass asks clients to', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okPayload));
    await runOverpassQuery('[out:json];out count;', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/cam-nav/);
    expect(init.method).toBe('POST');
  });

  it('rotates mirrors rather than hammering one', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(new URL(url).host);
      return new Response('rate limited', { status: 429 });
    });
    await expect(
      runOverpassQuery('q', { fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseMs: 1, maxAttempts: 3 }),
    ).rejects.toThrow();
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(seen[0]).toBe(new URL(DEFAULT_OVERPASS_ENDPOINTS[0]!).host);
  });

  it('succeeds on a later mirror when the first is down', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('boom', { status: 503 }) : jsonResponse(okPayload);
    });
    const result = await runOverpassQuery('q', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    expect(result.osm3s?.timestamp_osm_base).toBe('2026-09-21T00:00:00Z');
  });

  it('reports every host that failed, not just the last attempt', async () => {
    // The real case this comes from: an egress policy blocked all three
    // mirrors, and reporting only the final attempt named one host and implied
    // the others were fine.
    const fetchImpl = vi.fn(async (url: string) => {
      const host = new URL(url).host;
      return new Response(`Host not in allowlist: ${host}`, { status: 403 });
    });
    const error = await runOverpassQuery('q', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseMs: 1,
      maxAttempts: 3,
    }).catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    for (const endpoint of DEFAULT_OVERPASS_ENDPOINTS.slice(0, 3)) {
      expect(error.message).toContain(new URL(endpoint).host);
    }
    expect(error.message).toMatch(/3 host\(s\)/);
  });

  it('gives up on a stalled mirror and tries the next one', async () => {
    // The case this comes from: two mirrors accepted the connection and never
    // answered. With no per-attempt ceiling the first one hung forever, so the
    // retry loop never ran and the build never finished or failed.
    const hosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      hosts.push(new URL(url).host);
      if (hosts.length === 1) {
        // Never resolves on its own; only the abort signal ends it.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
          );
        });
      }
      return jsonResponse(okPayload);
    });

    const result = await runOverpassQuery('q', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseMs: 1,
      perAttemptTimeoutMs: 50,
    });
    expect(result).toBeDefined();
    expect(hosts.length).toBeGreaterThan(1);
    expect(hosts[1]).not.toBe(hosts[0]);
  });

  it('reports a stall as a timeout rather than as an abort', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
        );
      }),
    );
    const error = await runOverpassQuery('q', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseMs: 1,
      maxAttempts: 2,
      // A realistic ceiling, since the message rounds to whole seconds.
      perAttemptTimeoutMs: 2000,
    }).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/no response within 2s/);
  });

  it('does not swallow an abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error('aborted by test');
    });
    await expect(
      runOverpassQuery('q', { fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseMs: 1 }, controller.signal),
    ).rejects.toThrow(/aborted/);
    // One call only: an aborted request must not burn the retry budget.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('overpass client budget', () => {
  it('stops once the overall budget is spent, however many mirrors are left', async () => {
    // Per-attempt timeouts alone still allow attempts x timeout; the budget is
    // the single number that bounds the worst case.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('stalled'), { name: 'TimeoutError' })),
        );
      }),
    );
    const started = Date.now();
    const error = await runOverpassQuery('q', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseMs: 1,
      maxAttempts: 10,
      perAttemptTimeoutMs: 60,
      totalBudgetMs: 200,
    }).catch((e: unknown) => e as Error);

    expect(Date.now() - started).toBeLessThan(1500);
    expect(error.message).toMatch(/budget of 0\.2s exhausted|no response within/);
    // Ten attempts were allowed but the budget cut it short.
    expect(fetchImpl.mock.calls.length).toBeLessThan(10);
  });
});
