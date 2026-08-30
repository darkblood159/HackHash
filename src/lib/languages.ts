// src/lib/languages.ts
//
// Curated language list for the translation-language picker (see
// src/components/LanguagePicker.tsx). Codes follow the same short,
// No-Intro-derived convention IUPAG's own Text-Language tag rule points
// to (https://gist.github.com/Europia79/a51dd4632f8d4e4443d0048b70cb6e54,
// rule 6) — e.g. "En", "Fr", "De" — lowercased here to match this
// project's existing convention of lowercasing everything that isn't
// meant for display (hashes, tag slugs). Sorted alphabetically by name
// rather than IUPAG's own stated precedence order, since this list is
// for a person scanning/picking from a UI, not for constructing a
// filename — alphabetical is what's actually fast to scan.
//
// Not meant to be exhaustive. Add to this list as real submissions need a
// language it doesn't have yet — same "additive, grows with real use"
// spirit as the tag list.

export const LANGUAGES = [
  { code: 'ar', name: 'Arabic' },
  { code: 'ca', name: 'Catalan' },
  { code: 'zh', name: 'Chinese' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

const NAME_BY_CODE = new Map<string, string>(LANGUAGES.map((l) => [l.code, l.name]));

/** Display name for a code, or the raw code itself if it's not in the curated list (e.g. an older/manually-entered value). */
export function languageName(code: string): string {
  return NAME_BY_CODE.get(code) ?? code;
}
