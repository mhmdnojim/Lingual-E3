"""Tutor preparation: no secrets in errors, no learner configuration changes, no greeting.
Run: python -m unittest web/tests/test_assistant.py
"""
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import assistant


READY = {'conversation_config': {'agent': {'first_message': '', 'prompt': {'prompt': assistant.PROMPT}}}}


class AssistantTests(unittest.TestCase):
    def test_missing_key_does_not_connect_publicly(self):
        with patch.object(assistant, 'provider') as request:
            with self.assertRaises(assistant.AssistantError) as result:
                assistant.token('', 'agent', True)
            self.assertEqual(result.exception.status, 503)
            request.assert_not_called()

    def test_prepared_agent_returns_only_short_lived_credential(self):
        with patch.object(assistant, 'provider', side_effect=[READY, {'token': 'short-lived', 'other': 'private'}]) as request:
            self.assertEqual(assistant.token('private-key', 'agent'), {'conversationToken': 'short-lived', 'agentId': 'agent'})
            self.assertEqual(request.call_count, 2)

    def test_learner_cannot_change_agent_or_get_token_before_setup(self):
        with patch.object(assistant, 'provider', return_value={}) as request:
            with self.assertRaisesRegex(assistant.AssistantError, 'owner'):
                assistant.token('key', 'agent', False)
            self.assertEqual(request.call_count, 1)

    def test_owner_prepares_and_verifies_before_token(self):
        original = {'conversation_config': {'tts': {'voice_id': 'keep'}, 'agent': {
            'first_message': 'Welcome! How can I help?', 'prompt': {'prompt': 'Generic', 'llm': 'keep'}}}}
        with patch.object(assistant, 'provider', side_effect=[original, {}, READY, {'token': 'token'}]) as request:
            assistant.token('key', 'agent', True)
            update = request.call_args_list[1]
            self.assertEqual(update.args[2], 'PATCH')
            body = update.args[3]['conversation_config']
            self.assertNotIn('tts', body)
            self.assertNotIn('llm', body['agent']['prompt'])
            self.assertEqual(body['agent']['first_message'], '')
            self.assertEqual(body['agent']['prompt']['tools'][0]['name'], 'point_at_text')
            self.assertIn('No greeting', body['agent']['prompt']['prompt'])
            self.assertEqual(request.call_args_list[-1].args[1], 'conversation/token?agent_id=agent')

    def test_unsaved_settings_never_issue_token(self):
        with patch.object(assistant, 'provider', side_effect=[{}, {}, {}]) as request:
            with self.assertRaisesRegex(assistant.AssistantError, 'not saved'):
                assistant.token('key', 'agent', True)
            self.assertEqual(request.call_count, 3)

    def test_existing_prompt_with_greeting_is_not_ready(self):
        config = copy.deepcopy(READY)
        config['conversation_config']['agent']['first_message'] = 'Hello'
        self.assertFalse(assistant.ready(config))

    def test_empty_token_is_rejected(self):
        with patch.object(assistant, 'provider', side_effect=[READY, {'token': ''}]):
            with self.assertRaisesRegex(assistant.AssistantError, 'no conversation token'):
                assistant.token('key', 'agent')

    def test_provider_error_does_not_expose_response_or_key(self):
        error = HTTPError('https://provider', 403, 'private-key private-account', {}, io.BytesIO(b'private-account'))
        with patch.object(assistant, 'urlopen', side_effect=error):
            with self.assertRaises(assistant.AssistantError) as result:
                assistant.provider('private-key', 'agents/agent')
            self.assertIn('403', str(result.exception))
            self.assertNotIn('private', str(result.exception))

    def test_provider_uses_server_secret_and_bounded_timeout(self):
        with patch.object(assistant, 'urlopen') as request:
            request.return_value.__enter__.return_value.read.return_value = b'{"ok":true}'
            assistant.provider('server-secret', 'agents/agent', 'PATCH', {'conversation_config': {}})
            req = request.call_args.args[0]
            self.assertEqual(req.get_header('Xi-api-key'), 'server-secret')
            self.assertEqual(req.method, 'PATCH')
            self.assertEqual(json.loads(req.data), {'conversation_config': {}})
            self.assertLessEqual(request.call_args.kwargs['timeout'], 6)


if __name__ == '__main__':
    unittest.main()
