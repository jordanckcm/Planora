"""
Planora backend

This is a simple Flask app. It does NOT use a real database.
Everything is just kept in normal Python lists while the server
is running. That means if you stop the server, everything you
made (accounts, events, comments) gets wiped and you start over.
That's fine for now, it's just for learning / testing.

How to run this:
    1. pip install -r requirements.txt      (needs flask and pywebpush)
    2. set SECRET_KEY, PLANORA_ADMIN_PASSWORD, VAPID_PRIVATE_KEY,
       VAPID_PUBLIC_KEY in your environment (see PUSH below for the keys)
    3. python app.py
    4. open http://127.0.0.1:5000 in your browser

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

MENTIONS + NOTIFICATIONS
    Typing @username in a comment, a reply, or a public/global event
    description is a mention. The server works out which usernames are
    real (comment["mentions"], and "mentions" on event views) so the
    frontend only links real people.
    Notifications are created for:
        mention - you were @mentioned
        reply   - someone replied to your comment
        comment - someone commented on your event
    One notification per person per comment (mention beats reply beats
    comment), never for your own actions, capped per person, and cleaned
    up automatically when the event/comment/person they point at is gone.
    A "message" type can be added later the same way.

PUSH NOTIFICATIONS (Web Push)
    Every in-app notification above can also arrive as a real push on
    the person's phone / desktop, and events with a start time send a
    reminder shortly before they begin.

    Keys: run `npx web-push generate-vapid-keys` once, then set
        VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT,
        e.g. "mailto:you@yourdomain.com") in the environment.

    How a push is decided (push_to_user):
        1. push is on for this person, and this kind (mention / reply /
           comment / reminder) is on
        2. not inside their quiet hours (reminders ignore quiet hours -
           they asked for those)
        3. under the hourly cap (reminders ignore the cap too)
        4. they have at least one subscribed device
    Sending happens on a background thread so a slow push service can
    never slow down or break a comment request.

    What a push says:
        mention   "Sam mentioned you in Movie Night"   + comment preview
        reply     "Sam replied to you in Movie Night"  + comment preview
        comment   "Sam commented on Movie Night"       + comment preview
        reminder  "🎉 Movie Night"  /  "Starts in 30 min · 19:00"
    Previews can be switched off per person ("Tap to open" instead).
    Pushes about the same event share a tag, so the service worker can
    collapse a burst into "3 new notifications in Movie Night".

    Per-person settings live in GET/PUT /api/push/preferences.
    Devices register with POST /api/push/subscribe. Subscriptions are
    checked so they can only point at real push services (otherwise the
    server could be tricked into calling arbitrary URLs).

FEED RANKING
    GET /api/feed orders Global + Public posts by how useful they are to the
    person looking, not just by when they were posted (see rank_feed):
        just posted (last 15 min)   always at the very top
        recently posted             fresher scores higher, fading over ~a day
        event happening soon        today / this week gets a big boost
        event already over          sinks, and drops off after two weeks
        popular                     comments and "going" count
        people you interact with    posts from people whose events you've
                                    commented on or added
        @mentions you               boosted
        already on your calendar    lowered a little
    A small spread rule stops one person's posts from clumping together.
    ?sort=latest gives plain newest-first; ?offset=&limit= page through it.

LIVE UPDATES
    Pages don't need a refresh to see new things. Whenever something changes
    (an event posted/edited/deleted, a comment, a profile, a notification) the
    server writes one line to a small change log. The browser asks
    GET /api/changes?since=<n> every few seconds and gets back only WHAT
    changed (ids and usernames, not the content), then re-fetches just that.
    Your own actions are not echoed back to you (your page already shows
    them). Private events never show up for people who can't see them. If the log
    has moved on too far (or the server restarted) the answer says
    "reset": true and the page should refresh everything once.
    The browser side lives in live.js.

PREFERENCES
    Each account also carries a couple of small client-preference
    fields - theme_preference ("system" | "light" | "dark") and
    reduce_motion (bool). These aren't used for anything server-side;
    they're just stored so a person's theme/motion choice follows them
    to a new device, the same way Discord's account-level settings do.

STARS (reactions)
    A lightweight "star" a person can put on any event they can see
    (their own included) — the like-equivalent for Planora. Kept as its
    own flat list, `stars`, of {event_id, username, created_at}. One
    star per person per event; posting again just removes it (toggle).
    star_count()/has_starred() read it; feed_item() and get_events() both
    report starCount/starredByMe so the frontend can show a filled vs.
    outlined star. Stars are cleaned up alongside an event (cascade_delete_event)
    or a person's account (delete_me / admin_delete_user), same as
    comments and notifications.
"""
from pywebpush import webpush, WebPushException
import json as json_lib
import re
import time
import os
import math
import base64
import threading
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, available_timezones

from flask import Flask, request, jsonify, session, Response, has_request_context, redirect, make_response
from itsdangerous import URLSafeTimedSerializer, BadSignature
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

# notifications / mentions
MAX_NOTIFICATIONS_PER_USER = 100
MAX_CHANGE_LOG = 500          # how many recent changes the server remembers
FEED_PAGE_SIZE = 20           # posts per feed request (images are big, keep it modest)
FEED_JUST_POSTED_MINUTES = 15 # a brand-new post always goes to the very top for this long
FEED_STALE_DAYS = 14          # an event this long over drops out of the feed...
FEED_STALE_AGE_HOURS = 72     # ...once the post itself is also older than this
MAX_MENTIONS_PER_TEXT = 5
NOTIFICATION_SNIPPET = 80
# "@name" that isn't glued to a word, "@" or "." - so emails (a@b.com) don't count
MENTION_PATTERN = re.compile(r"(?<![\w@.])@([A-Za-z0-9_.]{3,40})")

# ---- web push settings ----
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_CLAIMS = {"sub": os.environ.get("VAPID_SUBJECT", "mailto:admin@planora.app")}

# The page a tapped notification opens. "?post=<id>" (and "&comment=<id>")
# get added. Change this if your feed page has a different name.
POST_URL = "/homepage.html"

# A subscription's endpoint is a URL the SERVER will POST to, so it must be a
# real push service. Anything else is rejected (otherwise a signed-in user could
# make the server call any address they like).
PUSH_HOSTS = (
    "fcm.googleapis.com",             # Chrome / Edge / Android / Brave
    "push.services.mozilla.com",      # Firefox
    "push.apple.com",                 # Safari / iOS home-screen apps
    "notify.windows.com",             # legacy Edge
)
MAX_PUSH_ENDPOINT = 1000
MAX_PUSH_KEY = 200
MAX_DEVICES_PER_USER = 10             # phone + laptop + tablet + a few spares
MAX_PUSH_PER_HOUR = 30                # comment/mention/reply pushes per person
PUSH_TTL_SECONDS = 3600               # if their device is offline, drop it after an hour
PUSH_TIMEOUT_SECONDS = 10
REMINDER_LEADS = (10, 30, 60, 120)    # minutes before an event starts
REMINDER_CHECK_SECONDS = 30
MAX_PUSH_TITLE = 50                   # event titles get shortened in push headlines
AVATAR_LINK_MAX_AGE = 7 * 24 * 3600   # a push's profile-picture link stops working after a week

