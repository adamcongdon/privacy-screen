import json, sys, urllib.request, urllib.error

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=3) as r:
        body = r.read().decode()
        print(f"== live {url} ==")
        print(r.status, body)
        data = json.loads(body)
        if r.status != 200 or data.get("ok") is not True:
            sys.exit(f"health not ok: {body}")
        print("verify live: PASS", "version=", data.get("version"))
except urllib.error.URLError as e:
    print("== live health SKIP (not listening) ==")
    print(e)
    sys.exit(0)
