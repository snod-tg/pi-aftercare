import json

import httpx
import pytest

from evals.api_user import ApiUser, UserSimulationError


def simulator(monkeypatch, replies, *, profile='faithful-v1', attempts='2'):
    monkeypatch.setenv('MODEL_BASE_URL', 'http://fixture.test/v1')
    monkeypatch.setenv('MODEL_NAME', 'fixture-model')
    monkeypatch.setenv('TAU_USER_PROFILE', profile)
    monkeypatch.setenv('TAU_USER_MAX_ATTEMPTS', attempts)
    calls = []
    iterator = iter(replies)
    def handle(request):
        calls.append(json.loads(request.content))
        text, finish = next(iterator)
        return httpx.Response(200, json={'choices': [{'finish_reason': finish, 'message': {'content': text}}],
                                        'usage': {'total_tokens': 20, 'completion_tokens': 5}})
    return ApiUser(transport=httpx.MockTransport(handle)), calls


def test_upstream_prompt_uses_one_request_and_original_output_limit(monkeypatch):
    user, calls = simulator(monkeypatch, [('Hello', 'stop')], profile='upstream', attempts='1')
    assert user.reset('Return the keyboard') == 'Hello'
    assert len(calls) == 1 and calls[0]['max_tokens'] == 512
    assert 'Private simulator fidelity rules' not in calls[0]['messages'][0]['content']


def test_fidelity_rejects_invented_address_and_keeps_private_review_out_of_agent_reply(monkeypatch):
    user, calls = simulator(monkeypatch, [('Ship to 123 Invented Street', 'stop'),
        ('{"valid":false,"reason":"Do not invent an address; ask to use the other order."}', 'stop'),
        ('Please use my NYC address from my other order.', 'stop'), ('{"valid":true,"reason":""}', 'stop')])
    reply = user.reset('Use the NYC address already in my other order. PRIVATE_ONLY')
    assert reply == 'Please use my NYC address from my other order.'
    assert len(calls) == 4 and user.tokens == 80
    assert [m['role'] for m in calls[2]['messages']].count('system') == 1
    assert calls[2]['messages'][0]['role'] == 'system'
    assert 'Private repair instruction' in calls[2]['messages'][0]['content']
    assert len(user.messages) == 3
    assert all('Invented Street' not in m['content'] for m in user.messages)
    assert 'PRIVATE_ONLY' in calls[1]['messages'][1]['content']
    assert 'PRIVATE_ONLY' not in reply and 'valid' not in reply
    assert calls[1]['response_format']['json_schema']['strict'] is True


def test_completed_goal_requires_standalone_stop_instead_of_goodbye_loop(monkeypatch):
    user, calls = simulator(monkeypatch, [('Thank you, goodbye!', 'stop'),
        ('{"valid":false,"reason":"The prior agent completed all goals; reply exactly ###STOP###."}', 'stop'),
        ('###STOP###', 'stop'), ('{"valid":true,"reason":""}', 'stop')])
    user.instruction = 'Return the keyboard.'
    user.messages = [{'role': 'system', 'content': 'fixture'}, {'role': 'user', 'content': 'Your requested return is processed.'}]
    assert user.generate() == '###STOP###'
    assert len(calls) == 4


def test_truncation_is_observable_bounded_and_not_added_to_history(monkeypatch):
    user, calls = simulator(monkeypatch, [('partial', 'length'), ('still partial', 'length')])
    with pytest.raises(UserSimulationError) as caught:
        user.reset('Return both items')
    assert len(calls) == 2 and len(user.messages) == 2
    assert caught.value.details['finish_reason'] == 'length'
    assert caught.value.details['completion_tokens'] == 5
    assert caught.value.details['partial_response'] == 'still partial'
    assert user.tokens == 40


def test_invalid_review_fails_closed_and_existing_stop_is_normalized(monkeypatch):
    user, calls = simulator(monkeypatch, [('Thanks ###STOP###', 'stop'), ('{"valid":true,"reason":""}', 'stop')], attempts='1')
    assert user.reset('Return an item') == '###STOP###'
    assert json.loads(calls[1]['messages'][1]['content'])['candidate'] == '###STOP###'
    assert len(user.messages) == 3
    user, calls = simulator(monkeypatch, [('Hello', 'stop'), ('[]', 'stop')], attempts='1')
    with pytest.raises(UserSimulationError, match='格式错误'):
        user.reset('Return an item')


def test_http_failure_keeps_status_diagnostic_and_redacts_key(monkeypatch):
    monkeypatch.setenv('MODEL_BASE_URL', 'http://fixture.test/v1')
    monkeypatch.setenv('MODEL_NAME', 'fixture')
    monkeypatch.setenv('MODEL_API_KEY', 'test-secret-key')
    monkeypatch.setenv('TAU_USER_API_KEY', 'test-secret-key')
    monkeypatch.setenv('TAU_USER_PROFILE', 'faithful-v1')
    monkeypatch.setenv('TAU_USER_MAX_ATTEMPTS', '1')
    def handle(request):
        return httpx.Response(400, json={'error': {'message': 'Only one leading system message: test-secret-key'}})
    user = ApiUser(transport=httpx.MockTransport(handle))
    with pytest.raises(UserSimulationError) as caught:
        user.reset('Return item')
    assert caught.value.details['status'] == 400
    assert 'test-secret-key' not in json.dumps(user.diagnostics)
    assert 'Only one leading system message' in caught.value.details['response_excerpt']


def test_faithful_v2_uses_fact_evidence_and_keeps_unreliable_review_as_diagnostic(monkeypatch):
    user, calls = simulator(monkeypatch, [('Ship to 123 Central Park West.', 'stop'),
        ('Please look up my NYC address in my other order.', 'stop'),
        ('{"valid":false,"reason":"Customer must provide all order IDs."}', 'stop')], profile='faithful-v2')
    reply = user.reset('Use my NYC address from my other order. I do not know it.')
    assert reply == 'Please look up my NYC address in my other order.'
    assert len(calls) == 3
    assert user.diagnostics[1]['purpose'] == 'fact_rejection'
    assert user.diagnostics[-1]['purpose'] == 'fidelity_rejection'
    assert user.diagnostics[-1]['mode'] == 'audit'
    assert all('123 Central Park West' not in m['content'] for m in user.messages)


def test_audit_does_not_synthesize_stop_or_replace_a_valid_customer(monkeypatch):
    user, calls = simulator(monkeypatch, [('I still need help exchanging the other item.', 'stop'),
        ('{"valid":false,"reason":"Say STOP now."}', 'stop')], profile='faithful-v2')
    assert user.reset('Exchange two different items.') == 'I still need help exchanging the other item.'
    assert '###STOP###' not in user.messages[-1]['content']


def test_repeated_ungrounded_facts_use_a_recorded_nonterminal_clarification(monkeypatch):
    user, calls = simulator(monkeypatch, [('My email is invented@example.com', 'stop'),
        ('Use anotherfake@example.com', 'stop')], profile='faithful-v2')
    reply = user.reset('My name is Yusuf and my ZIP is 19122. Exchange my keyboard.')
    assert len(calls) == 2
    assert "don't have that information" in reply
    assert '###STOP###' not in reply and '@' not in reply
    assert user.diagnostics[-1]['purpose'] == 'fact_fallback'
    assert user.messages[-1]['content'] == reply
