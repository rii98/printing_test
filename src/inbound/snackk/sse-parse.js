/**
 * A minimal, incremental Server-Sent-Events parser — enough of the SSE spec for
 * snackk's hub frames, and no dependency (the agent core stays zero-dep). Node
 * has no built-in EventSource, and the `eventsource` package can't attach the
 * Authorization header the device key rides on, so we parse the stream ourselves.
 *
 * Handles the frame shapes snackk emits (server/realtime/hub.ts formatFrame):
 *   id: <n>\nevent: <name>\ndata: <json>\n\n
 * plus the heartbeat comment lines (`: ping`) and the `retry:` advisory the
 * stream opens with. Multi-`data:` lines are joined with "\n" per spec; CRLF and
 * LF endings both work; a field split across chunks is buffered until complete.
 */

/**
 * @returns {{ push(chunk:string): Array<{id?:string, event:string, data:string}> }}
 */
export function createSseParser() {
  let buffer = '';
  /** @type {{id?:string, event:string, data:string[]}} */
  let cur = { id: undefined, event: 'message', data: [] };
  const reset = () => { cur = { id: undefined, event: 'message', data: [] }; };

  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        // Blank line → dispatch the buffered event (if it carried anything).
        if (line === '') {
          if (cur.data.length || cur.id !== undefined || cur.event !== 'message') {
            events.push({ id: cur.id, event: cur.event, data: cur.data.join('\n') });
          }
          reset();
          continue;
        }
        // A line starting with ":" is a comment — the heartbeat. Ignore it.
        if (line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1); // spec: strip ONE leading space

        if (field === 'id') cur.id = value;
        else if (field === 'event') cur.event = value;
        else if (field === 'data') cur.data.push(value);
        // 'retry' and any unknown field are ignored — the agent owns its backoff.
      }
      return events;
    },
  };
}
