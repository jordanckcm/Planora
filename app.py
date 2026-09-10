"""
Planora backend

This is a simple Flask app. It does NOT use a real database.
Everything is just kept in normal Python lists while the server
is running. That means if you stop the server, everything you
made (accounts, events, comments) gets wiped and you start over.
That's fine for now, it's just for learning / testing.

How to run this:
    1. pip install -r requirements.txt
    2. python app.py
    3. open http://127.0.0.1:5000 in your browser

ROLES
    community       - default role. Can create local events, up to a cap.
                       Cannot post to Global.
    community_plus  - can create local events (higher cap) AND post to
                       Global, up to a smaller cap.
    admin           - no caps. Can manage users (change role / delete)
                       and delete ANY event, not just their own.
"""

import hashlib
import secrets
import time
import os
from functools import wraps

from flask import Flask, request, jsonify, session


app = Flask(__name__, static_folder=".", static_url_path="")

# this key is used to keep login sessions safe.
# in a real project you would NOT hardcode this, you'd keep it secret!
app.secret_key = os.environ["SECRET_KEY"]


# =========================================================
# JSON ERROR HANDLERS
# Every response the frontend gets back needs to be JSON,
# because api.js always calls response.json() on it. Without
# these, an unmatched route (typo'd URL, etc.) or a bug that
# raises an exception falls through to Flask's default error
# page — which is HTML, not JSON. Trying to JSON-parse that
# HTML is exactly what throws the cryptic "Unexpected token
# ... in JSON" error in the browser, even though nothing about
# the actual request (like a delete) failed.
# =========================================================

@app.errorhandler(404)
def handle_not_found(e):
    return jsonify({"error": "That route doesn't exist."}), 404


@app.errorhandler(500)
def handle_server_error(e):
    return jsonify({"error": "Something went wrong on the server. Try again."}), 500


# =========================================================
# OUR "DATABASE" (just lists in memory, nothing fancy)
# =========================================================

users = []          # each item looks like: {"username": ..., "password_hash": ..., "role": ..., ...}
events = []         # each item looks like: {"id": 1, "owner": ..., "title": ..., ...}
comments = []       # each item looks like: {"id": 1, "event_id": 1, "author": ..., "text": ...}

# simple counters so every event/comment gets its own id number
next_event_id = 1
next_comment_id = 1

# keeps track of failed logins so people can't just guess passwords forever
login_attempts = {}   # {"username": {"count": 2, "locked_until": 1234567.0}}

AVATAR_COLORS = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"]

# same palette reused for event color-tags, so the picker UI feels consistent
EVENT_COLORS = AVATAR_COLORS

EVENT_ICONS = ["🎉", "🎮", "🎵", "🍕", "🏀", "🎨", "📚", "🌙", "🔥", "🎬"]

VALID_ROLES = ("community", "community_plus", "admin")

# how many ACTIVE (not deleted) events each role is allowed to have at once
COMMUNITY_LOCAL_LIMIT = 10
COMMUNITY_PLUS_LOCAL_LIMIT = 25
COMMUNITY_PLUS_GLOBAL_LIMIT = 1
# admin has no limits


# =========================================================
# LITTLE HELPER FUNCTIONS
# =========================================================

def find_user(username):
    """Look through the users list and find one with this username."""
    for user in users:
        if user["username"].lower() == username.lower():
            return user
    return None


def make_salt():
    """Makes a random bit of text to mix into the password before hashing."""
    return secrets.token_hex(8)


def hash_password(password, salt):
    """Turns a password into a scrambled hash so we never store the real password."""
    combined = salt + password
    return hashlib.sha256(combined.encode()).hexdigest()


def pick_avatar_color(username):
    """Just picks a color from our list based on the username, so it's always the same."""
    total = 0
    for letter in username:
        total = total + ord(letter)
    return AVATAR_COLORS[total % len(AVATAR_COLORS)]


def user_public_info(user):
    """Sends back the safe parts of a user (never the password/salt!)."""
    return {
        "username": user["username"],
        "displayName": user["display_name"],
        "bio": user["bio"],
        "avatarColor": user["avatar_color"],
        "createdAt": user["created_at"],
        "role": user["role"],
    }


def get_logged_in_username():
    """Checks the session cookie to see who (if anyone) is logged in."""
    return session.get("username")


def get_logged_in_user():
    """Same as above but returns the full user record instead of just the name."""
    username = get_logged_in_username()
    if not username:
        return None
    return find_user(username)