DEFAULT_PUSH_PREFS = {
    "enabled": True,        # master switch
    "mention": True,
    "reply": True,
    "comment": True,
    "previews": True,       # show comment text on the lock screen
    "reminders": True,      # "starts in 30 min" pushes
    "reminderLead": 30,     # minutes, one of REMINDER_LEADS
    "quietEnabled": False,  # mute mention/reply/comment pushes overnight
    "quietStart": "22:00",
    "quietEnd": "07:00",
    "timezone": "",         # needed for quiet hours (and reminders on events with no zone)
}
PUSH_BOOL_KEYS = ("enabled", "mention", "reply", "comment", "previews", "reminders", "quietEnabled")

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
friendships = []  # [{"id", "requester", "recipient", "status", "created_at"}]
next_friendship_id = 1
notifications = []
stars = []  # [{"event_id", "username", "created_at"}] - one per person per event
push_subscriptions = []  # [{"username", "subscription": {endpoint, keys}, "created_at"}, ...]
push_history = {}        # username (lowercase) -> [timestamps of recent pushes]
push_lock = threading.Lock()

next_event_id = 1
next_comment_id = 1
next_notification_id = 1

change_log = []          # [{"seq", "type", ...}] newest last - see LIVE UPDATES
next_change_seq = 1
change_lock = threading.Lock()

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


def shorten(text, limit):
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


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

def find_friendship(a, b):
    a, b = a.lower(), b.lower()
    for f in friendships:
        if {f["requester"].lower(), f["recipient"].lower()} == {a, b}:
            return f
    return None


def friendship_status(viewer_username, other_username):
    """From viewer's perspective: "self" | "friends" | "pending_outgoing" |
    "pending_incoming" | "none"."""
    if viewer_username.lower() == other_username.lower():
        return "self"
    f = find_friendship(viewer_username, other_username)
    if not f:
        return "none"
    if f["status"] == "accepted":
        return "friends"
    return "pending_outgoing" if f["requester"].lower() == viewer_username.lower() else "pending_incoming"


def are_friends(a, b):
    f = find_friendship(a, b)
    return bool(f and f["status"] == "accepted")


def drop_user_friendships(username):
    friendships[:] = [
        f for f in friendships
        if f["requester"].lower() != username.lower() and f["recipient"].lower() != username.lower()
    ]

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
    # Note: push preferences are deliberately NOT in here. This shape is
    # shown to other people (profiles, directory), and a person's push
    # settings and timezone are private. See GET /api/push/preferences.
    return {
        "username": user["username"],
        "displayName": user["display_name"],
        "bio": user["bio"],
        "avatarColor": user["avatar_color"],
        "avatarImage": user.get("avatar_image", ""),
        "avatarPosition": user.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION),
        "createdAt": user["created_at"],
        "role": user["role"],
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


def star_count(event_id):
    return len([s for s in stars if s["event_id"] == event_id])


def is_featured(event):
    """True if this event is currently pinned as Featured. featured_until
    is a millisecond timestamp (like created_at) - once it's in the past,
    the event just quietly stops being featured. Nothing needs to actively
    clear it."""
    until = event.get("featured_until")
    return bool(until and until > now_in_ms())


def has_starred(event_id, username):
    return any(
        s["event_id"] == event_id and s["username"].lower() == username.lower()
        for s in stars
    )


def going_count(event):
    """How many OTHER people have this post on their calendar - i.e. how many
    clones of it exist that aren't the poster's own auto-added copy."""
    return len([
        e for e in events
        if e.get("cloned_from") == event["id"] and e["owner"].lower() != event["owner"].lower()
    ])


def cascade_delete_event(deleted_event):
    """
    Removes the fallout of an already-removed event: if it was a Global
    post, everyone's local copies of it go too, along with the comments
    on the post and on those copies, and any stars on any of them.
    """
    removed_ids = {deleted_event["id"]}
    if deleted_event["visibility"] == "global":
        removed_ids |= {e["id"] for e in events if e.get("cloned_from") == deleted_event["id"]}
        events[:] = [e for e in events if e.get("cloned_from") != deleted_event["id"]]
    comments[:] = [c for c in comments if c["event_id"] not in removed_ids]
    stars[:] = [s for s in stars if s["event_id"] not in removed_ids]
    prune_notifications()
    log_change("event", event_id=deleted_event["id"])


def prune_orphan_replies():
    """If a comment vanished (its author's account was deleted, say), the
    replies hanging off it go with it."""
    alive = {c["id"] for c in comments}
    comments[:] = [c for c in comments if c.get("parent_id") is None or c["parent_id"] in alive]
    prune_notifications()


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


def extract_mentions(text):
    """Real usernames @-mentioned in text (canonical spelling, no dupes)."""
    found = []
    for match in MENTION_PATTERN.finditer(text or ""):
        raw = match.group(1)
        user = find_user(raw) or find_user(raw.rstrip("."))  # "@bob." at end of a sentence
        if user and user["username"] not in found:
            found.append(user["username"])
        if len(found) >= MAX_MENTIONS_PER_TEXT:
            break
    return found


# ---------------------------------------------------------------------------
# WEB PUSH
# ---------------------------------------------------------------------------

def get_push_prefs(user):
    """A person's push settings, with defaults filled in for anything unset."""
    prefs = dict(DEFAULT_PUSH_PREFS)
    prefs.update(user.get("push_prefs") or {})
    return prefs


def valid_clock(value):
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except (TypeError, ValueError):
        return False


def clean_push_prefs(data, current):
    """Returns (prefs, error). Only known keys are read; anything the request
    leaves out keeps its current value."""
    if not isinstance(data, dict):
        return None, "Invalid preferences."

    prefs = dict(current)

    for key in PUSH_BOOL_KEYS:
        if key in data:
            if not isinstance(data[key], bool):
                return None, "Invalid preferences."
            prefs[key] = data[key]

    if "reminderLead" in data:
        if data["reminderLead"] not in REMINDER_LEADS:
            return None, "Reminders can be 10, 30, 60 or 120 minutes before."
        prefs["reminderLead"] = data["reminderLead"]

    for key in ("quietStart", "quietEnd"):
        if key in data:
            value = clean_time(data[key])
            if not valid_clock(value):
                return None, "Quiet hours need a real time like 22:00."
            prefs[key] = value

    if "timezone" in data:
        zone = clean_timezone(data["timezone"])
        if data["timezone"] and not zone:
            return None, "That isn't a real time zone."
        prefs["timezone"] = zone

    return prefs, None


def in_quiet_hours(prefs):
    """True if it's currently inside the person's quiet window. Needs their
    time zone; without one, quiet hours can't be judged so nothing is muted."""
    if not prefs["quietEnabled"] or not prefs["timezone"]:
        return False
    try:
        now = datetime.now(ZoneInfo(prefs["timezone"])).strftime("%H:%M")
    except Exception:
        return False
    start, end = prefs["quietStart"], prefs["quietEnd"]
    if start == end:
        return False
    if start < end:
        return start <= now < end
    return now >= start or now < end   # window crosses midnight, e.g. 22:00-07:00


