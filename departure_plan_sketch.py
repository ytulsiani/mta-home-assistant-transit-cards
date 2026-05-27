# Add this to your FastAPI app (main.py or a separate router)
#
# Required env vars:
#   GOOGLE_CALENDAR_CREDENTIALS_FILE  path to OAuth2 credentials JSON
#   GOOGLE_CALENDAR_TOKEN_FILE        path to stored token JSON (created after first auth)
#   GOOGLE_MAPS_API_KEY               Maps Directions API key
#   HOME_ADDRESS                      e.g. "301 E 86th St, New York, NY"
#
# Python deps to add:
#   google-api-python-client
#   google-auth-httplib2
#   google-auth-oauthlib
#   httpx  (already in your stack)

import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
MAPS_API_KEY  = os.environ["GOOGLE_MAPS_API_KEY"]
HOME_ADDRESS  = os.environ["HOME_ADDRESS"]
CREDS_FILE    = os.environ.get("GOOGLE_CALENDAR_CREDENTIALS_FILE", "credentials.json")
TOKEN_FILE    = os.environ.get("GOOGLE_CALENDAR_TOKEN_FILE", "token.json")


# ── Google Calendar ───────────────────────────────────────────────────────────

def _get_gcal_creds() -> Credentials:
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return creds


def _next_event_with_location() -> Optional[dict]:
    """Return the next upcoming calendar event that has a non-empty location."""
    creds   = _get_gcal_creds()
    service = build("calendar", "v3", credentials=creds)
    now_iso = datetime.now(timezone.utc).isoformat()

    result = service.events().list(
        calendarId="primary",
        timeMin=now_iso,
        maxResults=10,
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    for event in result.get("items", []):
        location = event.get("location", "").strip()
        if not location:
            continue

        start = event["start"].get("dateTime") or event["start"].get("date")
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))

        return {
            "title":      event.get("summary", "Untitled event"),
            "start_time": int(start_dt.timestamp()),
            "location":   location,
        }

    return None


# ── Google Maps Directions (transit) ─────────────────────────────────────────

async def _get_transit_plan(destination: str, arrival_by_epoch: int) -> Optional[dict]:
    """
    Call the Google Maps Directions API in transit mode.
    Returns a structured plan dict, or None if no route found.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://maps.googleapis.com/maps/api/directions/json",
            params={
                "origin":        HOME_ADDRESS,
                "destination":   destination,
                "mode":          "transit",
                "arrival_time":  arrival_by_epoch,
                "key":           MAPS_API_KEY,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

    routes = data.get("routes", [])
    if not routes:
        return None

    leg = routes[0]["legs"][0]  # single leg (no waypoints)

    departure_epoch = leg["departure_time"]["value"]
    total_minutes   = round(leg["duration"]["value"] / 60)

    steps = []
    for s in leg["steps"]:
        mode = s["travel_mode"]

        if mode == "WALKING":
            steps.append({
                "type":        "walk",
                "minutes":     round(s["duration"]["value"] / 60),
                "instruction": _strip_html(s.get("html_instructions", "Walk")),
            })

        elif mode == "TRANSIT":
            td   = s["transit_details"]
            line = td["line"]
            steps.append({
                "type":           "transit",
                "line":           line.get("short_name") or line.get("name", "?"),
                "headsign":       td.get("headsign"),
                "from_stop":      td["departure_stop"]["name"],
                "to_stop":        td["arrival_stop"]["name"],
                "minutes":        round(s["duration"]["value"] / 60),
                "departure_time": td["departure_time"]["value"],
            })

    return {
        "leave_by":      departure_epoch,
        "total_minutes": total_minutes,
        "steps":         steps,
    }


def _strip_html(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", html).strip()


# ── FastAPI endpoint ──────────────────────────────────────────────────────────
# Add this to your app in main.py:

from fastapi import HTTPException  # already imported in your main.py

# @app.get("/departure-plan")
async def get_departure_plan():
    event = _next_event_with_location()
    if not event:
        raise HTTPException(status_code=404, detail="No upcoming events with a location")

    plan = await _get_transit_plan(
        destination=event["location"],
        arrival_by_epoch=event["start_time"],
    )
    if not plan:
        raise HTTPException(status_code=404, detail="No transit route found")

    return {"event": event, "plan": plan}
