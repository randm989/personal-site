// A minor gate for the House View preview at /house/. Runs on Cloudflare Pages before any file under
// /house is served, so nothing there (plan data included) is readable without the cookie.
// Only the SHA-256 of the password lives here. It is a courtesy lock, not real security.
const PASSWORD_SHA256 = "c9022680f888674e2b2274758755bfa07dea729b68d71cde5c521ed70ef261bf";
const COOKIE = "hv_gate";
const MAX_AGE = 60 * 60 * 24 * 30;

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function page(wrong) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>House View preview</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#10151C;color:#E6EAF0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  form{width:min(320px,86vw);display:grid;gap:14px}
  h1{font-size:20px;font-weight:600;margin:0}
  p{margin:0;color:#8C97A6;font-size:14px}
  input,button{font:inherit;border-radius:12px;padding:12px 14px;border:1px solid #2A3442}
  input{background:#1B232E;color:inherit}
  input:focus{outline:2px solid #FFD890;outline-offset:1px}
  button{background:#FFD890;color:#10151C;border-color:#FFD890;font-weight:600;cursor:pointer}
  .wrong{color:#F0A27A}
</style></head><body>
<form method="post" action="/house/">
  <h1>House View preview</h1>
  <p>A prototype with simulated devices. Enter the password to look around.</p>
  <input type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" autofocus required>
  ${wrong ? `<p class="wrong">That password did not match.</p>` : ""}
  <button type="submit">Open</button>
</form></body></html>`;
}

function html(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export async function onRequest({ request, next }) {
  const token = await sha256(PASSWORD_SHA256 + ":cookie");
  const cookies = (request.headers.get("cookie") || "").split(/;\s*/);

  if (cookies.includes(`${COOKIE}=${token}`)) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex, nofollow");
    out.headers.set("cache-control", "private, max-age=300");
    return out;
  }

  if (request.method === "POST") {
    let given = "";
    try { given = String((await request.formData()).get("password") || ""); } catch { /* not a form */ }
    if ((await sha256(given.trim().toLowerCase())) === PASSWORD_SHA256) {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/house/?scenario=evening",
          "set-cookie": `${COOKIE}=${token}; Path=/house; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    return html(page(true), 401);
  }
  return html(page(false), 401);
}
