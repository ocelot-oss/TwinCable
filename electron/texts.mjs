// The desktop shell's own texts – the menu until the page sends its labels, the file dialog, the start-up error – in
// the app language. They come from the page's dictionaries (web/i18n/<lang>.json; scripts/extract-i18n.mjs collects
// the t() calls in electron/ too), English is the fallback.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LANGS = ['en', 'de', 'fr', 'es', 'it'];

/** The app language: the one picked in Settings (config.json `lang`), else the system's when twicable has it, else English. */
export function appLang(configLang, locale) {
  if (LANGS.includes(configLang)) return configLang;
  const sys = String(locale || '').slice(0, 2).toLowerCase();
  return LANGS.includes(sys) ? sys : 'en';
}

/** t(key, english) for `lang`, reading `<dir>/<lang>.json`; a missing or broken file leaves the English texts. */
export function textsFor(lang, dir) {
  let dict = {};
  if (lang !== 'en' && LANGS.includes(lang)) {
    try {
      dict = JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')) || {};
    } catch {
      dict = {};
    }
  }
  return (key, fallback) => (typeof dict[key] === 'string' && dict[key] ? dict[key] : fallback);
}
