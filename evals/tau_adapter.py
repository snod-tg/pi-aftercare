"""Pi SDK Agent implementation of the pinned upstream tau-bench Agent interface."""
from __future__ import annotations
import json
import os
from pathlib import Path
from queue import Queue, Empty
import subprocess
import tempfile
from threading import Thread
from typing import Any

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
from tau_bench.agents.base import Agent
from tau_bench.types import Action, SolveResult

ROOT = Path(__file__).resolve().parents[1]

class PiTauAgent(Agent):
    def __init__(self, *, project_root: Path = ROOT, model_base_url: str | None = None,
                 model_name: str | None = None, api_key: str | None = None, timeout: float = 150):
        self.root = project_root
        self.timeout = timeout
        self.env = dict(os.environ)
        for name, value in (("MODEL_BASE_URL", model_base_url), ("MODEL_NAME", model_name), ("MODEL_API_KEY", api_key)):
            if value is not None:
                self.env[name] = value

    def solve(self, env, task_index: int | None = None, max_num_steps: int = 30) -> SolveResult:
        if not 1 <= max_num_steps <= 100:
            raise ValueError("max_num_steps must be in 1..100")
        reset = env.reset(task_index=task_index)
        info = reset.info.model_dump()
        messages: list[dict[str, Any]] = [{"role": "system", "content": env.wiki}, {"role": "user", "content": reset.observation}]
        reward, terminal, steps, tokens = 0.0, False, 0, 0
        status = "step_limit"
        worker_stats: dict[str, Any] = {}
        inbox: Queue = Queue()
        with tempfile.TemporaryFile(mode="w+t") as stderr:
            process = subprocess.Popen([str(self.root / ".runtime/node/bin/node"), "--import", "tsx", "scripts/tau-worker.ts"],
                                       cwd=self.root, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=stderr, text=True, bufsize=1)
            def reader():
                try:
                    for line in process.stdout:
                        inbox.put(json.loads(line))
                except Exception as exc:
                    inbox.put({"type": "error", "error": str(exc)})
                finally:
                    inbox.put({"type": "error", "error": "Pi worker ended"})
            Thread(target=reader, daemon=True).start()
            def send(message):
                process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
                process.stdin.flush()
            def receive():
                try:
                    message = inbox.get(timeout=self.timeout)
                except Empty as exc:
                    raise TimeoutError("Pi worker timed out") from exc
                if message.get("type") == "error":
                    raise RuntimeError(message.get("error", "Pi worker error"))
                return message
            def step(action: Action):
                nonlocal steps, info, reward, terminal
                if steps >= max_num_steps:
                    raise RuntimeError("environment step limit reached")
                steps += 1
                response = env.step(action)
                reward, terminal = response.reward, response.done
                info.update(response.info.model_dump())
                return response
            try:
                send({"type": "init", "tools": env.tools_info, "wiki": env.wiki, "maxSteps": max_num_steps})
                if receive()["type"] != "ready":
                    raise RuntimeError("Pi worker handshake failed")
                observation = reset.observation
                while steps < max_num_steps and not terminal:
                    send({"type": "prompt", "text": observation})
                    while True:
                        event = receive()
                        if event["type"] == "action":
                            action = Action(**event["action"])
                            response = step(action)
                            messages.extend([
                                {"role": "assistant", "tool_calls": [{"id": event["id"], "type": "function", "function": {"name": action.name, "arguments": json.dumps(action.kwargs)}}]},
                                {"role": "tool", "tool_call_id": event["id"], "name": action.name, "content": response.observation},
                            ])
                            send({"type": "observation", "id": event["id"], "observation": response.observation, "done": response.done})
                        elif event["type"] == "turn":
                            worker_stats = {k: event[k] for k in ("modelCalls", "toolCalls")}
                            tokens += event["tokens"]
                            if event.get("error"):
                                raise RuntimeError(event["error"])
                            if terminal:
                                break
                            if not event.get("text"):
                                raise RuntimeError("Pi returned an empty response")
                            response = step(Action(name="respond", kwargs={"content": event["text"]}))
                            messages.extend([{"role": "assistant", "content": event["text"]}, {"role": "user", "content": response.observation}])
                            observation = response.observation
                            break
                        else:
                            raise RuntimeError("unexpected Pi worker event")
                status = "completed" if terminal else "step_limit"
            except Exception as exc:
                status = "error"
                info["adapter_error"] = str(exc)[:1000]
            finally:
                try:
                    send({"type": "close"})
                    process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=3)
                process.stdin.close()
                process.stdout.close()
        info["pi_adapter"] = {"status": status, "environment_steps": steps, "tokens": tokens, **worker_stats,
                              "upstream_commit": "59a200c6d575d595120f1cb70fea53cef0632f6b", "cost": "unknown"}
        return SolveResult(reward=reward if terminal else 0.0, messages=messages, info=info, total_cost=None)