def require_role(*allowed_roles):
    """
    Route decorator. Blocks the request unless the logged-in user's role
    is one of allowed_roles. Passes the user record into the route as the
    first argument so you don't have to look it up again.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = get_logged_in_user()
            if not user:
                return jsonify({"error": "Not signed in."}), 401
            if user["role"] not in allowed_roles:
                return jsonify({"error": "You don't have permission to do that."}), 403
            return fn(user, *args, **kwargs)
        return wrapper
    return decorator


def register_failed_login(key):
    """Counts failed logins and locks the account for a bit after too many."""
    attempt = login_attempts.get(key, {"count": 0, "locked_until": 0})
    attempt["count"] += 1

    if attempt["count"] >= 5:
        attempt["locked_until"] = time.time() + 60  # locked for 60 seconds
        attempt["count"] = 0

    login_attempts[key] = attempt


def now_in_ms():
    """JavaScript likes timestamps in milliseconds, so we convert here."""
    return int(time.time() * 1000)


def cascade_delete_event(deleted_event):
    """
    Cleans up everything tied to a deleted event: its own comments, and —
    if it was a Global event — every personal ("local") copy other people
    made of it via "Add to my calendar", plus THEIR comments too. Local
    events aren't cloned by anyone, so deleting one never cascades.
    """
    removed_ids = {deleted_event["id"]}

    if deleted_event["visibility"] == "global":
        clone_ids = {e["id"] for e in events if e.get("cloned_from") == deleted_event["id"]}
        removed_ids |= clone_ids
        events[:] = [e for e in events if e.get("cloned_from") != deleted_event["id"]]

    comments[:] = [c for c in comments if c["event_id"] not in removed_ids]


# =========================================================
    DATA
# ==============-==========================================

def add_demo_data():
    demo_salt = make_salt()
    planora_password = os.environ["PLANORA_ADMIN_PASSWORD"]
    planora_password_hash = hash_password(planora_password, demo_salt)

    demo_users = [
        {"username": "Jordan", "role": "admin"},
        {"username": "Manlangit", "role": "admin"},
    ]

    for demo in demo_users:
        name = demo["username"]
        users.append({
            "username": name,
            "display_name": name.capitalize(),
            "salt": demo_salt,
            "password_hash": planora_password_hash,
            "bio": "",
            "avatar_color": pick_avatar_color(name),
            "created_at": now_in_ms(),
            "role": demo["role"],
        })

    global next_event_id
    year = time.localtime().tm_year

"""
    demo_events = [
        {"owner": "sable", "title": "Rooftop Card Night",
         "description": "Bring your own deck, we'll bring the snacks.",
         "date": f"{year}-06-14"},
        {"owner": "vex", "title": "Open Mic @ The Landing",
         "description": "Sign-ups open 30 minutes before doors.",
         "date": f"{year}-07-02"},
        {"owner": "juno", "title": "City Marathon",
         "description": "Route closes at 1PM sharp, start early!",
         "date": f"{year}-10-11"},
    ]

    for demo_event in demo_events:
        events.append({
            "id": next_event_id,
            "owner": demo_event["owner"],
            "title": demo_event["title"],
            "description": demo_event["description"],
            "date": demo_event["date"],
            "visibility": "global",
            "cloned_from": None,
            "created_at": now_in_ms(),
        })
        next_event_id += 1
