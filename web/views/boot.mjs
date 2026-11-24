import { html, useEffect, useState } from '/vendor/htm-preact.mjs';
import { play, preload } from '../lib/sound.mjs';

/** Power-on sequence: the logo scrolls down an LCD while the boot sound swells. */
export function BootScreen({ onDone, sound = true }) {
  const [phase, setPhase] = useState('play');
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (sound) preload('boot');
    const chime = setTimeout(() => play('boot', sound), 50);
    const out = setTimeout(() => setPhase('out'), reduced ? 900 : 3000);
    const done = setTimeout(onDone, reduced ? 1300 : 3450);
    const skip = (e) => {
      if (e.type === 'keydown' && e.metaKey) return;
      clearTimeout(chime);
      clearTimeout(out);
      clearTimeout(done);
      onDone();
    };
    addEventListener('keydown', skip);
    return () => {
      clearTimeout(chime);
      clearTimeout(out);
      clearTimeout(done);
      removeEventListener('keydown', skip);
    };
  }, []);
  return html`<div class=${`boot ${phase === 'out' ? 'run out' : 'run'}`} onClick=${onDone} role="presentation">
    <div class="boot-screen">
      <div class="boot-logo">
        <img src="/twincable-logo.png" alt="TwinCable" width="1536" height="1024" />
      </div>
    </div>
  </div>`;
}
