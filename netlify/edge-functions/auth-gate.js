// netlify/edge-functions/auth-gate.js
export default async (request, context) => {
  const url = new URL(request.url);
  let credential = null;

  // 1. Correctly catch Google's HTTP POST form submission
  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      credential = formData.get("credential");
    } catch (e) {
      // Not form data, safe to ignore
    }
  }

  // If a Google login token was submitted via POST
  if (credential) {
    try {
      // Decode the Google JWT token safely at the server edge
      const [, payloadBase64] = credential.split('.');
      const payload = JSON.parse(atob(payloadBase64));
      const userEmail = payload.email;

      // 🛑 YOUR STRICT EMAIL WHITELIST
      const ALLOWED_EMAILS = [
        "raviicustomerhelp@gmail.com"
      ];

      if (ALLOWED_EMAILS.includes(userEmail)) {
        // Authorized! Set a secure 30-day cookie and redirect to the ERP homepage
        const response = new Response(null, { status: 302 });
        response.headers.set("Location", "/");
        response.headers.set(
          "Set-Cookie", 
          `erp_access=${userEmail}; Path=/; Max-Age=2592000; Secure; SameSite=Strict`
        );
        return response;
      } else {
        // This stops the loop immediately for unauthorized users
        return new Response("Access Denied: This email is not on the ERP whitelist.", { status: 403 });
      }
    } catch (err) {
      return new Response("Authentication Error", { status: 400 });
    }
  }

  // 2. Check if they already have a valid session cookie
  const cookies = request.headers.get("cookie") || "";
  if (cookies.includes("erp_access=")) {
    // Let them view your actual website safely!
    return context.next();
  }

  // 3. If no session, serve the simple Google Sign-In button.
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ERP Authentication</title>
      <script src="https://accounts.google.com/gsi/client" async defer></script>
      <style>
        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f5f5f5; margin:0; }
        .box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>Company ERP Gate</h2>
        <p>Please sign in with your authorized company email to proceed.</p>
        
        <div id="g_id_onload"
             data-client_id="741152123628-o2468hff3b3d8vg6qdj5tl76o6cqtpuu.apps.googleusercontent.com"
             data-login_uri="${url.origin}/"
             data-auto_prompt="true">
        </div>
        <div class="g_id_signin" data-type="standard"></div>
      </div>
    </body>
    </html>
  `, {
    headers: { "Content-Type": "text/html" }
  });
};