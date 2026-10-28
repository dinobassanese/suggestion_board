"""
Optional browser test (needs: pip install playwright; Chromium installed).
Run:  python3 tests/browser_test.py
Starts its own server + empty database, then drives a real browser to check
that the page works end to end and that typed-in HTML/script is shown as text.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp()
env = {**os.environ, "PORT": "0", "DB_PATH": f"{tmp}/t.db", "ADMIN_PASSWORD": "test-password", "TRUST_PROXY": "", "RESEND_API_KEY": "", "SMTP_HOST": "", "SMTP_USER": "", "SMTP_PASS": "", "DIGEST_TO": ""}
srv = subprocess.Popen(["node", "server.js"], cwd=root, env=env, stdout=subprocess.PIPE, text=True)
base = re.search(r"http://localhost:\d+", srv.stdout.readline()).group(0)
failures = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: failures.append(name)

try:
    def api(method, path, body=None, cookie=None):
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {})})
        with urllib.request.urlopen(req) as r:
            return json.load(r), r.headers
    _, h = api("POST", "/api/admin/login", {"password": "test-password"})
    cookie = h["Set-Cookie"].split(";")[0]
    api("PATCH", "/api/admin/settings", {"require_approval": False}, cookie)

    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        dialogs = []
        page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        page.goto(base); time.sleep(2.5)

        def submit(title, name, email):
            page.fill("#title", title); page.fill("#name", name); page.fill("#email", email)
            page.click("#submit-btn")
            page.wait_for_selector("#result-dialog[open]", timeout=8000)

        submit("Export reports to Excel", "Ann", "ann@example.com")
        check("first idea is posted", "Posted" in page.inner_text("#result-dialog"))
        page.keyboard.press("Escape"); page.reload(); time.sleep(2.5)
        submit("Excel export for reports", "Bob", "bob@example.com")
        body = page.inner_text("#result-dialog")
        check("second customer is told 1 person asked for something similar", re.search(r"\b1\b", body) is not None and "similar" in body.lower())

        # Script/HTML typed in is shown as text and never runs
        page.keyboard.press("Escape"); page.reload(); time.sleep(2.5)
        evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
        submit(evil, '<b>Eve</b>', "eve@example.com")
        page.keyboard.press("Escape"); page.reload(); time.sleep(1)
        check("no script ran", dialogs == [])
        check("typed HTML is shown as text", "<script>alert(2)</script>" in page.inner_text("body"))

        # Admin page needs a login
        page.goto(base + "/admin.html")
        check("admin page asks for a password", page.locator("input[type=password]").count() > 0)
        page.fill("input[type=password]", "wrong"); page.keyboard.press("Enter"); time.sleep(0.8)
        check("wrong password: no data shown", "Export reports" not in page.inner_text("body"))
        page.fill("input[type=password]", "test-password"); page.keyboard.press("Enter"); time.sleep(1.5)
        check("right password shows the suggestions", "Export reports" in page.inner_text("body"))
        check("no script ran in admin either", dialogs == [])
        check("daily summary section says it is off", "Daily Summary Email" in page.inner_text("body") and "Off." in page.inner_text("#digest-status"))
        page.click("#digest-test"); page.wait_for_selector(".toast", timeout=4000)
        check("test-summary button explains what is missing", "not set up yet" in page.inner_text(".toast"))
        # Add a request from the dashboard (name and email left blank)
        page.click("#add-open"); page.wait_for_selector("#add-dialog[open]")
        page.click("#add-submit"); time.sleep(0.5)
        check("add form: empty title is refused with a message", "title" in page.inner_text("#add-error").lower())
        page.fill("#add-title-input", "Phone request from Dana")
        page.click("#add-submit"); time.sleep(1.2)
        check("add form: request appears in the list", "Phone request from Dana" in page.inner_text("#rows"))
        check("add form: shows no email", "(no email)" in page.inner_text("#rows"))
        # Adjust votes and date on that request
        page.click("[data-open]"); page.wait_for_selector("#e-extra")
        page.fill("#e-extra", "5"); page.fill("#e-date", "2026-01-15")
        page.screenshot(path=os.environ.get("SHOT", os.path.join(tmp, "admin-edit.png")))
        page.click("#edit-form button[type=submit]"); time.sleep(1.2)
        check("edit: dialog explains the vote split after saving", "Customers see 6 votes" in page.inner_text("#idea-content"))
        board = b.new_page(); board.goto(base); time.sleep(1.5)
        check("board shows the adjusted votes and the older date", "Phone request from Dana" in board.inner_text("#ideas") and "months ago" in board.inner_text("#ideas"))
        page.screenshot(path=os.path.join(tmp, "admin-add.png"), full_page=False)
        b.close()
finally:
    srv.terminate()
sys.exit(1 if failures else 0)
