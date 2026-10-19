"""Append progress metadata only: no prompts, answers, tool arguments or credentials."""
from datetime import datetime
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo


def progress(event, *, path=None, label=None, **fields):
    target = path or os.environ.get('TAU_PROGRESS_FILE')
    if not target:
        return
    record = {'time': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'),
              'event': event, 'task': label or os.environ.get('TAU_PROGRESS_LABEL', ''), **fields}
    target = Path(target)
    try:
        # A single append per entry; the runner executes trials sequentially.
        with target.open('a', encoding='utf8') as output:
            output.write(json.dumps(record, ensure_ascii=False) + '\n')
        with target.with_suffix('.log').open('a', encoding='utf8') as output:
            details = ' '.join(f'{key}={value}' for key, value in fields.items())
            output.write(f"{record['time']} {record['task']} {event} {details}\n")
    except OSError:
        # A progress display failure must not change the benchmark's business result.
        pass
