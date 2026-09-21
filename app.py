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

GLOBAL vs LOCAL (important - this changed)
    A Global post and your own calendar copy of it are now TWO separate
    records. Posting to Global creates the global event AND a private
    local copy owned by you, linked by cloned_from. Deleting the local
    copy only removes it from your calendar; the Global post stays up.
    Deleting the Global post itself still removes everyone's copies.
"""

import re
import time
import os
from datetime import timedelta
from functools import wraps
from zoneinfo import ZoneInfo, available_timezones

from flask import Flask, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash


app = Flask(__name__, static_folder=".", static_url_path="")

app.secret_key = os.environ["SECRET_KEY"]

# "Remember me" sessions last this long; without it they die with the browser.
app.permanent_session_lifetime = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# Images are stored as small base64 data URLs on the event itself.
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024   # reject any request over 2 MB
MAX_IMAGE_CHARS = 300_000                             # roughly a 220 KB image
IMAGE_PATTERN = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")

# Match the maxlength values the frontend forms use, so someone hand-rolling
# a request can't stuff a megabyte of text into a display name.
MAX_TITLE = 80
MAX_DESCRIPTION = 400
MAX_DISPLAY_NAME = 40
MAX_BIO = 200
MAX_COMMENT = 240

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^\d{2}:\d{2}$")

# Real IANA zone names ("Asia/Manila", "America/New_York"), loaded once at
# startup. The frontend sends Intl.DateTimeFormat().resolvedOptions().timeZone,
# which is always one of these - but never trust the client, so anything
# that isn't a real zone just gets dropped rather than stored.
_VALID_TIMEZONES = available_timezones()


def clean_timezone(value):
    if not isinstance(value, str) or value not in _VALID_TIMEZONES:
        return ""
    return value


@app.errorhandler(404)
def handle_not_found(e):
    return jsonify({"error": "That route doesn't exist."}), 404


@app.errorhandler(500)
def handle_server_error(e):
    return jsonify({"error": "Something went wrong on the server. Try again."}), 500


@app.errorhandler(413)
def handle_too_large(e):
    return jsonify({"error": "That image is too big. Try a smaller one."}), 413


users = []
events = []
comments = []

next_event_id = 1
next_comment_id = 1

login_attempts = {}

AVATAR_COLORS = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"]
EVENT_COLORS = AVATAR_COLORS
EVENT_ICONS = ["🎉", "🎮", "🎵", "🍕", "🏀", "🎨", "📚", "🌙", "🔥", "🎬"]

VALID_ROLES = ("community", "community_plus", "admin")

COMMUNITY_LOCAL_LIMIT = 10
COMMUNITY_PLUS_LOCAL_LIMIT = 25
COMMUNITY_PLUS_GLOBAL_LIMIT = 1


def body():
    """request.get_json() raises a 400 on a missing/odd body. This never does."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def clean_image(value):
    """Returns (image, error). An empty string means 'no image'."""
    if not value:
        return "", None
    if not isinstance(value, str) or len(value) > MAX_IMAGE_CHARS:
        return "", "That image is too big. Try a smaller one."
    if not IMAGE_PATTERN.match(value):
        return "", "Only JPEG, PNG or WebP images are allowed."
    return value, None


def clean_time(value):
    value = value.strip() if isinstance(value, str) else ""
    return value if TIME_PATTERN.match(value) else ""


def find_user(username):
    for user in users:
        if user["username"].lower() == username.lower():
            return user
    return None


def find_event(event_id):
    for event in events:
        if event["id"] == event_id:
            return event
    return None


def pick_avatar_color(username):
    total = 0
    for letter in username:
        total = total + ord(letter)
    return AVATAR_COLORS[total % len(AVATAR_COLORS)]


def user_public_info(user):
    return {
        "username": user["username"],
        "displayName": user["display_name"],
        "bio": user["bio"],
        "avatarColor": user["avatar_color"],
        "avatarImage": user.get("avatar_image", ""),
        "createdAt": user["created_at"],
        "role": user["role"],
    }


def get_logged_in_username():
    return session.get("username")


def get_logged_in_user():
    username = get_logged_in_username()
    if not username:
        return None
    return find_user(username)


def require_role(*allowed_roles):
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
    attempt = login_attempts.get(key, {"count": 0, "locked_until": 0})
    attempt["count"] += 1
    if attempt["count"] >= 5:
        attempt["locked_until"] = time.time() + 60
        attempt["count"] = 0
    login_attempts[key] = attempt


