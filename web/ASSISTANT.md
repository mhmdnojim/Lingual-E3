# Conversation tutor

The tutor is part of the existing vanilla JavaScript/Python app. API version 42 is required;
restart a running local server after updating the code, then refresh the browser.

## Controls

- The toolbar's tutor icon opens the panel. Repeated clicks do not start, end, or restart a session.
- The panel previews the selected whole sentence, including a word selected during saved-audio playback.
- **Start conversation** pauses lesson audio and clears its queued repeats. It connects and requests
  the sentence's translation, vocabulary and grammar immediately, without an introduction or opening question.
- During conversation, clicking a sentence reads that sentence once, with live speech or its saved
  audio. The tutor waits silently and explains it afterwards. Ordinary reading resumes after **End conversation**.
- **Mute mic** affects the tutor microphone. **End conversation** releases the session. Closing the
  panel only hides it; the active icon allows reopening. Disconnect, account change and the offline lock end it.
- Teaching style, speaking style and microphone choice are saved on the device. Style changes send
  context without reconnecting. Microphone changes apply to the next session.
- The only client tool is `point_at_text({text: string})`. It highlights exact text in the selected
  sentence using the book's word geometry, works through page zoom, and clears after 12 seconds or End.
  Unknown text returns `not found on screen`. It cannot navigate, edit, or operate admin controls.

## Server and ElevenLabs

`POST /api/assistant-token` uses the existing login, device and subscription gates. Credentials are
not cached. There is no public-agent fallback that bypasses these gates. A local developer uses
the existing local owner account. The packaged student server directs users to the website for this online feature.

Configure `LB_ASSISTANT_KEY` on the server, or save the existing ElevenLabs key in **Admin > API**
(local app: Script speech-recognition settings). Never put a key in the JavaScript or commit it.
`LB_ASSISTANT_AGENT_ID` optionally replaces the existing default agent ID. The key needs permission
to read that agent, create conversation tokens and, for initial owner setup, update the agent.

On Start, the server checks the agent prompt and empty `first_message`. If setup is needed, only
the owner may update it. The partial PATCH installs the sentence-tutor prompt and the
`point_at_text` client tool, replacing the old app-control tool list; the agent's voice and model
are retained. A follow-up GET must confirm the prompt and empty greeting before a token is issued.
Learners see a setup message until the owner has done this. Provider response bodies and API keys
are never returned in errors. The point tool's JSON schema is defined in `assistant.py`.

The browser sends bounded study data (selected sentence and cached translation, book/page names,
explanation language, preferences); no full-page text, form contents, account data or screen capture.
The SDK sends microphone audio directly to ElevenLabs. The panel discloses this before Start.

This change adapts the conversation controls and sentence handoff from the supplied SyncPlayer
reference. It does not implement its separate credit wallet/provider-cost reconciliation, avatar,
teacher-voice picker or shared TTS/flashcard redesign. Existing subscription checks apply; there is
no tutor credit balance, usage accounting or automatic credit-based termination yet. Use a private
ElevenLabs agent when access must be restricted: securing this endpoint does not make an agent private.

## Verification

- `python -m unittest web/tests/test_assistant.py`: configuration permissions, empty greeting,
  verification before token issuance, sanitized errors and credential handling.
- `node web/tests/assistant-test.mjs`: real app and isolated local server with a simulated SDK and
  microphone. Covers panel/session separation, active sentence, once-only playback, audio handoff,
  pointer, settings, mic refusal, cancelled connection and the POST endpoint.
- No automated test consumes provider credits or records the user's microphone. A real conversation
  still needs a working server key, network access, agent permissions and browser mic permission.

SDK behavior and provider schema checked against the official
[JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script) and
[agent update API](https://elevenlabs.io/docs/eleven-agents/api-reference/agents/update).
