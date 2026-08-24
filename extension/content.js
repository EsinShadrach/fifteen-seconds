/* Fifteen Seconds - WhatsApp Web word game helper
 *
 * Watches the open conversation for a prompt like:
 *
 *   Turn : @Rafe
 *   Next : @Dennis
 *   Starts with Y (at least 13 letters)
 *   Players left : 2/3
 *   You have 20 seconds to reply
 *   Total words : 33
 *
 * When it is your turn, it picks a word that fits and has not already been
 * played in the visible chat, then drafts it into the composer.
 *
 * Prompt detection deliberately reads rendered text rather than WhatsApp's
 * class names, which change without notice. Only the composer and the played-
 * word scan still need selectors, and both have fallbacks.
 */
(function () {
  "use strict";

  // Set before anything else can throw, so "did the script run?" is always
  // answerable even when startup fails later. This has to be a DOM attribute,
  // not a window property: content scripts run in an isolated world, so
  // anything hung off window is invisible to the page console.
  var VERSION = "1.2.0";
  try { document.documentElement.setAttribute("data-fs-loaded", VERSION); } catch (e) { /* ignore */ }
  console.log("[FS] content script loaded, v" + VERSION);

  var DEFAULTS = { handle: "Rafe", autoSend: false, delayMs: 800, enabled: true, sound: true };
  var cfg = Object.assign({}, DEFAULTS);
  var TAG = "[FS]";

  // WhatsApp wraps @mentions in Unicode bidi isolates, so "@Rafe" arrives as
  // "@\u2068Rafe\u2069" and a naive compare against "Rafe" misses.
  var FORMAT_CHARS = /[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
  function clean(s) { return String(s == null ? "" : s).replace(FORMAT_CHARS, ""); }

  var SEL = {
    main: ["#main", "div[data-testid='conversation-panel-messages']", "[role='application']"],
    // comma-selectors, not separate entries: pickAll stops at the first entry
    // that matches, so splitting these would silently drop your own messages
    bubble: [
      "div[role='row']",
      "div.message-in, div.message-out",
      "div[data-id]"
    ],
    bubbleText: [
      "span.selectable-text",
      "div.copyable-text span",
      "span[dir='ltr']",
      "span[dir='auto']"
    ],
    composer: [
      "footer div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'][data-lexical-editor='true']",
      "div[contenteditable='true'][aria-label*='message' i]",
      "div[contenteditable='true'][aria-label*='Type' i]",
      "footer div[contenteditable='true']",
      "div[contenteditable='true'][data-tab='10']",
      "div[contenteditable='true'][data-tab='9']",
      "div[contenteditable='true'][role='textbox']"
    ],
    // data-tab='11' is the MICROPHONE while the box is empty and only becomes
    // Send once there is text, so it must never be matched on its own.
    send: [
      "footer button[aria-label='Send']",
      "button[aria-label*='Send' i]",
      "span[data-icon='send']",
      "span[data-icon*='send' i]",
      "footer button[data-tab='11'][aria-label*='Send' i]"
    ],
    // Anything here is a hard veto for the send click.
    notSend: "[aria-label*='voice' i],[aria-label*='audio' i],[aria-label*='emoji' i],[aria-label*='attach' i],[aria-label*='sticker' i],[data-icon*='mic' i]"
  };

  function pick(list, root) {
    root = root || document;
    for (var i = 0; i < list.length; i++) {
      try {
        var el = root.querySelector(list[i]);
        if (el) return el;
      } catch (e) { /* bad selector on an old Chrome - skip */ }
    }
    return null;
  }
  function pickAll(list, root) {
    root = root || document;
    for (var i = 0; i < list.length; i++) {
      try {
        var els = root.querySelectorAll(list[i]);
        if (els.length) return Array.prototype.slice.call(els);
      } catch (e) { /* skip */ }
    }
    return [];
  }

  // ---------------------------------------------------------------- dictionary
  var IDX = null;
  function buildIndex() {
    if (IDX) return IDX;
    var d = self.FS_DICT;
    if (!d) { console.warn(TAG, "dictionary missing - dict.js did not load"); return null; }
    function bucket(str) {
      var m = Object.create(null), a = str.split("\n");
      for (var i = 0; i < a.length; i++) {
        var w = a[i];
        if (!w) continue;
        var k = w.charAt(0).toLowerCase();
        (m[k] || (m[k] = [])).push(w);
      }
      return m;
    }
    IDX = { common: bucket(d.C), rare: bucket(d.W), names: bucket(d.N) };
    return IDX;
  }

  // -------------------------------------------------------------------- parser
  var RE_START = /starts?\s*with\s*[:\-]?\s*([A-Za-z]+)/i;

  function parsePrompt(text) {
    if (!text) return null;
    text = clean(text);
    var mStart = text.match(RE_START);
    if (!mStart) return null;

    var mTurn = text.match(/turn\s*[:\-]\s*@?\s*([^\n\r]+)/i);
    var mSecs = text.match(/(\d+)\s*second/i);

    var lo = 1, hi = 99, rule = "any length";
    var mAtLeast = text.match(/at\s*least\s*(\d+)/i);
    var mAtMost = text.match(/at\s*most\s*(\d+)/i);
    var mExact = text.match(/exactly\s*(\d+)/i);
    var mBare = text.match(/\((\d+)\s*letters?\)/i);
    if (mExact) { lo = hi = +mExact[1]; rule = "exactly " + lo; }
    else if (mAtLeast && mAtMost) { lo = +mAtLeast[1]; hi = +mAtMost[1]; rule = lo + "-" + hi + " letters"; }
    else if (mAtLeast) { lo = +mAtLeast[1]; rule = lo + "+ letters"; }
    else if (mAtMost) { hi = +mAtMost[1]; rule = "up to " + hi + " letters"; }
    else if (mBare) { lo = hi = +mBare[1]; rule = "exactly " + lo; }

    return {
      prefix: mStart[1].toLowerCase(),
      lo: lo, hi: hi, rule: rule,
      turn: mTurn ? clean(mTurn[1]).trim() : "",
      seconds: mSecs ? +mSecs[1] : 0
    };
  }

  // Find the most recent prompt by reading rendered text, so no message-bubble
  // class name has to be right for this to work.
  function latestPromptBlock() {
    var root = pick(SEL.main) || document.body;
    var text = root.innerText || "";
    if (!text) return null;
    var lines = text.split("\n");
    var at = -1;
    for (var i = lines.length - 1; i >= 0; i--) {
      if (RE_START.test(lines[i])) { at = i; break; }
    }
    if (at === -1) return null;
    var from = Math.max(0, at - 4), to = Math.min(lines.length, at + 7);
    return {
      block: lines.slice(from, to).join("\n"),
      idx: at,
      hits: (text.match(/starts?\s*with/gi) || []).length
    };
  }

  // Loose both ways: the bot may render "Rafe", "@Rafe" or a fuller display
  // name, and the handle in settings may be a shortening of it.
  function sameParty(who) {
    var me = String(cfg.handle || "").trim().replace(/^@/, "").toLowerCase();
    if (!me) return false;
    who = clean(who || "").replace(/^@/, "").trim().toLowerCase();
    if (!who) return false;
    return who.indexOf(me) !== -1 || me.indexOf(who) !== -1;
  }

  function isMyTurn(p) {
    if (!p.turn) return true;
    if (!String(cfg.handle || "").trim()) return true;
    return sameParty(p.turn);
  }

  // ------------------------------------------------- words already played here
  // Every answer in this game is a bare single word, so any one-word message in
  // the loaded conversation is burned - yours and everyone else's.
  function playedWords() {
    var used = Object.create(null), n = 0;
    var main = pick(SEL.main);
    var bubbles = main ? pickAll(SEL.bubble, main) : [];
    function harvest(text) {
      clean(text).split("\n").forEach(function (line) {
        var s = line.trim();
        // Bias to over-collecting: wrongly burning a sender name costs one
        // candidate, missing a played word costs the round.
        if (/^[A-Za-z]{2,}$/.test(s) && !used[s.toLowerCase()]) {
          used[s.toLowerCase()] = true; n++;
        }
      });
    }
    if (bubbles.length) {
      for (var i = 0; i < bubbles.length; i++) {
        var t = pick(SEL.bubbleText, bubbles[i]);
        harvest((t ? t.innerText : bubbles[i].innerText) || "");
      }
    } else if (main) {
      // no bubble selector matched - fall back to scanning rendered lines
      harvest(main.innerText || "");
    }
    return { used: used, count: n, bubbles: bubbles.length };
  }

  // ---------------------------------------------------------------- candidates
  function candidates(p, used, limit) {
    var idx = buildIndex();
    if (!idx) return [];
    var out = [], key = p.prefix.charAt(0), plen = p.prefix.length;
    ["common", "rare"].forEach(function (tier) {
      var b = idx[tier][key];
      if (!b) return;
      for (var i = 0; i < b.length && out.length < limit; i++) {
        var w = b[i], L = w.length;
        if (L < p.lo || L > p.hi) continue;
        if (plen > 1 && w.toLowerCase().lastIndexOf(p.prefix, 0) !== 0) continue;
        if (used[w.toLowerCase()]) continue;
        out.push({ w: w, common: tier === "common" });
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ composer
  function insertText(box, text) {
    box.focus();
    try {
      var sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* best effort */ }
    // execCommand emits the beforeinput/input pair WhatsApp's editor listens
    // for; assigning textContent directly is silently discarded.
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok) {
      try {
        var dt = new DataTransfer();
        dt.setData("text/plain", text);
        box.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: dt, bubbles: true, cancelable: true
        }));
        ok = true;
      } catch (e2) { ok = false; }
    }
    return ok;
  }

  function draft(word) {
    var box = pick(SEL.composer);
    if (!box) {
      console.warn(TAG, "composer not found");
      note("Cannot find the message box - open a chat first.", true);
      return false;
    }
    var ok = insertText(box, word);
    console.log(TAG, ok ? "drafted: " + word : "could not type into composer");
    if (!ok) note("Could not type into the message box.", true);
    return ok;
  }

  function pressEnter() {
    var box = pick(SEL.composer);
    if (!box) return false;
    box.focus();
    ["keydown", "keypress", "keyup"].forEach(function (type) {
      box.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
    });
    console.log(TAG, "sent via Enter");
    return true;
  }

  // WhatsApp swaps the mic for the send button only after the box has text, so
  // poll briefly rather than looking once and giving up.
  function sendNow(tries) {
    tries = tries || 0;
    var btn = pick(SEL.send);
    if (btn) {
      var clickable = btn.tagName === "BUTTON" ? btn : btn.closest("button");
      // Refuse anything that is really the mic / emoji / attach control -
      // clicking the mic starts a voice recording, which is much worse than
      // simply falling back to Enter.
      var vetoed = clickable &&
        (clickable.matches(SEL.notSend) || clickable.querySelector(SEL.notSend));
      if (clickable && !vetoed) {
        clickable.click();
        console.log(TAG, "sent via button:", clickable.getAttribute("aria-label"));
        return true;
      }
      if (vetoed) console.log(TAG, "ignored non-send button:", clickable.getAttribute("aria-label"));
    }
    if (tries < 8) { setTimeout(function () { sendNow(tries + 1); }, 150); return true; }
    console.log(TAG, "no send button after 1.2s - falling back to Enter");
    return pressEnter();
  }

  // ----------------------------------------------------------------------- HUD
  var hud, elRule, elPick, elAlts, elNote, elSend, tick;

  function buildHud() {
    if (hud) return;
    hud = document.createElement("div");
    hud.id = "fs-hud";
    hud.innerHTML =
      '<div class="fs-top"><span class="fs-title">Fifteen Seconds</span>' +
      '<button class="fs-x" title="Hide">&times;</button></div>' +
      '<div class="fs-rule"></div>' +
      '<button class="fs-pick"></button>' +
      '<button class="fs-send"></button>' +
      '<div class="fs-alts"></div>' +
      '<div class="fs-note"></div>';
    document.body.appendChild(hud);
    elRule = hud.querySelector(".fs-rule");
    elPick = hud.querySelector(".fs-pick");
    elAlts = hud.querySelector(".fs-alts");
    elNote = hud.querySelector(".fs-note");
    elSend = hud.querySelector(".fs-send");
    hud.querySelector(".fs-x").addEventListener("click", hide);
    elPick.addEventListener("click", function () {
      if (elPick.dataset.word) draft(elPick.dataset.word);
    });
    elSend.addEventListener("click", function () {
      if (elPick.dataset.word && draft(elPick.dataset.word)) setTimeout(sendNow, 60);
    });
    elAlts.addEventListener("click", function (e) {
      var b = e.target.closest(".fs-alt");
      if (!b) return;
      setPick(b.dataset.word, b.dataset.common === "1", b.dataset.rank, elPick.dataset.total);
      draft(b.dataset.word);
    });
  }

  function hide() { if (hud) hud.classList.remove("on"); clearInterval(tick); }
  function note(msg, warn) {
    if (!elNote) return;
    elNote.className = "fs-note" + (warn ? " fs-warn" : "");
    elNote.textContent = msg;
  }
  function setPick(word, common, rank, total) {
    elPick.dataset.word = word;
    elPick.dataset.total = total;
    elPick.innerHTML = "";
    elPick.appendChild(document.createTextNode(word));
    var n = document.createElement("span");
    n.className = "fs-n";
    n.textContent = word.length + " letters - " + (common ? "everyday" : "obscure") +
      " - #" + rank + " of " + total;
    elPick.appendChild(n);
  }
  function endHud(title, msg, tone) {
    buildHud();
    hud.classList.add("on");
    hud.classList.remove("fs-good", "fs-bad");
    if (tone === "good") hud.classList.add("fs-good");
    if (tone === "bad") hud.classList.add("fs-bad");
    clearInterval(tick);
    elRule.innerHTML = "<b>" + title + "</b>";
    elPick.style.display = "none";
    elSend.style.display = "none";
    elAlts.innerHTML = "";
    note(msg, tone === "bad");
  }

  function bareHud(ruleHtml, msg, warn) {
    buildHud();
    hud.classList.add("on");
    hud.classList.remove("fs-good", "fs-bad");
    clearInterval(tick);
    elRule.innerHTML = ruleHtml;
    elPick.style.display = "none";
    elSend.style.display = "none";
    elAlts.innerHTML = "";
    note(msg, warn);
  }

  function show(p, list) {
    buildHud();
    hud.classList.add("on");
    hud.classList.remove("fs-good", "fs-bad");
    clearInterval(tick);

    elRule.innerHTML = [
      "<b>" + p.prefix.toUpperCase() + "</b>", p.rule, "<b>" + list.length + "</b> unplayed"
    ].join(' <span style="opacity:.4">/</span> ');

    if (p.seconds) {
      var left = p.seconds, clock = document.createElement("span");
      clock.className = "fs-clock";
      clock.textContent = left + "s";
      elRule.appendChild(document.createTextNode(" "));
      elRule.appendChild(clock);
      tick = setInterval(function () {
        left -= 1;
        clock.textContent = Math.max(0, left) + "s";
        if (left <= 0) clearInterval(tick);
      }, 1000);
    }

    if (!list.length) {
      elPick.style.display = "none";
      elSend.style.display = "none";
      elAlts.innerHTML = '<div class="fs-empty">No unplayed word fits this rule.</div>';
      note("Every match is already on the board.", true);
      return;
    }

    elPick.style.display = "";
    elSend.style.display = "";
    setPick(list[0].w, list[0].common, 1, list.length);
    elSend.textContent = "Insert and send";

    elAlts.innerHTML = "";
    list.slice(1, 25).forEach(function (r, i) {
      var b = document.createElement("button");
      b.className = "fs-alt";
      b.textContent = r.w;
      b.dataset.word = r.w;
      b.dataset.common = r.common ? "1" : "0";
      b.dataset.rank = i + 2;
      elAlts.appendChild(b);
    });
  }

  // ------------------------------------------------------------- end of game
  // The bot closes a round with lines like:
  //   @Rafe won the game 🏆
  //   Words : 36
  //   Longest word : organisation (12) by @Ifeoluwa 📚
  //   Time : 00:02:42 ⏱️
  // and knocks players out with:
  //   Time out @Ifeoluwa! You are out! 🚫
  var NAME = "@?\\s*([A-Za-z0-9._\\-]+(?:\\s[A-Za-z0-9._\\-]+)?)";
  var END_PATTERNS = [
    // someone took the game
    { kind: "win", re: new RegExp(NAME + "\\s+(?:won|wins)\\s+the\\s+game", "i"), ends: true },
    { kind: "win", re: new RegExp(NAME + "\\s+is\\s+the\\s+winner", "i"), ends: true },
    // a player was knocked out
    { kind: "out", re: new RegExp("time(?:d)?\\s*out\\s+" + NAME + "\\s*[!.]", "i"), ends: false },
    { kind: "out", re: new RegExp(NAME + "\\s*[!.]?\\s*you\\s+are\\s+out\\b", "i"), ends: false },
    { kind: "out", re: new RegExp(NAME + "\\s+(?:is|was|has\\s+been)\\s+(?:out|eliminated)\\b", "i"), ends: false },
    // ended with nobody named
    { kind: "over", re: /\bgame\s+over\b/i, ends: true },
    { kind: "over", re: /\bno\s+winner\b/i, ends: true }
  ];

  function detectEnd(text) {
    // "Longest word : organisation (12) by @Ifeoluwa" rides along inside the
    // winner block and names someone who did NOT win. Strip the fragment
    // rather than skipping the line: if WhatsApp ever renders the block on a
    // single line, dropping the line would throw away the win itself.
    var scrubbed = clean(text).replace(/longest\s+word[^\n]*/gi, " ");
    var lines = scrubbed.split("\n");
    // newest first: the freshest event wins if several are on screen
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (!line) continue;
      for (var j = 0; j < END_PATTERNS.length; j++) {
        var pat = END_PATTERNS[j], m = line.match(pat.re);
        if (!m) continue;
        return {
          kind: pat.kind,
          who: pat.kind === "over" ? "" : (m[1] || "").trim(),
          ends: pat.ends,
          idx: i,
          line: line
        };
      }
    }
    return null;
  }

  var lastEndKey = "";

  function checkEnd() {
    if (!cfg.enabled) return;
    var root = pick(SEL.main) || document.body;
    var text = root.innerText || "";
    if (!text) return;

    var ev = detectEnd(text);
    if (!ev) return;

    // Repeat rounds produce identical lines, so fold in how many times the
    // event has appeared - otherwise a second win would be silently ignored.
    var seen = (text.match(/won\s+the\s+game|you\s+are\s+out|game\s+over/gi) || []).length;
    var key = ev.kind + "|" + ev.who.toLowerCase() + "|" + seen;
    if (key === lastEndKey) return;
    lastEndKey = key;

    var mine = ev.who ? sameParty(ev.who) : false;
    var cue, title, msg, tone;

    if (ev.kind === "win") {
      if (mine) { cue = "win";  title = "You won"; msg = "Took the game. " + ev.line; tone = "good"; }
      else      { cue = "lose"; title = "Lost";    msg = ev.who + " took the game."; tone = "bad"; }
    } else if (ev.kind === "out") {
      if (mine) { cue = "lose"; title = "You're out"; msg = "Knocked out - " + ev.line; tone = "bad"; }
      else      { cue = "out";  title = ev.who + " is out"; msg = "One rival down."; tone = "good"; }
    } else {
      cue = "over"; title = "Game over"; msg = ev.line; tone = "neutral";
    }

    console.log(TAG, "end event:", ev.kind, "| who:", ev.who || "(none)", "| mine:", mine, "| cue:", cue);
    ping(cue);
    endHud(title, msg, tone);

    // Freeze the result on screen: the round is finished, so the prompt above
    // it must not be answered again. If a prompt has already arrived *below*
    // the result, a new round is running and must not be suppressed.
    if ((ev.ends || mine) && endIsCurrent(ev)) consumeVisiblePrompt();
  }

  // True when nothing has been asked since the result landed.
  function endIsCurrent(ev) {
    if (!ev || typeof ev.idx !== "number") return true;
    var found = latestPromptBlock();
    return !found || ev.idx > found.idx;
  }

  function ping(cue) {
    if (!cfg.sound) return;
    if (!self.FS_SOUND) { console.warn(TAG, "sound module missing - sound.js did not load"); return; }
    self.FS_SOUND.play(cue);
  }

  // ------------------------------------------------------------------ observer
  var lastKey = "";

  function promptKeyOf(found, p) {
    return found.hits + "|" + p.prefix + "|" + p.lo + "|" + p.hi + "|" + p.turn;
  }

  // After a result, mark whatever prompt is still on screen as already handled.
  // Clearing lastKey instead would make that stale prompt look brand new: the
  // result banner is overwritten and a word is drafted into a finished game.
  // A genuinely new round carries a higher "Starts with" count, so its key
  // differs and it still fires.
  function consumeVisiblePrompt() {
    try {
      var found = latestPromptBlock();
      if (!found) { lastKey = "end"; return; }
      var p = parsePrompt(found.block);
      lastKey = p ? promptKeyOf(found, p) : "end";
    } catch (e) { lastKey = "end"; }
  }

  function evaluate() {
    if (!cfg.enabled) return;
    var found = latestPromptBlock();
    if (!found) return;

    var p = parsePrompt(found.block);
    if (!p) return;

    var key = promptKeyOf(found, p);
    if (key === lastKey) return;
    lastKey = key;

    console.log(TAG, "prompt:", p.prefix.toUpperCase(), p.rule, "| turn:", p.turn || "(none)",
      "| mine:", isMyTurn(p));

    if (!isMyTurn(p)) {
      bareHud("<b>" + p.prefix.toUpperCase() + "</b> / " + p.rule,
        "Waiting - this turn belongs to " + p.turn + ".");
      return;
    }

    var played = playedWords();
    var list = candidates(p, played.used, 120);
    console.log(TAG, "bubbles:", played.bubbles, "| burned:", played.count, "| unplayed:", list.length);
    show(p, list);

    if (!list.length) return;

    if (cfg.autoSend) {
      note("Auto-sending in " + cfg.delayMs + "ms...");
      setTimeout(function () {
        if (draft(list[0].w)) {
          setTimeout(function () { sendNow(); ping("send"); }, 80);
        }
      }, Math.max(0, cfg.delayMs));
    } else {
      draft(list[0].w);
      note("Drafted - press Enter to send, or pick another word.");
    }
  }

  var pending = null;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(function () {
      // End-of-game first: a result should win over a stale prompt still on
      // screen above it.
      try { checkEnd(); } catch (e) { console.warn(TAG, "end check failed:", e.message); }
      try { evaluate(); } catch (e) { console.warn(TAG, "evaluate failed:", e.message); }
    }, 150);
  }

  function start() {
    console.log(TAG, "running. handle:", cfg.handle, "| autoSend:", cfg.autoSend,
      "| dictionary:", self.FS_DICT ? "loaded" : "MISSING");

    // proof of life, so a silent failure is distinguishable from "no prompt yet"
    var main = pick(SEL.main), box = pick(SEL.composer);
    bareHud("<b>Watching</b>",
      "Chat panel " + (main ? "found" : "NOT found") +
      ", message box " + (box ? "found" : "NOT found") + ".",
      !(main && box));
    setTimeout(function () { if (!lastKey) hide(); }, 6000);

    // Prime the end-of-game key from whatever is already rendered, so opening
    // a chat that still shows an old result does not blast a fanfare.
    try {
      var seed = (pick(SEL.main) || document.body).innerText || "";
      var ev0 = detectEnd(seed);
      if (ev0) {
        var n0 = (seed.match(/won\s+the\s+game|you\s+are\s+out|game\s+over/gi) || []).length;
        lastEndKey = ev0.kind + "|" + ev0.who.toLowerCase() + "|" + n0;
        console.log(TAG, "existing result on screen, muted:", ev0.kind, ev0.who || "");
        // and if that result is the newest thing in the chat, the round above
        // it is finished - do not draft, let alone auto-send, into it
        if ((ev0.ends || sameParty(ev0.who)) && endIsCurrent(ev0)) {
          consumeVisiblePrompt();
          console.log(TAG, "last round already finished - standing by");
        }
      }
    } catch (e) { /* non-fatal */ }

    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  // Start on defaults immediately, then fold in saved settings when they
  // arrive. Gating startup on chrome.storage meant an invalidated extension
  // context (the usual state after reloading the extension without reloading
  // the tab) killed the whole script silently, with no panel and no log.
  function boot() {
    try {
      start();
    } catch (e) {
      console.error(TAG, "startup failed:", e);
      try {
        bareHud("<b>Error</b>", "Fifteen Seconds failed to start: " + e.message, true);
      } catch (e2) { /* nothing left to do */ }
    }
  }

  try {
    chrome.storage.local.get(DEFAULTS, function (v) {
      if (chrome.runtime && chrome.runtime.lastError) {
        console.warn(TAG, "settings unavailable:", chrome.runtime.lastError.message);
      } else {
        cfg = Object.assign({}, DEFAULTS, v || {});
      }
      boot();
    });
  } catch (e) {
    console.warn(TAG, "chrome.storage unreachable, using defaults:", e.message);
    boot();
  }

  try {
    chrome.storage.onChanged.addListener(function (ch) {
      Object.keys(ch).forEach(function (k) { cfg[k] = ch[k].newValue; });
      if (!cfg.enabled) hide();
    });
  } catch (e) { /* context gone - defaults still apply */ }
})();
