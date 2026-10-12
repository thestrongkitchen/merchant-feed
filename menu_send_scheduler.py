"""Schedule this week's Wednesday "Last call" or Thursday menu email in Klaviyo, the morning of the send.

Why: a campaign scheduled days ahead kept the audience it had on the day it was scheduled, so
customers who came off the 6-day new-customer hold in between never got it (found 2026-10-07).
Scheduling the same morning keeps the audience current.

Scope (authorized by Luke 2026-10-07): these two weekly campaigns ONLY. The script copies last
week's campaign (same template, subject, sender), sets the fixed audience below and today's send
time, and schedules it. It never writes new content and never touches any other campaign.

Dry run is the default. --go makes the changes. Exits non-zero when something needs a human,
which makes GitHub email the account owner.

    python menu_send_scheduler.py                # dry run, decides Wed/Thu from today's date
    python menu_send_scheduler.py --day thu      # dry run as if it were Thursday
    python menu_send_scheduler.py --go
    python menu_send_scheduler.py --go --wait 10 # wait up to 10 min for a just-rebuilt feed to publish

Never sends an out-of-date menu: the live web feed must show the right ordering deadline (today for
Wednesday, next Wednesday for Thursday) before anything is scheduled. Added 2026-10-12 after the 10/8
Thursday email went out with the previous week's menu because the feed had not rebuilt yet.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
API = "https://a.klaviyo.com/api"
REVISION = "2024-10-15"
FEED = "https://thestrongkitchen.github.io/merchant-feed/products.json"   # Klaviyo web feed TSK_MENU reads this

LISTS = ["TnEuwQ", "Upt57m"]                  # Account Created, Newsletter
EXCLUDE_ALWAYS = ["U9cFGd",                   # first order in the last 6 days (welcome emails only)
                  "Vj59k9",                   # bot registrations
                  "X9grHS"]                   # not engaged 30 days
FIRST_MONTH = "Y6NRej"                        # 1-4 orders, ordered in last 35 days: skip Thursday only

SENDS = {
    "wed": {"name": "Weekly Menu Send - Wednesday", "hour": 9, "minute": 0, "cutoff_hour": 14,
            "excluded": EXCLUDE_ALWAYS},
    "thu": {"name": "Weekly Menu Send - Thursday", "hour": 12, "minute": 0, "cutoff_hour": 15,
            "excluded": EXCLUDE_ALWAYS + [FIRST_MONTH]},
}


def call(method, path, body=None, params=None):
    key = os.environ.get("KLAVIYO_API_KEY")
    if not key:
        sys.exit("KLAVIYO_API_KEY is not set")
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(5):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Klaviyo-API-Key " + key, "revision": REVISION,
            "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(2 ** attempt + 1)
                continue
            sys.exit("Klaviyo %s %s failed: %s %s" % (method, path, e.code, e.read()[:500].decode(errors="replace")))
    sys.exit("Klaviyo %s %s failed after retries" % (method, path))


def feed_deadline():
    """The ordering deadline the live web feed shows, as a date (None if unreadable)."""
    try:
        with urllib.request.urlopen(FEED + "?t=%d" % time.time(), timeout=30) as r:
            d = json.loads(r.read())
        if not d.get("meals"):
            return None
        m = re.search(r"([A-Za-z]+) (\d+)", d.get("deadline", "").split(",", 1)[-1])
        today = datetime.now(ET).date()
        dl = datetime.strptime("%s %s %d" % (m.group(1), m.group(2), today.year), "%B %d %Y").date()
        if (dl - today).days < -180:      # deadline in early January, read in late December
            dl = dl.replace(year=today.year + 1)
        return dl
    except Exception as e:
        print("Could not read the web feed: %s" % e)
        return None


def feed_is_current(day, today, wait_minutes):
    """Wednesday's email needs today's deadline; Thursday's needs next Wednesday's (the new menu).
    Polls for a few minutes because a feed rebuilt earlier in this run takes a minute or two to publish."""
    want = today if day == "wed" else today + timedelta(days=6)
    stop = time.time() + wait_minutes * 60
    while True:
        got = feed_deadline()
        if got == want:
            print("Web feed is current: deadline %s." % got.strftime("%a %m/%d"))
            return True
        if time.time() >= stop:
            print("Web feed is NOT current: shows deadline %s, this email needs %s." %
                  (got.strftime("%a %m/%d") if got else "nothing", want.strftime("%a %m/%d")))
            return False
        time.sleep(30)


def campaigns_named(prefix):
    out, params = [], {"filter": "and(equals(messages.channel,'email'),contains(name,'%s'))" % prefix,
                       "sort": "-created_at"}
    d = call("GET", "/campaigns", params=params)
    out += d.get("data", [])
    return out


def send_dt(c):
    s = (c["attributes"].get("send_strategy") or {}).get("options_static") or {}
    t = s.get("datetime") or c["attributes"].get("send_time")
    return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(ET) if t else None


def main():
    go = "--go" in sys.argv
    wait = int(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 0
    now = datetime.now(ET)
    day = sys.argv[sys.argv.index("--day") + 1] if "--day" in sys.argv else {2: "wed", 3: "thu"}.get(now.weekday())
    if day not in SENDS:
        print("Not a menu-email day (%s). Nothing to do." % now.strftime("%A"))
        return
    cfg = SENDS[day]
    today = now.date() if "--day" not in sys.argv else now.date() + timedelta(days=({"wed": 2, "thu": 3}[day] - now.weekday()) % 7)
    when = datetime(today.year, today.month, today.day, cfg["hour"], cfg["minute"], tzinfo=ET)
    cutoff = datetime(today.year, today.month, today.day, cfg["cutoff_hour"], 0, tzinfo=ET)
    print("%s | %s send %s ET | %s" % (now.strftime("%a %m/%d %H:%M"), cfg["name"], when.strftime("%a %m/%d %H:%M"),
                                       "LIVE" if go else "DRY RUN"))

    found = campaigns_named(cfg["name"])
    todays = [c for c in found if send_dt(c) and send_dt(c).date() == today
              and c["attributes"]["status"] not in ("Draft", "Cancelled")]
    for c in todays:
        a = c["attributes"]
        sched = a.get("scheduled_at")
        sched_day = datetime.fromisoformat(sched.replace("Z", "+00:00")).astimezone(ET).date() if sched else None
        if a["status"] in ("Sent", "Sending", "Adding Recipients", "Preparing to send") or sched_day == today:
            print("Already handled today: '%s' (%s, scheduled %s). Nothing to do." % (a["name"], a["status"], sched_day))
            if a["status"] == "Scheduled" and not feed_is_current(day, today, 0):
                sys.exit("'%s' is scheduled but the menu feed is out of date. Needs a human." % a["name"])
            return
        # Scheduled on an earlier day: its audience is stale. Put it back to draft and reschedule it below.
        if not menu_ready(day, today, when, now, wait):
            return
        if now >= cutoff or now >= when - timedelta(minutes=15):
            print("'%s' was scheduled early, but it is too close to send time to redo safely. Leaving it." % a["name"])
            return
        print("'%s' was scheduled on %s, before today. Its audience is stale; rescheduling it this morning." % (a["name"], sched_day))
        if go:
            call("PATCH", "/campaign-send-jobs/%s" % c["id"],
                 {"data": {"type": "campaign-send-job", "id": c["id"], "attributes": {"action": "revert"}}})
        return schedule(c["id"], a["name"], cfg, when, cutoff, now, go)

    if now >= cutoff:
        sys.exit("It is past %s ET and no %s is scheduled for today. Needs a human." % (cutoff.strftime("%H:%M"), cfg["name"]))
    if not menu_ready(day, today, when, now, wait):
        return
    sent = [c for c in found if c["attributes"]["status"] == "Sent"]
    if not sent:
        sys.exit("No previously sent '%s' campaign to copy. Needs a human." % cfg["name"])
    src = sent[0]
    new_name = "%s (Merchant Feed) %s auto" % (cfg["name"], f"{today.month}/{today.day}")
    print("Copying last week's '%s' (sent %s) as '%s'" % (src["attributes"]["name"], send_dt(src).strftime("%m/%d"), new_name))
    if not go:
        return schedule(None, new_name, cfg, when, cutoff, now, go)
    d = call("POST", "/campaign-clone", {"data": {"type": "campaign", "id": src["id"], "attributes": {"new_name": new_name}}})
    return schedule(d["data"]["id"], new_name, cfg, when, cutoff, now, go)


def menu_ready(day, today, when, now, wait):
    """Never send an out-of-date menu. If the feed is stale, stand down and let a later run retry;
    within an hour of send time, stop and ask for a human instead."""
    if feed_is_current(day, today, wait):
        return True
    if now >= when - timedelta(hours=1):
        sys.exit("The menu feed is still out of date close to send time. NOT sending. Needs a human.")
    print("Not scheduling yet; the next run will check the feed again.")
    return False


def schedule(cid, name, cfg, when, cutoff, now, go):
    if now >= cutoff:
        sys.exit("It is past %s ET; too late to send '%s' today. Needs a human." % (cutoff.strftime("%H:%M"), name))
    if now >= when - timedelta(minutes=5):
        when = now + timedelta(minutes=20)    # leaves time for Klaviyo's 15-minute feed cache
        print("Running late; sending at %s ET instead." % when.strftime("%H:%M"))
    attrs = {
        "audiences": {"included": LISTS, "excluded": cfg["excluded"]},
        "send_strategy": {"method": "static", "options_static": {"datetime": when.astimezone(ZoneInfo("UTC")).isoformat(),
                                                                 "is_local": False}},
        "send_options": {"use_smart_sending": False},
    }
    print("Audience: lists %s, excluding %s" % (LISTS, cfg["excluded"]))
    print("Send time: %s ET" % when.strftime("%a %m/%d %H:%M"))
    if not go:
        print("DRY RUN: nothing changed in Klaviyo.")
        return
    call("PATCH", "/campaigns/%s" % cid, {"data": {"type": "campaign", "id": cid, "attributes": attrs}})
    call("POST", "/campaign-send-jobs", {"data": {"type": "campaign-send-job", "id": cid}})
    a = call("GET", "/campaigns/%s" % cid)["data"]["attributes"]
    print("Scheduled '%s': status %s, send %s" % (a["name"], a["status"],
                                                   (a.get("send_strategy") or {}).get("options_static", {}).get("datetime")))
    if a["status"] not in ("Scheduled", "Sending", "Adding Recipients", "Preparing to send", "Sent"):
        sys.exit("Campaign did not end up scheduled. Needs a human.")


if __name__ == "__main__":
    main()
