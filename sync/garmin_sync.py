"""Legge i dati Garmin degli ultimi DAYS giorni e li scrive su Supabase (upsert)."""
import datetime as dt
import json
import os
import pathlib
import sys
from zoneinfo import ZoneInfo

import requests
from garminconnect import Garmin

TZ = ZoneInfo("Europe/Rome")
DAYS = int(os.environ.get("DAYS", "3"))
SUPA_URL = os.environ["SUPABASE_URL"].strip().rstrip("/")
if not SUPA_URL.startswith("http"):
    SUPA_URL = "https://" + SUPA_URL
SUPA_KEY = os.environ["SUPABASE_SECRET_KEY"].strip()


# ---------- utilità ----------

def as_plain(obj):
    """Converte i modelli tipizzati della libreria (versioni recenti) in dict/list semplici."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {k: as_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [as_plain(v) for v in obj]
    if hasattr(obj, "model_dump"):
        return as_plain(obj.model_dump(by_alias=True))
    if hasattr(obj, "__dict__"):
        return as_plain(vars(obj))
    return str(obj)


def pick(data, *paths):
    """Primo valore non nullo tra più percorsi possibili (camelCase o snake_case)."""
    for path in paths:
        cur = data
        for key in path.split("."):
            if isinstance(cur, dict) and cur.get(key) is not None:
                cur = cur[key]
            else:
                cur = None
                break
        if cur is not None:
            return cur
    return None


def to_int(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def to_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def first_value(d):
    """Garmin annida alcuni dati per deviceId: prende il primo dispositivo."""
    if isinstance(d, dict) and d:
        return next(iter(d.values()))
    return None


def ms_to_iso(v):
    try:
        return dt.datetime.fromtimestamp(float(v) / 1000, tz=dt.timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def safe(call, *args):
    try:
        return as_plain(call(*args))
    except Exception as exc:  # un singolo endpoint non deve bloccare tutto
        print(f"  avviso: {call.__name__}{args} -> {exc}")
        return None


def upsert(table, rows, conflict):
    if not rows:
        return
    headers = {
        "apikey": SUPA_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    if SUPA_KEY.startswith("eyJ"):  # chiave legacy service_role (JWT)
        headers["Authorization"] = f"Bearer {SUPA_KEY}"
    r = requests.post(f"{SUPA_URL}/rest/v1/{table}?on_conflict={conflict}",
                      headers=headers, data=json.dumps(rows, default=str), timeout=60)
    if r.status_code >= 300:
        sys.exit(f"Errore Supabase su {table}: {r.status_code} {r.text}")
    print(f"{table}: {len(rows)} righe salvate")


# ---------- login ----------

def login():
    store = pathlib.Path("~/.garminconnect").expanduser()
    store.mkdir(parents=True, exist_ok=True)
    for name, content in json.loads(os.environ["GARMIN_TOKENS"]).items():
        (store / name).write_text(content)
    garmin = Garmin()
    garmin.login(str(store))
    return garmin


# ---------- estrazione ----------

def sleep_levels(sleep):
    """Fasi del sonno minuto per minuto (Garmin: 0 profondo, 1 leggero, 2 REM, 3 sveglio)."""
    items = pick(sleep, "sleepLevels", "sleep_levels") or []
    out = []
    for it in items if isinstance(items, list) else []:
        s, e, lv = pick(it, "startGMT", "start_gmt"), pick(it, "endGMT", "end_gmt"), pick(it, "activityLevel", "activity_level")
        if s and e and lv is not None:
            out.append({"s": str(s), "e": str(e), "l": to_int(lv)})
    return out or None


def daily_row(garmin, day):
    ds = day.isoformat()
    stats = safe(garmin.get_stats, ds) or {}
    sleep = safe(garmin.get_sleep_data, ds) or {}
    hrv = safe(garmin.get_hrv_data, ds) or {}
    readiness = safe(garmin.get_training_readiness, ds)
    if isinstance(readiness, list):
        readiness = readiness[0] if readiness else {}
    readiness = readiness or {}

    s = pick(sleep, "dailySleepDTO", "daily_sleep_dto") or {}
    h = pick(hrv, "hrvSummary", "hrv_summary") or {}

    return {
        "day": ds,
        "hrv_night": to_num(pick(h, "lastNightAvg", "last_night_avg")),
        "hrv_weekly": to_num(pick(h, "weeklyAvg", "weekly_avg")),
        "hrv_status": pick(h, "status"),
        "resting_hr": to_num(pick(stats, "restingHeartRate", "resting_heart_rate")
                             or pick(sleep, "restingHeartRate", "resting_heart_rate")),
        "sleep_seconds": to_int(pick(s, "sleepTimeSeconds", "sleep_time_seconds")),
        "deep_seconds": to_int(pick(s, "deepSleepSeconds", "deep_sleep_seconds")),
        "light_seconds": to_int(pick(s, "lightSleepSeconds", "light_sleep_seconds")),
        "rem_seconds": to_int(pick(s, "remSleepSeconds", "rem_sleep_seconds")),
        "awake_seconds": to_int(pick(s, "awakeSleepSeconds", "awake_sleep_seconds")),
        "sleep_score": to_int(pick(s, "sleepScores.overall.value", "sleep_scores.overall.value")),
        "sleep_start": ms_to_iso(pick(s, "sleepStartTimestampGMT", "sleep_start_timestamp_gmt")),
        "sleep_end": ms_to_iso(pick(s, "sleepEndTimestampGMT", "sleep_end_timestamp_gmt")),
        "body_battery_max": to_int(pick(stats, "bodyBatteryHighestValue", "body_battery_highest_value")),
        "body_battery_min": to_int(pick(stats, "bodyBatteryLowestValue", "body_battery_lowest_value")),
        "stress_avg": (lambda v: v if v is not None and v >= 0 else None)(to_int(pick(stats, "averageStressLevel", "average_stress_level"))),
        "steps": to_int(pick(stats, "totalSteps", "total_steps")),
        "active_kcal": to_int(pick(stats, "activeKilocalories", "active_kilocalories")),
        "total_kcal": to_int(pick(stats, "totalKilocalories", "total_kilocalories")),
        "bmr_kcal": to_int(pick(stats, "bmrKilocalories", "bmr_kilocalories")),
        "training_readiness": to_int(pick(readiness, "score")),
        "resp_avg": to_num(pick(s, "averageRespirationValue", "average_respiration_value")),
        "spo2_avg": to_num(pick(s, "averageSpO2Value", "average_sp_o2_value", "average_spo2_value")),
        "awake_count": to_int(pick(s, "awakeCount", "awake_count")),
        "restless": to_int(pick(sleep, "restlessMomentsCount", "restless_moments_count")),
        "sleep_need_min": to_int(pick(s, "sleepNeed.actual", "sleep_need.actual")),
        "bb_change": to_int(pick(sleep, "bodyBatteryChange", "body_battery_change")),
        "sleep_levels": sleep_levels(sleep),
        "raw": {"sleep": s, "hrv": h, "readiness": readiness},
    }


def trim_lap(lap):
    keep = ("distance", "duration", "movingDuration", "averageSpeed", "averageHR", "maxHR",
            "averageRunCadence", "elevationGain", "averagePower", "lapIndex", "intensityType")
    return {k: lap.get(k) for k in keep if isinstance(lap, dict) and lap.get(k) is not None}


def activity_rows(garmin, start, end):
    items = safe(garmin.get_activities_by_date, start.isoformat(), end.isoformat()) or []
    rows = []
    for a in items:
        aid = pick(a, "activityId", "activity_id")
        if aid is None:
            continue
        aid = int(aid)
        splits = safe(garmin.get_activity_splits, aid) or {}
        laps = pick(splits, "lapDTOs", "lap_dtos") or []
        zones = safe(garmin.get_activity_hr_in_timezones, aid) or []
        zone_secs = [{"zone": pick(z, "zoneNumber", "zone_number"), "secs": pick(z, "secsInZone", "secs_in_zone"),
                      "low": pick(z, "zoneLowBoundary", "zone_low_boundary")} for z in zones if isinstance(z, dict)]
        rows.append({
            "id": aid,
            "start_local": pick(a, "startTimeLocal", "start_time_local"),
            "type_key": pick(a, "activityType.typeKey", "activity_type.type_key"),
            "name": pick(a, "activityName", "activity_name"),
            "duration_s": to_num(pick(a, "duration")),
            "avg_hr": to_num(pick(a, "averageHR", "average_hr")),
            "max_hr": to_num(pick(a, "maxHR", "max_hr")),
            "kcal": to_num(pick(a, "calories")),
            "training_load": to_num(pick(a, "activityTrainingLoad", "activity_training_load")),
            "aerobic_te": to_num(pick(a, "aerobicTrainingEffect", "aerobic_training_effect")),
            "anaerobic_te": to_num(pick(a, "anaerobicTrainingEffect", "anaerobic_training_effect")),
            "distance_m": to_num(pick(a, "distance")),
            "avg_speed": to_num(pick(a, "averageSpeed", "average_speed")),
            "max_speed": to_num(pick(a, "maxSpeed", "max_speed")),
            "avg_cadence": to_num(pick(a, "averageRunningCadenceInStepsPerMinute", "average_running_cadence_in_steps_per_minute")),
            "elev_gain": to_num(pick(a, "elevationGain", "elevation_gain")),
            "avg_power": to_num(pick(a, "avgPower", "avg_power")),
            "vo2max": to_num(pick(a, "vO2MaxValue", "v_o2_max_value", "vo2_max_value")),
            "te_label": pick(a, "trainingEffectLabel", "training_effect_label"),
            "hr_zones": zone_secs or None,
            "splits": [trim_lap(l) for l in laps] or None,
            "raw": a,
        })
    return rows


def metrics_row(garmin, day):
    ds = day.isoformat()
    status = safe(garmin.get_training_status, ds) or {}
    maxm = safe(garmin.get_max_metrics, ds)
    if isinstance(maxm, list):
        maxm = maxm[0] if maxm else {}
    maxm = maxm or {}
    latest = first_value(pick(status, "mostRecentTrainingStatus.latestTrainingStatusData",
                              "most_recent_training_status.latest_training_status_data")) or {}
    acute = pick(latest, "acuteTrainingLoadDTO", "acute_training_load_dto") or {}
    races = safe(garmin.get_race_predictions) or {}
    if isinstance(races, list):
        races = races[0] if races else {}
    return {
        "day": ds,
        "vo2max_run": to_num(pick(maxm, "generic.vo2MaxPreciseValue", "generic.vo2_max_precise_value")
                             or pick(status, "mostRecentVO2Max.generic.vo2MaxPreciseValue")),
        "vo2max_cycling": to_num(pick(maxm, "cycling.vo2MaxPreciseValue", "cycling.vo2_max_precise_value")),
        "training_status": pick(latest, "trainingStatusFeedbackPhrase", "training_status_feedback_phrase"),
        "acute_load": to_num(pick(acute, "dailyTrainingLoadAcute", "daily_training_load_acute")),
        "chronic_load": to_num(pick(acute, "dailyTrainingLoadChronic", "daily_training_load_chronic")),
        "load_ratio": to_num(pick(acute, "dailyAcuteChronicWorkloadRatio", "daily_acute_chronic_workload_ratio")),
        "race_5k_s": to_int(pick(races, "time5K", "time_5k")),
        "race_10k_s": to_int(pick(races, "time10K", "time_10k")),
        "race_half_s": to_int(pick(races, "timeHalfMarathon", "time_half_marathon")),
        "race_marathon_s": to_int(pick(races, "timeMarathon", "time_marathon")),
        "raw": {"status": latest, "max_metrics": maxm, "races": races},
    }


def body_rows(garmin, start, end):
    """Pesate della bilancia Garmin Index (o inserite in Garmin Connect): una riga per giorno, l'ultima del giorno."""
    data = safe(garmin.get_body_composition, start.isoformat(), end.isoformat()) or {}
    items = pick(data, "dateWeightList", "date_weight_list") or []
    kg = lambda g: round(g / 1000, 2) if g is not None and g > 500 else g
    rows = {}
    for it in items if isinstance(items, list) else []:
        day = pick(it, "calendarDate", "calendar_date")
        if not day:
            ms = pick(it, "date")
            day = dt.datetime.fromtimestamp(float(ms) / 1000, tz=TZ).date().isoformat() if ms else None
        w = to_num(pick(it, "weight"))
        if not day or not w:
            continue
        rows[str(day)[:10]] = {
            "day": str(day)[:10], "src": "Garmin", "weight_kg": kg(w),
            "fat_pct": to_num(pick(it, "bodyFat", "body_fat")),
            "muscle_kg": kg(to_num(pick(it, "muscleMass", "muscle_mass"))),
            "bone_kg": kg(to_num(pick(it, "boneMass", "bone_mass"))),
            "water_pct": to_num(pick(it, "bodyWater", "body_water")),
            "bmi": to_num(pick(it, "bmi")),
            "raw": it,
        }
    return list(rows.values())


