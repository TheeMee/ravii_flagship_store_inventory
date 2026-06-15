/**
 * RAVii inventory — CORS proxy to the Apps Script web app (Cloudflare Pages Function).
 *
 * File path `functions/api.js` -> serves the route `/api`. The browser (served from
 * Cloudflare Pages) calls /api ; this function forwards the request to the Apps Script
 * /exec endpoint server-side (no CORS there), follows the 302 it returns, and relays the
 * JSON back with permissive CORS headers so the page can read it.
 *
 * PER-STORE BACKEND (the "variable thing"): the Apps Script URL is read from the
 * APPS_SCRIPT_URL environment variable. Each store = one Cloudflare Pages project with
 * its own APPS_SCRIPT_URL set in: Project -> Settings -> Environment variables. Same code,
 * two projects, two variables -> two stores. The hardcoded value below is only a fallback
 * for when no variable is set.
 *
 * Cloudflare Pages Functions run on the Workers runtime (global fetch, env via context.env).
 */

const FALLBACK_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwflxt9AoEebPUlKEXTY0WlouILSd4Zx9oQorMyytdIHrsgOghD94dK16iLzzRxNiNX/exec";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest(context) {
  const { request, env } = context;
  const APPS_SCRIPT_URL = (env && env.APPS_SCRIPT_URL) || FALLBACK_APPS_SCRIPT_URL;

  // Per-store display name — answered here from the STORE_NAME env var (each Pages project sets
  // its own), so the identical frontend can title itself "Flagship" vs "Central World" without
  // any hostname logic. Handled before proxying so it never reaches Apps Script.
  if (new URL(request.url).searchParams.get("action") === "__store") {
    return new Response(
      JSON.stringify({ ok: true, data: { name: (env && env.STORE_NAME) || "RAVii Stock" } }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const isGet = request.method === "GET";
    const inUrl = new URL(request.url);
    // Forward the querystring on GETs (?action=...); POSTs carry their JSON body.
    const target = isGet && inUrl.search ? APPS_SCRIPT_URL + inUrl.search : APPS_SCRIPT_URL;

    const res = await fetch(target, {
      method: isGet ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: isGet ? undefined : ((await request.text()) || "{}"),
      redirect: "follow", // Apps Script /exec 302-redirects to googleusercontent.com
    });

    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e), code: "PROXY" }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
}
