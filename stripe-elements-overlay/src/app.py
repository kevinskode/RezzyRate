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
    req_origin = headers.get("origin") or headers.get("Origin")
    # Fallback to configured frontend or '*' during local testing
    acao = event["headers"].get("origin") if "rezzyrate.com" in event["headers"].get("origin","") else ""
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
