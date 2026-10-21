// Replays remote-control keys from the URL, e.g. ?keys=down,down,enter&step=400
// Keys: left right up down enter back play, waitMS pauses.
// ?seed=http://host:port pre-fills the launcher's saved server address.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('seed')) localStorage.setItem('immichTv.server', JSON.stringify(params.get('seed')));
  const keys = (params.get('keys') || '').split(',').filter(Boolean);
  const step = Number(params.get('step')) || 400;
  const NAMES = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', enter: 'Enter', back: 'Escape', play: ' ' };

  function press(name) {
    const key = NAMES[name] || name;
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  }

  function run(i) {
    if (i >= keys.length) return;
    if (keys[i].indexOf('wait') === 0) {
      setTimeout(() => run(i + 1), Number(keys[i].slice(4)) || 1000);
      return;
    }
    press(keys[i]);
    setTimeout(() => run(i + 1), step);
  }

  setTimeout(() => run(0), Number(params.get('delay')) || 1500);
})();
