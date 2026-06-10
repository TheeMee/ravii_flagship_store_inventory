/**
 * Legacy HTML server — UNUSED in production (the app is hosted on Netlify).
 *
 * Renamed OFF "doGet" on purpose: Apps Script allows only one doGet, and the
 * v2 JSON read-API in Code.js (doGet ?action=...) must own it. Kept here only
 * as an optional fallback if you ever serve the page from Apps Script again
 * (note: camera scanning will not work inside Apps Script's sandboxed iframe).
 */
function serveHtmlLegacy_() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Store Target Profile')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
}
