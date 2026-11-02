// Keep Windows voices distinct from similarly named online Natural voices.
const COUNTRY = {
  'United States': 'en-US', 'United Kingdom': 'en-GB', Australia: 'en-AU', Canada: 'en-CA', Ireland: 'en-IE',
  'New Zealand': 'en-NZ', India: 'en-IN', 'South Africa': 'en-ZA',
};

export const isWindowsVoice = (voice) => voice?.provider === 'windows' || /^windows:/i.test(voice?.id || '');

const normalizedName = (name) => String(name || '').replace(/^Microsoft\s+/i, '')
  .replace(/\s*\(Windows offline\)\s*$/i, '').replace(/\s+Desktop\b/i, '')
  .replace(/\s+Online.*$/i, '').replace(/\s*-\s*(English|Chinese).*$/i, '')
  .replace(/\s*\([^)]*\).*$/, '').trim().toLowerCase();
const normalizedLocale = (locale) => String(locale || '').replace(/_/g, '-').toLowerCase();

/** Only return the server's exact counterpart of a selected browser voice. */
export function matchingRecordingVoice(voice, voiceList, language = 'en') {
  if (!voice || !Array.isArray(voiceList)) return null;
  const candidates = voiceList.filter((item) => isWindowsVoice(item) === !!voice.localService);
  let locale = normalizedLocale(voice.lang);
  const natural = !voice.localService && voice.name.match(/Online\s*\(Natural\)\s*-\s*English\s*\(([^)]+)\)/i);
  if (natural && COUNTRY[natural[1]]) locale = normalizedLocale(COUNTRY[natural[1]]);
  const name = normalizedName(voice.name);
  const sameName = (item) => normalizedName(item.name) === name || (item.nativeName && normalizedName(item.nativeName) === name);
  return candidates.find((item) => normalizedLocale(item.locale) === locale && sameName(item))
    || (!voice.localService && language === 'zh'
      ? candidates.find((item) => /^zh[-_]/i.test(item.locale) && sameName(item)) : null)
    || null;
}

export function recordingVoiceLabel(voice, includeLocale = false) {
  const name = String(voice.name || '').replace(/\s*\(Windows offline\)\s*$/i, '');
  const detail = [includeLocale ? voice.locale : '', String(voice.gender || '').toLowerCase(), isWindowsVoice(voice) ? 'Windows offline' : 'online Natural'];
  return `${name} — ${detail.filter(Boolean).join(' · ')}`;
}

/** Default a new recording to the languages actually present in its selected text. */
export function detectRecordingLanguage(sentences, fallback = 'both') {
  const text = sentences.map((sentence) => String(sentence.text || '')
    .replace(/^\s*[A-Z][A-Za-z0-9_. '\-]{0,28}[:：]\s*/, '')).join(' ');
  const english = /[A-Za-z]/.test(text), chinese = /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
  return english && chinese ? 'both' : chinese ? 'zh' : english ? 'en' : fallback;
}

/** Propose installed alternatives; callers must require an explicit user click to apply them. */
export function offlineVoiceChoices(voiceList, current) {
  const choices = { voice: current.voice, voiceB: current.voiceB,
    zhVoice: current.zhVoice, zhVoiceB: current.zhVoiceB };
  const missing = [], shared = [];
  const languages = current.languageMode === 'en' ? ['en'] : current.languageMode === 'zh' ? ['zh'] : ['en', 'zh'];
  for (const language of languages) {
    const field = language === 'en' ? 'voice' : 'zhVoice';
    const candidates = voiceList.filter((v) => isWindowsVoice(v) && v.locale.startsWith(`${language}-`));
    if (!candidates.length) { missing.push(language === 'en' ? 'English' : 'Chinese'); continue; }
    const choose = (key, exclude) => {
      const prior = voiceList.find((v) => v.id === current[key]);
      const pool = candidates.filter((v) => v.id !== exclude);
      const options = pool.length ? pool : candidates;
      const score = (v) => (v.id === prior?.id ? 100 : 0)
        + (v.locale === prior?.locale ? 4 : 0) + (v.gender === prior?.gender ? 2 : 0);
      return [...options].sort((a, b) => score(b) - score(a))[0].id;
    };
    choices[field] = choose(field);
    if (current.twoSpeakers) {
      choices[`${field}B`] = choose(`${field}B`, choices[field]);
      if (choices[field] === choices[`${field}B`]) shared.push(language === 'en' ? 'English' : 'Chinese');
    }
  }
  return { voices: choices, missing, shared };
}
