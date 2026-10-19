export const AHREFS_API_BASE = 'https://api.ahrefs.com';
export const AHREFS_DR_PATH = '/v3/public/domain-rating-free';
export const AHREFS_DR_ENDPOINT = AHREFS_API_BASE + AHREFS_DR_PATH;
export const AHREFS_DR_PARAMETERS = { target: 'target', version: 'version', output: 'output' } as const;
export const AHREFS_DR_VERSION = 'dr3' as const;
export const AHREFS_DR_OUTPUT = 'json' as const;

export type AhrefsDrFailure = 'unauthorized' | 'rate_limited' | 'timeout' | 'network' | 'http' | 'invalid_response' | 'cancelled';

/** Deliberately omit response bodies: they can contain request or account details. */
export class AhrefsDrError extends Error {
  constructor(public readonly code: AhrefsDrFailure, public readonly status?: number, public readonly retryAfterMs?: number) {
    super(`Ahrefs DR: ${code}`);
    this.name = 'AhrefsDrError';
  }
}

export interface AhrefsDrResult { domainRating: number; license: unknown }
export interface AhrefsDrOptions { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date; signal?: AbortSignal }

function retryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

/** The API host is fixed; target is only a query parameter, never a request URL. */
export async function queryAhrefsDr(key: string, target: string, options: AhrefsDrOptions = {}): Promise<AhrefsDrResult> {
  if (!key.trim()) throw new AhrefsDrError('unauthorized');
  const url = new URL(AHREFS_DR_ENDPOINT);
  url.searchParams.set(AHREFS_DR_PARAMETERS.target, target);
  url.searchParams.set(AHREFS_DR_PARAMETERS.version, AHREFS_DR_VERSION);
  url.searchParams.set(AHREFS_DR_PARAMETERS.output, AHREFS_DR_OUTPUT);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new AhrefsDrError('cancelled')); };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => { controller.abort(); reject(new AhrefsDrError('timeout')); }, options.timeoutMs ?? 15_000);
  });
  const request = async (): Promise<AhrefsDrResult> => {
    if (options.signal?.aborted) throw new AhrefsDrError('cancelled');
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw new AhrefsDrError(options.signal?.aborted ? 'cancelled' : 'network');
    }
    if (response.status === 401) throw new AhrefsDrError('unauthorized', 401);
    if (response.status === 429) throw new AhrefsDrError('rate_limited', 429, retryAfter(response.headers.get('retry-after'), (options.now ?? (() => new Date()))()));
    if (!response.ok) throw new AhrefsDrError('http', response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw new AhrefsDrError('invalid_response'); }
    if (!body || typeof body !== 'object' || !('domain_rating' in body)
      || typeof body.domain_rating !== 'number' || !Number.isFinite(body.domain_rating)
      || body.domain_rating < 0 || body.domain_rating > 100) throw new AhrefsDrError('invalid_response');
    return { domainRating: body.domain_rating, license: 'license' in body ? body.license : undefined };
  };
  try { return await Promise.race([request(), interrupted]); }
  finally {
    clearTimeout(timeout);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
