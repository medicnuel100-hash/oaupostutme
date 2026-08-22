# QuickCBT

A small, fast, static CBT app for daily exam practice. Students enter a whitelisted
email plus the day's access code, sit a timed paper, and get instant feedback on
every question — including why the option *they* picked is wrong, not just why the
correct one is right.

No server, no database, no build step. It runs on GitHub Pages.

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
  "dayCode": "OAU-DAY1",
  "dayCodeHash": "",
  "resultsEndpoint": "",
  "allowedEmails": [
    "student.one@gmail.com",
    "student.two@gmail.com"
  ]
}
```

- **`allowedEmails`** — the whitelist. To let a friend join, add their Gmail here
  and push. Nobody else can start the test. Gmail dots and `+tags` are normalised,
  so `t.e.s.t+x@gmail.com` cannot be used to sneak in a second attempt.
- **`dayCode`** — the plain code you send out each morning. Fine to start with.
- **`dayCodeHash`** — the safer version: put the SHA-256 of the code here and leave
  `dayCode` empty, so the code is not sitting in your public repo. `admin.html`
  generates it.
- **`resultsEndpoint`** — optional, see *Seeing everyone's scores* below.

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
7. Send the code to the students.

Steps 4–5 are optional. Skip them and ship the plain JSON with a plain `dayCode`
if you are in a hurry — everything still works.

---

## Seeing everyone's scores

Optional, takes about three minutes, and gives you one spreadsheet of every
submission.

1. Create a Google Sheet. **Extensions → Apps Script.** Paste:

```js
function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().appendRow([
    new Date(), d.email, d.day, d.title, d.correct, d.total,
    d.percent, d.secondsUsed, d.timedOut, d.tabSwitches
  ]);
  return ContentService.createTextOutput("ok");
}
```

2. **Deploy → New deployment → Web app**, execute as *Me*, access *Anyone*.
3. Paste the resulting URL into `resultsEndpoint` in `access.json`.

Every submission now lands in the sheet with the score, the time taken, whether
the clock ran out, and how many times the student left the tab.

---

## What this does and does not stop

Built in:

- Only whitelisted emails can start.
- One attempt per email — a finished attempt shows a lock screen instead of the paper.
- Refreshing mid-test resumes where they left off with the clock still running down,
  so there is no reloading away from a hard question.
- Randomised question and option order per student.
- Tab switches are counted and reported.
- The clock is absolute — closing the laptop does not pause it.

Be clear-eyed about the limits. This is a static site, so everything runs in the
student's own browser:

- **The attempt lock is browser-local.** Clearing site data, or switching to
  another browser or device, gives a determined student a second attempt.
- **Encryption buys time, not secrecy.** Once you release the code, someone
  technical enough could pull the answers out of the decrypted paper. Against
  juniors racing a 15-minute clock this is plenty; against a motivated cheat it
  is not.

If it ever needs to be airtight, the fix is a real backend — the same front end
can talk to Supabase or Firebase with a server-side attempt record, and the
scoring moves off the client. That is a rewrite of the middle, not the whole app.