def now_in_ms():
    return int(time.time() * 1000)


def local_event_count(username):
    return len([
        e for e in events
        if e["owner"].lower() == username.lower() and e["visibility"] == "local"
    ])


def cascade_delete_event(deleted_event):
    """
    Removes the fallout of an already-removed event: if it was a Global
    post, everyone's local copies of it go too, along with the comments
    on the post and on those copies.
    """
    removed_ids = {deleted_event["id"]}
    if deleted_event["visibility"] == "global":
        removed_ids |= {e["id"] for e in events if e.get("cloned_from") == deleted_event["id"]}
        events[:] = [e for e in events if e.get("cloned_from") != deleted_event["id"]]
    comments[:] = [c for c in comments if c["event_id"] not in removed_ids]


def make_local_copy(source_event, username):
    """A private calendar copy of a Global post. Caller appends it."""
    global next_event_id

    copy = {
        "id": next_event_id,
        "owner": username,
        "title": source_event["title"],
        "description": source_event["description"],
        "date": source_event["date"],
        "end_date": source_event.get("end_date", source_event["date"]),
        "start_time": source_event.get("start_time", ""),
        "end_time": source_event.get("end_time", ""),
        "timezone": source_event.get("timezone", ""),
        "visibility": "local",
        "color": source_event.get("color", EVENT_COLORS[0]),
        "icon": source_event.get("icon", EVENT_ICONS[0]),
        "image": source_event.get("image", ""),
        "cloned_from": source_event["id"],
        "created_at": now_in_ms(),
    }
    next_event_id += 1
    return copy


def add_demo_data():
    planora_password = os.environ["PLANORA_ADMIN_PASSWORD"]

    demo_users = [
        {"username": "Jordan", "role": "admin"},
        {"username": "Manlangit", "role": "admin"},
    ]

    for demo in demo_users:
        name = demo["username"]
        users.append({
            "username": name,
            "display_name": name.capitalize(),
            # hashed per-user, so two accounts sharing a password don't
            # share a hash
            "password_hash": generate_password_hash(planora_password),
            "bio": "",
            "avatar_color": pick_avatar_color(name),
            "avatar_image": "",
            "created_at": now_in_ms(),
            "role": demo["role"],
        })


add_demo_data()


@app.route("/")
def serve_home_page():
    return app.send_static_file("index.html")


@app.route("/api/signup", methods=["POST"])
def signup():
    data = body()

    username = clean_text(data.get("username", ""), 40)
    display_name = clean_text(data.get("displayName", ""), MAX_DISPLAY_NAME) or username
    password = data.get("password", "")

    if not isinstance(password, str):
        password = ""

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

    new_user = {
        "username": username,
        "display_name": display_name,
        "password_hash": generate_password_hash(password),
        "bio": "",
        "avatar_color": pick_avatar_color(username),
        "avatar_image": "",
        "created_at": now_in_ms(),
        "role": "community",
    }
    users.append(new_user)

    session["username"] = username
    return jsonify(user_public_info(new_user))