"""

add_demo_data()


# =========================================================
# PAGE ROUTES (just sends the html files)
# =========================================================

@app.route("/")
def serve_home_page():
    return app.send_static_file("index.html")


# =========================================================
# ACCOUNT ROUTES
# =========================================================

@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json()

    username = data.get("username", "").strip()
    display_name = data.get("displayName", "").strip() or username
    password = data.get("password", "")

    if len(username) < 3:
        return jsonify({"error": "Username needs to be at least 3 characters."}), 400

    if not username.replace("_", "").replace(".", "").isalnum():
        return jsonify({"error": "Usernames can only use letters, numbers, \".\" and \"_\"."}), 400

    if find_user(username):
        return jsonify({"error": "That username is already taken."}), 400

    if len(password) < 8:
        return jsonify({"error": "Password needs to be at least 8 characters."}), 400

    if password.isalpha() or password.isdigit():
        return jsonify({"error": "Mix letters and numbers in your password."}), 400

    salt = make_salt()
    password_hash = hash_password(password, salt)

    new_user = {
        "username": username,
        "display_name": display_name,
        "salt": salt,
        "password_hash": password_hash,
        "bio": "",
        "avatar_color": pick_avatar_color(username),
        "created_at": now_in_ms(),
        "role": "community",   # everyone starts as Community
    }
    users.append(new_user)

    session["username"] = username
    return jsonify(user_public_info(new_user))


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()

    username = data.get("username", "").strip()
    password = data.get("password", "")
    remember = data.get("remember", False)

    key = username.lower()
    attempt = login_attempts.get(key)

    if attempt and attempt["locked_until"] > time.time():
        seconds_left = int(attempt["locked_until"] - time.time())
        return jsonify({"error": f"Too many attempts. Try again in {seconds_left}s."}), 429

    user = find_user(username)

    if not user:
        register_failed_login(key)
        return jsonify({"error": "Incorrect username or password."}), 401

    password_hash = hash_password(password, user["salt"])

    if password_hash != user["password_hash"]:
        register_failed_login(key)
        return jsonify({"error": "Incorrect username or password."}), 401

    if key in login_attempts:
        del login_attempts[key]

    session["username"] = user["username"]
    session.permanent = bool(remember)

    return jsonify(user_public_info(user))


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("username", None)
    return jsonify({"ok": True})


@app.route("/api/me", methods=["GET"])
def get_me():
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    user = find_user(username)
    if not user:
        session.pop("username", None)
        return jsonify({"error": "Not signed in."}), 401

    return jsonify(user_public_info(user))


@app.route("/api/me", methods=["PUT"])
def update_me():
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    user = find_user(username)
    data = request.get_json()

    if "displayName" in data:
        new_name = data["displayName"].strip()
        if new_name == "":
            return jsonify({"error": "Display name can't be empty."}), 400
        user["display_name"] = new_name

    if "bio" in data:
        user["bio"] = data["bio"].strip()

    if "avatarColor" in data:
        user["avatar_color"] = data["avatarColor"]

    return jsonify(user_public_info(user))


# =========================================================
# EVENT ROUTES
# =========================================================

@app.route("/api/events", methods=["GET"])
def get_events():
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    mode = request.args.get("mode", "local")
    year = request.args.get("year", "")

    if mode == "global":
        matching_events = [e for e in events if e["visibility"] == "global"]
    else:
        matching_events = [e for e in events if e["owner"].lower() == username.lower()]

    if year:
        matching_events = [e for e in matching_events if e["date"].startswith(year)]

    # add a little flag so the frontend knows which ones belong to you
    result = []
    for event in matching_events:
        event_copy = dict(event)
        event_copy.setdefault("color", EVENT_COLORS[0])
        event_copy.setdefault("icon", EVENT_ICONS[0])
        event_copy.setdefault("end_date", event_copy["date"])
        event_copy.setdefault("start_time", "")
        event_copy.setdefault("end_time", "")
        event_copy["isMine"] = event["owner"].lower() == username.lower()

        if mode == "global":
            # everyone who's added this to their own calendar — shown as
            # a little "who's going" avatar row on the card
            adders = []
            for e in events:
                if e.get("cloned_from") == event["id"]:
                    adder = find_user(e["owner"])
                    if adder:
                        adders.append({"username": adder["username"], "avatarColor": adder["avatar_color"]})
            event_copy["addedBy"] = adders

        result.append(event_copy)

    return jsonify(result)


@app.route("/api/events", methods=["POST"])
def add_event():
    global next_event_id

    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    data = request.get_json()
    title = data.get("title", "").strip()
    description = data.get("description", "").strip()
    date = data.get("date", "")
    visibility = "global" if data.get("visibility") == "global" else "local"

    color = data.get("color")
    if color not in EVENT_COLORS:
        color = EVENT_COLORS[0]

    icon = data.get("icon")
    if icon not in EVENT_ICONS:
        icon = EVENT_ICONS[0]

    if not title or not date:
        return jsonify({"error": "Add a name and date first."}), 400

    # Optional: what time it starts/ends, and — for something that runs
    # more than one day — when it ends. Leaving these blank just means
    # "no specific time, single day", same as before.
    start_time = data.get("startTime", "").strip()
    end_time = data.get("endTime", "").strip()
    end_date = data.get("endDate", "").strip() or date

    if end_date < date:
        return jsonify({"error": "End date can't be before the start date."}), 400

    role = user["role"]
    mine = [e for e in events if e["owner"].lower() == user["username"].lower()]

    if visibility == "global":
        if role == "community":
            return jsonify({"error": "Upgrade to Community+ to post to Global."}), 403

        if role != "admin":
            current_global = len([e for e in mine if e["visibility"] == "global"])
            if current_global >= COMMUNITY_PLUS_GLOBAL_LIMIT:
                return jsonify({
                    "error": f"You've hit your Global post limit ({COMMUNITY_PLUS_GLOBAL_LIMIT}). Remove one to add another."
                }), 403
    else:
        if role != "admin":
            limit = COMMUNITY_LOCAL_LIMIT if role == "community" else COMMUNITY_PLUS_LOCAL_LIMIT
            current_local = len([e for e in mine if e["visibility"] == "local"])
            if current_local >= limit:
                return jsonify({
                    "error": f"You've hit your local event limit ({limit}). Remove one to add another."
                }), 403

    new_event = {
        "id": next_event_id,
        "owner": user["username"],
        "title": title,
        "description": description,
        "date": date,
        "end_date": end_date,
        "start_time": start_time,
        "end_time": end_time,
        "visibility": visibility,
        "color": color,
        "icon": icon,
        "cloned_from": None,
        "created_at": now_in_ms(),
    }
    next_event_id += 1

    events.append(new_event)
    return jsonify(new_event)


@app.route("/api/events/<int:event_id>/add", methods=["POST"])
def add_to_my_calendar(event_id):
    global next_event_id

    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    username = user["username"]

    source_event = None
    for event in events:
        if event["id"] == event_id:
            source_event = event
            break

    if not source_event:
        return jsonify({"error": "Event not found."}), 404

    for event in events:
        if event["owner"].lower() == username.lower() and event.get("cloned_from") == event_id:
            return jsonify({"error": "You already added that one."}), 400

    if user["role"] != "admin":
        limit = COMMUNITY_LOCAL_LIMIT if user["role"] == "community" else COMMUNITY_PLUS_LOCAL_LIMIT
        current_local = len([
            e for e in events
            if e["owner"].lower() == username.lower() and e["visibility"] == "local"
        ])
        if current_local >= limit:
            return jsonify({
                "error": f"You've hit your local event limit ({limit}). Remove one to add another."
            }), 403

    clone = {
        "id": next_event_id,
        "owner": username,
        "title": source_event["title"],
        "description": source_event["description"],
        "date": source_event["date"],
        "end_date": source_event.get("end_date", source_event["date"]),
        "start_time": source_event.get("start_time", ""),
        "end_time": source_event.get("end_time", ""),
        "visibility": "local",
        "color": source_event.get("color", EVENT_COLORS[0]),
        "icon": source_event.get("icon", EVENT_ICONS[0]),
        "cloned_from": event_id,
        "created_at": now_in_ms(),
    }
    next_event_id += 1

    events.append(clone)
    return jsonify(clone)


@app.route("/api/events/<int:event_id>", methods=["DELETE"])
def delete_event(event_id):
    """
    Deletes an event you own. This is unrelated to role — every role
    (Community, Community+, Admin) can always delete their own events.
    Deleting events you DON'T own is handled separately, by admins only,
    at /api/admin/events/<id>.

    If it was a Global event, this also removes everyone's local copies
    of it (and comments on those copies) — see cascade_delete_event.
    """
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    for event in events:
        if event["id"] == event_id and event["owner"].lower() == username.lower():
            events.remove(event)
            cascade_delete_event(event)
            return jsonify({"ok": True})

    return jsonify({"error": "Event not found."}), 404


# =========================================================
# COMMENT ROUTES
# =========================================================

@app.route("/api/events/<int:event_id>/comments", methods=["GET"])
def get_comments(event_id):
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    matching_comments = [c for c in comments if c["event_id"] == event_id]
    return jsonify(matching_comments)


@app.route("/api/events/<int:event_id>/comments", methods=["POST"])
def add_comment(event_id):
    global next_comment_id

    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    data = request.get_json()
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Comment can't be empty."}), 400

    new_comment = {
        "id": next_comment_id,
        "event_id": event_id,
        "author": username,
        "text": text,
        "edited": False,
        "created_at": now_in_ms(),
    }
    next_comment_id += 1

    comments.append(new_comment)
    return jsonify(new_comment)


@app.route("/api/events/<int:event_id>/comments/<int:comment_id>", methods=["PUT"])
def edit_comment(event_id, comment_id):
    """Only the comment's own author can edit it — not the event's poster or an admin."""
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    comment = next((c for c in comments if c["id"] == comment_id and c["event_id"] == event_id), None)
    if not comment:
        return jsonify({"error": "Comment not found."}), 404

    if comment["author"].lower() != username.lower():
        return jsonify({"error": "You can only edit your own comments."}), 403

    data = request.get_json()
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "Comment can't be empty."}), 400

    comment["text"] = text
    comment["edited"] = True

    return jsonify(comment)


@app.route("/api/events/<int:event_id>/comments/<int:comment_id>", methods=["DELETE"])
def delete_comment(event_id, comment_id):
    """
    The comment's own author can always delete it. The event's poster or
    an admin can also delete ANY comment on that event, same as event
    moderation elsewhere.
    """
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = next((e for e in events if e["id"] == event_id), None)
    if not event:
        return jsonify({"error": "Event not found."}), 404

    comment = next((c for c in comments if c["id"] == comment_id and c["event_id"] == event_id), None)
    if not comment:
        return jsonify({"error": "Comment not found."}), 404

    is_admin = user["role"] == "admin"
    is_event_owner = event["owner"].lower() == user["username"].lower()
    is_comment_author = comment["author"].lower() == user["username"].lower()

    if not (is_admin or is_event_owner or is_comment_author):
        return jsonify({"error": "You don't have permission to delete that comment."}), 403

    comments.remove(comment)
    return jsonify({"ok": True})


# =========================================================
# PROFILE STATS
# =========================================================

@app.route("/api/stats", methods=["GET"])
def get_stats():
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    event_count = 0
    for event in events:
        if event["owner"].lower() == username.lower():
            event_count += 1

    comment_count = 0
    for comment in comments:
        if comment["author"].lower() == username.lower():
            comment_count += 1

    return jsonify({"events": event_count, "comments": comment_count})


# =========================================================
# ADMIN ROUTES
# All of these require role == "admin". Nobody else can reach them,
# even if they guess the URL, because @require_role checks the
# session on every request.
# =========================================================

@app.route("/api/admin/users", methods=["GET"])
@require_role("admin")
def admin_list_users(current_user):
    result = []
    for u in users:
        info = user_public_info(u)
        result.append(info)
    return jsonify(result)


@app.route("/api/admin/users/<username>/role", methods=["PUT"])
@require_role("admin")
def admin_set_role(current_user, username):
    target = find_user(username)
    if not target:
        return jsonify({"error": "User not found."}), 404

    data = request.get_json()
    new_role = data.get("role")

    if new_role not in VALID_ROLES:
        return jsonify({"error": "Invalid role."}), 400

    if target["username"].lower() == current_user["username"].lower() and new_role != "admin":
        return jsonify({"error": "You can't demote yourself."}), 400

    target["role"] = new_role
    return jsonify(user_public_info(target))


@app.route("/api/admin/users/<username>", methods=["DELETE"])
@require_role("admin")
def admin_delete_user(current_user, username):
    target = find_user(username)
    if not target:
        return jsonify({"error": "User not found."}), 404

    if target["username"].lower() == current_user["username"].lower():
        return jsonify({"error": "You can't delete your own account here."}), 400

    users.remove(target)

    # clean up their events + comments too, otherwise the app is left
    # pointing at events "owned" by nobody
    events[:] = [e for e in events if e["owner"].lower() != username.lower()]
    comments[:] = [c for c in comments if c["author"].lower() != username.lower()]

    return jsonify({"ok": True})


@app.route("/api/admin/events", methods=["GET"])
@require_role("admin")
def admin_list_events(current_user):
    return jsonify(events)


@app.route("/api/admin/events/<int:event_id>", methods=["DELETE"])
@require_role("admin")
def admin_delete_event(current_user, event_id):
    """
    Lets an admin remove ANY event, not just their own — e.g. to take
    down something inappropriate someone posted to Global. Also cascades:
    see cascade_delete_event.
    """
    for event in events:
        if event["id"] == event_id:
            events.remove(event)
            cascade_delete_event(event)
            return jsonify({"ok": True})

    return jsonify({"error": "Event not found."}), 404


if __name__ == "__main__":
    import os

    port = int(os.environ.get("PORT", 5000))

    app.run(
        host="0.0.0.0",
        port=port
    )
