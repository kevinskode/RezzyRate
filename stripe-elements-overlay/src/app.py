import os
import json
import base64
import boto3
import stripe

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
    acao = req_origin or os.environ.get("FRONTEND_URL") or "*"
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": acao,
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
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

# --- Minimal server-side product map (prices in cents) ---
PRODUCTS = {
    "basic_widget": {"amount": 2500, "currency": "usd"},  # $25.00
    "pro_widget":   {"amount": 7900, "currency": "usd"},  # $79.00
}

# === Lambda handler ===
def create_payment_intent(event, _context):
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {"ok": True}, event)

    try:
        body = _parse_json_body(event)
        price_id = body.get("priceId")
        quantity = int(body.get("quantity", 1))

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
            metadata={"price_id": price_id, "quantity": str(quantity), "source": "rezzy"},
        )
        return _response(200, {"client_secret": intent["client_secret"]}, event)

    except Exception as e:
        return _response(500, {"error": str(e)}, event)
