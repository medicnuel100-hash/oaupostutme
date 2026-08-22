# Setting up the Google Sheet backend

About 15 minutes, once. You need no new accounts, no card, and nothing to pay.
When you are done, students request a code on the page, the code arrives in
their inbox from your own Gmail, and it works exactly once.

---

## 1. Make the sheet

1. Go to [sheets.new](https://sheets.new). Name it something like `QuickCBT`.
2. **Extensions → Apps Script.** A code editor opens in a new tab.
3. Delete the `function myFunction() {}` stub that is already there.
4. Open `server/Code.gs` from this project, copy **the whole file**, paste it in.
5. Press the save icon (or Ctrl+S).

## 2. Run `setup` once

1. In the toolbar there is a dropdown that says `doGet` or `doPost`. Change it
   to **`setup`**.
2. Press **Run**.
3. Google will warn you: *"Google hasn't verified this app"*. This is your own
   script asking to write to your own sheet and send mail as you. Click
   **Advanced → Go to QuickCBT (unsafe) → Allow**. It says unsafe because it is
   unpublished, not because it is dangerous — you just pasted the code yourself.

Go back to the sheet. You now have two tabs: **Attempts** and **Settings**.

## 3. Deploy it as a web app

1. Top right: **Deploy → New deployment.**
2. Click the gear next to "Select type" and pick **Web app**.
3. Set:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`

   > `Anyone` is the one that matters. `Anyone with a Google account` looks
   > safer but breaks the app — it makes Google demand a login before your
   > page can talk to the script. Access is controlled by the codes, not by
   > this setting.
4. **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

## 4. Point the site at it

Open `data/access.json` and paste the URL in:

```json
"apiUrl": "https://script.google.com/macros/s/AKfy..../exec",
```

Then check it before trusting it: open `admin.html`, scroll to **Backend
connection**, paste the same URL, press **Test connection**. You should see the
current day, duration, question count and how many emails you have left today.
If it fails, the tester tells you which of the three usual causes it is.

Commit and push. The site is now on the code system.

---

## 5. Fill in the Settings tab

| key | what to put | notes |
|---|---|---|
| `day` | `1` | Bump it with the **QuickCBT → Move to the next day** menu |
| `title` | `Day 1 — English` | Shown on the brief and in the email |
| `durationMinutes` | `15` | The server enforces this, not the browser |
| `questionCount` | `40` | Just for the brief screen — `admin.html` tells you the number |
| `paperKey` | *(blank, or your passphrase)* | See "Hiding the answers" below |
| `autoApprove` | `TRUE` or `FALSE` | **FALSE** = you approve every gmail first |
| `requestsOpen` | `TRUE` or `FALSE` | `FALSE` shuts the door once everyone is in |
| `fromName` | `OAU Post-UTME Prep` | The sender name on the email |
| `siteUrl` | your GitHub Pages URL | Adds an "Open the test" button to the email |

### Approving people yourself

Set `autoApprove` to `FALSE`. Now every request lands in **Attempts** with
status `pending` and **nothing is emailed**. You look at the gmails, delete any
row you do not like, then run **QuickCBT → Send pending codes** from the sheet's
menu bar. Only the rows you left get a code.

That is your lever against someone spinning up fresh gmails: you see the address
before they ever see a question.

---

## 6. Hiding the answers from the repo

Optional but worth it. `questions.json` is public on GitHub Pages, so by default
a curious student could read tomorrow's answers straight out of the file.

1. In `admin.html`, put a passphrase in the code box — anything, e.g.
   `day1-cowries-2026`. This is **not** a student code; students never see it.
2. Press **Encrypt & download** and move the file into `data/questions.json`.
3. Put the same passphrase in the sheet's Settings as `paperKey`.

Now the repo holds an unreadable blob. The server only hands the key over after
a code has been consumed. It is not unbreakable — someone in devtools during
their own attempt can still dig the paper out — but it stops the easy read.

---

## What the Attempts tab gives you

One row per student per day, updated live:

| requestedAt | email | day | code | status | startedAt | endsAt | submittedAt | correct | total | percent | secondsUsed | timedOut | tabSwitches |

`status` walks `pending → issued → started → done`. At a glance you can see who
asked, who actually sat it, who ran out of time, who scored what, and who kept
leaving the tab.

---

## Limits worth knowing

- **100 emails a day** on a normal Gmail account (1,500 on Workspace). Check it
  any time with **QuickCBT → Check mail quota**. For a study group this is plenty.
- **A student can still make a new gmail.** Nothing short of ID checks fixes
  that. What you get is that every new address is visible to you in the sheet
  before it is let in — and with `autoApprove` off, it needs your click.
- **Codes are per-email.** The server looks the row up by email, then checks the
  code on it, so passing a code to a friend does nothing.
- **The clock lives on the server.** Closing the laptop, clearing site data or
  switching browser does not give anyone extra time or a second attempt.
- **Answers are kept in the browser mid-test.** If a student wipes storage
  halfway, they resume with the questions they already saw but with whatever
  time is left. The attempt itself is never refunded.

---

## When you change `Code.gs`

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy.**

If you skip this, the live URL keeps running the old code and you will chase a
bug that is already fixed. This catches everyone once.
