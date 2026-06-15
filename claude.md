# RAVii inventory — project notes

Browser app for two physical stores (**Flagship** + **Central World**) that reads/writes a Google
Sheet through a Google Apps Script backend. Two layers: a static frontend + CORS proxy (hosted), and
the Apps Script API (`Code.js`) over the Sheet.

## Hosting — Cloudflare Pages (current)

Frontend was migrated off Netlify (its 2026 free plan caps at **300 credits/month** and was drained
by repeated production deploys). Cloudflare Pages does **not** meter deploys — deploy freely.

Two Pages projects serve the **identical** `deploy/` folder, distinguished only by env vars:

| Project | URL | `STORE_NAME` | `APPS_SCRIPT_URL` |
|---------|-----|--------------|-------------------|
| `ravii-flagship-inventory` | https://ravii-flagship-inventory.pages.dev | `Flagship` | (unset — uses Flagship's `/exec` baked into the function as the fallback) |
| `ravii-centralworld-inventory` | https://ravii-centralworld-inventory.pages.dev | `Central World` | store 2's `/exec` (`…M_mjl-5A/exec`) |

- **Proxy:** `deploy/functions/api.js` is a Cloudflare Pages Function served at `/api`. It forwards
  to Apps Script (adding CORS) and answers `?action=__store` locally from `STORE_NAME`.
- **Per-store identity:** the frontend calls `/api?action=__store` on load and sets the browser tab
  (`RAVii — <name>`) and header `<h1 id="store-name">`. Each project reads its own `STORE_NAME`, so
  the same code self-labels per store. Do not hardcode store names in the HTML.
- **Per-store backend:** the function reads `env.APPS_SCRIPT_URL` (falls back to Flagship's `/exec`).
  Central World **must** keep its `APPS_SCRIPT_URL` set or it would serve Flagship's stock.

### Deploy (Cloudflare) — two gotchas, both required
```bash
cd deploy   # MUST run from inside deploy/ or the functions/ proxy isn't bundled and /api breaks
npx wrangler pages deploy . --project-name ravii-flagship-inventory --branch main --commit-dirty=true
# (…--project-name ravii-centralworld-inventory for the other store)
```
- Run from **inside `deploy/`** — else only static files upload and `/api` silently serves HTML.
- Pass **`--branch main`** — else the deploy can land as a *preview* and the live `…pages.dev` keeps
  serving the old version.
- Set a variable: `printf '%s' "<value>" | npx wrangler pages secret put STORE_NAME --project-name <project>`
- Wrangler OAuth tokens expire after a few days → re-run `npx wrangler login` if account API calls
  fail with `Authentication error [code: 10000]`.
- Pages projects **cannot be renamed** — to change a URL, create a new project and delete the old.

## Apps Script backend (`Code.js`)
- `doGet`/`doPost` route by `action` and return JSON (`{ok, data}` or `{ok:false,error,code}`).
- Pushed via clasp (`.clasp.json`); `deploy/**`, `*.md`, `dev-server.js` are claspignored.
- Stock lives in code, not sheet formulas: HQ Inventory (In Store), On Display, In Sales =
  max(0, HQ − On Display). Every mutation appends to "Stock Change History".

## Frontend files
- `Index.html` (capital I) is the version-controlled source; `deploy/index.html` is the deployed
  copy. **Keep them identical** (edit both).
- `deploy/netlify/` + `deploy/netlify.toml` are the legacy Netlify proxy/config (drag-and-drop). They
  carry the same `__store` route for parity but Netlify keeps hitting the credit cap; prefer the
  Cloudflare URLs. Safe to delete once nobody uses the Netlify links.

## Local dev (free, no deploy)
```bash
STORE_NAME="Flagship" node dev-server.js   # then open http://localhost:8787/
```
Serves `Index.html` and proxies `/api` to the live Apps Script Sheet (also answers `__store`). Use
this to iterate instead of deploying to test.

## Workflow notes
- `git push` does not trigger any deploy (Cloudflare is direct-upload via wrangler; Netlify is
  drag-and-drop). Pushing is purely for backup.
- Commit author currently records as the machine default (`theemee@…local`); set `git config
  user.email` if a real email is wanted.
