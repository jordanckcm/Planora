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

EVENT VISIBILITY (three kinds now)
    local   - PRIVATE. Only on your own calendar. (Shown as "Private" in the UI.)
    public  - on your calendar AND listed on your profile, so anyone who
              views your profile can see it. This is NOT the same as Global.
    global  - posted to the Global feed for everyone, with comments.
              Community+ / admin only.

GLOBAL vs LOCAL
    A Global post and your own calendar copy of it are TWO separate
    records. Posting to Global creates the global event AND a private
    local copy owned by you, linked by cloned_from. Deleting the local
    copy only removes it from your calendar; the Global post stays up.
    Deleting the Global post itself still removes everyone's copies.

PROFILES
    Anyone signed in can open GET /api/users/<username>. They see the
    profile fields plus that person's PUBLIC events. Only the owner also
    gets their private events back. You usually get there by clicking
    someone's name on a comment.

DISCOVERY
    GET /api/users is a separate, flatter endpoint: it lists everyone on
    Planora (optionally filtered by a text search or a single interest
    tag), for the directory page. It's how "browse people" and clicking
    an interest chip both work.

REPLIES
    Comments can have replies (parentId). Replies are one level deep:
    replying to a reply attaches it to the same top-level comment and
    remembers who you were answering (reply_to).

PREFERENCES
    Each account also carries a couple of small client-preference
    fields - theme_preference ("system" | "light" | "dark") and
    reduce_motion (bool). These aren't used for anything server-side;
    they're just stored so a person's theme/motion choice follows them
    to a new device, the same way Discord's account-level settings do.
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
# saveProfile() can send an avatarImage AND a bannerImage in the same PUT,
# so this needs headroom for two images at once, not just one.
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024   # reject any request over 3 MB
MAX_IMAGE_CHARS = 1_400_000                           # roughly a 1 MB image
IMAGE_PATTERN = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")

# Match the maxlength values the frontend forms use, so someone hand-rolling
# a request can't stuff a megabyte of text into a display name.
MAX_TITLE = 80
MAX_DESCRIPTION = 400
MAX_DISPLAY_NAME = 40
MAX_BIO = 200
MAX_COMMENT = 240

# profile extras
MAX_PRONOUNS = 20
MAX_LOCATION = 40
MAX_STATUS_EMOJI = 8
MAX_STATUS_TEXT = 60
MAX_NOW_PLAYING = 60
MAX_LINK = 100
MAX_INTERESTS = 5
MAX_INTEREST_LENGTH = 20

# how many rows the directory hands back at once - no real pagination yet,
# just a defensive cap so a search with no filters can't return everything
MAX_DIRECTORY_RESULTS = 100

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^\d{2}:\d{2}$")
LINK_PATTERN = re.compile(r"^https?://[^\s<>\"']+$")
ACCENT_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")

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
DEFAULT_ACCENT = AVATAR_COLORS[0]

VALID_ROLES = ("community", "community_plus", "admin")
VALID_THEMES = ("system", "light", "dark")

COMMUNITY_LOCAL_LIMIT = 10
COMMUNITY_PLUS_LOCAL_LIMIT = 25
COMMUNITY_PLUS_GLOBAL_LIMIT = 1

# "local" is the private kind. The frontend may also send "private".
CALENDAR_VISIBILITIES = ("local", "public")


