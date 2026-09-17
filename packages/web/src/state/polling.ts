/**
 * How often the client re-reads every host. Lives alone so that both the poller and
 * the code that *renders* timestamps can see it: a row can never know anything
 * fresher than the last poll, so any display bucket shorter than this interval
 * reports noise rather than information.
 */
export const POLL_INTERVAL_MS = 5000;
