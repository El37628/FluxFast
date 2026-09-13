"""Real isolated process tree used by supervisor lifecycle regressions."""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--marker", type=Path, required=True)
parser.add_argument("--descendant", action="store_true")
parser.add_argument("--ignore-term", action="store_true")
parser.add_argument("--exit-code", type=int)
parser.add_argument("--port", type=int)
arguments = parser.parse_args()

listener = None
if arguments.port is not None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", arguments.port))
    listener.listen()

if arguments.ignore_term:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

descendant = None
if arguments.descendant:
    descendant_marker = arguments.marker.with_suffix(".descendant.json")
    descendant = subprocess.Popen(
        [
            sys.executable,
            __file__,
            "--marker",
            str(descendant_marker),
            "--ignore-term",
        ]
    )
    deadline = time.monotonic() + 5
    while not descendant_marker.is_file():
        if descendant.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError("descendant failed to initialize")
        time.sleep(0.005)

temporary_marker = arguments.marker.with_suffix(".tmp")
temporary_marker.write_text(
    json.dumps(
        {
            "pid": os.getpid(),
            "descendant": descendant.pid if descendant else None,
        }
    )
)
temporary_marker.replace(arguments.marker)
if arguments.exit_code is not None:
    raise SystemExit(arguments.exit_code)

while True:
    time.sleep(0.1)
