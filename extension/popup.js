var DEFAULTS = { handle: "Rafe", autoSend: false, delayMs: 800, enabled: true, sound: true };
var f = {
  handle: document.getElementById("handle"),
  autoSend: document.getElementById("autoSend"),
  delayMs: document.getElementById("delayMs"),
  enabled: document.getElementById("enabled"),
  sound: document.getElementById("sound")
};
var saved = document.getElementById("saved"), t;

chrome.storage.local.get(DEFAULTS, function (v) {
  f.handle.value = v.handle;
  f.autoSend.checked = !!v.autoSend;
  f.delayMs.value = v.delayMs;
  f.enabled.checked = !!v.enabled;
  f.sound.checked = !!v.sound;
});

function save() {
  chrome.storage.local.set({
    handle: f.handle.value.trim(),
    autoSend: f.autoSend.checked,
    delayMs: Math.max(0, parseInt(f.delayMs.value, 10) || 0),
    enabled: f.enabled.checked,
    sound: f.sound.checked
  }, function () {
    saved.textContent = "Saved";
    clearTimeout(t);
    t = setTimeout(function () { saved.textContent = ""; }, 1200);
  });
}
Object.keys(f).forEach(function (k) {
  f[k].addEventListener(f[k].type === "checkbox" ? "change" : "input", save);
});

// Preview the cues in the popup itself - the popup is a normal page, so it can
// run the same synth without touching the WhatsApp tab.
var s = document.createElement("script");
s.src = "sound.js";
s.onload = function () {
  document.querySelectorAll(".cues button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (self.FS_SOUND) { self.FS_SOUND.unlock(); self.FS_SOUND.play(b.dataset.cue); }
    });
  });
};
document.head.appendChild(s);