def push_allowed(username):
    """Hourly cap so a busy thread can't turn someone's phone into a buzzer.
    Counts the push if it's allowed."""
    now = time.time()
    key = username.lower()
    recent = [t for t in push_history.get(key, []) if now - t < 3600]
    if len(recent) >= MAX_PUSH_PER_HOUR:
        push_history[key] = recent
        return False
    recent.append(now)
    push_history[key] = recent
    return True


def clean_push_subscription(sub):
    """Returns a trimmed {endpoint, keys} or None. The endpoint is a URL this
    server will POST to, so only real HTTPS push services are accepted."""
    if not isinstance(sub, dict):
        return None

    endpoint = sub.get("endpoint")
    keys = sub.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > MAX_PUSH_ENDPOINT or not isinstance(keys, dict):
        return None

    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    for key in (p256dh, auth):
        if not isinstance(key, str) or not key or len(key) > MAX_PUSH_KEY:
            return None

    try:
        url = urlparse(endpoint)
        port = url.port
    except ValueError:
        return None

    host = (url.hostname or "").lower()
    if url.scheme != "https" or port not in (None, 443) or url.username or url.password:
        return None
    if not any(host == h or host.endswith("." + h) for h in PUSH_HOSTS):
        return None

    return {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}


# Signs the profile-picture links that go inside pushes. Picture data is far too
# big to fit in a push message (about 4 KB), so the push carries a link and the
# browser downloads the picture when it shows the notification.
_avatar_signer = URLSafeTimedSerializer(app.secret_key, salt="push-avatar")


def push_avatar_url(user):
    """A signed, expiring link to this person's profile picture, or "" if they
    don't have one. The link works without logging in (the browser fetches it on
    its own), but it can't be guessed and it only exists inside pushes sent to
    someone who was meant to see this person's name anyway."""
    if not user or not user.get("avatar_image"):
        return ""
    return "/push-avatar/" + _avatar_signer.dumps(user["username"])


def user_subscriptions(username):
    return [e for e in push_subscriptions if e["username"].lower() == username.lower()]


def remove_subscription(username, endpoint):
    with push_lock:
        push_subscriptions[:] = [
            e for e in push_subscriptions
            if not (e["username"].lower() == username.lower() and e["subscription"]["endpoint"] == endpoint)
        ]


def drop_user_push_data(username):
    """Account deleted: their devices stop receiving anything, and a future
    account that reuses the name doesn't inherit them."""
    with push_lock:
        push_subscriptions[:] = [e for e in push_subscriptions if e["username"].lower() != username.lower()]
    push_history.pop(username.lower(), None)


def _deliver(subs, payload):
    """Sends one payload to a list of subscriptions. Never raises. A device is
    only forgotten when the push service says it's gone for good (404/410);
    a temporary failure just gets logged and retried on the next push."""
    stats = {"sent": 0, "failed": 0, "removed": 0}

    for entry in subs:
        try:
            webpush(
                subscription_info=entry["subscription"],
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=dict(VAPID_CLAIMS),   # pywebpush edits this dict, so pass a copy
                ttl=PUSH_TTL_SECONDS,
                timeout=PUSH_TIMEOUT_SECONDS,
            )
            stats["sent"] += 1
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                with push_lock:
                    if entry in push_subscriptions:
                        push_subscriptions.remove(entry)
                stats["removed"] += 1
            else:
                stats["failed"] += 1
                print(f"[push] delivery failed for {entry['username']} (status {status}): {e}")
        except Exception as e:
            stats["failed"] += 1
            print(f"[push] unexpected error for {entry['username']}: {e}")

    return stats


def push_to_user(username, kind, title, snippet="", fallback_body="Tap to open",
                 url="/", tag="", event_id=None, event_title="", urgent=False,
                 actor="", event_icon="", actor_username=""):
    """
    Decides whether a push goes out and, if so, sends it in the background.
    kind: "mention" | "reply" | "comment" | "reminder"
    urgent: reminders skip quiet hours and the hourly cap.
    """
    if not VAPID_PRIVATE_KEY:
        return

    user = find_user(username)
    if not user:
        return

    prefs = get_push_prefs(user)
    if not prefs["enabled"]:
        return
    if kind == "reminder":
        if not prefs["reminders"]:
            return
    elif not prefs.get(kind, True):
        return

    if not urgent:
        if in_quiet_hours(prefs):
            return
        if not push_allowed(user["username"]):
            return

    subs = user_subscriptions(user["username"])
    if not subs:
        return

    # the previews setting hides other people's words; a reminder's
    # "Starts in 20 min" isn't private, so it always shows
    show_text = bool(snippet) and (prefs["previews"] or kind == "reminder")

    payload = json_lib.dumps({
        "title": title,
        "body": snippet if show_text else fallback_body,
        "preview": show_text,        # False -> the body is just "Tap to open"
        "actor": actor,              # who did it (display name), for grouped pushes
        "avatarUrl": push_avatar_url(find_user(actor_username)) if actor_username else "",
        "eventIcon": event_icon,     # the event's emoji, shown in front of the headline
        "url": url,
        "tag": tag,
        "kind": kind,
        "eventId": event_id,
        "eventTitle": event_title,
        "badge": unread_count(user),   # the app-icon badge number
        "ts": now_in_ms(),
    })
    threading.Thread(target=_deliver, args=(subs, payload), daemon=True).start()


# ---- event reminders ----

def humanize_minutes(minutes):
    minutes = max(1, int(round(minutes)))
    if minutes >= 60 and minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} hr"
    return f"{minutes} min"


def check_reminders():
    """Sends 'starts in N min' pushes for calendar events. Runs every
    REMINDER_CHECK_SECONDS. Each event is reminded once per start time (the
    marker resets by itself if the date or time is edited)."""
    now = datetime.now(ZoneInfo("UTC"))

    for event in list(events):
        if event["visibility"] not in CALENDAR_VISIBILITIES or not event.get("start_time"):
            continue

        owner = find_user(event["owner"])
        if not owner:
            continue

        prefs = get_push_prefs(owner)
        if not (prefs["enabled"] and prefs["reminders"]):
            continue

        # an event's own zone wins; otherwise fall back to the person's zone
        zone = event.get("timezone") or prefs["timezone"]
        if not zone:
            continue

        try:
            start = datetime.strptime(
                f'{event["date"]} {event["start_time"]}', "%Y-%m-%d %H:%M"
            ).replace(tzinfo=ZoneInfo(zone))
        except Exception:
            continue

        minutes_left = (start - now).total_seconds() / 60
        if not (0 < minutes_left <= prefs["reminderLead"]):
            continue

        marker = f'{event["date"]} {event["start_time"]} {zone}'
        if event.get("reminded_for") == marker:
            continue
        event["reminded_for"] = marker

        push_to_user(
            owner["username"], "reminder",
            title=f'{event.get("icon", "")} {shorten(event["title"], MAX_PUSH_TITLE)}'.strip(),
            snippet=f'Starts in {humanize_minutes(minutes_left)} · {event["start_time"]}',
            url=f'{POST_URL}?post={event["id"]}',
            tag=f'reminder-{event["id"]}',
            event_id=event["id"],
            event_title=event["title"],
            urgent=True,
        )


