/* Paste this into the DevTools Console of the WHATSAPP TAB (not the extension
   popup) if nothing appears. It only reads - it changes nothing. */
(() => {
  if (!location.host.includes('web.whatsapp.com')) {
    console.error('Wrong console. This is "' + (location.host || location.protocol) +
      '". Click the WhatsApp page itself, press Cmd+Option+J, and paste this there.');
    return;
  }
  const q = (s) => { try { return document.querySelectorAll(s).length; } catch { return 'bad-selector'; } };
  const main = document.querySelector('#main');
  const txt = (main || document.body).innerText || '';
  const lines = txt.split('\n').filter(Boolean);

  // The content script marks the shared DOM the instant it executes.
  const loaded = document.documentElement.getAttribute('data-fs-loaded');
  const hud = document.getElementById('fs-hud');

  console.log('%c--- Fifteen Seconds diagnosis ---', 'font-weight:bold');

  if (!loaded) {
    console.log('%cVERDICT: the content script is NOT running in this tab.',
      'color:#b00020;font-weight:bold');
    console.log('Nothing can be typed into the message box until it is. Fix, in order:');
    console.log('  1. chrome://extensions - is "Fifteen Seconds" present and toggled ON?');
    console.log('  2. Any red "Errors" button on its card? Open it and send me the text.');
    console.log('  3. Click its circular reload arrow.');
    console.log('  4. RELOAD THIS WHATSAPP TAB (Cmd+R). Content scripts only inject at');
    console.log('     page load - reloading the extension alone never affects an open tab.');
  } else {
    console.log('%cContent script: RUNNING (v' + loaded + ')', 'color:#0a7c2f;font-weight:bold');
    console.log('panel element present:', !!hud, hud ? '(visible: ' + hud.classList.contains('on') + ')' : '');
  }

  console.log('host:', location.host);
  console.log('#main found:', !!main);
  console.log('bubbles  [role=row]:', q('#main div[role=\'row\']'));
  console.log('composer footer[contenteditable]:', q('footer div[contenteditable=\'true\']'));
  console.log('composer [data-lexical-editor]:', q('div[contenteditable=\'true\'][data-lexical-editor=\'true\']'));
  console.log('send button (real):', q('button[aria-label*=\'Send\' i]'),
    '| mic present:', q('button[aria-label*=\'voice\' i]'));
  console.log('"Starts with" occurrences in rendered text:', (txt.match(/starts?\s*with/gi) || []).length);
  console.log('last 12 rendered lines:', JSON.stringify(lines.slice(-12), null, 1));
  console.log('--- end ---');
})();
