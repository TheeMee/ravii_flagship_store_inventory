# RAVii Stock — deploy & migration guide

Two things get deployed:
1. **Backend** (Apps Script) — `Code.js` etc., pushed with `clasp push` then **redeployed** so the live `/exec` URL serves v2.
2. **Frontend** (this `deploy/` folder) — dragged onto Netlify. It includes the app **and** the CORS proxy function.

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

## B. Frontend — Netlify (drag-and-drop)

1. Go to your Netlify site → **Deploys** → drag the **`deploy/` folder** onto the deploy area.
   The folder already contains `index.html`, `netlify.toml`, and `netlify/functions/api.js`.
2. **Verify the proxy works:** open `https://<your-site>/.netlify/functions/api?action=ping` → `{"ok":true,...}`.
   - If functions don't run on a manual deploy for your account, connect the folder to a Git repo instead (Netlify will then build/bundle functions automatically). The function is dependency-free, so either path works.
3. Open the site on your phone. The app calls `/.netlify/functions/api`, which proxies to Apps Script with CORS.

If you ever redeploy the Apps Script to a **new** `/exec` URL, update it in **either**:
- `deploy/netlify/functions/api.js` (the `APPS_SCRIPT_URL` constant), or
- Netlify → Site settings → Environment → `APPS_SCRIPT_URL` (overrides the constant).

---

## C. Golden-case verification (run on the copy, then prod)
Pick 3–5 SKUs with known starting **In Store**. Then:
- **Add 2** to SKU-A → In Store +2, one `Add (App)` ledger row.
- **Deduct 1** from SKU-A → In Store −1, one `Deduct (App)` row.
- **Partial count** scope = one product, scan some but not all → unscanned in-scope SKUs become **0**, others match scan, variance summary matches by hand. Out-of-scope SKUs unchanged.
- **Mark show** SKU-B ×1 → `Show Items` qty 1; In Store unchanged; **Available = In Store − 1** in the app's Inventory tab.
- **Concurrent add** to the same SKU from two phones → both land (lock serializes), In Store reflects the sum.

## Notes
- `Index.html` (capital I) in the repo is the version-controlled source pushed by clasp (the Apps Script project no longer serves it — `doGet` is now the JSON API). `deploy/index.html` is the lowercase copy Netlify serves. Keep them identical.
- Old/cached copies of the previous app still post the legacy `{target, items}` shape; the backend's `doPost` falls through to `legacyDoPost_` so they keep working during cutover. Retire after one clean cycle.