# Mappatura typeId dei record Garmin: da verificare sul primo sync reale (vedi colonna raw).
RECORD_LABELS = {1: "1 km", 2: "1 miglio", 3: "5 km", 4: "10 km", 5: "Mezza maratona",
                 6: "Maratona", 7: "Corsa più lunga"}


def record_rows(garmin):
    items = safe(garmin.get_personal_record) or []
    rows = []
    for r in items if isinstance(items, list) else []:
        tid = pick(r, "typeId", "type_id")
        if tid is None:
            continue
        rows.append({
            "type_id": int(tid),
            "label": RECORD_LABELS.get(int(tid), f"Record tipo {tid}"),
            "value": to_num(pick(r, "value")),
            "activity_id": to_int(pick(r, "activityId", "activity_id")),
            "achieved_at": pick(r, "prStartTimeGmtFormatted", "actStartDateTimeInGMTFormatted", "pr_start_time_gmt_formatted"),
            "raw": r,
        })
    return rows


def main():
    garmin = login()
    today = dt.datetime.now(TZ).date()
    start = today - dt.timedelta(days=DAYS - 1)
    print(f"Sincronizzo dal {start} al {today}")

    rows = []
    day = start
    while day <= today:
        print(f"- {day}")
        rows.append(daily_row(garmin, day))
        day += dt.timedelta(days=1)
    upsert("daily", rows, "day")
    upsert("activities", activity_rows(garmin, start, today), "id")
    upsert("metrics", [metrics_row(garmin, d) for d in
                       (start + dt.timedelta(days=i) for i in range((today - start).days + 1))], "day")
    upsert("records", record_rows(garmin), "type_id")
    upsert("body_comp", body_rows(garmin, start, today), "day,src")


if __name__ == "__main__":
    main()