def body():
    """request.get_json() raises a 400 on a missing/odd body. This never does."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


GIF_PATTERN = re.compile(r"^data:image/gif;base64,[A-Za-z0-9+/=]+$")

# Roles allowed to upload an animated GIF anywhere an image goes (profile
# picture, banner, event cover) - static images stay open to everyone.
GIF_ROLES = ("community_plus", "admin")


def clean_image(value, allow_gif=False):
    """Returns (image, error). An empty string means 'no image'."""
    if not value:
        return "", None
    if not isinstance(value, str) or len(value) > MAX_IMAGE_CHARS:
        return "", "That image is too big. Try a smaller one."
    if GIF_PATTERN.match(value):
        if not allow_gif:
            return "", "GIFs need a Community+ or Admin account."
        return value, None
    if not IMAGE_PATTERN.match(value):
        return "", "Only JPEG, PNG, WebP images are allowed (GIF needs Community+ or Admin)."
    return value, None


DEFAULT_IMAGE_POSITION = {"x": 50.0, "y": 50.0}


def clean_position(value):
    """A focal point for an image - {'x': 0-100, 'y': 0-100}, percentages
    from the top-left, same idea as CSS background-position. Anything
    missing or out of range falls back to dead center rather than erroring
    the whole request over a cosmetic field."""
    if not isinstance(value, dict):
        return dict(DEFAULT_IMAGE_POSITION)
    try:
        x = float(value.get("x"))
        y = float(value.get("y"))
    except (TypeError, ValueError):
        return dict(DEFAULT_IMAGE_POSITION)
    if not (0 <= x <= 100 and 0 <= y <= 100):
        return dict(DEFAULT_IMAGE_POSITION)
    return {"x": round(x, 1), "y": round(y, 1)}


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
        "avatarPosition": user.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION),
        "createdAt": user["created_at"],
        "role": user["role"],
        # profile extras - .get() so accounts made before these existed still work
        "bannerImage": user.get("banner_image", ""),
        "bannerPosition": user.get("banner_position") or dict(DEFAULT_IMAGE_POSITION),
        "accent": user.get("accent", "") or user["avatar_color"],
        "pronouns": user.get("pronouns", ""),
        "location": user.get("location", ""),
        "link": user.get("link", ""),
        "statusEmoji": user.get("status_emoji", ""),
        "statusText": user.get("status_text", ""),
        "nowSong": user.get("now_song", ""),
        "nowArtist": user.get("now_artist", ""),
        "interests": user.get("interests", []),
        # client preferences - follow the account across devices, same
        # idea as Discord's account-level appearance settings
        "themePreference": user.get("theme_preference", "system"),
        "reduceMotion": bool(user.get("reduce_motion", False)),
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
    """Private + public events both count toward the calendar cap."""
    return len([
        e for e in events
        if e["owner"].lower() == username.lower() and e["visibility"] in CALENDAR_VISIBILITIES
    ])


def can_see_event(user, event):
    """Global and public events are visible to any signed-in user. Private
    ones only to their owner (or an admin)."""
    if event["visibility"] in ("global", "public"):
        return True
    return user["role"] == "admin" or event["owner"].lower() == user["username"].lower()


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


def prune_orphan_replies():
    """If a comment vanished (its author's account was deleted, say), the
    replies hanging off it go with it."""
    alive = {c["id"] for c in comments}
    comments[:] = [c for c in comments if c.get("parent_id") is None or c["parent_id"] in alive]


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
        "image_position": source_event.get("image_position") or dict(DEFAULT_IMAGE_POSITION),
        "cloned_from": source_event["id"],
        "created_at": now_in_ms(),
        "edited": False,
        "edited_at": None,
    }
    next_event_id += 1
    return copy


def profile_event_view(event):
    """The trimmed-down shape of an event shown on a profile page - enough
    to render it as a post (banner, caption, comments) if the viewer
    clicks into it, not just as a grid tile."""
    return {
        "id": event["id"],
        "owner": event["owner"],
        "title": event["title"],
        "description": event["description"],
        "date": event["date"],
        "end_date": event.get("end_date", event["date"]),
        "start_time": event.get("start_time", ""),
        "end_time": event.get("end_time", ""),
        "color": event.get("color", EVENT_COLORS[0]),
        "icon": event.get("icon", EVENT_ICONS[0]),
        "image": event.get("image", ""),
        "image_position": event.get("image_position") or dict(DEFAULT_IMAGE_POSITION),
        "visibility": event["visibility"],
        "edited": bool(event.get("edited")),
        "edited_at": event.get("edited_at"),
        "created_at": event.get("created_at"),
    }


def comment_view(comment):
    """A comment plus enough about its author to draw a name, a face,
    and a link to their profile."""
    out = dict(comment)
    out.setdefault("parent_id", None)
    out.setdefault("reply_to", None)
    author = find_user(comment["author"])
    out["authorDisplayName"] = author["display_name"] if author else comment["author"]
    out["authorAvatarColor"] = author["avatar_color"] if author else AVATAR_COLORS[0]
    out["authorAvatarImage"] = author.get("avatar_image", "") if author else ""
    return out


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
            "theme_preference": "system",
            "reduce_motion": False,
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
        "theme_preference": "system",
        "reduce_motion": False,
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

    # Validate everything first and only apply it at the end, so a bad
    # field can't leave the profile half-updated.
    updates = {}

    if "displayName" in data:
        new_name = clean_text(data["displayName"], MAX_DISPLAY_NAME)
        if new_name == "":
            return jsonify({"error": "Display name can't be empty."}), 400
        updates["display_name"] = new_name

    if "bio" in data:
        updates["bio"] = clean_text(data["bio"], MAX_BIO)

    # Profile picture and banner. Same rules as event covers: small base64
    # data URL, JPEG/PNG/WebP for everyone, GIF too for Community+/Admin.
    # Send "" to remove.
    allow_gif = user["role"] in GIF_ROLES

    if "avatarImage" in data:
        image, image_error = clean_image(data["avatarImage"], allow_gif)
        if image_error:
            return jsonify({"error": image_error}), 400
        updates["avatar_image"] = image

    if "bannerImage" in data:
        image, image_error = clean_image(data["bannerImage"], allow_gif)
        if image_error:
            return jsonify({"error": image_error}), 400
        updates["banner_image"] = image

    # Where within the image the focal point sits - lets a photo that's
    # wider or taller than its frame still show the part that matters,
    # instead of always cropping dead center.
    if "avatarPosition" in data:
        updates["avatar_position"] = clean_position(data["avatarPosition"])

    if "bannerPosition" in data:
        updates["banner_position"] = clean_position(data["bannerPosition"])

    # kept as the fallback/background behind a picture
    if "avatarColor" in data:
        if data["avatarColor"] not in AVATAR_COLORS:
            return jsonify({"error": "That isn't one of the avatar colors."}), 400
        updates["avatar_color"] = data["avatarColor"]

    # accent = the color that tints your whole profile (banner fallback,
    # stats, tabs). Any #rrggbb.
    if "accent" in data:
        if not isinstance(data["accent"], str) or not ACCENT_PATTERN.match(data["accent"]):
            return jsonify({"error": "Pick a valid accent color."}), 400
        updates["accent"] = data["accent"].lower()

    # appearance preferences - "system" follows the OS/browser, "light"/
    # "dark" pin it. Stored per-account so it's the same on every device,
    # not just the one you set it on.
    if "theme" in data:
        if data["theme"] not in VALID_THEMES:
            return jsonify({"error": "Invalid theme."}), 400
        updates["theme_preference"] = data["theme"]

    if "reduceMotion" in data:
        updates["reduce_motion"] = bool(data["reduceMotion"])

    plain_fields = {
        "pronouns": ("pronouns", MAX_PRONOUNS),
        "location": ("location", MAX_LOCATION),
        "statusEmoji": ("status_emoji", MAX_STATUS_EMOJI),
        "statusText": ("status_text", MAX_STATUS_TEXT),
        "nowSong": ("now_song", MAX_NOW_PLAYING),
        "nowArtist": ("now_artist", MAX_NOW_PLAYING),
    }
    for key, (field, limit) in plain_fields.items():
        if key in data:
            updates[field] = clean_text(data[key], limit)

    if "link" in data:
        link = clean_text(data["link"], MAX_LINK)
        if link and not LINK_PATTERN.match(link):
            return jsonify({"error": "Links need to start with http:// or https://"}), 400
        updates["link"] = link

    if "interests" in data:
        raw = data["interests"] if isinstance(data["interests"], list) else []
        cleaned = []
        for item in raw:
            tag = clean_text(item, MAX_INTEREST_LENGTH).lstrip("#").strip()
            if tag and tag.lower() not in [t.lower() for t in cleaned]:
                cleaned.append(tag)
            if len(cleaned) >= MAX_INTERESTS:
                break
        updates["interests"] = cleaned

    user.update(updates)
    return jsonify(user_public_info(user))


@app.route("/api/me", methods=["DELETE"])
def delete_me():
    """
    Self-service account deletion. Same cascade as an admin removing
    someone (admin_delete_event below) - your events go, along with
    everyone's copies of any Global posts you made and the comments on
    them, then your own comments and any now-orphaned replies to them -
    but with no role check, since deleting your own account is always
    allowed regardless of role. Ends the session on the way out.
    """
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    username = user["username"]
    users.remove(user)

    theirs = [e for e in events if e["owner"].lower() == username.lower()]
    events[:] = [e for e in events if e["owner"].lower() != username.lower()]
    for event in theirs:
        cascade_delete_event(event)

    comments[:] = [c for c in comments if c["author"].lower() != username.lower()]
    prune_orphan_replies()

    session.pop("username", None)
    return jsonify({"ok": True})


@app.route("/api/users", methods=["GET"])
def list_users():
    """
    The discovery directory: everyone on Planora, optionally narrowed by
    a text search (matches username or display name) and/or a single
    interest tag (exact match, case-insensitive). Powers directory.html,
    including the "click an interest chip on a profile" path, which
    links here with ?interest=<tag>.

    Distinct from GET /api/users/<username> below - that one is a single
    person's full profile (with their public events); this one is a
    flat, lightweight list for browsing.
    """
    viewer = get_logged_in_user()
    if not viewer:
        return jsonify({"error": "Not signed in."}), 401

    query = clean_text(request.args.get("q", ""), 40).lower()
    interest = clean_text(request.args.get("interest", ""), MAX_INTEREST_LENGTH).lower()

    results = []
    for user in users:
        if query and query not in user["username"].lower() and query not in user["display_name"].lower():
            continue
        if interest and interest not in [tag.lower() for tag in user.get("interests", [])]:
            continue
        results.append(user_public_info(user))
        if len(results) >= MAX_DIRECTORY_RESULTS:
            break

    return jsonify(results)


@app.route("/api/users/<username>", methods=["GET"])
def get_user_profile(username):
    """
    Someone's profile page data. Any signed-in user can open any profile.
    Everyone sees the profile fields and PUBLIC events. Only the owner
    also gets privateEvents back.
    """
    viewer = get_logged_in_user()
    if not viewer:
        return jsonify({"error": "Not signed in."}), 401

    target = find_user(username)
    if not target:
        return jsonify({"error": "User not found."}), 404

    is_self = target["username"].lower() == viewer["username"].lower()
    owned = [e for e in events if e["owner"].lower() == target["username"].lower()]

    public_events = sorted(
        [e for e in owned if e["visibility"] == "public"],
        key=lambda e: (e["date"], e.get("start_time", "")),
    )

    info = user_public_info(target)
    info["isSelf"] = is_self
    info["stats"] = {
        "events": len([e for e in owned if e.get("cloned_from") is None]),
        "publicEvents": len(public_events),
        "comments": len([c for c in comments if c["author"].lower() == target["username"].lower()]),
    }

    public_event_views = []
    for e in public_events:
        view = profile_event_view(e)
        # never true for your own profile - a public event already IS
        # your calendar event, there's no separate copy to "add"
        view["addedByMe"] = (not is_self) and any(
            other["owner"].lower() == viewer["username"].lower() and other.get("cloned_from") == e["id"]
            for other in events
        )
        public_event_views.append(view)
    info["publicEvents"] = public_event_views

    if is_self:
        private_events = sorted(
            # copies of Global posts you added are calendar bookkeeping,
            # not "your" private events
            [e for e in owned if e["visibility"] == "local" and e.get("cloned_from") is None],
            key=lambda e: (e["date"], e.get("start_time", "")),
        )
        info["privateEvents"] = [profile_event_view(e) for e in private_events]

    return jsonify(info)


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
        # your own calendar: private + public events. Your Global posts are
        # represented here by their own local copy, never the post itself
        matching_events = [
            e for e in events
            if e["owner"].lower() == username.lower() and e["visibility"] in CALENDAR_VISIBILITIES
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
        event_copy.setdefault("image_position", dict(DEFAULT_IMAGE_POSITION))
        event_copy.setdefault("edited", False)
        event_copy.setdefault("edited_at", None)
        event_copy["isMine"] = event["owner"].lower() == username.lower()

        # so the card can show the host's face instead of a bare day
        # number - falls back to their assigned color if they have no photo
        owner_user = find_user(event["owner"])
        event_copy["ownerAvatarColor"] = owner_user["avatar_color"] if owner_user else EVENT_COLORS[0]
        event_copy["ownerAvatarImage"] = owner_user.get("avatar_image", "") if owner_user else ""
        event_copy["ownerDisplayName"] = owner_user["display_name"] if owner_user else event["owner"]

        if mode == "global":
            adders = []
            viewer_has_copy = False
            for e in events:
                if e.get("cloned_from") != event["id"]:
                    continue
                if e["owner"].lower() == username.lower():
                    # the viewer's own copy - proves they already have it,
                    # whether or not they're also the one who posted it
                    viewer_has_copy = True
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
            event_copy["addedByMe"] = viewer_has_copy

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

    # "local" (alias "private"), "public" or "global". Anything else
    # falls back to private, the safest default.
    visibility = data.get("visibility")
    if visibility == "private":
        visibility = "local"
    if visibility not in ("local", "public", "global"):
        visibility = "local"

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

    image, image_error = clean_image(data.get("image", ""), user["role"] in GIF_ROLES)
    if image_error:
        return jsonify({"error": image_error}), 400

    image_position = clean_position(data.get("imagePosition"))

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
        # private and public both live on your calendar, so both use the cap
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
        "image_position": image_position,
        "cloned_from": None,
        "created_at": now_in_ms(),
        "edited": False,
        "edited_at": None,
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


@app.route("/api/events/<int:event_id>/visibility", methods=["PUT"])
def set_event_visibility(event_id):
    """
    Flip one of your own calendar events between Private and Public
    without re-creating it. Global posts aren't switchable here - Global
    is its own thing.
    """
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or event["owner"].lower() != user["username"].lower():
        return jsonify({"error": "Event not found."}), 404

    if event["visibility"] not in CALENDAR_VISIBILITIES:
        return jsonify({"error": "Global posts can't be switched to public or private."}), 400

    new_visibility = body().get("visibility")
    if new_visibility == "private":
        new_visibility = "local"
    if new_visibility not in CALENDAR_VISIBILITIES:
        return jsonify({"error": "Choose public or private."}), 400

    # a copy of somebody else's Global post keeps its link to that post,
    # so it stays private - it isn't yours to publish
    if event.get("cloned_from") is not None and new_visibility == "public":
        return jsonify({"error": "Events you added from Global can't be made public."}), 400

    event["visibility"] = new_visibility
    response = dict(event)
    response["isMine"] = True
    return jsonify(response)


@app.route("/api/events/<int:event_id>", methods=["PUT"])
def edit_event(event_id):
    """
    Edits the content of an event you own - title, description, date,
    time, image, icon, color. Visibility has its own endpoint above and
    isn't touched here.

    A copy you added from someone else's Global post isn't editable -
    it's not yours to rewrite, only the original poster's. If you DO own
    the Global post, the edit also updates everyone's calendar copy of
    it, so it doesn't just silently drift out of sync with what they
    added. Editing marks the event (and, for a Global post, its clones)
    as edited, same idea as an edited comment.
    """
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or event["owner"].lower() != user["username"].lower():
        return jsonify({"error": "Event not found."}), 404

    if event.get("cloned_from") is not None:
        return jsonify({"error": "You can't edit an event you added from Global - only the person who posted it can."}), 403

    data = body()

    title = clean_text(data.get("title", ""), MAX_TITLE)
    description = clean_text(data.get("description", ""), MAX_DESCRIPTION)
    date = data.get("date", "")

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

    color = data.get("color")
    if color not in EVENT_COLORS:
        color = event["color"]

    icon = data.get("icon")
    if icon not in EVENT_ICONS:
        icon = event["icon"]

    image, image_error = clean_image(data.get("image", ""), user["role"] in GIF_ROLES)
    if image_error:
        return jsonify({"error": image_error}), 400

    image_position = clean_position(data.get("imagePosition"))

    timezone = clean_timezone(data.get("timezone", "")) if start_time else ""

    edited_at = now_in_ms()
    changes = {
        "title": title,
        "description": description,
        "date": date,
        "end_date": end_date,
        "start_time": start_time,
        "end_time": end_time,
        "timezone": timezone,
        "color": color,
        "icon": icon,
        "image": image,
        "image_position": image_position,
        "edited": True,
        "edited_at": edited_at,
    }
    event.update(changes)

    # A Global post's clones mirror its content - an edit here should
    # show up on everyone's calendar copy of it too, not just the post
    # itself, or their copy would silently go stale.
    if event["visibility"] == "global":
        for clone in events:
            if clone.get("cloned_from") == event["id"]:
                clone.update(changes)

    response = dict(event)
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

    # Global posts AND public profile events are addable. Without this
    # check anyone could copy a stranger's PRIVATE event - title,
    # description, cover and all - just by guessing its id.
    if source_event["visibility"] not in ("global", "public"):
        return jsonify({"error": "That event isn't public."}), 403

    # Posting to Global already drops the owner a copy automatically, so
    # normally they'd hit the "already added" check right below like
    # anyone else who's added it. But if they later deleted that copy off
    # their calendar, they have nothing representing this post anymore -
    # they should be able to add it back the same way anyone else would,
    # not be told it's "already there" when it isn't.
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
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or not can_see_event(user, event):
        return jsonify({"error": "Event not found."}), 404

    matching_comments = [comment_view(c) for c in comments if c["event_id"] == event_id]
    return jsonify(matching_comments)


@app.route("/api/events/<int:event_id>/comments", methods=["POST"])
def add_comment(event_id):
    global next_comment_id

    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or not can_see_event(user, event):
        return jsonify({"error": "Event not found."}), 404

    data = body()
    text = clean_text(data.get("text", ""), MAX_COMMENT)

    if not text:
        return jsonify({"error": "Comment can't be empty."}), 400

    # Replies. Only one level deep: reply to a reply and it hangs off the
    # same top-level comment, with reply_to remembering who you answered.
    parent_id = None
    reply_to = None
    requested_parent = data.get("parentId")

    if requested_parent is not None:
        if not isinstance(requested_parent, int) or isinstance(requested_parent, bool):
            return jsonify({"error": "That comment can't be replied to."}), 400

        parent = next(
            (c for c in comments if c["id"] == requested_parent and c["event_id"] == event_id),
            None,
        )
        if not parent:
            return jsonify({"error": "The comment you're replying to is gone."}), 404

        parent_id = parent["parent_id"] if parent.get("parent_id") is not None else parent["id"]
        reply_to = parent["author"]

    new_comment = {
        "id": next_comment_id,
        "event_id": event_id,
        "author": user["username"],
        "text": text,
        "edited": False,
        "parent_id": parent_id,
        "reply_to": reply_to,
        "created_at": now_in_ms(),
    }
    next_comment_id += 1

    comments.append(new_comment)
    return jsonify(comment_view(new_comment))


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

    return jsonify(comment_view(comment))


@app.route("/api/events/<int:event_id>/comments/<int:comment_id>", methods=["DELETE"])
def delete_comment(event_id, comment_id):
    """
    The comment's own author can always delete it. The event's poster or
    an admin can also delete ANY comment on that event, same as event
    moderation elsewhere. Deleting a comment also deletes its replies.
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

    comments[:] = [
        c for c in comments
        if c["id"] != comment["id"] and c.get("parent_id") != comment["id"]
    ]
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

    public_count = len([
        e for e in events
        if e["owner"].lower() == username.lower() and e["visibility"] == "public"
    ])

    comment_count = len([
        c for c in comments if c["author"].lower() == username.lower()
    ])

    return jsonify({"events": event_count, "publicEvents": public_count, "comments": comment_count})


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
    prune_orphan_replies()

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
