// A Pokémon of the board's live teams, opened from its party panel: level, held item and moves, and – where the game's
// data holds them and twincable read them – nature, ability, Hidden Power, IVs and EVs (Game Boy: DVs and stat
// experience, shared/monstats.mjs). "Copy for damage calc" puts it on the clipboard as a Pokémon Showdown set.
import { html } from '/vendor/htm-preact.mjs';
import { useApp, Sprite, Types, Modal, copy } from '../lib/ui.mjs';
import { t } from '../lib/i18n.mjs';
import { speciesName, speciesFormName, itemName, moveName, abilityName, natureName, typeLabel } from '../lib/data.mjs';
import { cleanSummary, hiddenPower, natureEffect, evTotal, showdownSet } from '/shared/monstats.mjs';
import { shownLevel } from './party.mjs';

const statLabels = () => [t('mon.hp', 'HP'), t('mon.atk', 'Atk'), t('mon.def', 'Def'), t('mon.spa', 'SpA'), t('mon.spd', 'SpD'), t('mon.spe', 'Spe')];
const gbLabels = () => [t('mon.hp', 'HP'), t('mon.atk', 'Atk'), t('mon.def', 'Def'), t('mon.spe', 'Spe'), t('mon.spc', 'Spc')];

/** The held item's name in a language ('' when it has none twincable can name). */
function heldName(mon, gen, lang) {
  if (!mon.item) return '';
  if (typeof mon.item === 'string') return mon.item;
  return mon.itemOwn ? mon.itemName || '' : itemName(mon.item, gen, lang);
}

/** The Pokémon as a Showdown set (names in English, as Showdown and the calculators take them). */
export function damageCalcText(mon, gen) {
  return showdownSet(mon, gen, {
    species: (id) => speciesName(id, 'en'),
    item: (m) => heldName(m, gen, 'en'),
    move: (id) => moveName(id, 'en'),
    ability: (s) => s.abilityName || abilityName(s.ability, 'en'),
    nature: (n) => natureName(n, 'en'),
  });
}

/** One row of numbers under the stat names; `mark` = { up, down } (the nature's) marks two of them. */
function StatRow({ label, values, mark, total }) {
  return html`<tr><th scope="row">${label}</th>${values.map((v, i) => html`<td class=${mark?.up === i ? 'up' : mark?.down === i ? 'down' : ''}>${v}</td>`)}
    ${total !== undefined && html`<td class="mon-total">${total}</td>`}</tr>`;
}

/** The stats block: nature, ability, Hidden Power and the IV / EV table – only the lines twincable read. */
export function MonStats({ mon, gen }) {
  const s = cleanSummary(mon?.summary);
  if (!s) return null;
  const nature = gen >= 3 && s.nature !== undefined ? natureName(s.nature) : '';
  const eff = nature ? natureEffect(s.nature) : null;
  const ability = gen >= 3 && s.ability ? s.abilityName || abilityName(s.ability) : '';
  const hp = hiddenPower(s, gen);
  const labels = gen <= 2 ? gbLabels() : statLabels();
  const head = (mark) => html`<tr><th></th>${labels.map((l, i) => html`<th scope="col" class=${mark?.up === i ? 'up' : mark?.down === i ? 'down' : ''}>${l}${mark?.up === i ? '+' : mark?.down === i ? '−' : ''}</th>`)}
    ${gen >= 3 && s.evs && html`<th scope="col" class="mon-total">${t('mon.total', 'Total')}</th>`}</tr>`;
  const ivs = gen >= 3 ? s.ivs : s.dvs;
  const evs = gen >= 3 ? s.evs : s.statExp;
  return html`<div class="mon-stats">
    ${(nature || ability || hp) && html`<dl class="mon-facts">
      ${nature && html`<dt>${t('mon.nature', 'Nature')}</dt><dd>${nature}${eff ? html` <span class="faint">(+${labels[eff.up]} −${labels[eff.down]})</span>` : ''}</dd>`}
      ${ability && html`<dt>${t('mon.ability', 'Ability')}</dt><dd>${ability}</dd>`}
      ${hp && html`<dt>${t('mon.hiddenPower', 'Hidden Power')}</dt><dd><span class=${`type t-${hp.type}`}>${typeLabel(hp.type)}</span>${gen <= 5 ? html` <span class="faint num">${hp.power}</span>` : ''}</dd>`}
    </dl>`}
    ${(ivs || evs) && html`<table class="mon-table">
      <thead>${head(eff)}</thead>
      <tbody>
        ${ivs && html`<${StatRow} label=${gen >= 3 ? t('mon.ivs', 'IVs') : t('mon.dvs', 'DVs')} values=${ivs} mark=${eff} total=${gen >= 3 && s.evs ? '' : undefined} />`}
        ${evs && html`<${StatRow} label=${gen >= 3 ? t('mon.evs', 'EVs') : t('mon.statExp', 'Stat exp.')} values=${evs} mark=${eff} total=${gen >= 3 ? evTotal(s) : undefined} />`}
      </tbody>
    </table>`}
  </div>`;
}

/**
 * The details of one Pokémon of a live team. `mon`: the run's live party shape (web/lib/run.mjs liveMon); `owner`: whose
 * it is (shown in the title in a group run); `caption`: where it was caught.
 */
export function MonDetail({ mon, gen, slot, owner, caption, onClose }) {
  const { runData, toast } = useApp();
  if (!mon) return null;
  const name = mon.nick || mon.nickname || speciesName(mon.species);
  const species = speciesFormName(mon.species, mon.form, gen);
  const lv = shownLevel(mon.level);
  const item = heldName(mon, gen);
  const moves = (mon.moves || []).map((id) => moveName(id)).filter(Boolean);
  const text = damageCalcText(mon, gen);
  const doCopy = () => {
    Promise.resolve(copy(text)).then(
      () => toast?.({ kind: 'ok', title: t('common.copied', 'Copied'), text: t('mon.copied', 'Paste it into a damage calculator’s import box (Pokémon Showdown format).') }),
      () => toast?.({ kind: 'warn', title: t('mon.copyFailed', 'Couldn’t copy'), text }),
    );
  };
  return html`<${Modal} open=${true} onClose=${onClose} title=${owner ? `${name} · ${owner}` : name}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.close', 'Close')}</button>
      ${text && html`<button class="btn primary" onClick=${doCopy}>${t('mon.copyCalc', 'Copy for damage calc')}</button>`}`}>
    <div class="row mon-head">
      <${Sprite} id=${mon.species} form=${mon.form} shiny=${mon.shiny} size=${64} gen=${gen} />
      <div class="stack-s" style="min-width:0">
        <div>${name !== species && html`<b>${species}</b> `}<span class="muted">${lv ? `${t('common.lv', 'Lv')} ${lv}` : ''}${mon.shiny ? ` · ${t('common.shiny', 'shiny')}` : ''}</span></div>
        <${Types} types=${runData.types(mon.species, slot, mon.form || 0)} />
        ${item && html`<div class="small muted">${t('party.holds', 'holds {item}', { item })}</div>`}
        ${caption && html`<div class="small faint">${caption}</div>`}
      </div>
    </div>
    ${moves.length > 0 && html`<ul class="mon-moves" aria-label=${t('mon.moves', 'Moves')}>${moves.map((m, i) => html`<li key=${i} class="chip">${m}</li>`)}</ul>`}
    <${MonStats} mon=${mon} gen=${gen} />
  <//>`;
}
