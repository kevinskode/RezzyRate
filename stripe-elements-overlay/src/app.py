import os
import json
import base64
import boto3
import stripe
from urllib.parse import parse_qs

dynamodb = boto3.client("dynamodb")

def _q(event, key):
    """Get a query param from either REST (queryStringParameters) or HTTP API (rawQueryString)."""
    qsp = event.get("queryStringParameters")
    if isinstance(qsp, dict) and qsp.get(key) is not None:
        return qsp.get(key)
    raw = event.get("rawQueryString") or ""
    try:
        from urllib.parse import parse_qs
        return parse_qs(raw).get(key, [""])[0]
    except Exception:
        return ""

def _get_webhook_secret():
    name = os.environ["STRIPE_WEBHOOK_SECRET_PARAM"]
    return _ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]

TABLE = os.environ.get("CREDIT_TABLE")

def _add_credits(token: str, amount: int):
    if not token or amount <= 0 or not TABLE:
        return
    dynamodb.update_item(
        TableName=TABLE,
        Key={"token": {"S": token}},
        UpdateExpression="ADD credits :n",
        ExpressionAttributeValues={":n": {"N": str(amount)}}
    )

# --- Stripe secret loading (SSM Parameter Store) ---
_ssm = boto3.client("ssm")
_cached_key = None

def _get_stripe_key():
    """Read and cache the Stripe secret key from SSM Parameter Store."""
    global _cached_key
    if _cached_key:
        return _cached_key
    param_name = os.environ["STRIPE_SECRET_PARAM"]  # e.g. /stripe/secret
    resp = _ssm.get_parameter(Name=param_name, WithDecryption=True)
    _cached_key = resp["Parameter"]["Value"]
    return _cached_key

# --- Helpers ---
def _response(status: int, body: dict, event: dict):
    """CORS headers reflect the caller's Origin (works for localhost during dev)."""
    headers = (event.get("headers") or {})
    req_origin = headers.get("origin") or headers.get("Origin") or ""
    # Only echo back our own origins (exact match, so e.g. evil-rezzyrate.com is rejected)
    allowed_origins = {"https://rezzyrate.com", "https://www.rezzyrate.com"}
    acao = req_origin if req_origin in allowed_origins else ""
    #acao = "*"
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": acao,
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(body),
    }

def _parse_json_body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8", "ignore")
        except Exception:
            pass
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}

# === Lambda handler ===
def create_payment_intent(event, _context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {"ok": True}, event)

    try:
        body = _parse_json_body(event)
        price_id = body.get("priceId")
        quantity = int(body.get("quantity", 1))
        
        token = (body.get("token") or "").strip()
        credits = int(body.get("credits", quantity))  # how many credits this purchase represents

        if not price_id:
            return _response(400, {"error": "priceId required"}, event)
        if quantity < 1 or quantity > 50:
            return _response(400, {"error": "quantity must be 1..50"}, event)

        stripe.api_key = _get_stripe_key()

        # Optional allowlist, e.g. ALLOWED_PRICE_IDS="price_xxx_single,price_xxx_pack10,price_xxx_pack20"
        allowed = {p.strip() for p in os.environ.get("ALLOWED_PRICE_IDS", "").split(",") if p.strip()}
        if allowed and price_id not in allowed:
            return _response(400, {"error": "priceId not allowed"}, event)

        price = stripe.Price.retrieve(price_id)
        if not price.get("active"):
            return _response(400, {"error": "price is inactive"}, event)
        if price.get("type") != "one_time" or price.get("unit_amount") is None:
            return _response(400, {"error": "price must be one_time with unit_amount"}, event)

        amount_cents = int(price["unit_amount"]) * quantity
        currency = price["currency"]

        intent = stripe.PaymentIntent.create(
            amount=amount_cents,
            currency=currency,
            automatic_payment_methods={"enabled": True},
            metadata={
                "price_id": price_id, 
                "quantity": str(quantity), 
                "credits": str(credits),   # NEW
                "token": token,            # NEW (used by webhook)
                "source": "rezzy"
            },
        )
        return _response(200, {"client_secret": intent["client_secret"]}, event)

    except Exception as e:
        return _response(500, {"error": str(e)}, event)

def webhook(event, _context):
    # Raw body (do NOT json.loads before verify)
    payload = event.get("body") or ""
    if event.get("isBase64Encoded"):
        payload = base64.b64decode(payload)

    sig = (event.get("headers") or {}).get("Stripe-Signature") or (event.get("headers") or {}).get("stripe-signature")
    if not sig:
        return {"statusCode": 400, "body": "Missing signature"}

    try:
        secret = _get_webhook_secret()
        evt = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception as e:
        return {"statusCode": 400, "body": f"Invalid: {e}"}

    if evt["type"] == "payment_intent.succeeded":
        pi = evt["data"]["object"]
        meta = pi.get("metadata") or {}
        token = (meta.get("token") or "").strip()
        credits = int(meta.get("credits") or "0")
        if token and credits > 0:
            _add_credits(token, credits)

    # Always 2xx so Stripe doesn't retry forever (use DLQ/logs for real failures)
    return {"statusCode": 200, "body": "ok"}

def fetch_credits(event, _context):
    token = (_q(event, "token") or "").strip()
    if not token or not TABLE:
        return _response(400, {"error": "token required" if not token else "server missing CREDIT_TABLE"}, event)

    # Atomically read previous value and set to zero
    resp = dynamodb.update_item(
        TableName=TABLE,
        Key={"token": {"S": token}},
        UpdateExpression="SET credits = :z",
        ExpressionAttributeValues={":z": {"N": "0"}},
        ReturnValues="UPDATED_OLD"
    )
    prev = int(resp.get("Attributes", {}).get("credits", {}).get("N", "0"))
    return _response(200, {"credits": prev}, event)


