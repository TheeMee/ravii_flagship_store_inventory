# RAVii Stock — deploy & migration guide

Two things get deployed:
1. **Backend** (Apps Script) — `Code.js` etc., pushed with `clasp push` then **redeployed** so the live `/exec` URL serves v2.
2. **Frontend** (this `deploy/` folder) — hosted on **Cloudflare Pages**. It includes the app **and** the CORS proxy function (`functions/api.js`, served at `/api`).

> ⚠️ The backend migration is **destructive** (it converts `HQ Inventory` from a formula to code-maintained values). **Rehearse on a copy of the spreadsheet first.** Nothing here touches the live system until you choose to deploy.

---

## A. Backend — Apps Script

### 1. Migrate the spreadsheet (do this once, ideally on a copy first)
1. **Snapshot:** File → Make a copy of the whole spreadsheet → name it `PRE-LEDGER <date>`. This is your rollback.
2. **Verify columns:** On `Inventory`, confirm row 1 is exactly
   `SKU | Code | Brand | color | size | Name | Inflow HQ | Outflow HQ | Static Initial Stock Count | HQ Inventory`
   and that **HQ Inventory is column J**.
3. **Freeze HQ to values:** select column **J** → Copy → Paste Special → **Values only**.
   (Turns the `=Static+Inflow−Outflow` formula into hard numbers — the starting point the code will maintain.)
4. **Retire Inflow/Outflow (in place, don't delete):** stop using columns **G/H**. You may rename their headers to `Inflow HQ (retired)` / `Outflow HQ (retired)`. **Do not delete the columns** — that would shift HQ off column J and break the matrix.
5. *(Optional)* Update the `Live Inventory` tab's QUERY so it filters on stock again. It currently references the now-retired G/H columns (`… OR G!=0 OR H!=0 …`); change that condition to use **HQ Inventory (col J)**, e.g. `WHERE A IS NOT NULL AND J <> 0`.
6. The `Show Items` sheet is created automatically on first use (columns `SKU | Qty On Display | Last Updated | Note`).

### 2. Push + redeploy the code
```bash
clasp push
# then publish a NEW VERSION of the EXISTING deployment so the /exec URL stays the same:
clasp redeploy AKfycbwflxt9AoEebPUlKEXTY0WlouILSd4Zx9oQorMyytdIHrsgOghD94dK16iLzzRxNiNX
```
Or in the editor: **Deploy → Manage deployments → (edit) → New version → Deploy**. Keep `Execute as: Me`, `Who has access: Anyone`.

### 3. Smoke-test the API (through the deployment)
After redeploy, in a browser open: `…/exec?action=ping` → should return `{"ok":true,"data":{"pong":true,...}}`.
Then `…/exec?action=getInventory` → JSON of your stock.

---

## B. Frontend — Cloudflare Pages (free, deploys are NOT metered)

The app is a static `index.html` plus one CORS proxy at `deploy/functions/api.js` (a Cloudflare
Pages Function, served at `/api`). Cloudflare Pages has unlimited static bandwidth, ~100k
function calls/day free, and **does not charge credits per deploy** (which is what drained Netlify).

### Easiest: direct upload with Wrangler
```bash
# IMPORTANT: run from INSIDE the deploy/ folder so wrangler finds functions/ (the proxy).
# Deploying from the repo root uploads only static files and the /api proxy silently won't work.
# Use --branch main so the deploy is promoted to the PRODUCTION alias (…pages.dev); without it a
# deploy can land as a preview and the live site keeps serving the old version.
cd deploy
npx wrangler pages deploy . --project-name ravii-store-1 --branch main --commit-dirty=true
```
Then in the Cloudflare dashboard: **Workers & Pages → ravii-store-1 → Settings → Variables and
Secrets → add `APPS_SCRIPT_URL`** = that store's `/exec` URL (see "Two stores" below), and redeploy.

### Or: connect the GitHub repo
**Workers & Pages → Create → Pages → Connect to Git** → pick the repo, then set:
- **Root directory:** `deploy`
- **Build command:** *(leave empty — no build)*
- **Build output directory:** `/`

Cloudflare picks up `deploy/functions/api.js` automatically. With Git connected, deploys still
don't cost credits, but you can **pause automatic deployments** in Settings → Builds & deployments
if you only want to publish on demand.

**Verify the proxy:** open `https://<your-project>.pages.dev/api?action=ping` → `{"ok":true,...}`.
Then open the site on your phone — the app calls `/api`, which proxies to Apps Script with CORS.

### Two stores — the per-store variable
Each store is **one Cloudflare Pages project** running the same code, distinguished only by its
`APPS_SCRIPT_URL` environment variable:

| Project | `APPS_SCRIPT_URL` (Settings → Variables and Secrets) |
|---------|------------------------------------------------------|
| `ravii-store-1` | store 1's Apps Script `…/exec` URL |
| `ravii-store-2` | store 2's Apps Script `…/exec` URL |

The frontend calls the relative path `/api`, so it always hits *its own* project's function, which
reads *that* project's variable. Set the variable for **Production** (and Preview if you use it),
then redeploy. The hardcoded URL in `deploy/functions/api.js` is only a fallback when no variable
is set. For local dev against a specific store: `APPS_SCRIPT_URL=…/exec node dev-server.js`.

> The old Netlify files (`deploy/netlify.toml`, `deploy/netlify/functions/api.js`) are unused by
> Cloudflare and can be deleted once the Cloudflare site is confirmed working.

---

## C. Golden-case verification (run on the copy, then prod)
Pick 3–5 SKUs with known starting **In Store**. Then:
- **Add 2** to SKU-A → In Store +2, one `Add (App)` ledger row.
- **Deduct 1** from SKU-A → In Store −1, one `Deduct (App)` row.
- **Partial count** scope = one product, scan some but not all → unscanned in-scope SKUs become **0**, others match scan, variance summary matches by hand. Out-of-scope SKUs unchanged.
- **Mark show** SKU-B ×1 → `Show Items` qty 1; In Store unchanged; **Available = In Store − 1** in the app's Inventory tab.
- **Concurrent add** to the same SKU from two phones → both land (lock serializes), In Store reflects the sum.

## Notes
- `Index.html` (capital I) in the repo is the version-controlled source pushed by clasp (the Apps Script project no longer serves it — `doGet` is now the JSON API). `deploy/index.html` is the lowercase copy Cloudflare Pages serves. Keep them identical.
- Old/cached copies of the previous app still post the legacy `{target, items}` shape; the backend's `doPost` falls through to `legacyDoPost_` so they keep working during cutover. Retire after one clean cycle.