@app.route("/api/login", methods=["POST"])
def login():
    data = body()

    username = clean_text(data.get("username", ""), 40)
    password = data.get("password", "")
    remember = bool(data.get("remember", False))

    if not isinstance(password, str):
        password = ""

    key = username.lower()
    attempt = login_attempts.get(key)

    if attempt and attempt["locked_until"] > time.time():
        seconds_left = int(attempt["locked_until"] - time.time())
        return jsonify({"error": f"Too many attempts. Try again in {seconds_left}s."}), 429

    user = find_user(username)

    # check_password_hash is constant-time, so a wrong password and a
    # missing account take the same path and the same shape of answer
    if not user or not check_password_hash(user["password_hash"], password):
        register_failed_login(key)
        return jsonify({"error": "Incorrect username or password."}), 401

    login_attempts.pop(key, None)

    session["username"] = user["username"]
    session.permanent = remember

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
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    data = body()

    if "displayName" in data:
        new_name = clean_text(data["displayName"], MAX_DISPLAY_NAME)
        if new_name == "":
            return jsonify({"error": "Display name can't be empty."}), 400
        user["display_name"] = new_name

    if "bio" in data:
        user["bio"] = clean_text(data["bio"], MAX_BIO)

    # Profile picture. Same rules as event covers: small base64 data URL,
    # JPEG/PNG/WebP only. Send "" to go back to the plain color circle.
    if "avatarImage" in data:
        image, image_error = clean_image(data["avatarImage"])
        if image_error:
            return jsonify({"error": image_error}), 400
        user["avatar_image"] = image

    # kept as the fallback/background behind a picture
    if "avatarColor" in data:
        if data["avatarColor"] not in AVATAR_COLORS:
            return jsonify({"error": "That isn't one of the avatar colors."}), 400
        user["avatar_color"] = data["avatarColor"]

    return jsonify(user_public_info(user))


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
        # only your private calendar records - your Global posts are
        # represented here by their own local copy, never the post itself
        matching_events = [
            e for e in events
            if e["owner"].lower() == username.lower() and e["visibility"] == "local"
        ]

    if year:
        matching_events = [e for e in matching_events if e["date"].startswith(year)]

    result = []
    for event in matching_events:
        event_copy = dict(event)
        event_copy.setdefault("color", EVENT_COLORS[0])
        event_copy.setdefault("icon", EVENT_ICONS[0])
        event_copy.setdefault("end_date", event_copy["date"])
        event_copy.setdefault("start_time", "")
        event_copy.setdefault("end_time", "")
        event_copy.setdefault("timezone", "")
        event_copy.setdefault("image", "")
        event_copy["isMine"] = event["owner"].lower() == username.lower()

        # so the card can show the host's face instead of a bare day
        # number - falls back to their assigned color if they have no photo
        owner_user = find_user(event["owner"])
        event_copy["ownerAvatarColor"] = owner_user["avatar_color"] if owner_user else EVENT_COLORS[0]
        event_copy["ownerAvatarImage"] = owner_user.get("avatar_image", "") if owner_user else ""
        event_copy["ownerDisplayName"] = owner_user["display_name"] if owner_user else event["owner"]

        if mode == "global":
            adders = []
            for e in events:
                if e.get("cloned_from") != event["id"]:
                    continue
                # the poster's own auto-copy isn't them "going" to it
                if e["owner"].lower() == event["owner"].lower():
                    continue
                adder = find_user(e["owner"])
                if adder:
                    adders.append({
                        "username": adder["username"],
                        "avatarColor": adder["avatar_color"],
                        "avatarImage": adder.get("avatar_image", ""),
                        "addedAt": e.get("created_at"),
                    })
            event_copy["addedBy"] = adders

        result.append(event_copy)

    return jsonify(result)


@app.route("/api/events", methods=["POST"])
def add_event():
    global next_event_id

    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    data = body()
    title = clean_text(data.get("title", ""), MAX_TITLE)
    description = clean_text(data.get("description", ""), MAX_DESCRIPTION)
    date = data.get("date", "")
    visibility = "global" if data.get("visibility") == "global" else "local"

    color = data.get("color")
    if color not in EVENT_COLORS:
        color = EVENT_COLORS[0]

    icon = data.get("icon")
    if icon not in EVENT_ICONS:
        icon = EVENT_ICONS[0]

    if not title or not isinstance(date, str) or not DATE_PATTERN.match(date):
        return jsonify({"error": "Add a name and date first."}), 400

    start_time = clean_time(data.get("startTime", ""))
    end_time = clean_time(data.get("endTime", ""))

    end_date = data.get("endDate", "")
    end_date = end_date.strip() if isinstance(end_date, str) else ""
    if end_date and not DATE_PATTERN.match(end_date):
        return jsonify({"error": "That end date isn't a real date."}), 400
    end_date = end_date or date

    if end_date < date:
        return jsonify({"error": "End date can't be before the start date."}), 400

    image, image_error = clean_image(data.get("image", ""))
    if image_error:
        return jsonify({"error": image_error}), 400

    # Only meaningful when there's a start_time - an all-day event has no
    # single instant to convert, so there's nothing for a timezone to do.
    timezone = clean_timezone(data.get("timezone", "")) if start_time else ""

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
            if local_event_count(user["username"]) >= limit:
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
        "timezone": timezone,
        "visibility": visibility,
        "color": color,
        "icon": icon,
        "image": image,
        "cloned_from": None,
        "created_at": now_in_ms(),
    }
    next_event_id += 1
    events.append(new_event)

    # Posting to Global also drops a copy on your own calendar, as its own
    # record. Removing that copy later leaves the Global post standing.
    # Deliberately exempt from the local cap - you didn't ask for it.
    if visibility == "global":
        events.append(make_local_copy(new_event, user["username"]))

    response = dict(new_event)
    response["isMine"] = True
    return jsonify(response)


