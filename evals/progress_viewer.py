# 启动：.venv/bin/python -m evals.progress_viewer --run-dir .data/evals/tau-full-2026-10-19-agent9b-user4b-32k
# 查看：http://127.0.0.1:8766 （每2秒自动刷新，仅监听本机，只读评测元数据）
"""A read-only local progress page for a single evaluation directory."""
import argparse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent 评测进度</title>
<style>body{margin:0;background:#f4f6fa;color:#182230;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1050px;margin:40px auto;padding:0 24px}h1{margin:0;font-size:30px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}.muted{color:#637083;font-size:14px}.badge{padding:5px 14px;border-radius:20px;background:#dceaff;color:#1753a6}.roles,.cards{display:grid;gap:16px;margin:24px 0}.roles{grid-template-columns:1fr 1fr}.cards{grid-template-columns:repeat(4,1fr)}article{background:white;border:1px solid #e1e6ed;border-radius:14px;padding:18px}.number{font-size:30px;font-weight:650;margin-top:6px}.track{height:12px;border-radius:8px;background:#dce2ec;overflow:hidden;margin:12px 0 24px}.bar{height:100%;width:0;background:#3775df;transition:width .5s}pre{background:#152231;color:#d7e5ef;border-radius:12px;padding:20px;font:13px/1.7 ui-monospace,monospace;white-space:pre-wrap;max-height:430px;overflow:auto}.current{font-size:18px;font-weight:600}#notice{color:#a04417}@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}.roles{grid-template-columns:1fr}main{margin-top:20px}}</style>
<main><header><div><h1>官方全量评测进度</h1><div class="muted">自动刷新 · 只统计已结束任务的最终得分</div></div><div id="state" class="badge">连接中</div></header>
<div class="roles"><article><div class="muted">Agent · 独立服务</div><strong id="agent">—</strong><div class="muted" id="agentUrl"></div></article><article><div class="muted">客户模拟器 · 独立服务</div><strong id="user">—</strong><div class="muted" id="userUrl"></div></article></div>
<div class="cards"><article><div class="muted">已结束 / 总任务</div><div id="count" class="number">—</div></article><article><div class="muted">累计得分 / 已结束任务</div><div id="score" class="number">—</div></article><article><div class="muted">当前通过率</div><div id="rate" class="number">—</div></article><article><div class="muted">接口错误 / 超时</div><div id="errors" class="number">—</div></article></div>
<div class="track"><div class="bar" id="bar"></div></div><div class="current" id="current">等待读取进度</div><div class="muted" id="updated"></div><p id="notice"></p>
<h3>实时事件</h3><div class="muted">done=False 的步骤 reward=0 是中间状态；task_end 才代表本项最终结果。</div><pre id="log">等待日志…</pre></main>
<script>const el=id=>document.getElementById(id);async function update(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();el('state').textContent=d.state;el('agent').textContent=d.agent;el('agentUrl').textContent=d.agent_url;el('user').textContent=d.user;el('userUrl').textContent=d.user_url;el('count').textContent=d.finished+' / '+d.planned;el('score').textContent=d.score+' / '+d.finished;el('rate').textContent=d.finished?(100*d.score/d.finished).toFixed(1)+'%':'—';el('errors').textContent=d.errors;el('bar').style.width=(d.planned?100*d.finished/d.planned:0)+'%';el('current').textContent=d.current||'等待任务开始';el('updated').textContent='刷新时间：'+d.updated;el('notice').textContent='中间结果不是全量结论。当前上下文 '+d.context+'；每项结果自动保存，可断点续跑。';const box=el('log');const follow=box.scrollHeight-box.scrollTop-box.clientHeight<60;box.textContent=d.log||'等待日志…';if(follow)box.scrollTop=box.scrollHeight}catch(e){el('state').textContent='进度页面连接中断';el('updated').textContent=String(e)}}update();setInterval(update,2000);</script></html>'''


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def tail(path, limit=65536):
    try:
        with path.open('rb') as file:
            file.seek(0, 2)
            start = max(0, file.tell() - limit)
            file.seek(start)
            data = file.read().decode('utf8', errors='replace')
        return data.split('\n', 1)[-1] if start else data
    except OSError:
        return ''


def snapshot(directory):
    manifest = read_json(directory / 'manifest.json')
    config = manifest.get('config', {})
    summary = read_json(directory / 'summary.json')
    planned = summary.get('planned_runs', len(config.get('tasks', [])) * config.get('trials', 1))
    events = []
    for line in tail(directory / 'progress.jsonl').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    starts = [event for event in events if event.get('event') == 'task_start']
    last = events[-1] if events else {}
    current = starts[-1].get('task', '') if starts else ''
    if last:
        current += ' · ' + str(last.get('event', ''))
        if 'action' in last:
            current += ' · ' + str(last['action'])
    alive = False
    try:
        pid = int((directory.parent / (directory.name + '.pid')).read_text())
        os.kill(pid, 0)
        alive = True
    except (OSError, ValueError):
        pass
    statuses = summary.get('statuses', {})
    return {'state': '已结束' if summary.get('complete') else '运行中' if alive else '已停止 / 等待启动',
            'planned': planned, 'finished': summary.get('finished_runs', 0),
            'score': sum(task.get('successes', 0) for task in summary.get('per_task', [])),
            'errors': statuses.get('error', 0) + statuses.get('timeout', 0),
            'agent': config.get('model', '—'), 'agent_url': config.get('model_base_url', ''),
            'user': config.get('user_model', '—'), 'user_url': config.get('user_base_url', ''),
            'context': config.get('context_window', '—'), 'current': current,
            'log': '\n'.join(tail(directory / 'progress.log').splitlines()[-65:]),
            'updated': datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True, type=Path)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    directory = args.run_dir.resolve()
    if not (directory / 'manifest.json').is_file():
        parser.error('运行目录尚未生成 manifest.json')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            if self.path == '/':
                data, content_type = PAGE.encode(), 'text/html; charset=utf-8'
            elif self.path == '/api/status':
                data, content_type = json.dumps(snapshot(directory), ensure_ascii=False).encode(), 'application/json; charset=utf-8'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Progress page ready: http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
