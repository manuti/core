"use strict";

// Minimal, dependency-free i18n for the Potato OS front-end.
//
// - `en.json` is the source of truth; other locales fall back to it per key,
//   so a partial translation never breaks the UI.
// - Static markup is translated declaratively via `data-i18n` attributes
//   (see applyTranslations); dynamic JS strings call `t()` directly.
// - Active language: localStorage `potato_lang` → navigator.language → "en".
//
// Contributing a language = copy en.json, translate the values, add the code
// to SUPPORTED, and open a PR. The locale-coverage test guards completeness.

export const SUPPORTED = ["en", "es", "fr", "pt"];
export const DEFAULT_LANG = "en";

// Native language names for the picker. Adding a language = add its code to
// SUPPORTED, its name here, and ship locales/<code>.json.
export const LANG_NAMES = {
  en: "English",
  es: "Español",
  fr: "Français",
  pt: "Português",
};

// Right-to-left languages. All shipped locales are LTR today; adding an RTL
// language (e.g. "ar", "he") here flips <html dir> automatically. Before
// shipping an RTL locale, migrate the remaining physical CSS offsets
// (left/right, margin-left, …) to logical properties — see docs/i18n.md.
export const RTL_LANGS = new Set(["ar", "fa", "he", "ur"]);

export function dirFor(lang) {
  return RTL_LANGS.has(lang) ? "rtl" : "ltr";
}

let _lang = DEFAULT_LANG;
let _dict = {};      // active locale dictionary
let _fallback = {};  // en dictionary (always loaded)
const _listeners = new Set();

function _isSupported(lang) {
  return typeof lang === "string" && SUPPORTED.includes(lang);
}

export function resolveInitialLang() {
  try {
    const saved = localStorage.getItem("potato_lang");
    if (_isSupported(saved)) return saved;
  } catch { /* private mode / quota */ }
  const nav = String((typeof navigator !== "undefined" && navigator.language) || DEFAULT_LANG)
    .slice(0, 2)
    .toLowerCase();
  return _isSupported(nav) ? nav : DEFAULT_LANG;
}

async function _fetchLocale(lang) {
  const res = await fetch(`/assets/locales/${lang}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`locale ${lang} → HTTP ${res.status}`);
  return res.json();
}

// Load the English fallback plus the requested/detected locale. Any failure
// degrades gracefully to whatever loaded (English, or raw keys).
export async function initI18n() {
  _fallback = await _fetchLocale(DEFAULT_LANG).catch(() => ({}));
  _lang = resolveInitialLang();
  _dict = _lang === DEFAULT_LANG ? _fallback : await _fetchLocale(_lang).catch(() => _fallback);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", _lang);
    document.documentElement.setAttribute("dir", dirFor(_lang));
  }
  return _lang;
}

// Translate a key, interpolating {vars}. Missing keys fall back to English,
// then to the key itself (so nothing renders blank).
export function t(key, vars) {
  let s = (_dict && _dict[key] != null)
    ? _dict[key]
    : (_fallback[key] != null ? _fallback[key] : key);
  if (vars) {
    for (const name of Object.keys(vars)) {
      s = s.split(`{${name}}`).join(String(vars[name]));
    }
  }
  return s;
}

// Translate a backend reason/error code (e.g. "insufficient_storage") via the
// errcode.* namespace. Unknown values pass through unchanged (they may already
// be human text); empty → "". Lets the client localize codes the API emits.
export function tReason(code) {
  if (!code) return "";
  const key = `errcode.${code}`;
  const translated = t(key);
  return translated !== key ? translated : String(code);
}

// Hydrate declaratively-marked static markup within `root`.
export function applyTranslations(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  root.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.setAttribute("alt", t(el.getAttribute("data-i18n-alt")));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
  });
}

export function getLang() { return _lang; }

// Subscribe to language changes; returns an unsubscribe fn. Modules that
// render dynamic strings re-run their render on change.
export function onLangChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export async function setLang(lang) {
  if (!_isSupported(lang) || lang === _lang) return;
  _lang = lang;
  try { localStorage.setItem("potato_lang", lang); } catch { /* quota */ }
  _dict = lang === DEFAULT_LANG ? _fallback : await _fetchLocale(lang).catch(() => _fallback);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", dirFor(lang));
    applyTranslations(document);
  }
  for (const fn of _listeners) {
    try { fn(lang); } catch { /* listener errors must not break switching */ }
  }
}
