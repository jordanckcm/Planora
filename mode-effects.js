/* =========================================================
   PLANORA — MODE SWITCH EFFECTS
   Adds the animations when you switch between Local / Global /
   Timeline. It doesn't touch homepage.js: it just watches for
   the mode classes homepage.js already puts on <body>.

   What it does on every switch:
     - slides a glowing pill from the old tab to the new one
     - sends a color ripple out from the tab you clicked
     - glitches the big year (VHS-style)
     - Local <-> Global: months slide in from the side you moved toward
     - Timeline: the spine draws itself, dots pop in, cards fly in
       from alternating sides
   Respects "reduce motion" system settings.
========================================================= */

(() => {
    const topbar = document.querySelector(".topbar");
    const timelineContainer = document.getElementById("timelineContainer");
    const yearEl = document.getElementById("year");
    if (!topbar || !timelineContainer) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const MODES = ["local", "global", "timeline"]; // same order as the tabs

    let lastMode = null;
    let pendingTimelineAt = 0;   // waiting for timeline cards to be built
    let pendingMonths = null;    // waiting for month cards to reappear
    let pendingMonthsAt = 0;
    const PENDING_TIMEOUT = 4000; // give up if the data never arrives


    /* ---------- elements this script adds ---------- */

    const indicator = document.createElement("span");
    indicator.className = "mode-indicator";
    topbar.appendChild(indicator);

    const wash = document.createElement("div");
    wash.className = "mode-wash";
    document.body.appendChild(wash);


    /* ---------- helpers ---------- */

    function currentMode() {
        return MODES.find(m => document.body.classList.contains(`mode-${m}`)) || null;
    }

    function activeButton() {
        return topbar.querySelector(
            ".local-button.mode-active, .global-button.mode-active, .timeline-button.mode-active"
        );
    }

    /* Slides the pill under the active tab. `instant` skips the
       slide (first placement, window resize, fonts loading). */
    function placeIndicator(instant) {
        const button = activeButton();
        if (!button) return;

        if (instant) indicator.classList.add("no-anim");

        indicator.style.width = `${button.offsetWidth}px`;
        indicator.style.transform = `translateX(${button.offsetLeft}px)`;
        indicator.classList.add("ready");

        if (instant) {
            void indicator.offsetWidth; // apply the jump before re-enabling the slide
            indicator.classList.remove("no-anim");
        }
    }


    /* ---------- effects ---------- */

    /* Color ripple expanding from the clicked tab, in the new mode's color. */
    function playWash(button) {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const reach = Math.hypot(window.innerWidth, window.innerHeight);

        wash.animate(
            [
                { clipPath: `circle(0px at ${x}px ${y}px)`, opacity: 0.9 },
                { clipPath: `circle(${reach}px at ${x}px ${y}px)`, opacity: 0 }
            ],
            { duration: 800, easing: "cubic-bezier(.22,.7,.2,1)" }
        );
    }

    /* Quick VHS tracking glitch on the big year numerals. */
    function glitchYear() {
        if (!yearEl) return;

        const none = "0 0 0 rgba(0,0,0,0), 0 0 0 rgba(0,0,0,0)";

        yearEl.animate(
            [
                { transform: "translateX(0)", textShadow: none },
                { transform: "translateX(-9px) skewX(-4deg)", textShadow: "7px 0 rgba(255,60,90,.55), -7px 0 rgba(60,200,255,.55)", offset: 0.2 },
                { transform: "translateX(7px) skewX(3deg)", textShadow: "-6px 0 rgba(255,60,90,.45), 6px 0 rgba(60,200,255,.45)", offset: 0.4 },
                { transform: "translateX(-3px)", textShadow: "3px 0 rgba(255,60,90,.3), -3px 0 rgba(60,200,255,.3)", offset: 0.65 },
                { transform: "translateX(0)", textShadow: none }
            ],
            { duration: 460, easing: "ease-out" }
        );
    }

    /* Months slide in from the side you moved toward, one after another. */
    function animateMonths(direction) {
        const dx = direction === "forward" ? 56 : -56;

        document.querySelectorAll(".month-wrapper").forEach((wrapper, i) => {
            wrapper.animate(
                [
                    { opacity: 0, transform: `translateX(${dx}px) scale(0.96)`, filter: "blur(5px)" },
                    { opacity: 1, transform: "translateX(0) scale(1)", filter: "blur(0)" }
                ],
                { duration: 540, delay: i * 34, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }
            );
        });
    }

    /* Timeline: spine draws down, dots pop, cards fly in from alternating sides. */
    function animateTimeline() {
        const wide = window.innerWidth > 700;

        [...timelineContainer.children].forEach((child, i) => {
            const delay = Math.min(i, 14) * 70;
            const body = child.querySelector(".timeline-body");

            // the "no events yet" message just fades up
            if (!body) {
                child.animate(
                    [
                        { opacity: 0, transform: "translateY(12px)" },
                        { opacity: 0.5, transform: "translateY(0)" }
                    ],
                    { duration: 400, easing: "ease-out", fill: "backwards" }
                );
                return;
            }

            const dot = child.querySelector(".timeline-dot");
            const line = child.querySelector(".timeline-line");
            const fromX = wide && i % 2 === 1 ? -56 : 56; // matches the left/right layout

            body.animate(
                [
                    { opacity: 0, transform: `translateX(${fromX}px) scale(0.96)`, filter: "blur(4px)" },
                    { opacity: 1, transform: "translateX(0) scale(1)", filter: "blur(0)" }
                ],
                { duration: 560, delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }
            );

            if (dot) {
                dot.animate(
                    [
                        { transform: "scale(0)" },
                        { transform: "scale(1.6)", offset: 0.6 },
                        { transform: "scale(1)" }
                    ],
                    { duration: 480, delay: delay + 120, easing: "ease-out", fill: "backwards" }
                );
            }

            if (line) {
                line.style.transformOrigin = "top";
                line.animate(
                    [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
                    { duration: 520, delay: delay + 180, easing: "ease-out", fill: "backwards" }
                );
            }
        });
    }


    /* ---------- reacting to mode changes ---------- */

    function onModeChange() {
        const mode = currentMode();
        if (!mode || mode === lastMode) return;

        const previous = lastMode;
        lastMode = mode;

        placeIndicator(previous === null);

        if (reduceMotion.matches) return;

        // first load: one gentle cascade of the months, nothing else
        if (previous === null) {
            animateMonths("forward");
            return;
        }

        const direction = MODES.indexOf(mode) > MODES.indexOf(previous) ? "forward" : "back";

        const button = activeButton();
        if (button) playWash(button);
        glitchYear();

        if (mode === "timeline") {
            // cards don't exist yet — homepage.js builds them once the data
            // arrives, so wait for them (see the observer below)
            pendingTimelineAt = Date.now();
            pendingMonths = null;
        } else if (previous === "timeline") {
            // month cards are hidden right now; animate them when they come back
            pendingMonths = direction;
            pendingMonthsAt = Date.now();
            pendingTimelineAt = 0;
        } else {
            animateMonths(direction);
        }
    }

    new MutationObserver(onModeChange).observe(document.body, {
        attributes: true,
        attributeFilter: ["class"]
    });

    // timeline cards just got built
    new MutationObserver(() => {
        if (
            pendingTimelineAt &&
            Date.now() - pendingTimelineAt < PENDING_TIMEOUT &&
            timelineContainer.children.length > 0
        ) {
            pendingTimelineAt = 0;
            animateTimeline();
        }
    }).observe(timelineContainer, { childList: true });

    // month cards just came back from the timeline
    new MutationObserver(() => {
        if (
            pendingMonths &&
            Date.now() - pendingMonthsAt < PENDING_TIMEOUT &&
            !timelineContainer.classList.contains("active")
        ) {
            const direction = pendingMonths;
            pendingMonths = null;
            animateMonths(direction);
        }
    }).observe(timelineContainer, { attributes: true, attributeFilter: ["class"] });


    /* ---------- keep the pill lined up ---------- */

    window.addEventListener("resize", () => placeIndicator(true));
    window.addEventListener("load", () => placeIndicator(true));
    if (document.fonts && document.fonts.ready) {
        // tab widths change once the custom fonts arrive
        document.fonts.ready.then(() => placeIndicator(true));
    }

    onModeChange(); // in case the mode class was already set
})();
