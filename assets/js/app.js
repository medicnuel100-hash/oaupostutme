/* ============================================================
   QuickCBT — client app

   Two modes, chosen automatically from data/access.json:

   API mode   (apiUrl is set) — a Google Apps Script backend issues one code
              per email, consumes it on first use, and owns the clock. The
              attempt lock is server-side and survives cleared browser data.

   Local mode (no apiUrl)     — a shared day code and a whitelist in the repo,
              with the attempt lock in localStorage. Fine for a dry run.
============================================================ */
(function () {
  "use strict";

  var STORE = "qcbt.v1";
  var ACCESS_URL = "data/access.json";
  var QUESTIONS_URL = "data/questions.json";

  var access = null;   // access.json
  var api = "";        // Apps Script /exec URL, empty in local mode
  var quiz = null;     // decoded questions.json
  var server = null;   // what the backend told us about this attempt
  var session = null;  // live attempt (answers + progress)
  var tick = null;     // timer interval

  var isApi = function () { return !!api; };

  /* ---------- tiny helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function show(name) {
    var list = document.querySelectorAll(".screen");
    for (var i = 0; i < list.length; i++) list[i].classList.remove("active");
    $("screen-" + name).classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* Gmail treats dots and +tags as noise, so two "different" addresses can be
     the same inbox. This must stay identical to normalizeEmail() in Code.gs,
     or a code gets issued against one spelling and checked against another. */
  function normalizeEmail(raw) {
    var e = String(raw || "").trim().toLowerCase();
    var at = e.lastIndexOf("@");
    if (at < 1) return e;
    var local = e.slice(0, at), domain = e.slice(at + 1);
    var plus = local.indexOf("+");
    if (plus > -1) local = local.slice(0, plus);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      local = local.replace(/\./g, "");
      domain = "gmail.com";
    }
    return local + "@" + domain;
  }

  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var out = "", view = new Uint8Array(buf);
      for (var i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
      return out;
    });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* questions.json can be shipped encrypted. In API mode the key is held in
     the sheet and only handed over once a code has been consumed, so the
     answers are not sitting in the public repo before the session. */
  function decryptPayload(payload, key) {
    var salt = b64ToBytes(payload.salt);
    var iv = b64ToBytes(payload.iv);
    var data = b64ToBytes(payload.data);
    var enc = new TextEncoder();
    return crypto.subtle
      .importKey("raw", enc.encode(key), "PBKDF2", false, ["deriveKey"])
      .then(function (baseKey) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: 120000, hash: "SHA-256" },
          baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
        );
      })
      .then(function (k) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, k, data);
      })
      .then(function (plain) {
        return JSON.parse(new TextDecoder().decode(plain));
      });
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- backend ---------- */
  /* text/plain dodges the CORS preflight that Apps Script cannot answer. */
  function callApi(action, payload) {
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    return fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error("http_" + r.status);
      return r.json();
    });
  }

  var API_MESSAGES = {
    closed:      "Code requests are closed right now. Check with your tutor.",
    bad_email:   "That does not look like a valid email address.",
    done:        "You have already sat this test.",
    in_progress: "Your attempt is already running. Enter the code you were sent to continue it.",
    pending:     "Your request is waiting to be approved. You will get the code by email once it is.",
    no_code:     "That code does not match this email address.",
    expired:     "Your time for this test has already run out.",
    mail_failed: "The email could not be sent. Tell your tutor the daily mail limit may be reached.",
    server:      "The server hit an error. Try once more, then tell your tutor."
  };

  function apiMessage(res) {
    return API_MESSAGES[res && res.error] || "Something went wrong. Try again in a moment.";
  }

  /* ---------- storage ---------- */
  function keyFor(email) {
    var day = (server && server.day) || (quiz && quiz.meta && quiz.meta.day) || "d";
    return STORE + "." + day + "." + email;
  }
  function loadSession(email) {
    try { return JSON.parse(localStorage.getItem(keyFor(email)) || "null"); }
    catch (e) { return null; }
  }
  function saveSession() {
    if (!session) return;
    try { localStorage.setItem(keyFor(session.email), JSON.stringify(session)); }
    catch (e) { /* private mode — progress just will not survive a refresh */ }
  }

  /* ---------- theme ---------- */
  (function theme() {
    var saved = null;
    try { saved = localStorage.getItem(STORE + ".theme"); } catch (e) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("themeBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem(STORE + ".theme", next); } catch (e) {}
    });
  })();

  /* ---------- boot ---------- */
  function boot() {
    fetch(ACCESS_URL, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("access"); return r.json(); })
      .then(function (json) {
        access = json;
        api = String(json.apiUrl || "").trim();

        var a = access.app || {};
        if (a.title) {
          $("brandName").textContent = a.title;
          document.title = a.title + " — QuickCBT";
        }
        if (a.subtitle) $("appSubtitle").textContent = a.subtitle;

        if (isApi()) {
          $("requestRow").style.display = "";
          $("emailHint").textContent =
            "Your code is emailed to this address, so use one you can open now.";
          $("codeHint").textContent =
            "The 6-character code from your email. It works once, on this address only.";
          $("supportLine").textContent =
            "Code not arriving? Check your spam folder before asking for another.";
        } else if (a.supportContact) {
          $("supportLine").textContent = "No access yet? Message " + a.supportContact + " to be added.";
        }
      })
      .catch(function () {
        gateError("Could not load the access list. If you opened the file directly, run it through a web server instead.");
        $("gateBtn").disabled = true;
      });
  }

  function gateError(msg) {
    var el = $("gateError");
    el.textContent = msg;
    el.classList.add("show");
    $("requestNote").classList.remove("show");
  }

  function gateNote(msg) {
    var el = $("requestNote");
    el.textContent = msg;
    el.classList.add("show");
    $("gateError").classList.remove("show");
  }

  /* ---------- request a code ---------- */
  $("requestBtn").addEventListener("click", function () {
    var btn = this;
    var email = normalizeEmail($("email").value);
    if (!validEmail(email)) return gateError("Enter your email address first.");

    btn.disabled = true;
    btn.textContent = "Sending…";

    callApi("request", { email: email })
      .then(function (res) {
        if (!res.ok) return gateError(apiMessage(res));
        if (res.pending) {
          gateNote("Request received. Your tutor will approve it and the code will arrive by email.");
        } else if (res.resent) {
          gateNote("You already had a code — it has been sent again to " + email + ". Check spam too.");
        } else {
          gateNote("Code sent to " + email + ". Check your inbox, and your spam folder.");
        }
      })
      .catch(function () {
        gateError("Could not reach the server. Check your connection and try again.");
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "Email me my access code";
      });
  });

  /* ---------- gate ---------- */
  $("gateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("gateError").classList.remove("show");

    var email = normalizeEmail($("email").value);
    var code = $("code").value.trim();
    var btn = $("gateBtn");

    if (!validEmail(email)) return gateError("That does not look like a valid email address.");
    if (!code) return gateError(isApi() ? "Enter the code from your email." : "Enter today's access code.");

    btn.disabled = true;
    btn.textContent = "Checking…";

    var done = function () {
      btn.disabled = false;
      btn.textContent = "Continue →";
    };

    (isApi() ? apiGate(email, code) : localGate(email, code))
      .catch(function (err) {
        gateError(err && err.friendly ? err.message : "Could not start the test. Try again in a moment.");
      })
      .then(done, done);
  });

  function friendly(msg) {
    var e = new Error(msg);
    e.friendly = true;
    return e;
  }

  /* --- API mode: the server owns access and the clock --- */
  function apiGate(email, code) {
    return callApi("start", { email: email, code: code }).then(function (res) {
      if (!res.ok) {
        if (res.error === "done") {
          server = { day: res.day };
          return showLockedFromServer(res.result, email);
        }
        throw friendly(apiMessage(res));
      }

      server = res;
      server.email = email;
      server.code = code;

      if (res.resume) return beginAttempt(email, code, true);

      $("briefDay").textContent = "● Day " + res.day;
      $("briefTitle").textContent = res.title || "Today's practice test";
      $("statQ").textContent = res.questionCount || "—";
      $("statT").textContent = res.durationMinutes + " min";
      show("brief");
    });
  }

  function showLockedFromServer(result, email) {
    var when = result && result.submittedAt ? new Date(result.submittedAt).toLocaleString() : null;
    $("lockedLine").textContent =
      "This email has already used its code" + (when ? " on " + when : "") + "." +
      (result && result.total
        ? " You scored " + result.correct + " of " + result.total + " (" + result.percent + "%)."
        : "") +
      " Each code works once.";

    // The paper only exists locally if they sat it in this browser.
    var prior = loadSession(email);
    $("viewResultBtn").style.display = prior && prior.finished ? "" : "none";
    if (prior && prior.finished) session = prior;
    show("locked");
  }

  /* --- Local mode: whitelist + shared code, lock in localStorage --- */
  function localGate(email, code) {
    var allowed = (access.allowedEmails || []).map(normalizeEmail);
    if (allowed.indexOf(email) === -1) {
      return Promise.reject(friendly("This email has not been given access. Ask to be added, then try again."));
    }
    return verifyLocalCode(code)
      .then(function () { return loadQuiz(code.trim().toUpperCase()); })
      .then(function () {
        var prior = loadSession(email);

        if (prior && prior.finished) {
          session = prior;
          $("lockedLine").textContent =
            "You sat " + (quiz.meta.title || "this test") + " on " +
            new Date(prior.finishedAt).toLocaleString() + ". Each email gets one attempt.";
          $("viewResultBtn").style.display = "";
          return show("locked");
        }

        if (prior && prior.startedAt) {
          session = prior;
          if (remaining() <= 0) return finish(true);
          show("test");
          startClock();
          return renderQuestion();
        }

        newSession(email, code, null);
        $("briefDay").textContent = "● Day " + (quiz.meta.day || 1);
        $("briefTitle").textContent = quiz.meta.title || "Today's practice test";
        $("statQ").textContent = quiz.questions.length;
        $("statT").textContent = (quiz.meta.durationMinutes || 15) + " min";
        show("brief");
      });
  }

  function verifyLocalCode(code) {
    if (access.dayCodeHash) {
      return sha256Hex(code.trim().toUpperCase()).then(function (h) {
        if (h !== access.dayCodeHash.toLowerCase()) throw friendly("That access code is not correct for today.");
      });
    }
    if (access.dayCode &&
        code.trim().toUpperCase() !== String(access.dayCode).trim().toUpperCase()) {
      return Promise.reject(friendly("That access code is not correct for today."));
    }
    return Promise.resolve();
  }

  function loadQuiz(paperKey) {
    return fetch(QUESTIONS_URL, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw friendly("Today's paper has not been published yet."); return r.json(); })
      .then(function (json) {
        if (json && json.enc === "aes-gcm") {
          if (!paperKey) throw friendly("Today's paper is locked and no key was supplied.");
          return decryptPayload(json, paperKey).catch(function () {
            throw friendly("Today's paper could not be unlocked. Tell your tutor the key does not match the file.");
          });
        }
        return json;
      })
      .then(function (json) {
        if (!json || !json.questions || !json.questions.length) {
          throw friendly("Today's paper has not been published yet.");
        }
        quiz = json;
        quiz.meta = quiz.meta || {};
      });
  }

  function newSession(email, code, deadline) {
    var order = shuffle(quiz ? quiz.questions.map(function (q) { return q.id; }) : []);
    var opts = {};
    if (quiz) {
      quiz.questions.forEach(function (q) {
        opts[q.id] = shuffle(q.options.map(function (o) { return o.id; }));
      });
    }
    session = {
      email: email, code: code,
      day: (server && server.day) || (quiz && quiz.meta.day) || null,
      order: order, opts: opts,
      idx: 0, answers: {},
      startedAt: null, deadline: deadline,
      finished: false, finishedAt: null,
      blurs: 0
    };
  }

  /* ---------- begin ---------- */
  $("beginBtn").addEventListener("click", function () {
    var btn = this;
    if (isApi()) {
      btn.disabled = true;
      btn.textContent = "Starting…";
      beginAttempt(server.email, server.code, false).catch(function (err) {
        show("gate");
        gateError(err && err.friendly ? err.message : "Could not start the test. Try again.");
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "Begin test";
      });
      return;
    }

    var mins = quiz.meta.durationMinutes || 15;
    session.startedAt = Date.now();
    session.deadline = session.startedAt + mins * 60000;
    saveSession();
    show("test");
    startClock();
    renderQuestion();
  });

  /* Consumes the code server-side, then unlocks and loads the paper. */
  function beginAttempt(email, code, resuming) {
    return callApi("begin", { email: email, code: code })
      .then(function (res) {
        if (!res.ok) {
          if (res.error === "done") return showLockedFromServer(res.result, email);
          throw friendly(apiMessage(res));
        }
        // Trust the server's clock, not the device's, but keep it as an offset
        // so a wrong system time on the student's laptop cannot buy them time.
        var skew = res.serverNow ? Date.now() - res.serverNow : 0;
        var deadline = res.endsAt + skew;

        return loadQuiz(res.paperKey).then(function () {
          var prior = loadSession(email);
          if (resuming && prior && prior.order && prior.order.length) {
            session = prior;
          } else if (!prior || !prior.order || !prior.order.length) {
            newSession(email, code, deadline);
          } else {
            session = prior;
          }
          session.deadline = deadline;
          session.startedAt = session.startedAt || Date.now();
          session.code = code;
          saveSession();

          if (remaining() <= 0) return finish(true);
          show("test");
          startClock();
          renderQuestion();
        });
      });
  }

  /* ---------- test ---------- */
  function remaining() {
    return (session.deadline - Date.now()) / 1000;
  }

  function startClock() {
    $("qTotal").textContent = quiz.questions.length;
    clearInterval(tick);
    paintClock();
    tick = setInterval(paintClock, 250);
  }

  function paintClock() {
    var left = remaining();
    var el = $("timer");
    el.textContent = fmt(left);
    el.classList.toggle("warn", left <= 120 && left > 60);
    el.classList.toggle("danger", left <= 60);
    if (left <= 0) {
      clearInterval(tick);
      finish(true);
    }
  }

  function currentQuestion() {
    return quiz.questions.filter(function (q) { return q.id === session.order[session.idx]; })[0];
  }

  function renderQuestion() {
    var q = currentQuestion();
    var total = quiz.questions.length;

    $("qNow").textContent = session.idx + 1;
    $("qTotal").textContent = total;
    $("qSubject").textContent = q.subject || "General";
    $("qSubject").style.display = q.subject ? "" : "none";
    $("qText").textContent = q.text;
    $("progressBar").style.width = (session.idx / total * 100) + "%";

    $("feedback").classList.remove("show");
    $("nextBtn").style.display = "none";
    $("nextBtn").textContent =
      session.idx === total - 1 ? "Finish & see score →" : "Next question →";

    var wrap = $("options");
    wrap.innerHTML = "";
    session.opts[q.id].forEach(function (optId, pos) {
      var opt = q.options.filter(function (o) { return o.id === optId; })[0];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.dataset.optId = optId;
      b.innerHTML =
        '<span class="key">' + String.fromCharCode(65 + pos) + "</span>" +
        '<span class="body">' + esc(opt.text) + "</span>" +
        '<span class="tag"></span>';
      b.addEventListener("click", function () { answer(q, optId); });
      wrap.appendChild(b);
    });

    // Resuming into a question already answered? Re-show its feedback.
    if (session.answers[q.id]) replay(q, session.answers[q.id]);
  }

  function answer(q, chosenId) {
    if (session.answers[q.id]) return;
    session.answers[q.id] = chosenId;
    saveSession();
    replay(q, chosenId);
  }

  function replay(q, chosenId) {
    var correctId = q.answer;
    var right = chosenId === correctId;
    var buttons = $("options").querySelectorAll(".opt");

    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i], id = b.dataset.optId;
      b.disabled = true;
      if (id === correctId) {
        b.classList.add("correct");
        b.querySelector(".tag").textContent = "✓";
      } else if (id === chosenId) {
        b.classList.add("wrong");
        b.querySelector(".tag").textContent = "✕";
      } else {
        b.classList.add("muted");
      }
    }

    var v = $("verdict");
    v.className = "verdict " + (right ? "right" : "wrong");
    v.innerHTML = right
      ? "<span>✓</span><span>Correct — well spotted.</span>"
      : "<span>✕</span><span>Not quite.</span>";

    var correctOpt = q.options.filter(function (o) { return o.id === correctId; })[0];
    var chosenOpt = q.options.filter(function (o) { return o.id === chosenId; })[0];
    var html = "";

    if (!right) {
      var why = (chosenOpt && chosenOpt.feedback) ||
        "That option does not satisfy what the question is asking for.";
      html +=
        '<div class="note bad"><h4>Why "' + esc(chosenOpt ? chosenOpt.text : "") + '" is wrong</h4>' +
        esc(why) + "</div>";
    }

    html +=
      '<div class="note good"><h4>' +
      (right ? "Why this is correct" : "Correct answer — " + esc(correctOpt ? correctOpt.text : "")) +
      "</h4>" + esc(q.explanation || "") + "</div>";

    $("feedbackNotes").innerHTML = html;
    $("feedback").classList.add("show");
    $("nextBtn").style.display = "";
  }

  $("nextBtn").addEventListener("click", function () {
    if (session.idx >= quiz.questions.length - 1) return finish(false);
    session.idx += 1;
    saveSession();
    renderQuestion();
  });

  /* Recorded, not punished — it just shows up on the result sheet. */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && session && session.startedAt && !session.finished) {
      session.blurs = (session.blurs || 0) + 1;
      saveSession();
    }
  });

  window.addEventListener("beforeunload", function (e) {
    if (session && session.startedAt && !session.finished) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------- result ---------- */
  function finish(timedOut) {
    if (session.finished) return renderResult();
    clearInterval(tick);
    session.finished = true;
    session.finishedAt = Date.now();
    session.timedOut = !!timedOut;
    session.secondsUsed = Math.round((session.finishedAt - session.startedAt) / 1000);
    saveSession();
    submitRemote();
    renderResult();
    if (timedOut) toast("Time up — your test was submitted automatically.");
  }

  function scoreOf() {
    var correct = 0, bySubject = {};
    quiz.questions.forEach(function (q) {
      var s = q.subject || "General";
      bySubject[s] = bySubject[s] || { got: 0, total: 0 };
      bySubject[s].total += 1;
      if (session.answers[q.id] === q.answer) {
        correct += 1;
        bySubject[s].got += 1;
      }
    });
    return { correct: correct, total: quiz.questions.length, bySubject: bySubject };
  }

  function renderResult() {
    var s = scoreOf();
    var pct = s.total ? Math.round(s.correct / s.total * 100) : 0;
    var passMark = quiz.meta.passMark != null ? quiz.meta.passMark : 50;
    var pass = pct >= passMark;

    $("scorePct").textContent = pct + "%";
    var circ = 2 * Math.PI * 52;
    var arc = $("scoreArc");
    arc.setAttribute("stroke-dasharray", circ.toFixed(1));
    arc.setAttribute("stroke-dashoffset", circ.toFixed(1));
    setTimeout(function () {
      arc.setAttribute("stroke-dashoffset", (circ * (1 - pct / 100)).toFixed(1));
    }, 120);

    $("resultHeadline").textContent =
      pct >= 85 ? "Outstanding." :
      pct >= 70 ? "Strong showing." :
      pct >= 50 ? "Decent — sharpen the gaps." :
                  "Rough one. Work the review.";

    $("resultSummary").textContent =
      "You got " + s.correct + " of " + s.total + " right on " +
      ((server && server.title) || quiz.meta.title || "today's paper") + ". " +
      (pass ? "That is above the pass mark." : "That is below the pass mark — go through every explanation below.") +
      (session.timedOut ? " The clock ran out before you finished." : "");

    $("rCorrect").textContent = s.correct;
    $("rWrong").textContent = s.total - s.correct;
    $("rTime").textContent = fmt(session.secondsUsed || 0);

    var bd = $("breakdown");
    var names = Object.keys(s.bySubject);
    bd.innerHTML = names.length > 1
      ? "<h2>By subject</h2>" + names.map(function (n) {
          var v = s.bySubject[n];
          var p = Math.round(v.got / v.total * 100);
          return '<div class="subj"><span class="name">' + esc(n) + "</span>" +
                 '<span class="bar"><i style="width:' + p + '%"></i></span>' +
                 '<span class="num">' + v.got + "/" + v.total + "</span></div>";
        }).join("")
      : "";

    $("review").innerHTML = session.order.map(function (qid, i) {
      var q = quiz.questions.filter(function (x) { return x.id === qid; })[0];
      var chosenId = session.answers[qid];
      var chosen = q.options.filter(function (o) { return o.id === chosenId; })[0];
      var correct = q.options.filter(function (o) { return o.id === q.answer; })[0];
      var ok = chosenId === q.answer;

      return '<details class="rev' + (ok ? "" : " miss") + '">' +
        '<summary><span class="n">' + (i + 1) + ".</span>" +
        '<span class="t">' + esc(q.text) + "</span>" +
        "<span>" + (ok ? "✓" : "✕") + "</span></summary>" +
        '<div class="inner">' +
          "<p><b>Your answer:</b> " + esc(chosen ? chosen.text : "— not answered —") + "</p>" +
          "<p><b>Correct answer:</b> " + esc(correct ? correct.text : "") + "</p>" +
          (!ok && chosen && chosen.feedback ? "<p><b>Why yours misses:</b> " + esc(chosen.feedback) + "</p>" : "") +
          "<p>" + esc(q.explanation || "") + "</p>" +
        "</div></details>";
    }).join("");

    $("resultFoot").textContent =
      "Recorded for " + session.email +
      (session.blurs ? " · left the tab " + session.blurs + " time(s)" : "");

    show("result");
  }

  $("viewResultBtn").addEventListener("click", function () {
    if (session && session.finished && quiz) renderResult();
  });

  $("copyBtn").addEventListener("click", function () {
    var s = scoreOf();
    var text =
      ((server && server.title) || quiz.meta.title || "CBT") + "\n" +
      session.email + "\n" +
      "Score: " + s.correct + "/" + s.total +
      " (" + Math.round(s.correct / s.total * 100) + "%)\n" +
      "Time used: " + fmt(session.secondsUsed || 0) + "\n" +
      "Submitted: " + new Date(session.finishedAt).toLocaleString();
    navigator.clipboard.writeText(text).then(
      function () { toast("Result copied — paste it to your tutor."); },
      function () { toast("Could not copy. Screenshot this page instead."); }
    );
  });

  $("printBtn").addEventListener("click", function () { window.print(); });

  function submitRemote() {
    var s = scoreOf();
    var body = {
      email: session.email,
      code: session.code,
      day: (server && server.day) || quiz.meta.day || null,
      title: (server && server.title) || quiz.meta.title || "",
      correct: s.correct,
      total: s.total,
      percent: s.total ? Math.round(s.correct / s.total * 100) : 0,
      secondsUsed: session.secondsUsed,
      timedOut: !!session.timedOut,
      tabSwitches: session.blurs || 0,
      submittedAt: new Date(session.finishedAt).toISOString()
    };

    if (isApi()) {
      callApi("submit", body).catch(function () {
        toast("Your score could not be sent up. Screenshot this page for your tutor.");
      });
      return;
    }

    var url = access && access.resultsEndpoint;
    if (!url) return;
    try {
      fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (e) { /* never block the student on this */ }
  }

  boot();
})();