_scheduler_started = False


def start_reminder_scheduler():
    """One background thread, started once. Set DISABLE_REMINDERS=1 to turn it off."""
    global _scheduler_started
    if _scheduler_started or os.environ.get("DISABLE_REMINDERS"):
        return
    _scheduler_started = True

    def loop():
        while True:
            try:
                check_reminders()
            except Exception as e:
                print(f"[reminders] error: {e}")
            time.sleep(REMINDER_CHECK_SECONDS)

    threading.Thread(target=loop, daemon=True, name="planora-reminders").start()


# ---------------------------------------------------------------------------
# LIVE UPDATES
# ---------------------------------------------------------------------------

def log_change(kind, **fields):
    """Records that something changed so open pages can notice.
    kind: "event" | "comments" | "profile" | "notifications"."""
    global next_change_seq
    # remember WHO did it, so their own page isn't told about its own action
    by = session.get("username") if has_request_context() else None
    with change_lock:
        change_log.append({"seq": next_change_seq, "type": kind, "by": by, **fields})
        next_change_seq += 1
        if len(change_log) > MAX_CHANGE_LOG:
            del change_log[: len(change_log) - MAX_CHANGE_LOG]


# ---------------------------------------------------------------------------
# IN-APP NOTIFICATIONS (each one also fires a push)
# ---------------------------------------------------------------------------

PUSH_VERBS = {
    "mention": "mentioned you in",
    "reply": "replied to you in",
    "comment": "commented on",
}


def create_notification(recipient, actor, kind, event, comment=None, text=""):
    """kind: "mention" | "reply" | "comment". Never notifies you about yourself."""
    global next_notification_id
    if recipient.lower() == actor.lower():
        return

    notifications.append({
        "id": next_notification_id,
        "recipient": recipient,
        "actor": actor,
        "type": kind,
        "event_id": event["id"],
        "comment_id": comment["id"] if comment else None,
        "text": (comment["text"] if comment else text)[:NOTIFICATION_SNIPPET],
        "read": False,
        "created_at": now_in_ms(),
    })
    next_notification_id += 1
    log_change("notifications", recipient=recipient)

    # keep each person's inbox bounded - oldest fall off first
    mine = [n for n in notifications if n["recipient"].lower() == recipient.lower()]
    overflow = len(mine) - MAX_NOTIFICATIONS_PER_USER
    if overflow > 0:
        drop = {n["id"] for n in mine[:overflow]}
        notifications[:] = [n for n in notifications if n["id"] not in drop]

    # Also send a real push. Headline names WHO and WHERE, the body is a
    # short preview. The badge number in the payload is read AFTER the
    # notification above was added, so it already counts this one.
    actor_user = find_user(actor)
    actor_name = actor_user["display_name"] if actor_user else actor
    event_title = event.get("title", "")
    push_to_user(
        recipient, kind,
        title=f'{actor_name} {PUSH_VERBS.get(kind, "notified you about")} {shorten(event_title, MAX_PUSH_TITLE) or "a post"}',
        snippet=(comment["text"] if comment else text)[:120],
        url=f"{POST_URL}?post={event['id']}" + (f"&comment={comment['id']}" if comment else ""),
        tag=f"event-{event['id']}",
        event_id=event["id"],
        event_title=event_title,
        actor=actor_name,
        event_icon=event.get("icon", ""),
        actor_username=actor,
    )

def create_friend_notification(recipient, actor, kind):
    """kind: "friend_request" | "friend_accept". Not tied to an event."""
    global next_notification_id
    if recipient.lower() == actor.lower():
        return

    notifications.append({
        "id": next_notification_id,
        "recipient": recipient,
        "actor": actor,
        "type": kind,
        "event_id": None,
        "comment_id": None,
        "text": "",
        "read": False,
        "created_at": now_in_ms(),
    })
    next_notification_id += 1
    log_change("notifications", recipient=recipient)

    mine = [n for n in notifications if n["recipient"].lower() == recipient.lower()]
    overflow = len(mine) - MAX_NOTIFICATIONS_PER_USER
    if overflow > 0:
        drop = {n["id"] for n in mine[:overflow]}
        notifications[:] = [n for n in notifications if n["id"] not in drop]

    actor_user = find_user(actor)
    actor_name = actor_user["display_name"] if actor_user else actor
    verb = "sent you a friend request" if kind == "friend_request" else "accepted your friend request"
    push_to_user(
        recipient, kind,
        title=f"{actor_name} {verb}",
        snippet="",
        url=f"/profile.html?u={actor}",
        tag=f"friend-{actor.lower()}",
        actor=actor_name,
        actor_username=actor,
    )

def notify_comment(event, comment):
    """Event owner -> "comment", person replied to -> "reply", @mentioned ->
    "mention". One notification per person; the strongest type wins."""
    priority = {"comment": 1, "reply": 2, "mention": 3}
    targets = {}

    def want(username, kind):
        person = find_user(username)
        if not person or person["username"].lower() == comment["author"].lower():
            return
        if not can_see_event(person, event):  # don't leak private events via @mention
            return
        key = person["username"].lower()
        if key not in targets or priority[kind] > priority[targets[key][1]]:
            targets[key] = (person["username"], kind)

    want(event["owner"], "comment")
    if comment.get("reply_to"):
        want(comment["reply_to"], "reply")
    for name in comment.get("mentions", []):
        want(name, "mention")

    for username, kind in targets.values():
        create_notification(username, comment["author"], kind, event, comment)


def notify_event_mentions(event, actor, old_description=""):
    """@mentions in a public/global event's description. On an edit, only
    people who weren't already mentioned get pinged."""
    if event["visibility"] not in ("public", "global"):
        return
    already = {n.lower() for n in extract_mentions(old_description)}
    for name in extract_mentions(event["description"]):
        if name.lower() not in already:
            create_notification(name, actor, "mention", event, None, event["description"])


def prune_notifications():
    live_users = {u["username"].lower() for u in users}
    live_events = {e["id"] for e in events}
    live_comments = {c["id"] for c in comments}
    notifications[:] = [
        n for n in notifications
        if n["recipient"].lower() in live_users
        and n["actor"].lower() in live_users
        and (n["event_id"] is None or n["event_id"] in live_events)   # changed
        and (n["comment_id"] is None or n["comment_id"] in live_comments)
    ]


def unread_count(user):
    return len([
        n for n in notifications
        if n["recipient"].lower() == user["username"].lower() and not n["read"]
    ])


def notification_view(n):
    event = find_event(n["event_id"])
    return {
        "id": n["id"],
        "type": n["type"],
        "read": n["read"],
        "actor": n["actor"],
        "eventId": n["event_id"],
        "eventTitle": event["title"] if event else "",
        "commentId": n["comment_id"],
        "text": n["text"],
        "createdAt": n["created_at"],
    }


def profile_event_view(event):
    """The trimmed-down shape of an event shown on a profile page - enough
    to render it as a post (banner, caption, comments) if the viewer
    clicks into it, not just as a grid tile."""
    return {
        "id": event["id"],
        "owner": event["owner"],
        "title": event["title"],
        "description": event["description"],
        "mentions": extract_mentions(event["description"]),
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
        "featured": is_featured(event),
    }


