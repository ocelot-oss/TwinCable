// "Playing now" (docs/PRIVACY.md): while a game actually runs, the page tells the local server every minute – the
// server sends the anonymous heartbeat to the twincable Discord bot when Settings › General allows it
// (server/lib/presence.mjs). Only the system and the mode leave this page; the game, the run and the player don't.

export const EVERY_MS = 60_000;
const SYSTEM = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': '3ds' };

/** The target's system → what the count knows ('gbc' counts as 'gb'), or null. */
export const presenceSystem = (system) => SYSTEM[system] || null;

/**
 * A timer that calls `send(state)` right away and then every `every` ms while a state ({ system, mode }) is set, and
 * `send(null)` once when it is cleared. Setting the same state again changes nothing.
 */
export function presenceLoop({ send, every = EVERY_MS, timers = globalThis }) {
  let state = null;
  let timer = null;
  const keyOf = (s) => (s ? `${s.system}|${s.mode}` : '');
  const tick = () => { if (state) send({ ...state }); };
  return {
    set(next) {
      const s = next && presenceSystem(next.system) && next.mode ? { system: presenceSystem(next.system), mode: next.mode } : null;
      if (keyOf(s) === keyOf(state)) return;
      if (timer) timers.clearInterval(timer);
      timer = null;
      const had = !!state;
      state = s;
      if (!s) {
        if (had) send(null);
        return;
      }
      tick();
      timer = timers.setInterval(tick, every);
    },
    get state() { return state; },
  };
}

/** What the page posts to /api/presence for a state. */
export const presenceBody = (state) => (state ? { system: state.system, mode: state.mode } : { playing: false });