# =====================================================================
# Similar jobs (Adzuna proxy) — keeps the Adzuna app_id/app_key server-side
# GET /jobs?q=<title>&skills=<comma list>&where=<city, ST>&remote=1&limit=12
# =====================================================================
import re
import time
import urllib.request
import urllib.parse

_adzuna_creds = None
_jobs_cache = {}            # key -> (expires_at, payload)
_JOBS_TTL = 60 * 60         # 1 hour; saves Adzuna quota (trial = 250 calls/day)
_MAX_CALLS = 2              # at most 2 Adzuna calls per search


def _get_adzuna_creds():
    global _adzuna_creds
    if _adzuna_creds:
        return _adzuna_creds
    resp = _ssm.get_parameters(
        Names=[os.environ["ADZUNA_APP_ID_PARAM"], os.environ["ADZUNA_APP_KEY_PARAM"]],
        WithDecryption=True,
    )
    vals = {p["Name"]: p["Value"] for p in resp.get("Parameters", [])}
    _adzuna_creds = (vals[os.environ["ADZUNA_APP_ID_PARAM"]], vals[os.environ["ADZUNA_APP_KEY_PARAM"]])
    return _adzuna_creds


def _clean(s, n=120):
    """Strip anything odd and cap length before it goes into an upstream query."""
    s = re.sub(r"[^\w\s,.+#&/'-]", " ", str(s or ""))
    return re.sub(r"\s+", " ", s).strip()[:n]


def _adzuna_search(what="", what_or="", where="", limit=20):
    app_id, app_key = _get_adzuna_creds()
    country = os.environ.get("ADZUNA_COUNTRY", "us")
    params = {
        "app_id": app_id,
        "app_key": app_key,
        "results_per_page": str(limit),
        "content-type": "application/json",
        "sort_by": "relevance",
        "max_days_old": "30",
    }
    if what:
        params["what"] = what
    if what_or:
        params["what_or"] = what_or
    if where:
        params["where"] = where
        params["distance"] = "40"  # km
    url = f"https://api.adzuna.com/v1/api/jobs/{country}/search/1?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "RezzyRate/1.0"})
    with urllib.request.urlopen(req, timeout=6) as r:
        data = json.loads(r.read().decode("utf-8", "ignore"))
    return data.get("results") or []


def _shape_job(j):
    desc = re.sub(r"<[^>]+>", " ", j.get("description") or "")
    return {
        "id": str(j.get("id") or ""),
        "title": re.sub(r"<[^>]+>", "", j.get("title") or "").strip(),
        "company": ((j.get("company") or {}).get("display_name") or "").strip(),
        "location": ((j.get("location") or {}).get("display_name") or "").strip(),
        "desc": re.sub(r"\s+", " ", desc).strip(),
        "url": j.get("redirect_url") or "",
        "created": j.get("created") or "",
        "salary_min": j.get("salary_min"),
        "salary_max": j.get("salary_max"),
        "salary_predicted": str(j.get("salary_is_predicted") or "0") == "1",
        "contract_time": j.get("contract_time") or "",
        "category": ((j.get("category") or {}).get("label") or ""),
    }


def jobs(event, _context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {"ok": True}, event)

    title = _clean(_q(event, "q"), 80)
    skills = [_clean(s, 30) for s in (_q(event, "skills") or "").split(",")]
    skills = [s for s in skills if s][:8]
    where = _clean(_q(event, "where"), 60)
    remote = (_q(event, "remote") or "") in ("1", "true", "yes")
    try:
        limit = max(1, min(20, int(_q(event, "limit") or 12)))
    except ValueError:
        limit = 12

    if not title and not skills:
        return _response(400, {"error": "q or skills required"}, event)

    cache_key = json.dumps([title.lower(), [s.lower() for s in skills], where.lower(), remote, limit])
    hit = _jobs_cache.get(cache_key)
    if hit and hit[0] > time.time():
        return _response(200, hit[1], event)

    # Adzuna "what" = ALL words must match, "what_or" = ANY. We try progressively
    # broader searches until we have enough results.
    # multi-word skills ("Power BI") would split into noisy single words, so only use one-word skills here
    skill_or = " ".join([s for s in skills if " " not in s][:6])
    what_title = f"{title} remote" if remote and title else title
    loc = "" if remote else where
    core = title.split()[-1] if title else ""   # "Senior Data Analyst" -> "Analyst"
    attempts = [
        dict(what=what_title, what_or=skill_or, where=loc),
        dict(what=what_title, where=loc),
        dict(what=what_title, what_or=skill_or),
        dict(what=core, what_or=skill_or, where=loc),
        dict(what_or=skill_or, where=loc),
    ]

    seen, results, errors, calls = set(), [], 0, 0
    for a in attempts:
        if len(results) >= limit or calls >= _MAX_CALLS:
            break
        if not (a.get("what") or a.get("what_or")):
            continue
        calls += 1
        try:
            raw = _adzuna_search(limit=20, **a)
        except Exception as e:  # network / quota — keep trying the next shape
            errors += 1
            print(f"adzuna error for {a}: {e}")
            continue
        for j in raw:
            shaped = _shape_job(j)
            dedupe = (shaped["title"].lower(), shaped["company"].lower())
            if not shaped["url"] or dedupe in seen:
                continue
            seen.add(dedupe)
            results.append(shaped)

    if not results and errors:
        return _response(502, {"error": "job search unavailable"}, event)

    payload = {"jobs": results[: max(limit, 20)], "query": {"q": title, "skills": skills, "where": loc, "remote": remote}}
    _jobs_cache[cache_key] = (time.time() + _JOBS_TTL, payload)
    return _response(200, payload, event)
