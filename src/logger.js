'use strict';

/**
 * Minimal structured JSON logger. Never pass secrets or full webhook
 * payloads to these functions — only small, explicitly chosen fields.
 */
function log(level, msg, fields) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(fields || {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};
