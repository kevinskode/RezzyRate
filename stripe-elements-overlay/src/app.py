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
    # Preflight for CORS
    if event.get("httpMethod") == "OPTIONS":
        return _response(200, {"ok": True}, event)

    try:
        body = _parse_json_body(event)
        product_id = body.get("productId")
        quantity = int(body.get("quantity", 1))

        if not product_id or product_id not in PRODUCTS:
            return _response(400, {"error": "Unknown or missing productId"}, event)
        if quantity < 1 or quantity > 50:
            return _response(400, {"error": "quantity must be 1..50"}, event)

        item = PRODUCTS[product_id]
        amount_cents = item["amount"] * quantity
        currency = item.get("currency", "usd")

        # Stripe
        stripe.api_key = _get_stripe_key()
        intent = stripe.PaymentIntent.create(
            amount=amount_cents,
            currency=currency,
            automatic_payment_methods={"enabled": True},
            metadata={
                "product_id": product_id,
                "quantity": str(quantity),
                "source": "s3-overlay",
            },
        )

        return _response(200, {"client_secret": intent["client_secret"]}, event)

    except Exception as e:
        # Log full details in CloudWatch in real life; returning message here for speed while you test
        return _response(500, {"error": str(e)}, event)
