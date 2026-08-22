#!/usr/bin/env python3
"""
publish.py — take every paper in question-bank/, encrypt it, tell the sheet
about it, and push. One command, no manual steps.

    pip install cryptography requests
    python publish.py

What it does, per file:
  question-bank/dayN.json  ->  validate
                           ->  encrypt with a fresh random passphrase
                           ->  data/dayN.json          (safe to make public)
                           ->  Papers row in the sheet (day, date, key, ...)
  then: git commit + push

The app goes live for each paper on the date inside its own meta.date. You do
not touch anything on the morning of a test.

First run only: create .quickcbt.json next to this script (it is git-ignored):

    {
      "apiUrl":     "https://script.google.com/macros/s/..../exec",
      "adminToken": "<the adminToken value from the Settings tab of your sheet>"
    }
"""

import base64
import glob
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.request

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    sys.exit("Missing dependency. Run:  pip install cryptography")

ROOT = os.path.dirname(os.path.abspath(__file__))
BANK = os.path.join(ROOT, "question-bank")
DATA = os.path.join(ROOT, "data")
CONF = os.path.join(ROOT, ".quickcbt.json")

# Must match decryptPayload() in assets/js/app.js
ITERATIONS = 120_000

RED, GREEN, YELLOW, DIM, OFF = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[0m"


def die(msg):
    print(f"{RED}✗ {msg}{OFF}")
    sys.exit(1)


def load_config():
    if not os.path.exists(CONF):
        die(
            ".quickcbt.json not found.\n"
            "  Create it next to publish.py with your /exec URL and the\n"
            "  adminToken from the Settings tab of your sheet. See the\n"
            "  docstring at the top of this file."
        )
    with open(CONF, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for key in ("apiUrl", "adminToken"):
        if not cfg.get(key):
            die(f'.quickcbt.json is missing "{key}"')
    return cfg


def validate(paper, name):
    """Same checks as admin.html. Returns (errors, warnings)."""
    errors, warnings = [], []
    meta = paper.get("meta") or {}

    if not meta.get("day"):
        errors.append("meta.day is missing")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(meta.get("date", ""))):
        errors.append("meta.date is missing or not YYYY-MM-DD")
    if not meta.get("title"):
        warnings.append("meta.title is missing")
    if not meta.get("durationMinutes"):
        warnings.append("meta.durationMinutes missing — the app will use 15")

    questions = paper.get("questions") or []
    if not questions:
        errors.append("no questions")
        return errors, warnings

    seen = set()
    for i, q in enumerate(questions, 1):
        at = f"Q{i}"
        qid = q.get("id")
        if not qid:
            errors.append(f"{at}: no id")
        elif qid in seen:
            errors.append(f'{at}: duplicate id "{qid}"')
        else:
            seen.add(qid)

        if not q.get("text"):
            errors.append(f"{at}: no question text")

        options = q.get("options") or []
        if len(options) < 2:
            errors.append(f"{at}: fewer than 2 options")
            continue

        ids = [o.get("id") for o in options]
        answer = q.get("answer")
        if not answer:
            errors.append(f"{at}: no answer")
        elif answer not in ids:
            errors.append(f'{at}: answer "{answer}" is not one of {ids}')

        for o in options:
            if not o.get("text"):
                errors.append(f'{at}: option {o.get("id")} has no text')
            if o.get("id") != answer and not o.get("feedback"):
                warnings.append(f'{at}: option {o.get("id")} has no tailored feedback')

        if not q.get("explanation"):
            warnings.append(f"{at}: no explanation")

    return errors, warnings


def encrypt(plaintext, passphrase):
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS
    ).derive(passphrase.encode("utf-8"))
    blob = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": 1, "enc": "aes-gcm", "salt": b64(salt), "iv": b64(iv), "data": b64(blob)}


def call_api(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def git(*args, check=True):
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=check
    )


def main():
    cfg = load_config()
    os.makedirs(DATA, exist_ok=True)

    files = sorted(
        glob.glob(os.path.join(BANK, "day*.json")),
        key=lambda p: int(re.search(r"day(\d+)", os.path.basename(p)).group(1)),
    )
    if not files:
        die("No question-bank/dayN.json files found.")

    papers, blocked, dates = [], False, {}

    for path in files:
        name = os.path.basename(path)
        try:
            with open(path, encoding="utf-8") as fh:
                paper = json.load(fh)
        except json.JSONDecodeError as exc:
            print(f"{RED}✗ {name}: invalid JSON — {exc}{OFF}")
            blocked = True
            continue

        errors, warnings = validate(paper, name)
        if errors:
            blocked = True
            print(f"{RED}✗ {name}{OFF}")
            for e in errors[:8]:
                print(f"    {RED}{e}{OFF}")
            if len(errors) > 8:
                print(f"    {RED}...and {len(errors) - 8} more{OFF}")
            continue

        meta = paper["meta"]
        day, date = int(meta["day"]), str(meta["date"])
        if date in dates:
            print(f"{RED}✗ {name}: date {date} already used by {dates[date]}{OFF}")
            blocked = True
            continue
        dates[date] = name

        passphrase = secrets.token_urlsafe(24)
        out = os.path.join(DATA, f"day{day}.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(encrypt(json.dumps(paper), passphrase), fh)

        papers.append(
            {
                "day": day,
                "date": date,
                "title": meta.get("title", f"Day {day}"),
                "questionCount": len(paper["questions"]),
                "durationMinutes": meta.get("durationMinutes", 15),
                "file": f"data/day{day}.json",
                "key": passphrase,
            }
        )

        note = f"  {YELLOW}({len(warnings)} warning{'s' if len(warnings) != 1 else ''}){OFF}" if warnings else ""
        print(
            f"{GREEN}✓{OFF} {name:<14} {date}  "
            f"{len(paper['questions']):>3} questions  "
            f"{meta.get('durationMinutes', 15)} min  -> data/day{day}.json{note}"
        )
        for w in warnings[:3]:
            print(f"    {DIM}{w}{OFF}")

    if blocked:
        die("Nothing published — fix the errors above and run again.")
    if not papers:
        die("Nothing to publish.")

    print(f"\n{DIM}Sending {len(papers)} paper rows to the sheet...{OFF}")
    res = call_api(
        cfg["apiUrl"],
        {"action": "config", "token": cfg["adminToken"], "papers": papers},
    )
    if not res.get("ok"):
        die(f"Sheet rejected the update: {res.get('error')}")

    active = res.get("activeDay")
    print(
        f"{GREEN}✓{OFF} Sheet updated. Today is {res.get('today')} — "
        + (f"{GREEN}day {active} is live{OFF}" if active else f"{YELLOW}no paper scheduled today{OFF}")
    )

    status = git("status", "--porcelain").stdout.strip()
    if not status:
        print(f"{DIM}Nothing changed in git.{OFF}")
        return

    git("add", "-A")
    git("commit", "-m", f"Publish {len(papers)} paper(s)")
    push = git("push", check=False)
    if push.returncode != 0:
        print(f"{YELLOW}! Committed, but the push failed:{OFF}\n{push.stderr.strip()}")
        print(f"{YELLOW}  Run 'git push' yourself.{OFF}")
        return

    print(f"{GREEN}✓{OFF} Pushed. The site will redeploy in a moment.")
    print(f"\n{DIM}Keys live only in the sheet. data/*.json is unreadable without them.{OFF}")


if __name__ == "__main__":
    main()
