# Deploying the "Similar Jobs" backend

**Payments no longer use AWS.** The site now uses Stripe Payment Links (Stripe-hosted
checkout), the same approach as Clean Paws. Nothing Stripe-related needs deploying.

The only backend change is the new job-search route. The site calls `GET /Prod/jobs` on
the existing API (`gyw1n7b24m`, us-east-2). That route doesn't exist yet, so browsers get
a 403 "Missing Authentication Token" today.

## Steps (us-east-2, stack `rezzy-rate`, per samconfig.toml)

1. Save the Adzuna credentials (Kevin has the app ID and key):
   ```
   aws ssm put-parameter --region us-east-2 --name /rezzy/adzuna/app_id  --type String       --value <APP_ID>
   aws ssm put-parameter --region us-east-2 --name /rezzy/adzuna/app_key --type SecureString --value <APP_KEY>
   ```
2. Build and deploy:
   ```
   cd stripe-elements-overlay
   sam build
   sam deploy
   ```
3. Check. This should return JSON with a `jobs` array:
   `https://gyw1n7b24m.execute-api.us-east-2.amazonaws.com/Prod/jobs?q=Data%20Analyst&skills=SQL`
   If `sam deploy` reports an `ApiBaseUrl` other than `gyw1n7b24m`, tell Kevin.
   `API_BASE_URL` in `www/script.js` would need to change to match.

## What this deploy changes

- **New `JobsFn`** (`app.jobs`, `GET /jobs`): proxies Adzuna so the keys stay
  server-side. It uses Python stdlib only, makes at most 2 Adzuna calls per search, and
  caches results for 1 hour. It can read the two Adzuna SSM parameters only.
- **`GatewayResponses`** on `PublicApi`: adds `Access-Control-Allow-Origin: *` to API
  Gateway's own 4XX/5XX errors, so browsers show the real error instead of a CORS error.
- **`_response()` CORS fix**: exact origin match on `https://rezzyrate.com` /
  `https://www.rezzyrate.com`. The old substring check let look-alike domains through.
- **`create_payment_intent` hardening**: credits now come from the `PRICE_CREDITS` env
  var, not from the browser. The site no longer calls this function, so this only
  matters if it's ever used again.

The existing Stripe functions and parameters are unchanged and unused by the site.
They can be removed later.

## Note
Adzuna's free plan is "Trial Access": 250 calls a day and 2,500 a month, and for
commercial sites it's intended as a 14-day trial. Plan on either a commercial license
or a switch to Careerjet later.
