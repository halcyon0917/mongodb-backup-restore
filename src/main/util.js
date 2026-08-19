'use strict';

/** Thrown when the user cancels a running job; handled specially by callers. */
class CancelledError extends Error {
  constructor(message = 'Cancelled by user.') {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Filesystem-safe local timestamp, e.g. 2026-08-18_18-42-07. */
function timestampSlug(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Rate-limit a function to at most one call per `waitMs`, with a `flush()` that
 * fires any pending trailing call. Used to keep progress events from swamping
 * the IPC channel on fast collections.
 */
function throttle(fn, waitMs = 200) {
  let lastRun = 0;
  let pending = false;

  const wrapped = (...args) => {
    const now = Date.now();
    if (now - lastRun >= waitMs) {
      lastRun = now;
      pending = false;
      fn(...args);
    } else {
      pending = true;
      wrapped.lastArgs = args;
    }
  };

  wrapped.flush = () => {
    if (pending) {
      pending = false;
      lastRun = Date.now();
      fn(...(wrapped.lastArgs || []));
    }
  };

  return wrapped;
}

/**
 * Replace the password in a connection string so it is safe to display.
 *
 * Applied to every error message that reaches the UI or the activity log: the
 * log can be saved and shared, and a driver error that happened to quote the
 * connection string back would otherwise carry the password with it.
 */
function redactUri(text) {
  if (typeof text !== 'string') return text;
  return text.replace(
    /(mongodb(?:[+]srv)?:[/][/])([^@\s/]+)@/gi,
    (_match, scheme, credentials) => `${scheme}${credentials.split(':')[0]}:****@`
  );
}

/** Turn any thrown value into a readable single-line message. */
function describeError(error) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return redactUri(error);

  let message = error.message || String(error);

  // MongoServerError carries useful detail that the message alone can hide.
  if (error.codeName && !message.includes(error.codeName)) {
    message += ` (${error.codeName})`;
  } else if (error.code && !message.includes(String(error.code))) {
    message += ` (code ${error.code})`;
  }
  return redactUri(message);
}

module.exports = {
  CancelledError,
  describeError,
  formatBytes,
  redactUri,
  throttle,
  timestampSlug,
};