@app.route("/api/events/<int:event_id>/add", methods=["POST"])
def add_to_my_calendar(event_id):
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    username = user["username"]

    source_event = find_event(event_id)
    if not source_event:
        return jsonify({"error": "Event not found."}), 404

    # Only Global posts are addable. Without this check anyone could copy
    # a stranger's private event - title, description, cover and all - just
    # by guessing its id.
    if source_event["visibility"] != "global":
        return jsonify({"error": "That event isn't posted to Global."}), 403

    if source_event["owner"].lower() == username.lower():
        return jsonify({"error": "That's already on your calendar."}), 400

    for event in events:
        if event["owner"].lower() == username.lower() and event.get("cloned_from") == event_id:
            return jsonify({"error": "You already added that one."}), 400

    if user["role"] != "admin":
        limit = COMMUNITY_LOCAL_LIMIT if user["role"] == "community" else COMMUNITY_PLUS_LOCAL_LIMIT
        if local_event_count(username) >= limit:
            return jsonify({
                "error": f"You've hit your local event limit ({limit}). Remove one to add another."
            }), 403

    clone = make_local_copy(source_event, username)
    events.append(clone)
    return jsonify(clone)


@app.route("/api/events/<int:event_id>", methods=["DELETE"])
def delete_event(event_id):
    """
    Deletes an event you own. This is unrelated to role - every role
    (Community, Community+, Admin) can always delete their own events.
    Deleting events you DON'T own is handled separately, by admins only,
    at /api/admin/events/<id>.

    Deleting a local copy only affects your calendar. Deleting a Global
    post takes everyone's copies of it with it - see cascade_delete_event.
    """
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or event["owner"].lower() != username.lower():
        return jsonify({"error": "Event not found."}), 404

    events.remove(event)
    cascade_delete_event(event)
    return jsonify({"ok": True})


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

    if not find_event(event_id):
        return jsonify({"error": "Event not found."}), 404

    text = clean_text(body().get("text", ""), MAX_COMMENT)

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
    """Only the comment's own author can edit it - not the event's poster or an admin."""
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    comment = next((c for c in comments if c["id"] == comment_id and c["event_id"] == event_id), None)
    if not comment:
        return jsonify({"error": "Comment not found."}), 404

    if comment["author"].lower() != username.lower():
        return jsonify({"error": "You can only edit your own comments."}), 403

    text = clean_text(body().get("text", ""), MAX_COMMENT)
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

    event = find_event(event_id)
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


@app.route("/api/stats", methods=["GET"])
def get_stats():
    username = get_logged_in_username()
    if not username:
        return jsonify({"error": "Not signed in."}), 401

    # count what you actually made, not the auto-copies of it
    event_count = len([
        e for e in events
        if e["owner"].lower() == username.lower() and e.get("cloned_from") is None
    ])

    comment_count = len([
        c for c in comments if c["author"].lower() == username.lower()
    ])

    return jsonify({"events": event_count, "comments": comment_count})


@app.route("/api/admin/users", methods=["GET"])
@require_role("admin")
def admin_list_users(current_user):
    return jsonify([user_public_info(u) for u in users])


@app.route("/api/admin/users/<username>/role", methods=["PUT"])
@require_role("admin")
def admin_set_role(current_user, username):
    target = find_user(username)
    if not target:
        return jsonify({"error": "User not found."}), 404

    new_role = body().get("role")

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

    # take their events with them, and then everyone's copies of whatever
    # Global posts they had up
    theirs = [e for e in events if e["owner"].lower() == username.lower()]
    events[:] = [e for e in events if e["owner"].lower() != username.lower()]
    for event in theirs:
        cascade_delete_event(event)

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
    Lets an admin remove ANY event, not just their own - e.g. to take
    down something inappropriate someone posted to Global. Also cascades:
    see cascade_delete_event.
    """
    event = find_event(event_id)
    if not event:
        return jsonify({"error": "Event not found."}), 404

    events.remove(event)
    cascade_delete_event(event)
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    app.run(
        host="0.0.0.0",
        port=port
    )
