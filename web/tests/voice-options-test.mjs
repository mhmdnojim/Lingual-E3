import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWindowsVoice, matchingRecordingVoice, recordingVoiceLabel } from '../js/voice-options.js';

const voices = [
  { id: 'windows:TTS_MS_EN-US_DAVID_11.0', name: 'David (Windows offline)', locale: 'en-US', gender: 'Male', provider: 'windows' },
  { id: 'windows:TTS_MS_EN-US_ZIRA_11.0', name: 'Zira (Windows offline)', locale: 'en-US', gender: 'Female', provider: 'windows' },
  { id: 'windows:TTS_MS_ZH-CN_HUIHUI_11.0', name: 'Huihui (Windows offline)', locale: 'zh-CN', gender: 'Female', provider: 'windows' },
  { id: 'en-US-AnaNeural', name: 'Ana', locale: 'en-US', gender: 'Female', provider: 'edge' },
  // Matching a shared name must never silently change the provider or voice.
  { id: 'en-US-DavidNeural', name: 'David', locale: 'en-US', gender: 'Male', provider: 'edge' },
];

test('installed browser voices map to the exact Windows recording voice', () => {
  const found = matchingRecordingVoice({ name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true }, voices);
  assert.equal(found.id, 'windows:TTS_MS_EN-US_DAVID_11.0');
  const desktop = matchingRecordingVoice({ name: 'Microsoft Zira Desktop - English (United States)', lang: 'en_US', localService: true }, voices);
  assert.equal(desktop.id, 'windows:TTS_MS_EN-US_ZIRA_11.0');
});

test('Chinese Windows name and locale map without choosing a Natural voice', () => {
  const found = matchingRecordingVoice({ name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true }, voices, 'zh');
  assert.equal(found.id, 'windows:TTS_MS_ZH-CN_HUIHUI_11.0');
});

test('Natural voice names stay mapped to online providers', () => {
  const ana = matchingRecordingVoice({ name: 'Microsoft Ana Online (Natural) - English (United States)', lang: 'en-US', localService: false }, voices);
  assert.equal(ana.id, 'en-US-AnaNeural');
  const david = matchingRecordingVoice({ name: 'Microsoft David Online (Natural) (en-US)', lang: 'en-US', localService: false }, voices);
  assert.equal(david.id, 'en-US-DavidNeural');
});

test('no silent provider, locale, or similar-name substitution', () => {
  assert.equal(matchingRecordingVoice({ name: 'Microsoft Ana', lang: 'en-US', localService: true }, voices), null);
  assert.equal(matchingRecordingVoice({ name: 'Microsoft Zira Online (Natural)', lang: 'en-US', localService: false }, voices), null);
  assert.equal(matchingRecordingVoice({ name: 'Microsoft David', lang: 'en-GB', localService: true }, voices), null);
  assert.equal(matchingRecordingVoice({ name: 'Microsoft Anna Online (Natural)', lang: 'en-US', localService: false }, voices), null);
});

test('option labels state the real Windows or online provider', () => {
  assert.equal(recordingVoiceLabel(voices[0], true), 'David — en-US · male · Windows offline');
  assert.equal(recordingVoiceLabel(voices[3]), 'Ana — female · online Natural');
  assert.equal(isWindowsVoice({ id: 'windows:installed' }), true);
  assert.equal(isWindowsVoice(voices[3]), false);
});
