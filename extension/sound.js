/* Fifteen Seconds - 8-bit cues
 *
 * Synthesised rather than shipped as audio files: no binaries in the
 * extension, nothing to fetch, and the CSP on web.whatsapp.com never
 * gets involved.
 *
 * The character comes from pulse waves at NES duty cycles (12.5 / 25 / 50%)
 * plus a white-noise channel for percussion, which is what the 2A03 actually
 * had. A plain Web Audio "square" is 50% only and sounds thinner.
 */
(function () {
  "use strict";

  var ctx = null, master = null, waves = {}, noiseBuf = null;
  var TAG = "[FS]";
  var blocked = false;

  function ac() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;          // headroom: cues sit under WhatsApp's own
      master.connect(ctx.destination);
    } catch (e) {
      console.warn(TAG, "audio unavailable:", e.message);
      return null;
    }
    return ctx;
  }

  // Fourier series for a pulse of the given duty cycle.
  // x(t) = d + SUM (2/(n*pi)) * sin(n*pi*d) * cos(2*pi*n*f*t)
  function pulse(duty) {
    var key = String(duty);
    if (waves[key]) return waves[key];
    var n = 28, real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (var i = 1; i <= n; i++) real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
    waves[key] = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    return waves[key];
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 0.4);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    // 1-bit-ish: quantised to +/-1 like a shift register, not smooth noise
    for (var i = 0; i < len; i++) d[i] = Math.random() < 0.5 ? -1 : 1;
    return noiseBuf;
  }

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // One pulse-channel note. `bend` slides to a second pitch, NES style.
  function note(at, dur, freq, opt) {
    opt = opt || {};
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.setPeriodicWave(pulse(opt.duty == null ? 0.5 : opt.duty));
    o.frequency.setValueAtTime(freq, at);
    if (opt.bend) o.frequency.exponentialRampToValueAtTime(Math.max(20, opt.bend), at + dur);
    if (opt.vibrato) {
      var lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 7; lg.gain.value = freq * 0.012;
      lfo.connect(lg); lg.connect(o.frequency);
      lfo.start(at); lfo.stop(at + dur);
    }
    var peak = opt.gain == null ? 0.9 : opt.gain;
    // hard attack, flat body, quick release - no analogue swell
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.004);
    g.gain.setValueAtTime(peak, at + Math.max(0.006, dur * 0.7));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master);
    o.start(at); o.stop(at + dur + 0.02);
  }

  function hit(at, dur, opt) {
    opt = opt || {};
    var s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    s.buffer = noise();
    f.type = opt.type || "highpass";
    f.frequency.value = opt.cutoff || 2000;
    var peak = opt.gain == null ? 0.35 : opt.gain;
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(at); s.stop(at + dur + 0.02);
  }

  var CUES = {
    // acknowledgement after an auto-send: two-note rising blip
    send: function (t) {
      note(t,        0.055, midi(81), { duty: 0.5,   gain: 0.7 });   // A5
      note(t + 0.055, 0.11, midi(88), { duty: 0.25,  gain: 0.8 });   // E6
    },

    // you took the round
    win: function (t) {
      var d = 0.085;
      [72, 76, 79, 84].forEach(function (n, i) {            // C5 E5 G5 C6
        note(t + i * d, d * 0.95, midi(n), { duty: 0.5, gain: 0.85 });
      });
      note(t + 4 * d, d,    midi(79), { duty: 0.25, gain: 0.85 });
      note(t + 5 * d, 0.42, midi(84), { duty: 0.25, gain: 0.95, vibrato: true });
      // bass line underneath
      [48, 55, 48, 60].forEach(function (n, i) {
        note(t + i * (d * 1.5), d * 1.3, midi(n), { duty: 0.125, gain: 0.4 });
      });
      [0, 1, 2, 3, 4, 5].forEach(function (i) {
        hit(t + i * d, 0.04, { gain: 0.16, cutoff: 6000 });
      });
    },

    // you are out
    lose: function (t) {
      var d = 0.13;
      [67, 66, 65, 64].forEach(function (n, i) {            // G4 F#4 F4 E4
        note(t + i * d, d * 0.92, midi(n), { duty: 0.25, gain: 0.8 });
      });
      // final slide into the floor
      note(t + 4 * d, 0.6, midi(52), { duty: 0.125, gain: 0.85, bend: midi(36) });
      hit(t + 4 * d, 0.28, { type: "lowpass", cutoff: 900, gain: 0.3 });
    },

    // a rival went out - quieter, this is good news but not your moment
    out: function (t) {
      note(t,        0.07, midi(64), { duty: 0.25, gain: 0.45 });
      note(t + 0.08, 0.14, midi(59), { duty: 0.25, gain: 0.45 });
    },

    // game ended with no winner line we could attribute
    over: function (t) {
      note(t,        0.1,  midi(60), { duty: 0.5, gain: 0.6 });
      note(t + 0.11, 0.1,  midi(58), { duty: 0.5, gain: 0.6 });
      note(t + 0.22, 0.28, midi(55), { duty: 0.25, gain: 0.7, bend: midi(48) });
    }
  };

  function play(name) {
    var c = ac();
    if (!c || !CUES[name]) return false;
    if (c.state === "suspended") {
      // Chrome will not start audio before a gesture. Ask once, and let the
      // gesture hook below retry; do not queue, a late cue is worse than none.
      c.resume().catch(function () {});
      if (c.state === "suspended") {
        if (!blocked) { blocked = true; console.warn(TAG, "sound blocked until you click the page once"); }
        return false;
      }
    }
    blocked = false;
    try { CUES[name](c.currentTime + 0.01); return true; }
    catch (e) { console.warn(TAG, "cue failed:", e.message); return false; }
  }

  function unlock() {
    var c = ac();
    if (c && c.state === "suspended") c.resume().catch(function () {});
  }
  ["pointerdown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  self.FS_SOUND = { play: play, unlock: unlock, cues: Object.keys(CUES) };
})();