def feed_item(e, me):
    """One event shaped for the feed / a single-post view."""
    owner = find_user(e["owner"])
    item = profile_event_view(e)
    item["ownerDisplayName"] = owner["display_name"] if owner else e["owner"]
    item["ownerAvatarColor"] = owner["avatar_color"] if owner else EVENT_COLORS[0]
    item["ownerAvatarImage"] = owner.get("avatar_image", "") if owner else ""
    item["ownerAvatarPosition"] = (owner.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION)) if owner else dict(DEFAULT_IMAGE_POSITION)
    item["isMine"] = e["owner"].lower() == me
    item["addedByMe"] = any(
        o["owner"].lower() == me and o.get("cloned_from") == e["id"] for o in events
    )
    item["commentCount"] = len([c for c in comments if c["event_id"] == e["id"]])
    item["starCount"] = star_count(e["id"])
    item["starredByMe"] = has_starred(e["id"], me)
    item["goingCount"] = going_count(e)
    return item


def comment_view(comment):
    """A comment plus enough about its author to draw a name, a face,
    and a link to their profile."""
    out = dict(comment)
    out.setdefault("parent_id", None)
    out.setdefault("reply_to", None)
    out.setdefault("mentions", [])
    author = find_user(comment["author"])
    out["authorDisplayName"] = author["display_name"] if author else comment["author"]
    out["authorAvatarColor"] = author["avatar_color"] if author else AVATAR_COLORS[0]
    out["authorAvatarImage"] = author.get("avatar_image", "") if author else ""
    out["authorAvatarPosition"] = (author.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION)) if author else dict(DEFAULT_IMAGE_POSITION)
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

def _days_until_event(event, today):
    """0 = happening today (or a multi-day event that's underway), positive =
    days until it starts, negative = days since it ended. None if the date is odd."""
    try:
        start = datetime.strptime(event["date"], "%Y-%m-%d").date()
        end = datetime.strptime(event.get("end_date") or event["date"], "%Y-%m-%d").date()
    except (KeyError, ValueError):
        return None
    if start <= today <= end:
        return 0
    if start > today:
        return (start - today).days
    return (end - today).days


def _feed_context(viewer):
    """The counts the ranking needs, worked out once per request."""
    me = viewer["username"].lower()
    by_id = {e["id"]: e for e in events}

    comment_counts = {}
    for c in comments:
        comment_counts[c["event_id"]] = comment_counts.get(c["event_id"], 0) + 1

    going = {}
    already_added = set()
    affinity = set()   # people whose events this viewer has engaged with
    for e in events:
        source = by_id.get(e.get("cloned_from"))
        if not source:
            continue
        if e["owner"].lower() != source["owner"].lower():
            going[source["id"]] = going.get(source["id"], 0) + 1
        if e["owner"].lower() == me:
            already_added.add(source["id"])
            if source["owner"].lower() != me:
                affinity.add(source["owner"].lower())

    for c in comments:
        if c["author"].lower() == me and c["event_id"] in by_id:
            owner = by_id[c["event_id"]]["owner"].lower()
            if owner != me:
                affinity.add(owner)

    # "today" in the viewer's own time zone when they've told us one
    zone = get_push_prefs(viewer).get("timezone") or "UTC"
    try:
        today = datetime.now(ZoneInfo(zone)).date()
    except Exception:
        today = datetime.now(ZoneInfo("UTC")).date()

    return {"me": me, "comments": comment_counts, "going": going,
            "added": already_added, "affinity": affinity, "today": today}


def feed_score(event, viewer, ctx):
    """Higher = nearer the top. Returns (score, why) where why is a short
    label for the strongest reason, for the UI to show if it wants to."""
    age_hours = max(0.0, (now_in_ms() - event.get("created_at", 0)) / 3600000)
    why = "Featured" if is_featured(event) else ""

    # 1. freshness: full marks when just posted, half every 18 hours
    score = 100 * 0.5 ** (age_hours / 18)
    if is_featured(event):
        score += 500
    if age_hours < 6 and not why:
        why = "New"

    # a post made this very moment always lands at the very top
    if age_hours * 60 < FEED_JUST_POSTED_MINUTES:
        score += 200
        why = "Just posted"

    # 2. when the event happens: soon is relevant, over is not
    days = _days_until_event(event, ctx["today"])
    if days is not None:
        if 0 <= days <= 14:
            score += 10 + 55 * (1 - days / 14)
            if days == 0 and not why:
                why = "Happening today"
            elif days <= 3 and not why:
                why = "Coming up soon"
        elif days > 14:
            score += 3
        else:
            score -= min(60, 20 + 5 * -days)

    # 3. popularity (log scale, so 40 comments isn't 40x better than 1)
    engagement = (12 * math.log2(1 + ctx["comments"].get(event["id"], 0))
                  + 10 * math.log2(1 + ctx["going"].get(event["id"], 0)))
    score += engagement
    if engagement >= 25 and not why:
        why = "Popular"

    # 4. people and relevance
    owner = event["owner"].lower()
    if owner == ctx["me"]:
        score += 10
    elif owner in ctx["affinity"]:
        score += 20
        if not why:
            why = "From someone you know"
    if viewer["username"] in extract_mentions(event.get("description", "")):
        score += 40
        why = "Mentions you"
    if event["id"] in ctx["added"]:
        score -= 25    # already on their calendar - less to act on

    return score, why


def rank_feed(viewer, posts):
    """Orders posts for this viewer. Returns [(event, why), ...]."""
    ctx = _feed_context(viewer)

    scored = []
    for e in posts:
        age_hours = (now_in_ms() - e.get("created_at", 0)) / 3600000
        days = _days_until_event(e, ctx["today"])
        # long over AND an old post: nothing left to do with it (yours excepted)
        if (days is not None and days < -FEED_STALE_DAYS
                and age_hours > FEED_STALE_AGE_HOURS and e["owner"].lower() != ctx["me"]):
            continue
        score, why = feed_score(e, viewer, ctx)
        scored.append([score, e, why])

    # highest first, ties go to the newer post
    scored.sort(key=lambda row: (row[0], row[1].get("created_at", 0), row[1]["id"]), reverse=True)

    # spread: if the last few picks were all one person, nudge their next post
    # down so the feed doesn't turn into one person's timeline
    ordered = []
    remaining = scored
    while remaining:
        recent_owners = [r[1]["owner"].lower() for r in ordered[-3:]]
        best = max(
            range(len(remaining)),
            key=lambda i: (
                remaining[i][0] - 20 * recent_owners.count(remaining[i][1]["owner"].lower()),
                remaining[i][1].get("created_at", 0),
            ),
        )
        ordered.append(remaining.pop(best))

    return [(row[1], row[2]) for row in ordered]


