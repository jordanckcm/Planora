/* =========================================================
   PLANORA — LOGIN PAGE
========================================================= */

// If already signed in, skip straight to the calendar.
(async () => {
    const existingUser = await Planora.getCurrentUser();
    if (existingUser) {
        window.location.href = "homepage.html";
    }
})();


/* =========================
   TOASTS
========================= */

function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}


/* =========================
   TABS
========================= */

const tabs = document.querySelectorAll(".auth-tab");
const forms = {
    login: document.getElementById("loginForm"),
    signup: document.getElementById("signupForm")
};

tabs.forEach(tab => {
    tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");

        Object.values(forms).forEach(f => f.classList.remove("active"));
        forms[tab.dataset.tab].classList.add("active");
    });
});


/* =========================
   PASSWORD REVEAL
========================= */

document.querySelectorAll(".reveal-toggle").forEach(button => {
    button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.target);
        const showing = input.type === "text";

        input.type = showing ? "password" : "text";
        button.textContent = showing ? "Show" : "Hide";
    });
});


/* =========================
   LIVE STRENGTH HINT
========================= */

const signupPassword = document.getElementById("signupPassword");
const strengthHint = document.getElementById("strengthHint");

signupPassword.addEventListener("input", () => {
    if (!signupPassword.value) {
        strengthHint.textContent = "Mix letters and numbers, 8+ characters.";
        strengthHint.classList.remove("ok");
        return;
    }

    const result = Planora.passwordStrength(signupPassword.value);
    strengthHint.textContent = result.ok ? "Looks good." : result.message;
    strengthHint.classList.toggle("ok", result.ok);
});


/* =========================
   LOGIN SUBMIT
========================= */

document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;
    const remember = document.getElementById("rememberMe").checked;
    const errorBox = document.getElementById("loginError");
    const submitButton = document.getElementById("loginSubmit");

    errorBox.textContent = "";

    if (!username || !password) {
        errorBox.textContent = "Enter your username and password.";
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Signing in...";

    try {
        await Planora.login(username, password, remember);
        window.location.href = "homepage.html";
    } catch (err) {
        errorBox.textContent = err.message;
        submitButton.disabled = false;
        submitButton.textContent = "Sign in";
    }
});


/* =========================
   SIGNUP SUBMIT
========================= */

document.getElementById("signupForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const displayName = document.getElementById("signupDisplayName").value;
    const username = document.getElementById("signupUsername").value;
    const password = document.getElementById("signupPassword").value;
    const errorBox = document.getElementById("signupError");
    const submitButton = document.getElementById("signupSubmit");

    errorBox.textContent = "";

    submitButton.disabled = true;
    submitButton.textContent = "Creating account...";

    try {
        await Planora.signup(username, displayName, password);
        await Planora.login(username, password, true);
        toast("Account created — welcome in.", "success");
        window.location.href = "homepage.html";
    } catch (err) {
        errorBox.textContent = err.message;
        submitButton.disabled = false;
        submitButton.textContent = "Create account";
    }
});
