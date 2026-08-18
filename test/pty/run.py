#!/usr/bin/env python3
"""End-to-end check over a real pty, under Bun.

Hunk runs extensions under Bun, not Node, and Bun's terminal behavior differs in ways
the unit tests cannot see, because they inject a fake stream. Two earlier designs of
this extension shipped bugs only visible here:

  * closing a /dev/tty descriptor while a read is pending blocks forever, so a
    terminal that ignores the query hung startup instead of falling back to dark;
  * an open /dev/tty *read* stream permanently starves process.stdin, so the review
    UI never received a keystroke again.

This harness gives the extension a real controlling terminal, answers its OSC 11 query
with a known background, and checks the theme it chose, that typing still works
afterwards, and that a re-run factory reuses the cached answer instead of querying a
live renderer's streams.

Usage: python3 test/pty/run.py
"""

import json
import os
import pty
import select
import sys
import time

DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "driver.ts")
TIMEOUT_SECONDS = 20

CASES = [
    ("white", b"ffff/ffff/ffff", "light", "github-light-default"),
    ("#1e1e1e", b"1e1e/1e1e/1e1e", "dark", "github-dark-default"),
    ("solarized light #fdf6e3", b"fdfd/f6f6/e3e3", "light", "github-light-default"),
    ("no reply at all", None, "dark", "github-dark-default"),
]


def run(background, keyboard=False, reload=False):
    """Run the driver on a pty, answering its query and optionally typing at it.

    Returns (answered, result dict, typed-back string or None, queries written).
    """
    pid, fd = pty.fork()
    if pid == 0:
        argv = ["bun", DRIVER]
        if keyboard:
            argv.append("keyboard")
        elif reload:
            argv.append("reload")
        os.execvp("bun", argv)

    output, answered, typed_at, deadline = b"", False, False, time.time() + TIMEOUT_SECONDS
    queries = 0
    while time.time() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.2)
        if readable:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            queries = output.count(b"]11;?")
            if background and not answered and queries:
                os.write(fd, b"\x1b]11;rgb:" + background + b"\x07")
                answered = True
        # Wait for TYPE-NOW: before raw mode is on, the line discipline holds bytes back.
        if keyboard and not typed_at and b"TYPE-NOW" in output:
            os.write(fd, b"ABC")
            typed_at = True
        done = b"KEYBOARD " in output if keyboard else b"RESULT " in output
        if done:
            break

    try:
        os.close(fd)
        os.waitpid(pid, 0)
    except OSError:
        pass

    text = output.decode(errors="replace")
    result, keys = None, None
    for line in text.splitlines():
        for marker, setter in (("RESULT ", "result"), ("KEYBOARD ", "keys")):
            at = line.find(marker)
            if at != -1:
                value = json.loads(line[at + len(marker) :])
                if setter == "result":
                    result = value
                else:
                    keys = value
    if result is None:
        raise AssertionError(f"driver produced no result; output was {output!r}")
    return answered, result, keys, output.count(b"]11;?")


def check(name, background, expected_mode, expected_base):
    answered, result, _, _ = run(background)
    theme = result["themes"][0] if result["themes"] else {}
    problems = []
    if background and not answered:
        problems.append("query was never written to the terminal")
    if expected_mode not in " ".join(result["logs"]):
        problems.append(f"expected mode {expected_mode}, logs said {result['logs']}")
    if theme.get("base") != expected_base:
        problems.append(f"expected base {expected_base}, got {theme.get('base')!r}")
    if theme.get("id") != "adaptive-theme":
        problems.append(f"expected id adaptive-theme, got {theme.get('id')!r}")
    report(name + f" -> {theme.get('base')}", problems)
    return problems


def check_keyboard():
    """The regression guard: the query must not consume the keyboard afterwards."""
    failures = []
    for name, background in (("after a reply", b"ffff/ffff/ffff"), ("after no reply", None)):
        _, _, keys, _ = run(background, keyboard=True)
        problems = [] if keys == "ABC" else [f"renderer received {keys!r} instead of 'ABC'"]
        report(f"keyboard still works {name} -> {keys!r}", problems)
        failures += problems
    return failures


def check_reload():
    """A re-run factory must reuse the cached answer instead of querying again."""
    _, result, _, queries = run(b"ffff/ffff/ffff", reload=True)
    problems = []
    if queries != 1:
        problems.append(f"factory ran twice but wrote {queries} queries, expected 1")
    if len(result["themes"]) != 2:
        problems.append(f"expected 2 registrations from 2 runs, got {len(result['themes'])}")
    bases = {theme.get("base") for theme in result["themes"]}
    if bases != {"github-light-default"}:
        problems.append(f"both runs should pick the light theme, got {bases}")
    report(f"reload reuses one query -> {queries} query, {len(result['themes'])} registrations", problems)
    return problems


def report(label, problems):
    print(f"{'FAIL' if problems else 'ok  '}  {label}")
    for problem in problems:
        print(f"        {problem}")


def main():
    failures = []
    for case in CASES:
        failures += check(*case)
    failures += check_keyboard()
    failures += check_reload()

    total = len(CASES) + 3
    print(f"\n{total - len(failures)}/{total} passed" if not failures else "\nFAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