@app.route("/api/feed", methods=["GET"])
def get_feed():
    """The home feed. ?sort=latest for plain newest-first (default is the
    ranked "top" order), ?offset= and ?limit= to page through it."""
    viewer = get_logged_in_user()
    if not viewer:
        return jsonify({"error": "Not signed in."}), 401

    me = viewer["username"].lower()
    posts = [e for e in events if e["visibility"] in ("global", "public")]

    if request.args.get("sort") == "latest":
        posts.sort(key=lambda e: e.get("created_at", 0), reverse=True)
        ordered = [(e, "") for e in posts]
    else:
        ordered = rank_feed(viewer, posts)

    limit = min(max(request.args.get("limit", FEED_PAGE_SIZE, type=int), 1), FEED_PAGE_SIZE)
    offset = max(request.args.get("offset", 0, type=int), 0)

    result = []
    for event, why in ordered[offset:offset + limit]:
        item = feed_item(event, me)
        item["why"] = why
        result.append(item)
    return jsonify(result)

@app.route("/api/featured", methods=["GET"])
def get_featured():
    """Every currently-active Featured post, for the stories row at the
    top of the Home feed. No pagination - there should only ever be a
    handful of these at once, by nature of how featuring works."""
    viewer = get_logged_in_user()
    if not viewer:
        return jsonify({"error": "Not signed in."}), 401

    me = viewer["username"].lower()
    active = [
        e for e in events
        if e["visibility"] in ("global", "public") and is_featured(e)
    ]
    # most recently featured first
    active.sort(key=lambda e: e.get("featured_until", 0), reverse=True)

    return jsonify([feed_item(e, me) for e in active])

@app.route("/")
def serve_home_page():
    """
    The front door. index.html is the onboarding page, which only makes sense
    the first time someone sees Planora:
        signed in                     -> straight to the homepage
        seen onboarding before        -> straight to login
        brand-new visitor             -> onboarding (and we remember they saw it)
    Visit /?intro=1 any time to see the onboarding again.
    """
    if get_logged_in_user():
        return redirect("/homepage.html")

    if request.args.get("intro") is None and request.cookies.get("planora_seen_intro"):
        return redirect("/login.html")

    response = make_response(app.send_static_file("index.html"))
    response.set_cookie("planora_seen_intro", "1", max_age=365 * 24 * 3600, samesite="Lax")
    response.headers["Cache-Control"] = "no-cache"   # never let the browser skip this check
    return response


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
    log_change("profile", username=username)   # they now show up in the directory

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
    """The frontend should send {"pushEndpoint": "<this device's endpoint>"}
    so this browser stops receiving the signed-out person's notifications
    (PlanoraPush.logoutCleanup() in push.js does this for you)."""
    username = get_logged_in_username()
    endpoint = body().get("pushEndpoint")
    if username and isinstance(endpoint, str):
        remove_subscription(username, endpoint)

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
    log_change("profile", username=user["username"])
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
    stars[:] = [s for s in stars if s["username"].lower() != username.lower()]
    prune_orphan_replies()
    drop_user_push_data(username)
    drop_user_friendships(username)
    log_change("profile", username=username)
    log_change("comments", event_id=None)   # their comments vanished

    session.pop("username", None)
    return jsonify({"ok": True})


