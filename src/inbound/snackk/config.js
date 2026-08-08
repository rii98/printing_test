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
    if (!res.ok) {
      const e = new Error(`config → HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  return {
    /**
     * Load the first config and begin periodic refresh. Does NOT throw: a snackk
     * that's unreachable or a tenant that hasn't enabled `printing` yet must not
     * crash the appliance (the local HTTP inbound has to keep printing). It warns
     * — loudly for a rejected key, which needs the owner to re-mint one — and
     * keeps polling, so delivery begins the moment the config comes good.
     */
    async start() {
      try {
        cached = await fetchOnce();
      } catch (e) {
        if (e.status === 401) log.warn?.(`[snackk] device key rejected (401) — re-mint it in Settings; will keep retrying`);
        else log.warn?.(`[snackk] config unavailable (${e.message}) — keeping local printing, will retry`);
      }
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
