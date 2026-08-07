/**
 * Minimal structured logger. Human-readable by default; set PRINT_LOG=json for
 * line-delimited JSON (easy to ship to a log collector later).
 */
const JSON_MODE = process.env.PRINT_LOG === 'json';
const stamp = () => new Date().toISOString();

function emit(level, msg, fields) {
  if (JSON_MODE) { console.log(JSON.stringify({ t: stamp(), level, msg, ...fields })); return; }
  const extra = fields && Object.keys(fields).length ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  console.log(`${stamp()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/** Turn a queue/service event into a log line. */
export function logEvent(evt) {
  switch (evt.type) {
    case 'sent': log.info(`printed ${evt.label || evt.jobId}`, { printer: evt.printerId, attempts: evt.attempts }); break;
    case 'queued': log.info(`queued ${evt.label || evt.jobId}`, { printer: evt.printerId }); break;
    case 'retry': log.warn(`retry ${evt.jobId}`, { printer: evt.printerId, attempts: evt.attempts, delay: evt.delay, error: evt.error }); break;
    case 'offline': log.warn(`printer OFFLINE`, { printer: evt.printerId, error: evt.error }); break;
    case 'online': log.info(`printer back ONLINE`, { printer: evt.printerId }); break;
    case 'dead': log.error(`DEAD-LETTER ${evt.jobId} (kept for reprint)`, { printer: evt.printerId, attempts: evt.attempts, error: evt.error }); break;
    case 'recovered': log.info(`recovered ${evt.count} job(s) after restart`, { printer: evt.printerId }); break;
    case 'store-error': log.error(`STORE ERROR during ${evt.op} (job kept safe; may reprint on restart)`, { printer: evt.printerId, jobId: evt.jobId, error: evt.error }); break;
    case 'duplicate': log.info(`skipped duplicate`, { key: evt.key }); break;
    case 'rejected': log.warn(`rejected invalid ticket`, { error: evt.error }); break;
    default: break;
  }
}