@app.route("/api/users", methods=["GET"])
def list_users():
    """
    The discovery directory: everyone on Planora, optionally narrowed by
    a text search (matches username or display name) and/or a single
    interest tag (exact match, case-insensitive). Powers directory.html,
    including the "click an interest chip on a profile" path, which
    links here with ?interest=<tag>. Also powers @mention autocomplete.

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
    info["friendStatus"] = friendship_status(viewer["username"], target["username"])
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

    global_events = sorted(
        [e for e in owned if e["visibility"] == "global"],
        key=lambda e: (e["date"], e.get("start_time", "")),
    )
    global_event_views = []
    for e in global_events:
        view = profile_event_view(e)
        view["addedByMe"] = (not is_self) and any(
            other["owner"].lower() == viewer["username"].lower() and other.get("cloned_from") == e["id"]
            for other in events
        )
        global_event_views.append(view)
    info["globalEvents"] = global_event_views

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
        event_copy.pop("reminded_for", None)   # internal bookkeeping for reminders
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
        event_copy["mentions"] = extract_mentions(event.get("description", ""))
        event_copy["isMine"] = event["owner"].lower() == username.lower()
        event_copy["starCount"] = star_count(event["id"])
        event_copy["starredByMe"] = has_starred(event["id"], username.lower())
        event_copy["featured"] = is_featured(event)

        # so the card can show the host's face instead of a bare day
        # number - falls back to their assigned color if they have no photo
        owner_user = find_user(event["owner"])
        event_copy["ownerAvatarColor"] = owner_user["avatar_color"] if owner_user else EVENT_COLORS[0]
        event_copy["ownerAvatarImage"] = owner_user.get("avatar_image", "") if owner_user else ""
        event_copy["ownerAvatarPosition"] = (owner_user.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION)) if owner_user else dict(DEFAULT_IMAGE_POSITION)
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


@app.route("/api/events/<int:event_id>", methods=["GET"])
def get_event(event_id):
    """A single event, if the viewer is allowed to see it. Notifications use
    this to open the post they point at."""
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or not can_see_event(user, event):
        return jsonify({"error": "Event not found."}), 404

    return jsonify(feed_item(event, user["username"].lower()))


@app.route("/api/events/<int:event_id>/star", methods=["POST"])
def toggle_star(event_id):
    """
    Toggles the signed-in person's star on this event: adds one if they
    hadn't starred it, removes it if they had. Works on any event the
    viewer can see (their own calendar events included), the same
    visibility rule as commenting. Returns the new state so the frontend
    doesn't need a follow-up fetch.
    """
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    event = find_event(event_id)
    if not event or not can_see_event(user, event):
        return jsonify({"error": "Event not found."}), 404

    username = user["username"]
    existing = next(
        (s for s in stars if s["event_id"] == event_id and s["username"].lower() == username.lower()),
        None,
    )

    if existing:
        stars.remove(existing)
        starred = False
    else:
        stars.append({"event_id": event_id, "username": username, "created_at": now_in_ms()})
        starred = True

    log_change("event", event_id=event_id)
    return jsonify({"starred": starred, "starCount": star_count(event_id)})


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
        "featured_until": None,
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

    log_change("event", event_id=new_event["id"])

    # ping anyone @mentioned in a public/global description
    notify_event_mentions(new_event, user["username"])

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
    log_change("event", event_id=event["id"])
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
    old_description = event["description"]
    event.update(changes)

    # A Global post's clones mirror its content - an edit here should
    # show up on everyone's calendar copy of it too, not just the post
    # itself, or their copy would silently go stale.
    if event["visibility"] == "global":
        for clone in events:
            if clone.get("cloned_from") == event["id"]:
                clone.update(changes)

    log_change("event", event_id=event["id"])

    # only people newly @mentioned in the description get pinged
    notify_event_mentions(event, user["username"], old_description)

    response = dict(event)
    response.pop("reminded_for", None)
    response["isMine"] = True
    response["mentions"] = extract_mentions(event["description"])
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
    log_change("event", event_id=event_id)   # the post's "added by" list changed
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
        "mentions": extract_mentions(text),
        "created_at": now_in_ms(),
    }
    next_comment_id += 1

    comments.append(new_comment)
    log_change("comments", event_id=event_id)
    notify_comment(event, new_comment)
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

    event = find_event(event_id)
    old_mentions = {m.lower() for m in comment.get("mentions", [])}

    comment["text"] = text
    comment["edited"] = True
    comment["mentions"] = extract_mentions(text)
    log_change("comments", event_id=event_id)

    # only people newly @mentioned by this edit get pinged
    if event:
        for name in comment["mentions"]:
            person = find_user(name)
            if name.lower() not in old_mentions and person and can_see_event(person, event):
                create_notification(person["username"], comment["author"], "mention", event, comment)

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
    prune_notifications()
    log_change("comments", event_id=event_id)
    return jsonify({"ok": True})


@app.route("/api/notifications", methods=["GET"])
def get_notifications():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    mine = [n for n in notifications if n["recipient"].lower() == user["username"].lower()]
    mine.sort(key=lambda n: n["id"], reverse=True)
    shown = mine[:50]

    # avatars can be ~1MB base64, so send each person once instead of per row
    actors = {}
    for n in shown:
        if n["actor"] in actors:
            continue
        actor = find_user(n["actor"])
        if actor:
            actors[n["actor"]] = {
                "displayName": actor["display_name"],
                "avatarColor": actor["avatar_color"],
                "avatarImage": actor.get("avatar_image", ""),
                "avatarPosition": actor.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION),
            }

    return jsonify({
        "notifications": [notification_view(n) for n in shown],
        "actors": actors,
        "unreadCount": len([n for n in mine if not n["read"]]),
    })


@app.route("/api/notifications/unread-count", methods=["GET"])
def get_unread_count():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401
    return jsonify({"unreadCount": unread_count(user)})


@app.route("/api/notifications/<int:notification_id>/read", methods=["POST"])
def read_notification(notification_id):
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    n = next((n for n in notifications
              if n["id"] == notification_id and n["recipient"].lower() == user["username"].lower()), None)
    if not n:
        return jsonify({"error": "Notification not found."}), 404

    n["read"] = True
    return jsonify({"ok": True, "unreadCount": unread_count(user)})


@app.route("/api/notifications/read-all", methods=["POST"])
def read_all_notifications():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    for n in notifications:
        if n["recipient"].lower() == user["username"].lower():
            n["read"] = True
    return jsonify({"ok": True, "unreadCount": 0})


@app.route("/api/notifications/<int:notification_id>", methods=["DELETE"])
def delete_notification(notification_id):
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    n = next((n for n in notifications
              if n["id"] == notification_id and n["recipient"].lower() == user["username"].lower()), None)
    if not n:
        return jsonify({"error": "Notification not found."}), 404

    notifications.remove(n)
    return jsonify({"ok": True, "unreadCount": unread_count(user)})


@app.route("/api/notifications", methods=["DELETE"])
def clear_notifications():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    notifications[:] = [n for n in notifications if n["recipient"].lower() != user["username"].lower()]
    return jsonify({"ok": True, "unreadCount": 0})


@app.route("/api/changes", methods=["GET"])
def get_changes():
    """
    What changed since the last time this page asked? Send ?since=<seq> (the
    "seq" from the previous answer); leave it off on the first call to just
    get the current position. Answer:
        seq            - send this back as ?since= next time
        reset          - true if the page missed too much (or the server
                         restarted) and should re-fetch everything once
        events         - event ids that changed (null = "something changed,
                         can't say which"); refresh feeds/calendars
        comments       - event ids whose comments changed (null = any)
        profiles       - usernames whose profile changed
        notifications  - true if this person got a new notification
        unread         - their current unread count, always included
    Comments on events the viewer can't see are left out.
    """
    viewer = get_logged_in_user()
    if not viewer:
        return jsonify({"error": "Not signed in."}), 401

    since = request.args.get("since", type=int)

    with change_lock:
        latest = next_change_seq - 1
        entries = list(change_log)

    result = {
        "seq": latest, "reset": False, "unread": unread_count(viewer),
        "events": [], "comments": [], "profiles": [], "notifications": False,
    }

    if since is not None:
        # ahead of the server (it restarted) or behind what it still remembers
        missed = since < latest and (not entries or entries[0]["seq"] > since + 1)
        if since > latest or since < 0 or missed:
            result["reset"] = True
        else:
            me = viewer["username"].lower()
            for entry in entries:
                if entry["seq"] <= since:
                    continue
                kind = entry["type"]

                # your own actions: the page you did them on already shows them
                if kind != "notifications" and (entry.get("by") or "").lower() == me:
                    continue

                if kind == "notifications":
                    if entry["recipient"].lower() == me:
                        result["notifications"] = True

                elif kind == "profile":
                    if entry["username"] not in result["profiles"]:
                        result["profiles"].append(entry["username"])

                elif kind in ("event", "comments"):
                    event_id = entry.get("event_id")
                    event = find_event(event_id) if event_id is not None else None
                    visible = event is None or can_see_event(viewer, event)
                    if kind == "comments" and not visible:
                        continue
                    key = "events" if kind == "event" else "comments"
                    value = event_id if visible else None   # never name an event they can't see
                    if value not in result[key]:
                        result[key].append(value)

    response = jsonify(result)
    response.headers["Cache-Control"] = "no-store"
    return response


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


# ---------------------------------------------------------------------------
# PUSH ROUTES
# ---------------------------------------------------------------------------

@app.route("/push-avatar/<token>", methods=["GET"])
def push_avatar(token):
    """The picture shown on a push notification. No login (the browser fetches
    it by itself), so access is controlled by the signed, expiring token."""
    try:
        username = _avatar_signer.loads(token, max_age=AVATAR_LINK_MAX_AGE)
    except BadSignature:   # also covers an expired token
        return "", 404

    user = find_user(username)
    match = re.match(r"^data:(image/[a-z]+);base64,(.+)$", (user or {}).get("avatar_image") or "")
    if not match:
        return "", 404

    try:
        raw = base64.b64decode(match.group(2))
    except ValueError:
        return "", 404

    response = Response(raw, mimetype=match.group(1))
    response.headers["Cache-Control"] = "private, max-age=3600"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/api/push/vapid-public-key", methods=["GET"])
def get_vapid_public_key():
    return jsonify({"key": VAPID_PUBLIC_KEY})


@app.route("/api/push/subscribe", methods=["POST"])
def push_subscribe():
    """Registers this browser/device for the signed-in person. Safe to call on
    every page load - the same endpoint just replaces its old entry."""
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    subscription = clean_push_subscription(body().get("subscription"))
    if not subscription:
        return jsonify({"error": "That doesn't look like a valid push subscription."}), 400

    with push_lock:
        # same device re-subscribing (or a device switching accounts)
        push_subscriptions[:] = [
            e for e in push_subscriptions if e["subscription"]["endpoint"] != subscription["endpoint"]
        ]
        push_subscriptions.append({
            "username": user["username"],
            "subscription": subscription,
            "created_at": now_in_ms(),
        })

        # keep the number of devices per person bounded - oldest fall off first
        mine = user_subscriptions(user["username"])
        overflow = len(mine) - MAX_DEVICES_PER_USER
        if overflow > 0:
            drop_ids = {id(e) for e in mine[:overflow]}
            push_subscriptions[:] = [e for e in push_subscriptions if id(e) not in drop_ids]

    return jsonify({"ok": True})


@app.route("/api/push/unsubscribe", methods=["POST"])
def push_unsubscribe():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    endpoint = body().get("endpoint")
    if isinstance(endpoint, str):
        remove_subscription(user["username"], endpoint)
    return jsonify({"ok": True})


def push_settings_response(user):
    return jsonify({
        "prefs": get_push_prefs(user),
        "devices": len(user_subscriptions(user["username"])),
        "configured": bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY),
        "reminderLeads": list(REMINDER_LEADS),
    })


@app.route("/api/push/preferences", methods=["GET"])
def get_push_preferences():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401
    return push_settings_response(user)


@app.route("/api/push/preferences", methods=["PUT"])
def update_push_preferences():
    """Send any subset of: enabled, mention, reply, comment, previews,
    reminders, reminderLead (10|30|60|120), quietEnabled, quietStart,
    quietEnd ("HH:MM"), timezone (IANA name)."""
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    prefs, error = clean_push_prefs(body(), get_push_prefs(user))
    if error:
        return jsonify({"error": error}), 400

    user["push_prefs"] = prefs
    return push_settings_response(user)


@app.route("/api/push/test", methods=["POST"])
def push_test():
    """Sends a test push to YOUR devices right now and reports what happened.
    Ignores your notification settings - it's for checking the setup works."""
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    if not VAPID_PRIVATE_KEY:
        return jsonify({"error": "Push isn't set up on the server (missing VAPID keys)."}), 503

    subs = user_subscriptions(user["username"])
    if not subs:
        return jsonify({"error": "No device is subscribed yet. Turn notifications on first."}), 400

    payload = json_lib.dumps({
        "title": "Planora notifications are on",
        "body": "This is what a notification looks like.",
        "url": "/",
        "tag": "test",
        "kind": "test",
        "eventId": None,
        "eventTitle": "",
        "badge": unread_count(user),
        "ts": now_in_ms(),
    })
    stats = _deliver(subs, payload)
    stats["devices"] = len(subs)
    return jsonify(stats)


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
    log_change("profile", username=target["username"])
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
    stars[:] = [s for s in stars if s["username"].lower() != username.lower()]
    prune_orphan_replies()
    drop_user_push_data(username)
    drop_user_friendships(username)
    log_change("profile", username=target["username"])
    log_change("comments", event_id=None)

    return jsonify({"ok": True})


@app.route("/api/admin/events", methods=["GET"])
@require_role("admin")
def admin_list_events(current_user):
    return jsonify(events)

@app.route("/api/friends", methods=["GET"])
def get_friends():
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    me = user["username"].lower()
    mine = [f for f in friendships if f["requester"].lower() == me or f["recipient"].lower() == me]

    def other_username(f):
        return f["recipient"] if f["requester"].lower() == me else f["requester"]

    def friend_view(username):
        person = find_user(username)
        if not person:
            return None
        return {
            "username": person["username"],
            "displayName": person["display_name"],
            "avatarColor": person["avatar_color"],
            "avatarImage": person.get("avatar_image", ""),
            "avatarPosition": person.get("avatar_position") or dict(DEFAULT_IMAGE_POSITION),
        }

    friends, incoming, outgoing = [], [], []
    for f in mine:
        view = friend_view(other_username(f))
        if not view:
            continue
        if f["status"] == "accepted":
            friends.append(view)
        elif f["requester"].lower() == me:
            outgoing.append(view)
        else:
            incoming.append(view)

    return jsonify({"friends": friends, "incoming": incoming, "outgoing": outgoing})


@app.route("/api/friends/request/<username>", methods=["POST"])
def send_friend_request(username):
    global next_friendship_id
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    target = find_user(username)
    if not target:
        return jsonify({"error": "User not found."}), 404
    if target["username"].lower() == user["username"].lower():
        return jsonify({"error": "You can't friend yourself."}), 400

    existing = find_friendship(user["username"], target["username"])
    if existing:
        if existing["status"] == "accepted":
            return jsonify({"error": "You're already friends."}), 400
        if existing["requester"].lower() == target["username"].lower():
            # they'd already sent one — accept it instead of duplicating
            existing["status"] = "accepted"
            create_friend_notification(target["username"], user["username"], "friend_accept")
            return jsonify({"ok": True, "status": "friends"})
        return jsonify({"error": "Friend request already sent."}), 400

    friendships.append({
        "id": next_friendship_id,
        "requester": user["username"],
        "recipient": target["username"],
        "status": "pending",
        "created_at": now_in_ms(),
    })
    next_friendship_id += 1

    create_friend_notification(target["username"], user["username"], "friend_request")
    return jsonify({"ok": True, "status": "pending_outgoing"})


@app.route("/api/friends/accept/<username>", methods=["POST"])
def accept_friend_request(username):
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    f = find_friendship(user["username"], username)
    if not f or f["status"] != "pending" or f["recipient"].lower() != user["username"].lower():
        return jsonify({"error": "No pending request from that person."}), 404

    f["status"] = "accepted"
    create_friend_notification(f["requester"], user["username"], "friend_accept")
    return jsonify({"ok": True, "status": "friends"})


@app.route("/api/friends/<username>", methods=["DELETE"])
def remove_friendship(username):
    """Covers declining a request you got, canceling one you sent, and
    unfriending someone — same endpoint, whichever state it's in."""
    user = get_logged_in_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401

    f = find_friendship(user["username"], username)
    if not f:
        return jsonify({"error": "Not friends with that person."}), 404

    friendships.remove(f)
    return jsonify({"ok": True, "status": "none"})

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

@app.route("/api/admin/events/<int:event_id>/feature", methods=["PUT"])
@require_role("admin")
def admin_feature_event(current_user, event_id):
    """
    Pins (or unpins) an event as Featured. Send {"hours": 24} to feature
    it for 24 hours from now, or {"hours": null} (or omit "hours"
    entirely) to unfeature it immediately. Only Public/Global events make
    sense to feature - a Private event has no feed presence to boost -
    but this doesn't hard-block Private just in case an admin wants to
    feature something right after flipping its visibility; the frontend
    is expected to only ever offer this on Public/Global posts.
    """
    event = find_event(event_id)
    if not event:
        return jsonify({"error": "Event not found."}), 404

    hours = body().get("hours")

    if hours is None:
        event["featured_until"] = None
    else:
        if not isinstance(hours, (int, float)) or isinstance(hours, bool) or hours <= 0 or hours > 720:
            return jsonify({"error": "Pick a number of hours between 1 and 720 (30 days)."}), 400
        event["featured_until"] = now_in_ms() + int(hours * 3600000)

    log_change("event", event_id=event["id"])
    return jsonify({"ok": True, "featured": is_featured(event), "featuredUntil": event["featured_until"]})


# starts the "event starts soon" reminder checker (also when run by gunicorn)
start_reminder_scheduler()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    app.run(
        host="0.0.0.0",
        port=port
    )
