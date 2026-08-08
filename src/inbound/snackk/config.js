/**
 * The agent's live view of snackk's per-restaurant config (GET /api/print/config).
 * Read once at startup (so a wrong URL/key fails loudly), then refreshed on an
 * interval — an owner flipping KDS↔Print or changing the routing mode takes
 * effect without touching the box. A transient refresh failure KEEPS the last
 * good value: a network blip must never silently switch printing off mid-service.
 */

/**
 * @param {{baseUrl:string, deviceKey:string, refreshMs?:number, fetchImpl?:typeof fetch, log?:any}} o
 */
export function createConfigClient({ baseUrl, deviceKey, refreshMs = 30_000, fetchImpl = fetch, log = console }) {
  let cached = null;
  let timer = null;

  async function fetchOnce() {
    const res = await fetchImpl(`${baseUrl}/api/print/config`, {
      headers: { Authorization: `Bearer ${deviceKey}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`config → HTTP ${res.status}`);
    return res.json();
  }

  return {
    /** Load the first config (throws on failure) and begin periodic refresh. */
    async start() {
      cached = await fetchOnce();
      timer = setInterval(async () => {
        try {
          cached = await fetchOnce();
        } catch (e) {
          log.warn?.(`[snackk] config refresh failed, keeping last: ${e.message}`);
        }
      }, refreshMs);
      timer.unref?.(); // never keep the process alive just to poll
      return cached;
    },
    /** The last good config, or null before start() resolves. */
    get() {
      return cached;
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
