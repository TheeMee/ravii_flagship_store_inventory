/**
 * RAVii inventory — CORS proxy to the Apps Script web app.
 *
 * The browser (served from Netlify) calls /.netlify/functions/api ; this
 * function forwards the request to the Apps Script /exec endpoint server-side
 * (no CORS there), follows the 302 it returns, and relays the JSON back with
 * permissive CORS headers so the page can read it.
 *
 * Dependency-free (Node 18+ global fetch) so it bundles cleanly on a manual
 * drag-and-drop deploy.
 */

// The same public /exec URL the app used before. Override via Netlify env var
// APPS_SCRIPT_URL (Site settings -> Environment) if you redeploy to a new URL.
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbwflxt9AoEebPUlKEXTY0WlouILSd4Zx9oQorMyytdIHrsgOghD94dK16iLzzRxNiNX/exec";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  // Per-store display name — answered here from the STORE_NAME env var (each Netlify site sets
  // its own), so the identical frontend titles itself "Flagship" vs "Central World". Handled
  // before proxying so it never reaches Apps Script.
  if (event.queryStringParameters && event.queryStringParameters.action === "__store") {
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, data: { name: process.env.STORE_NAME || "RAVii Stock" } }),
    };
  }

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    const isGet = event.httpMethod === "GET";
    // Netlify usually provides rawQuery; fall back to reconstructing from the parsed map.
    const qs = event.rawQuery ||
      (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : "");
    const url = isGet && qs ? APPS_SCRIPT_URL + "?" + qs : APPS_SCRIPT_URL;

    const res = await fetch(url, {
      method: isGet ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: isGet ? undefined : (event.body || "{}"),
      redirect: "follow", // Apps Script /exec 302-redirects to googleusercontent.com
    });

    const text = await res.text();
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e), code: "PROXY" }),
    };
  }
};
