# QuickCBT

A small, fast CBT app for daily exam practice. A student asks for a code, it
arrives in their inbox, and it works exactly once. They sit a timed paper and get
instant feedback on every question — including why the option *they* picked is
wrong, not just why the correct one is right.

The site is static and runs free on GitHub Pages. Access control, the one-attempt
rule and the clock live in a free Google Apps Script backend attached to a
spreadsheet you own. No hosting bill, no card, no new accounts.

---

## Launch it in 5 minutes

```bash
cd "QUICK CBT"
git init
git add .
git commit -m "QuickCBT"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save.**

A minute later it is live at `https://<you>.github.io/<repo>/`.

> Testing locally? Open a terminal in this folder and run `npx serve` (or
> `python -m http.server`), then visit the address it prints. Opening
> `index.html` straight off your disk will **not** work — browsers block
> `fetch()` on `file://`.

---

## The two files you edit

### `data/access.json`

```json
{
  "app": {
    "title": "OAU Post-UTME Prep",
    "subtitle": "Daily timed practice — Great Ife, here we come.",
    "supportContact": "you@gmail.com"
  },
  "apiUrl": "https://script.google.com/macros/s/..../exec",
  "dayCode": "OAU-DAY1",
  "dayCodeHash": "",
  "resultsEndpoint": "",
  "allowedEmails": [
    "student.one@gmail.com",
    "student.two@gmail.com"
  ]
}
```

- **`apiUrl`** — your Apps Script web app URL. Setting it turns on code mode and
  makes everything below it unused. See [SETUP-SHEET.md](SETUP-SHEET.md).
- **`allowedEmails`** — local mode only: the whitelist. Gmail dots and `+tags` are
  normalised everywhere, so `t.e.s.t+x@gmail.com` cannot sneak in a second attempt.
- **`dayCode`** — the plain code you send out each morning. Fine to start with.
- **`dayCodeHash`** — the safer version: put the SHA-256 of the code here and leave
  `dayCode` empty, so the code is not sitting in your public repo. `admin.html`
  generates it.
- **`resultsEndpoint`** — local mode only. In code mode scores go to the sheet.

### `data/questions.json`

Today's paper, and only today's. Full format:

```json
{
  "meta": {
    "day": 1,
    "title": "Day 1 — English & Use of English",
    "durationMinutes": 15,
    "passMark": 50
  },
  "questions": [
    {
      "id": "d1q1",
      "subject": "English",
      "text": "The principal, together with the teachers, ______ arrived.",
      "options": [
        { "id": "A", "text": "have", "feedback": "\"Have\" needs a plural subject; the subject here is the singular \"principal\"." },
        { "id": "B", "text": "has",  "feedback": "" },
        { "id": "C", "text": "were", "feedback": "\"Were\" is plural and past tense." },
        { "id": "D", "text": "are",  "feedback": "\"Are\" cannot pair with \"arrived\" here." }
      ],
      "answer": "B",
      "explanation": "With 'together with', 'as well as' or 'in addition to', the verb still agrees with the original singular subject."
    }
  ]
}
```

- `feedback` on each **wrong** option is what the student sees the moment they pick
  it — write it as a direct correction of that specific mistake. Leave the correct
  option's `feedback` empty.
- `explanation` is the teaching note for the correct answer. Everyone sees it.
- `subject` drives the per-subject breakdown on the result sheet. Optional.
- Question order **and** option order are shuffled per student, so "the answer is
  3-C" is useless information to pass around.

---

## The daily routine

All seven papers live in **`question-bank/`**, which is git-ignored — nothing in
there ever reaches GitHub. Each morning:

1. Open `admin.html` in your browser.
2. Paste that day's file from `question-bank/` and type the day's code.
3. Hit **Check the paper** — it catches missing answers, duplicate ids, options
   with no feedback, and answer keys that point at nothing.
4. Hit **Encrypt & download**, then move the downloaded `questions.json` into
   `data/`, replacing yesterday's.
5. Hit **Hash the code**, paste the hash into `access.json` as `dayCodeHash`, and
   set `dayCode` to `""`.
6. `git add . && git commit -m "Day 2" && git push`
7. In the sheet: **QuickCBT → Move to the next day**, then update `title`,
   `questionCount` and `paperKey` in the Settings tab.

Steps 4–5 are optional — ship the plain JSON if you are in a hurry. In code mode
the day code in step 5 is not used at all; students get their own codes instead.

---

## Two modes

The app reads `apiUrl` in `data/access.json` and switches itself:

**Local mode** (`apiUrl` empty) — one shared day code, a whitelist in the repo,
attempt lock in the browser. Good for a dry run.

**Code mode** (`apiUrl` set) — the real thing. A free Google Apps Script backend
issues **one code per gmail**, emails it from your own Gmail, consumes it on
first use, and owns the clock. Students press "Email me my access code" on the
page; you can approve each address first if you want.

Setup is in **[SETUP-SHEET.md](SETUP-SHEET.md)** — about 15 minutes, no new
accounts, nothing to pay. The script itself is `server/Code.gs`.

In code mode you get, per student per day: when they asked, whether you
approved, when they started, when they submitted, their score, how long they
took, whether the clock beat them, and how many times they left the tab.

## What this does and does not stop

In code mode:

- **One code per gmail**, emailed to that address. Requesting twice resends the
  same code; it never mints a second.
- **The code is bound to the email.** Passing it to a friend does nothing — the
  server finds the row by email first, then checks the code on it.
- **Used once, server-side.** Clearing site data, another browser, another
  laptop: the attempt is already spent.
- **The clock is on the server.** Closing the tab does not pause it and cannot
  be reset.
- **Optional manual approval** — every request waits as `pending` until you
  release it from the sheet menu.
- Refreshing mid-test resumes where they left off with the clock still running down,
  so there is no reloading away from a hard question.
- Randomised question and option order per student.
- Tab switches are counted and reported.
- The clock is absolute — closing the laptop does not pause it.

Be clear-eyed about the limits:

- **A student can still register a new gmail.** No system fixes that without
  checking ID. What you get instead is that every new address shows up in your
  sheet before it is let in, and with manual approval it needs your click.
- **Encryption buys time, not secrecy.** Someone in devtools during their own
  attempt can still dig the paper out. Against juniors racing a 15-minute clock
  this is plenty.
- **In local mode the lock is browser-local** and a cleared cache defeats it.
  That is what code mode exists to fix.

Supabase or Firebase would buy nothing over this: they enforce the same
one-attempt-per-email rule, are equally powerless against a second gmail, and
neither can send an email without signing up for a third-party mail service on
top.
