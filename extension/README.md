# Fifteen Seconds - WhatsApp Web extension

Watches the open conversation for a word-game prompt, picks a word that fits and
has not been played yet, and types it into the message box.

## Install

1. Chrome -> `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** -> choose `~/fifteen-seconds/extension`
4. Open https://web.whatsapp.com and reload the tab
5. Click the extension icon and confirm your name reads `Rafe`

## How it behaves

A prompt like

    Turn : @Rafe
    Starts with Y (at least 13 letters)
    You have 20 seconds to reply

makes a panel appear at the bottom right with the best word, a live countdown,
and up to 24 alternates. The top word is typed into the message box straight
away - **you press Enter to send it**. Click any alternate to swap it.

If the turn belongs to someone else the panel says so and does nothing.

## Auto-send is off by default

The extension drafts, you send. That is deliberate: WhatsApp has no undo, the
prompt format can change without warning, and a mis-parse would post a wrong
word to the group. Turn on **Send automatically** in the popup only once you
have watched it pick correctly a few times. The delay setting controls how long
it waits before sending.

## Words already played

Every one-word message in the loaded conversation is treated as burned -
yours and everyone else's - so the extension will not suggest a repeat. This
matters more than it sounds: `Y` with 13+ letters has only 13 possible answers
in the whole dictionary, and `Y` with 15+ has exactly one.

Only messages currently loaded in the DOM are counted. Scroll up to load more
history if a long game has drifted out of view.

## When it stops working

WhatsApp Web has no public API, so this reads the page directly and that page
changes without notice. Run `diagnose.js` in the console of the WhatsApp tab
(not the extension popup - it now refuses to run in the wrong one) and compare.

Confirmed against a live session on 2026-08-24:

- `div.message-in` / `div.message-out` are **gone**. Message rows are
  `div[role='row']`, which is what the scan uses first now.
- Mentions are wrapped in Unicode bidi isolates, so `@Rafe` arrives as
  `@\u2068Rafe\u2069`. `clean()` strips those before any comparison.
- The send button does not exist while the box is empty - WhatsApp shows the
  mic instead and swaps it in once there is text. `sendNow()` polls for up to
  1.2s, then falls back to a synthetic Enter.

Prompt detection no longer depends on any of this: it reads rendered text and
finds the last "Starts with" line. Only the played-word scan and the composer
still need selectors, and both have fallbacks in the `SEL` object.

## Files

    manifest.json   MV3 manifest
    content.js      parser, played-word scan, DOM integration, panel
    dict.js         237,695 words + 1,306 names, frequency-ranked
    hud.css         panel styling
    popup.html/js   settings


## v1.1.0 - what changed and why

Diagnosed from a live session on 2026-08-24 where the panel never appeared and
nothing reached the message box. The diagnostic reported `panel injected: false`
while `#main`, the composer and 17 "Starts with" matches were all present.

- **`#fs-hud` is created on the first line of startup and is never removed** -
  hiding only drops a CSS class. Its absence therefore means the content script
  did not execute in that tab at all, which is the state after reloading the
  extension without reloading the WhatsApp tab. Content scripts inject only at
  page load.
- **The load marker is a DOM attribute**, `data-fs-loaded`, not a `window`
  property. Content scripts run in an isolated world, so anything hung off
  `window` is invisible to a script pasted into the page console.
- **Startup no longer waits on `chrome.storage`.** It boots on defaults and
  folds in saved settings when they arrive. Previously an invalidated extension
  context killed the whole script silently - no panel, no log.
- **`button[data-tab='11']` was removed from the send selectors.** In the live
  DOM that attribute belongs to the *microphone* while the box is empty, and
  only becomes Send once there is text. The old list would have clicked the mic
  and started a voice recording. `sendNow()` now also vetoes any control
  labelled voice / audio / emoji / attach / sticker before clicking.

Verified against a mock built from the live DOM (`role='row'` rows, the Lexical
composer, the mic-to-send swap): drafts `you` for `Y / 3+ letters`, excludes the
burned `yacht` / `yellow` / `yonder`, and registers exactly one click, on Send.


## v1.2.0 - end of game, and 8-bit cues

The helper now recognises that a round has finished, not just that a prompt
appeared. Detection reads rendered text, like the prompt parser, so no
WhatsApp class name has to hold.

Recognised (all matched after Unicode bidi isolates are stripped):

| bot line                                   | event | if it names you | if it names someone else |
|--------------------------------------------|-------|-----------------|--------------------------|
| `@Rafe won the game`, `@Rafe is the winner` | win   | **win** fanfare | **lose** - they took it  |
| `Time out @X! You are out!`                 | out   | **lose** slide  | **out** pip - rival down |
| `@X is out` / `has been eliminated`         | out   | **lose**        | **out**                  |
| `Game over`, `No winner`                    | over  | **over**        | **over**                 |

Plus a short **send** blip after every auto-send.

### Sound

`sound.js` synthesises everything with Web Audio - no audio files, nothing
fetched, so WhatsApp's CSP is never involved. The character comes from pulse
waves at NES duty cycles (12.5 / 25 / 50%) built as `PeriodicWave` from the
Fourier series, plus a 1-bit noise channel for percussion; Web Audio's built-in
`square` is 50% only and sounds thin by comparison. Chrome will not start audio
before a user gesture, so the module resumes the context on the first
`pointerdown` or `keydown` and logs once if a cue was dropped.

Toggle and preview the four cues from the extension popup.

### Two traps found while testing this

- **`Longest word : organisation (12) by @Ifeoluwa` names a loser.** It rides
  inside the winner block. The fragment is stripped before matching rather than
  the line being skipped - if WhatsApp ever renders that block on one line,
  skipping would have discarded the win itself.
- **A finished game must silence the helper.** Clearing the prompt key after a
  result made the stale prompt above it look brand new: the result banner was
  overwritten and, with auto-send on, a word was fired into a game that had
  already ended. The prompt still on screen is now marked as consumed, and line
  positions decide whether the result really is the newest thing in the chat -
  so a genuinely new round below a result still plays normally.
