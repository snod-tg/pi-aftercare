import json
import httpx
from evals.run_tau import ApiUser


def test_user_simulator_uses_its_own_endpoint_model_and_history(monkeypatch):
    monkeypatch.setenv('MODEL_BASE_URL', 'http://agent.test/v1')
    monkeypatch.setenv('MODEL_NAME', 'agent-4b')
    monkeypatch.setenv('TAU_USER_BASE_URL', 'http://user.test/v1')
    monkeypatch.setenv('TAU_USER_MODEL', 'user-4b')
    monkeypatch.setenv('TAU_USER_API_KEY', 'user-test-key')
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': 'Yes, please continue.'}}], 'usage': {'total_tokens': 5}})
    original = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    user = ApiUser()
    assert user.reset('Return the T-shirt after checking the quote.') == 'Yes, please continue.'
    assert user.step('Please confirm the return.') == 'Yes, please continue.'
    assert all(str(request.url) == 'http://user.test/v1/chat/completions' for request in requests)
    assert all(json.loads(request.content)['model'] == 'user-4b' for request in requests)
    assert all(request.headers['Authorization'] == 'Bearer user-test-key' for request in requests)
    assert user.tokens == 10
    assert len(json.loads(requests[0].content)['messages']) == 2
    assert len(json.loads(requests[1].content)['messages']) == 4
