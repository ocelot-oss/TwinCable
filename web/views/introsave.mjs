// Intro saves (a community idea, server/lib/introsave.mjs): keep a save made after a game's intro – before the
// starter – and start new attempts of that game from it. Two small pieces: the "Start from my intro save" option where
// a new game is built (new run, new attempt, joining) and "Keep as intro save" in the board's Files menu.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';

/**
 * The intro save kept for a game – `query`: "run=<id>" (a run's game) or "romId=…&patchId=…" (the new-run wizard's
 * pick); null: nothing to ask. → [intro | null | undefined (loading), forget()]
 */
export function useIntroSave(query) {
  const [intro, setIntro] = useState(undefined);
  useEffect(() => {
    if (!query) {
      setIntro(null);
      return undefined;
    }
    let off = false;
    setIntro(undefined);
    api.get(`/api/intro-saves/for?${query}`).then((r) => !off && setIntro(r.intro || null), () => !off && setIntro(null));
    return () => { off = true; };
  }, [query]);
  const forget = async () => {
    if (!intro) return;
    await api.del(`/api/intro-saves/${intro.id}`);
    setIntro(null);
  };
  return [intro, forget];
}

/** "It already has a Pokémon / {n} Pokémon …" – the gentle note for a save from after the starter (or null). */
export function partyNote(party) {
  if (!(party > 0)) return null;
  return party === 1
    ? t('intro.partyOne', 'It already has a Pokémon – it comes along as it is and doesn’t count for the run. A save from before your starter works best.')
    : t('intro.partyMany', 'It already has {n} Pokémon – they come along as they are and don’t count for the run. A save from before your starter works best.', { n: party });
}

/**
 * "Start from my intro save" – shown only when one is kept for this game. on / onChange: the choice (on by default
 * where it's used); the intro save can be removed right here (asks once more).
 */
export function IntroSaveOption({ intro, forget, on, onChange, disabled = false }) {
  const { status } = useApp();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setArmed(false), [intro?.id]);
  if (!intro) return null;
  // a 3DS game played in Azahar itself: Azahar keeps its saves in its own folder
  const azahar = intro.system === '3ds' && (!status?.ctr?.ok || status?.config?.emulatorFor?.['3ds'] === 'azahar');
  const note = partyNote(intro.party);
  const remove = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      await forget();
    } catch {
      setArmed(false);
    }
    setBusy(false);
  };
  return html`<div class="intro-opt row nowrap">
    <label class="check grow"><input type="checkbox" checked=${on} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />
      <span>${t('intro.start', 'Start from my intro save')}
        <span class="hint">${intro.from?.name
          ? t('intro.fromRun', 'Saved {when} in “{run}” – you skip the intro and start where you saved.', { when: ago(Date.parse(intro.savedAt)), run: intro.from.name })
          : t('intro.saved', 'Saved {when} – you skip the intro and start where you saved.', { when: ago(Date.parse(intro.savedAt)) })}</span>
        ${note && html`<span class="hint warn">${note}</span>`}
        ${azahar && html`<span class="hint">${t('intro.ctrOwn', 'Only in twincable’s own 3DS player – Azahar keeps its saves in its own folder.')}</span>`}</span></label>
    <button class=${armed ? 'btn small danger' : 'btn small ghost'} disabled=${disabled || busy} onClick=${remove} onBlur=${() => setArmed(false)}
      title=${t('intro.removeHint', 'Forget this intro save – your runs keep their saves.')}>${armed ? t('intro.removeSure', 'Really remove?') : t('common.remove', 'Remove')}</button>
  </div>`;
}

/**
 * The board's Files menu entry: keep my battery save of this run as the intro save of its game. `state`: GET
 * /api/runs/<id>/intro/<slot> ({ supported, hasSave, intro }); onDone(): the menu closes.
 */
export function KeepIntroItem({ manifest, me, state, onDone }) {
  const { toast } = useApp();
  if (!state?.supported || !state.hasSave) return null;
  const keep = async () => {
    onDone();
    try {
      // the game may have just saved: let the play view put its newest save on disk first
      window.dispatchEvent(new Event('sl-save-now'));
      await new Promise((r) => setTimeout(r, 400));
      const { intro } = await api.post(`/api/runs/${manifest.id}/intro/${me}`);
      const note = partyNote(intro.party);
      toast({ kind: note ? 'warn' : 'ok', title: t('intro.kept', 'Intro save kept'), text: note || t('intro.keptText', 'New attempts of this game can start from it – you’ll find the option when you start one.'), ...(note ? { ttl: 9000 } : {}) });
    } catch (e) {
      toast({ kind: 'warn', title: t('intro.keepFailed', 'Couldn’t keep the intro save'), text: e.message });
    }
  };
  return html`<button role="menuitem" onClick=${keep}
    title=${t('intro.keepHint', 'Save in the game right after the intro, before you pick your starter – new attempts of this game can then start there.')}>
    ${state.intro ? t('intro.replace', 'Use as my intro save instead') : t('intro.keep', 'Use as my intro save')}</button>`;
}
