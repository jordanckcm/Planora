/* =========================================================
   PLANORA — SETTINGS
   The Discord-style "User Settings" overlay. Included via
   <script src="settings.js"></script> on any page after api.js;
   builds itself into the page once, on first open, then just
   toggles visibility after that. Exposed as Planora.Settings.open(user).

   Two panes for now:
     My Account  - who you are, log out, delete your account
     Appearance  - theme (system/light/dark), reduce motion

   Both persist through PUT /api/me (via Planora.updateAccountPreferences),
   the same endpoint the profile editor uses for everything else, so a
   theme choice made here follows the account to any device.
========================================================= */

(function () {

    const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

    function safeImage(value) {
        return typeof value === "string" && IMAGE_DATA_URL.test(value) ? value : "";
    }

    function safeColor(value) {
        return HEX_COLOR.test(value || "") ? value : "#c9a227";
    }

    function toast(message, type = "") {
        let stack = document.getElementById("toastStack");
        if (!stack) {
            // pages that always have one already use it; this is just a
            // fallback so settings.js works even on a page without one
            stack = document.createElement("div");
            stack.id = "toastStack";
            stack.className = "toast-stack";
            document.body.appendChild(stack);
        }
        const el = document.createElement("div");
        el.className = `toast ${type}`;
        el.textContent = message;
        stack.appendChild(el);
        setTimeout(() => el.remove(), 3200);
    }

    /* Same "are you sure?" dialog pattern used on the homepage and
       profile page — duplicated here (rather than shared) so this file
       works standalone regardless of which page includes it, same
       convention the rest of the codebase already follows. */
    function confirmAction({ title, message, confirmLabel = "Delete" }) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "confirm-overlay";

            const box = document.createElement("div");
            box.className = "confirm-box";
            box.setAttribute("role", "alertdialog");
            box.setAttribute("aria-modal", "true");

            const titleEl = document.createElement("div");
            titleEl.className = "confirm-title";
            titleEl.textContent = title;

            const messageEl = document.createElement("p");
            messageEl.className = "confirm-message";
            messageEl.textContent = message;

            const buttons = document.createElement("div");
            buttons.className = "confirm-buttons";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "confirm-cancel";
            cancelBtn.textContent = "Cancel";

            const confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className = "confirm-confirm";
            confirmBtn.textContent = confirmLabel;

            buttons.append(cancelBtn, confirmBtn);
            box.append(titleEl, messageEl, buttons);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            function close(result) {
                overlay.classList.remove("show");
                document.removeEventListener("keydown", onKeydown);
                setTimeout(() => overlay.remove(), 180);
                resolve(result);
            }
            function onKeydown(e) { if (e.key === "Escape") close(false); }

            cancelBtn.addEventListener("click", () => close(false));
            confirmBtn.addEventListener("click", () => close(true));
            overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
            document.addEventListener("keydown", onKeydown);

            // settings.css puts the overlay itself at z-index 700; the
            // confirm dialog needs to sit above THAT too (see profile.css's
            // own confirm-overlay z-index — this reuses the same class, so
            // it inherits whatever z-index profile.css/homepage.css gave
            // it; if neither page's CSS is loaded, settings.css's own
            // fallback rule below covers it)
            requestAnimationFrame(() => {
                overlay.classList.add("show");
                cancelBtn.focus();
            });
        });
    }

    function roleLabel(role) {
        if (role === "admin") return "Admin";
        if (role === "community_plus") return "Community+";
        return "Community";
    }

    let built = false;
    let overlay, closeBtn, navItems, panes;
    let themeButtons, reduceMotionSwitch, deleteBtn;
    let currentUser = null;

    function build() {
        if (built) return;
        built = true;

        overlay = document.createElement("div");
        overlay.className = "settings-overlay";
        overlay.innerHTML = `
            <div class="settings-shell">
                <nav class="settings-sidebar">
                    <div class="settings-sidebar-title">User Settings</div>
                    <button class="settings-nav-item active" type="button" data-pane="account">My Account</button>
                    <button class="settings-nav-item" type="button" data-pane="appearance">Appearance</button>
                    <div class="settings-sidebar-divider"></div>
                    <button class="settings-nav-item danger" type="button" id="settingsLogout">Log Out</button>
                </nav>
                <div class="settings-content">
                    <button class="settings-close" type="button" aria-label="Close settings">×</button>

                    <section class="settings-pane" data-pane="account">
                        <div class="settings-pane-title">My Account</div>

                        <div class="settings-account-card">
                            <div class="settings-account-avatar" id="settingsAvatar"></div>
                            <div>
                                <div class="settings-account-name" id="settingsDisplayName"></div>
                                <div class="settings-account-handle" id="settingsUsername"></div>
                            </div>
                        </div>

                        <div class="settings-row">
                            <div class="settings-row-label">Role</div>
                            <div class="settings-row-hint" id="settingsRole"></div>
                        </div>

                        <div class="settings-danger-zone">
                            <div class="settings-row-label">Delete Account</div>
                            <p class="settings-row-hint">
                                This permanently removes your account, your events, and your
                                comments. This can't be undone.
                            </p>
                            <button class="settings-danger-button" type="button" id="settingsDeleteAccount">Delete Account</button>
                        </div>
                    </section>

                    <section class="settings-pane" data-pane="appearance" hidden>
                        <div class="settings-pane-title">Appearance</div>

                        <div class="settings-row-label">Theme</div>
                        <div class="settings-theme-toggle" id="settingsThemeToggle">
                            <button type="button" data-theme="system">System</button>
                            <button type="button" data-theme="light">Light</button>
                            <button type="button" data-theme="dark">Dark</button>
                        </div>

                        <div class="settings-switch-row">
                            <div>
                                <div class="settings-row-label">Reduce motion</div>
                                <div class="settings-row-hint">Turns off animations and transitions across Planora.</div>
                            </div>
                            <button class="settings-switch" type="button" id="settingsReduceMotion" role="switch" aria-checked="false"></button>
                        </div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        closeBtn = overlay.querySelector(".settings-close");
        navItems = overlay.querySelectorAll(".settings-nav-item[data-pane]");
        panes = overlay.querySelectorAll(".settings-pane");
        themeButtons = overlay.querySelectorAll("#settingsThemeToggle button");
        reduceMotionSwitch = overlay.querySelector("#settingsReduceMotion");
        deleteBtn = overlay.querySelector("#settingsDeleteAccount");

        function showPane(name) {
            navItems.forEach(item => item.classList.toggle("active", item.dataset.pane === name));
            panes.forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
        }

        navItems.forEach(item => {
            item.addEventListener("click", () => showPane(item.dataset.pane));
        });

        function close() {
            overlay.classList.remove("show");
            document.body.style.overflow = "";
        }

        closeBtn.addEventListener("click", close);
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && overlay.classList.contains("show")) close();
        });

        overlay.querySelector("#settingsLogout").addEventListener("click", async () => {
            await Planora.logout();
            window.location.href = "login.html";
        });

        themeButtons.forEach(btn => {
            btn.addEventListener("click", async () => {
                const theme = btn.dataset.theme;
                themeButtons.forEach(b => b.classList.toggle("active", b === btn));
                Planora.applyThemePreference(theme); // instant, no flash
                try {
                    await Planora.updateAccountPreferences({ theme });
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });

        reduceMotionSwitch.addEventListener("click", async () => {
            const next = reduceMotionSwitch.getAttribute("aria-checked") !== "true";
            reduceMotionSwitch.setAttribute("aria-checked", String(next));
            Planora.applyReduceMotion(next);
            try {
                await Planora.updateAccountPreferences({ reduceMotion: next });
            } catch (err) {
                toast(err.message, "error");
            }
        });

        deleteBtn.addEventListener("click", async () => {
            const confirmed = await confirmAction({
                title: "Delete your account?",
                message: "Your account, your events (including any Global posts and everyone's copies of them), and your comments will all be permanently removed. This can't be undone.",
                confirmLabel: "Delete account"
            });
            if (!confirmed) return;

            deleteBtn.disabled = true;
            try {
                await Planora.deleteAccount();
                window.location.href = "login.html";
            } catch (err) {
                toast(err.message, "error");
                deleteBtn.disabled = false;
            }
        });
    }

    function fillAccountPane(user) {
        const avatar = overlay.querySelector("#settingsAvatar");
        const img = safeImage(user.avatarImage);
        if (img) {
            avatar.style.background = `center / cover no-repeat url("${img}")`;
            avatar.textContent = "";
        } else {
            avatar.style.background = `linear-gradient(135deg, ${safeColor(user.avatarColor)}, #1b1b1b)`;
            avatar.textContent = (user.displayName || user.username || "?").charAt(0).toUpperCase();
        }

        overlay.querySelector("#settingsDisplayName").textContent = user.displayName;
        overlay.querySelector("#settingsUsername").textContent = "@" + user.username;
        overlay.querySelector("#settingsRole").textContent = roleLabel(user.role);
    }

    function fillAppearancePane(user) {
        const theme = user.themePreference || "system";
        themeButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.theme === theme));
        reduceMotionSwitch.setAttribute("aria-checked", String(Boolean(user.reduceMotion)));
    }

    function open(user) {
        currentUser = user;
        build();
        fillAccountPane(user);
        fillAppearancePane(user);

        overlay.querySelectorAll(".settings-nav-item[data-pane]")[0].click(); // reset to My Account
        overlay.classList.add("show");
        document.body.style.overflow = "hidden";
    }

    // Planora is the same top-level `const` object api.js defines —
    // separate <script> tags share one script-scope lexical environment
    // for let/const (unlike var, this never touches `window`), so this
    // adds Settings onto the very object profile.js/homepage.js already
    // call Planora.requireAuth()/Planora.logout() etc. on, rather than
    // creating a second, disconnected object.
    Planora.Settings = { open };

})();
