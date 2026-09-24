/*
  Planora notification sounds  ->  <script src="/sound.js"></script>  (load it before live.js)

  Plays a short custom sound when something arrives WHILE PLANORA IS OPEN AND VISIBLE.
  (In that case sw.js shows the system notification silently, so you never get two sounds.
  When the tab is hidden or closed, the phone/computer plays its own default sound - browsers
  don't let a website change that one.)

  The sounds are generated in code, so there are no audio files to host:
    message / comment  a soft "pop"
    reply              two rising notes
    mention            three rising notes (the most eye-catching)
    reminder           a gentle two-ding bell

  PlanoraSound.play(kind)        kind: "message" | "comment" | "reply" | "mention" | "reminder"
  PlanoraSound.preview(kind)     always plays (call it from a button - for a settings page)
  PlanoraSound.setEnabled(bool) / isEnabled()      per device, remembered
  PlanoraSound.setVolume(0..1)  / getVolume()      per device, remembered
  PlanoraSound.useFile(url)      optional: play YOUR OWN sound file (mp3/ogg/wav) for everything
                                 e.g. PlanoraSound.useFile("/ding.mp3")   (call again with null to go back)
*/
(function () {
  const KEY_ON = "planora_sound_on";
  const KEY_VOL = "planora_sound_vol";
  const DEDUPE_MS = 1200;      // a push and a poll can both notice the same thing

  let ctx = null;
  let lastPlayed = 0;
  let fileUrl = null;

  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  function isEnabled() { return get(KEY_ON) !== "0"; }
  function setEnabled(on) { set(KEY_ON, on ? "1" : "0"); }
  function getVolume() {
    const v = parseFloat(get(KEY_VOL));
    return Number.isNaN(v) ? 0.5 : Math.min(1, Math.max(0, v));
  }
  function setVolume(v) { set(KEY_VOL, String(Math.min(1, Math.max(0, Number(v) || 0)))); }
  function useFile(url) { fileUrl = url || null; }

  // Browsers only allow sound after the person has tapped/clicked/typed on the page
  // at least once, so the audio engine is created on the first interaction.
  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
  }
  ["pointerdown", "keydown", "touchstart"].forEach((t) =>
    window.addEventListener(t, unlock, { passive: true })
  );

  // one soft sine "note", with a quick fade in and out so it never clicks
  function note(c, freq, start, length, peak, glideTo) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + length);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(start);
    osc.stop(start + length + 0.03);
  }

  const SOUNDS = {
    message(c, t, v) {                       // "pop"
      note(c, 900, t, 0.16, v, 520);
      note(c, 1800, t, 0.08, v * 0.25, 1040);
    },
    reply(c, t, v) {                         // ba-ding
      note(c, 660, t, 0.13, v);
      note(c, 990, t + 0.11, 0.2, v);
    },
    mention(c, t, v) {                       // rising three
      note(c, 784, t, 0.12, v);
      note(c, 988, t + 0.1, 0.12, v);
      note(c, 1319, t + 0.2, 0.3, v);
    },
    reminder(c, t, v) {                      // bell, twice
      [0, 0.38].forEach((d) => {
        note(c, 1047, t + d, 0.55, v * 0.8);
        note(c, 2093, t + d, 0.35, v * 0.25);
      });
    },
  };
  SOUNDS.comment = SOUNDS.message;
  SOUNDS.test = SOUNDS.reply;

  function play(kind, options) {
    const force = options && options.force;
    if (!force) {
      if (!isEnabled()) return;
      if (document.visibilityState !== "visible") return;   // hidden tab: the system plays its own sound
      if (Date.now() - lastPlayed < DEDUPE_MS) return;
    }

    if (fileUrl) {
      lastPlayed = Date.now();
      try {
        const audio = new Audio(fileUrl);
        audio.volume = getVolume();
        audio.play().catch(() => {});
      } catch (e) {}
      return;
    }

    if (!ctx) return;                                        // nobody has touched the page yet
    if (ctx.state === "suspended") ctx.resume();
    lastPlayed = Date.now();                                 // only counts once a sound really plays
    const make = SOUNDS[kind] || SOUNDS.message;
    make(ctx, ctx.currentTime + 0.02, 0.32 * getVolume());   // 0.32 = a comfortable top level
  }

  function preview(kind) {
    unlock();
    play(kind || "mention", { force: true });
  }

  // sw.js tells open pages the moment a push arrives, and says what kind it was
  window.addEventListener("planora:push", (event) => {
    const kind = event.detail && event.detail.kind;
    play(kind || "message");
  });

  window.PlanoraSound = { play, preview, isEnabled, setEnabled, getVolume, setVolume, useFile };
})();
