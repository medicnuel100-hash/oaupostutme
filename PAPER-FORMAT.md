# Paper format — paste this whole file to the AI converting your questions

You are converting exam questions into JSON for a CBT app. Output **only** valid
JSON, no commentary, no markdown fences.

## Schema

```json
{
  "meta": {
    "day": 1,
    "date": "2026-08-25",
    "title": "Day 1 — English & Use of English",
    "durationMinutes": 30,
    "passMark": 50
  },
  "questions": [
    {
      "id": "d1q1",
      "subject": "English",
      "text": "Choose the option nearest in meaning to the underlined word: The lecturer gave a LUCID explanation.",
      "options": [
        { "id": "A", "text": "lengthy",   "feedback": "Length is not part of the meaning — a lucid explanation can be very short." },
        { "id": "B", "text": "confusing", "feedback": "This is the opposite. Lucid means easy to understand." },
        { "id": "C", "text": "clear",     "feedback": "" },
        { "id": "D", "text": "boring",    "feedback": "Lucid says nothing about how interesting it was, only how understandable." }
      ],
      "answer": "C",
      "explanation": "'Lucid' means expressed clearly and easy to follow. The closest synonym here is 'clear'."
    }
  ]
}
```

## Rules

1. **`meta.day`** is 1–7. **`meta.date`** is the day it should go live, `YYYY-MM-DD`.
   Both must be present. The app uses the date to decide which paper is today's.
2. **`id`** on each question is unique across the paper: `d1q1`, `d1q2`, … for day 1.
3. **`subject`** groups the score breakdown. Use consistent names within a paper
   (`English`, `Mathematics`, `Physics`, `Chemistry`, `Biology`, `Current Affairs`).
4. **`options`** — exactly four, with ids `A`, `B`, `C`, `D`, in that order.
5. **`answer`** is the id of the correct option.
6. **`feedback`** is the crucial field. On every **wrong** option, write one or two
   sentences correcting *that specific mistake* — the misconception that leads a
   student to pick it. Not "this is wrong", but *why someone would choose it and
   what they misunderstood*. Leave the **correct** option's `feedback` as `""`.
7. **`explanation`** teaches the correct answer: the rule, method or fact. Every
   student sees it, including those who got it right. Show the working for maths.
8. Escape properly. Use `\"` inside strings and `\n` for line breaks. No smart
   quotes in JSON syntax positions.
9. Do not shuffle the options — the app randomises order per student.

## Worked example of good vs weak feedback

Question: `The principal, together with the teachers, ______ arrived.` Answer: `has`

- **Weak:** `"feedback": "Wrong answer."`
- **Good:** `"feedback": "You matched the verb to 'teachers' because it sits closest, but 'together with the teachers' is an interrupting phrase — the subject is still the singular 'principal'."`

The second one teaches. The first wastes the question.

## Maths example

```json
{
  "id": "d3q7",
  "subject": "Mathematics",
  "text": "If 2x + 5 = 17, find x.",
  "options": [
    { "id": "A", "text": "6",  "feedback": "" },
    { "id": "B", "text": "11", "feedback": "You subtracted 5 but forgot to divide by 2. 17 - 5 = 12, and 12 is not the answer until it is halved." },
    { "id": "C", "text": "22", "feedback": "You multiplied by 2 instead of dividing. Undo operations in reverse: subtract first, then divide." },
    { "id": "D", "text": "8.5","feedback": "You divided 17 by 2 before removing the 5. The +5 must come off first." }
  ],
  "answer": "A",
  "explanation": "2x + 5 = 17. Subtract 5: 2x = 12. Divide by 2: x = 6."
}
```

Notice each wrong option maps to a **real** error a student makes, not a random number.

## Output

One JSON object per day, 40 questions each unless told otherwise. Name the files
`day1.json` through `day7.json`.
