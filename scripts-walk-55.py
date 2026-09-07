#!/usr/bin/env python3
# Tier-2 walk for oauth3-server #55 — /oauth3/app connect→approve→items, extension ABSENT.
# Drives the envoy bridge (real Brave, real pointer events; no CDP). One drivable tab:
#   run 1 walks the consent UI with real clicks (shots 01-03),
#   run 2 completes connect→approve→items in the live page (shot 04; the approve POST is
#   fired from page context — the same endpoint+session the walked button uses — because
#   the bridge cannot hold a second tab; documented in flow.md).
import json, time, urllib.request, sys, os, base64

BRIDGE = "http://localhost:3002/api/bridge"
EVDIR = os.path.expanduser("/tmp/oa-55/.evidence/issue-55")
os.makedirs(EVDIR, exist_ok=True)
staging = [l.split("=", 1)[1].strip() for l in open(os.path.expanduser("~/projects/oauth3-apps/.staging-env")) if l.startswith("WEBHOST_STAGING")][0]
APP = staging + "/oauth3/app?plugin=reddit"
USERKEY = open(os.path.expanduser("~/.paseo-secrets/swarm-userkey")).read().strip()

def call(tool, args, timeout=45):
    req = urllib.request.Request(BRIDGE, data=json.dumps({"id": tool + str(time.time()), "tool": tool, "args": args}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def ev(js):
    r = call("evaluate", [js])
    if not r.get("success"): raise RuntimeError("evaluate failed: " + json.dumps(r))
    return r["result"]

def nav(url):
    r = call("navigate", [url])
    if not r.get("success"): raise RuntimeError("navigate failed: " + json.dumps(r))
    time.sleep(2.5)

def shot(name):
    r = call("screenshot", [])
    b64 = (r.get("result") or "").replace("data:image/png;base64,", "")
    if not b64: raise RuntimeError("empty screenshot " + name)
    open(os.path.join(EVDIR, name), "wb").write(base64.b64decode(b64))
    print(f"  shot {name} ({len(b64)//1024}KB b64)")

def die(msg):
    print("FAIL:" + msg); sys.exit(1)

# --- u-swarm session over the real API (rig identity; browser gets it where the login page keeps it)
login = json.load(urllib.request.urlopen(urllib.request.Request(
    staging + "/oauth3/api/login", data=json.dumps({"userKey": USERKEY}).encode(),
    headers={"Content-Type": "application/json"}), timeout=20))
if not login.get("session"): die("u-swarm login failed: " + json.dumps(login))
print("SUBJECT=" + login["subject"])

# --- run 1: consent UI walk
nav(APP)
print("href:", ev("location.href"))
provider = ev("typeof globalThis.oauth3")
print("provider object before neutralize:", provider)
if provider != "undefined":
    ev("globalThis.oauth3 = undefined; 'neutralized'")
    print("provider neutralized (extension installed in rig; provider object removed pre-click — see flow.md)")
ev(f"localStorage.setItem('oauth3_session', '{login['session']}'); 'session-set'")
print("provider after neutralize:", ev("typeof globalThis.oauth3"))

r = call("click", ["#login"])
if not r.get("success"): die("click #login failed: " + json.dumps(r))
print("clicked #login (real pointer)")
for i in range(10):
    time.sleep(1.5)
    href = ev("(document.querySelector('#approve a')||{}).href || ''")
    if href: break
if not href: die("approve link never rendered — page state: " + ev("document.getElementById('result').innerHTML")[:300] + " / approve:" + ev("document.getElementById('approve').innerHTML")[:200])
print("approveUrl:", href)
no_deadend = ev("document.body.innerHTML.includes('extension not found')") == False
print("no 'extension not found' dead end:", no_deadend)
if not no_deadend: die("dead end text present")
shot("01-approve-link-rendered.png")

reqid = href.rstrip("/").split("/approve/")[-1]
approve_url = staging + "/oauth3/approve/" + reqid
nav(approve_url)
got = ev("location.href")
print("approve page href:", got)
if "/approve/" not in got: die("approve page did not load")
time.sleep(1.5)
print("approve buttons:", ev("JSON.stringify([...document.querySelectorAll('button')].map(b=>[b.id,b.className,b.textContent.trim().slice(0,40)]))"))
shot("02-consent-screen.png")

# real click the Approve button
picked = ev("""(()=>{const bs=[...document.querySelectorAll('button')];
  const b=bs.find(x=>/approve/i.test(x.textContent)&&!/steer/i.test(x.id))||bs.find(x=>/approve/i.test(x.textContent));
  if(!b) return 'NONE'; b.setAttribute('data-walk','1'); return b.className||b.id;})()""")
if picked == "NONE": die("no approve button found")
r = call("click", ["button[data-walk='1']"])
print("clicked approve button (real pointer):", r.get("success"))
for i in range(8):
    time.sleep(1.2)
    msg = ev("(document.querySelector('.msg,#msg,.note')||{}).textContent || document.body.innerText.slice(0,200)")
    if "pproved" in msg: break
print("approve page says:", msg[:160])
shot("03-approved.png")

# --- run 2: end-to-end connect→approve→items in the live page
nav(APP)
if ev("typeof globalThis.oauth3") != "undefined": ev("globalThis.oauth3 = undefined; 'neutralized'")
r = call("click", ["#login"])
if not r.get("success"): die("run2 click #login failed")
for i in range(10):
    time.sleep(1.5)
    href2 = ev("(document.querySelector('#approve a')||{}).href || ''")
    if href2: break
if not href2: die("run2: approve link never rendered")
reqid2 = href2.rstrip("/").split("/approve/")[-1]
print("run2 approveUrl:", href2)
# approve from page context — same endpoint+session the walked button posts to
ap = ev(f"""fetch('api/connect/{reqid2}/approve',{{method:'POST',headers:{{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('oauth3_session')}},body:'{{}}'}}).then(r=>r.status).catch(e=>'ERR:'+e);'fired'""")
print("run2 approve POST fired:", ap)
# the page's own poll should now adopt the token and render items
ok = False
for i in range(20):
    time.sleep(1.5)
    pill = ev("document.getElementById('token').textContent")
    rows = ev("document.querySelectorAll('.row').length")
    if "scoped token" in pill and int(rows or 0) > 0:
        ok = True; break
if not ok:
    die("run2: items never rendered — pill=" + pill + " rows=" + str(rows) + " result=" + ev("document.getElementById('result').innerText.slice(0,300)"))
items_line = ev("[...document.querySelectorAll('.block div')].map(d=>d.textContent.trim()).join(' | ')")
print("run2 OK: pill=%r rows=%s items-line=%r" % (pill, rows, items_line))
# privacy overlay (public repo; reddit saved-post titles are personal data)
ev("""(()=>{const o=document.createElement('div');o.style.cssText='position:fixed;left:0;right:0;bottom:0;background:#b4441f;color:#fff;font:700 13px monospace;padding:10px 14px;z-index:9999';o.textContent='EVIDENCE REDACTION: item titles below are real but hidden in this shot — personal data (public repo). Count is asserted and logged in flow.md.';document.body.appendChild(o);document.querySelectorAll('.row b').forEach(b=>b.textContent='[title hidden — personal data]');'overlay' })()""")
time.sleep(0.6)
shot("04-items-rendered.png")
print("ALL-WALK-STEPS-DONE")
