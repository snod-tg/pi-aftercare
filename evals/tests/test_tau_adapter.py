import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from evals.tau_adapter import PiTauAgent
from evals.tau_smoke import make_smoke_env

@contextmanager
def model_api(*, wrong_item=False, unavailable=False, finish_length_at=None, recover_text=False):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if unavailable:
                self.send_response(503); self.end_headers(); return
            actual_index = len(requests) - 1
            index = actual_index - 1 if recover_text and actual_index >= 2 else actual_index
            if index == 0:
                delta = {"tool_calls": [{"index": 0, "id": "read-1", "type": "function", "function": {"name": "get_order_details", "arguments": json.dumps({"order_id": "#W1000000"})}}]}
            elif index == 1:
                delta = {"content": "订单已签收，退商品1001，退款原路返回。请明确确认。"}
            elif index == 2:
                delta = {"tool_calls": [{"index": 0, "id": "write-1", "type": "function", "function": {"name": "return_delivered_order_items", "arguments": json.dumps({"order_id": "#W1000000", "item_ids": ["wrong" if wrong_item else "1001"], "payment_method_id": "credit_card_100"})}}]}
            else:
                delta = {"content": "退货申请已创建，等待寄回，退款尚未到账。"}
            base = {"id": f"response-{index}", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
            chunks = [
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", **delta}, "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "length" if actual_index == finish_length_at else "tool_calls" if "tool_calls" in delta else "stop"}]},
                {**base, "choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60}},
            ]
            data = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)

def test_native_tau_env_tools_user_and_final_state_reward_through_real_pi_sdk(tmp_path, monkeypatch):
    log = tmp_path / "progress.jsonl"
    monkeypatch.setenv("TAU_PROGRESS_FILE", str(log))
    monkeypatch.setenv("TAU_PROGRESS_LABEL", "fixture task=0 trial=1")
    env = make_smoke_env()
    with model_api() as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(env, task_index=0, max_num_steps=10)
    assert result.reward == 1, result.info
    assert result.info["pi_adapter"]["status"] == "completed"
    assert result.info["pi_adapter"]["environment_steps"] == 4
    assert len(requests) == 4
    assert requests[0]["tools"][0]["function"]["name"] == "get_order_details"
    assert not any(tool["function"]["name"] in ("bash", "read", "create_aftercare_request") for tool in requests[0]["tools"])
    assert result.total_cost is None
    events = [json.loads(line) for line in log.read_text().splitlines()]
    assert any(event['event'] == 'model_request' for event in events)
    assert any(event['event'] == 'environment_action' and event['action'] == 'return_delivered_order_items' for event in events)
    assert all('content' not in event and 'kwargs' not in event for event in events)
    assert log.with_suffix('.log').exists()

def test_model_claim_of_success_cannot_override_upstream_database_reward():
    with model_api(wrong_item=True) as (url, _):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=10)
    assert result.reward == 0
    assert result.info["reward_info"]["info"]["r_actions"] == 0
    assert any("退货申请已创建" in message.get("content", "") for message in result.messages)

def test_adapter_bounds_actions_and_propagates_model_api_failure():
    with model_api() as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=1)
    assert result.reward == 0
    assert result.info["pi_adapter"]["environment_steps"] <= 1
    assert len(requests) <= 1
    with model_api(unavailable=True) as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=10)
    assert result.reward == 0
    assert result.info["pi_adapter"]["status"] == "error"
    assert len(requests) == 1


def test_truncated_tool_output_is_recorded_but_never_executed():
    env = make_smoke_env()
    with model_api(finish_length_at=2) as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(env, task_index=0, max_num_steps=10)
    assert result.reward == 0 and result.info['pi_adapter']['status'] == 'error'
    assert env.data['orders']['#W1000000']['status'] == 'delivered'
    truncated = next(d for d in result.info['model_diagnostics'] if d['stopReason'] == 'length')
    assert truncated['outputTokens'] == 10
    assert 'return_delivered_order_items' in truncated['partial']


def test_customer_failure_preserves_agent_reply_and_structured_diagnostics():
    from evals.api_user import UserSimulationError
    env = make_smoke_env()
    def fail(content):
        raise UserSimulationError('用户模拟器没有生成完整回复', {'finish_reason': 'length', 'completion_tokens': 512})
    env.user.step = fail
    with model_api() as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(env, task_index=0, max_num_steps=10)
    assert result.messages[-1]['role'] == 'assistant'
    assert '明确确认' in result.messages[-1]['content']
    assert result.info['error_details']['finish_reason'] == 'length'


def test_careful_profile_blocks_wrong_item_without_hidden_instruction_leak(monkeypatch):
    monkeypatch.setenv('TAU_AGENT_PROFILE', 'careful-v1')
    env = make_smoke_env()
    env.task.instruction += ' PRIVATE_TEST_SECRET'
    with model_api(wrong_item=True) as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(env, task_index=0, max_num_steps=10)
    assert result.reward == 0
    assert result.info['action_guard_rejections'][0]['tool'] == 'return_delivered_order_items'
    assert result.info['reward_info']['info']['r_actions'] == 0
    assert any(m.get('role') == 'tool' and 'observed-fact guard' in m.get('content', '') for m in result.messages)
    assert 'PRIVATE_TEST_SECRET' not in json.dumps(requests)
    assert 'Track every request' in requests[0]['messages'][0]['content'] or 'track every request' in requests[0]['messages'][0]['content']


def test_model_call_limit_is_independent_and_counts_only_issued_requests(monkeypatch):
    monkeypatch.setenv('TAU_MAX_MODEL_CALLS', '1')
    with model_api() as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name="test-model", api_key="local", timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=10)
    assert len(requests) == 1
    assert result.info['pi_adapter']['modelCalls'] == 1
    assert result.info['worker_error_code'] == 'model_call_limit'


def test_read_only_truncation_can_retry_once_without_replaying_tools(monkeypatch):
    monkeypatch.setenv('TAU_AGENT_PROFILE', 'careful-v1')
    with model_api(finish_length_at=1, recover_text=True) as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name='test-model', api_key='local', timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=10)
    assert result.reward == 1, result.info
    assert len(requests) == 5
    assert sum(m.get('name') == 'get_order_details' for m in result.messages) == 1
    assert any(d['stopReason'] == 'length' for d in result.info['model_diagnostics'])


def test_truncation_after_attempted_write_is_never_retried(monkeypatch):
    monkeypatch.setenv('TAU_AGENT_PROFILE', 'careful-v1')
    with model_api(finish_length_at=3) as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name='test-model', api_key='local', timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=10)
    assert result.info['pi_adapter']['status'] == 'error'
    assert len(requests) == 4


def test_exact_environment_step_boundary_stops_without_extra_model_request():
    with model_api() as (url, requests):
        result = PiTauAgent(model_base_url=url, model_name='test-model', api_key='local', timeout=15).solve(make_smoke_env(), task_index=0, max_num_steps=1)
    assert result.info['pi_adapter']['status'] == 'step_limit'
    assert len(requests) == 1
    assert result.info['pi_adapter']['environment_steps'] == 1
