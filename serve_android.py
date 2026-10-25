"""Serve Invisible Worker over HTTPS so a real Android phone can install it as an app."""

from __future__ import annotations

import argparse
import http.server
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
CERT_DIR = ROOT / "data" / "certs"
CA_PEM = CERT_DIR / "ca.pem"
CA_KEY = CERT_DIR / "ca-key.pem"
SERVER_PEM = CERT_DIR / "server.pem"
SERVER_KEY = CERT_DIR / "server-key.pem"
SERVER_EXT = CERT_DIR / "server.ext"

CONF: dict[str, object] = {}

OPENSSL_CANDIDATES = (
    "openssl",
    r"C:\Program Files\Git\usr\bin\openssl.exe",
    r"C:\Program Files\Git\mingw64\bin\openssl.exe",
    r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
)


def find_openssl() -> str:
    for candidate in OPENSSL_CANDIDATES:
        found = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if found:
            return found
    raise SystemExit("openssl not found. Install Git for Windows or OpenSSL and retry.")


def candidate_ips() -> list[str]:
    ips: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(str(info[4][0]))
    except OSError:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        ips.insert(0, probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    def rank(ip: str) -> int:
        if ip.startswith(("127.", "169.254.")):
            return 9
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("10."):
            return 1
        if ip.startswith("172."):
            try:
                second = int(ip.split(".")[1])
            except (IndexError, ValueError):
                return 5
            return 2 if not 16 <= second <= 31 else 6
        return 3

    unique = list(dict.fromkeys(ips))
    unique.sort(key=rank)
    return [ip for ip in unique if rank(ip) < 9] or ["127.0.0.1"]


def run_openssl(*args: str) -> None:
    result = subprocess.run(
        [find_openssl(), *args],
        cwd=CERT_DIR,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"openssl failed: {' '.join(args)}\n{result.stderr.strip()}")


def cert_expiring_soon(path: Path, days: int = 30) -> bool:
    result = subprocess.run(
        [find_openssl(), "x509", "-checkend", str(days * 86400), "-noout", "-in", str(path)],
        capture_output=True,
    )
    return result.returncode != 0


def ensure_certificates(ip: str) -> None:
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    if not (CA_PEM.exists() and CA_KEY.exists()):
        run_openssl(
            "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
            "-keyout", CA_KEY.name, "-out", CA_PEM.name,
            "-subj", "/O=Invisible Worker/CN=Invisible Worker Local CA",
            "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        )

    ext = (
        f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}\n"
        "extendedKeyUsage=serverAuth\n"
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
    )
    stale_ext = SERVER_EXT.exists() and SERVER_EXT.read_text(encoding="utf-8") != ext
    if SERVER_PEM.exists() and SERVER_KEY.exists() and not stale_ext and not cert_expiring_soon(SERVER_PEM):
        return

    csr = CERT_DIR / "server.csr"
    run_openssl(
        "req", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", SERVER_KEY.name, "-out", csr.name,
        "-subj", "/O=Invisible Worker/CN=Invisible Worker",
    )
    SERVER_EXT.write_text(ext, encoding="utf-8")
    run_openssl(
        "x509", "-req", "-sha256", "-days", "397",
        "-in", csr.name, "-CA", CA_PEM.name, "-CAkey", CA_KEY.name, "-CAcreateserial",
        "-extfile", SERVER_EXT.name, "-out", SERVER_PEM.name,
    )
    csr.unlink(missing_ok=True)
    print(f"certificate issued for {ip}")


def install_page() -> str:
    app_origin = CONF["app_origin"]
    app_url = CONF["app_url"]
    http_url = CONF["http_url"]
    template = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#d9cdac" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#100d07" media="(prefers-color-scheme: dark)">
<title>Install Invisible Worker</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #d9cdac;
    --surface: rgba(255, 252, 243, .74);
    --ink: #241d10;
    --muted: #5d5340;
    --line: rgba(58, 48, 28, .18);
    --green: #0f6b46;
    --on-green: #fffcf4;
    --soft: rgba(255, 252, 243, .55);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14100a;
      --surface: rgba(48, 42, 27, .66);
      --ink: #f2ecdb;
      --muted: #b8ad94;
      --line: rgba(255, 255, 255, .14);
      --green: #58d191;
      --on-green: #10251b;
      --soft: rgba(255, 255, 255, .06);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 20px 40px;
    background:
      radial-gradient(120% 70% at 8% 0%, rgba(255, 255, 255, .35), transparent 60%),
      radial-gradient(120% 80% at 100% 0%, rgba(120, 96, 48, .22), transparent 55%),
      var(--bg);
    color: var(--ink);
    font: 16px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    min-height: 100dvh;
  }
  main { max-width: 470px; margin: 0 auto; }
  .eyebrow { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
  h1 { font-size: 1.65rem; line-height: 1.2; letter-spacing: -.02em; margin: 0 0 8px; font-weight: 600; }
  .lede { margin: 0 0 14px; color: var(--muted); font-size: 15px; }
  .status {
    display: inline-block; margin: 0 0 22px; padding: 7px 13px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--soft); font-size: 13px; font-weight: 600;
  }
  .status[data-state="ok"] { background: var(--green); color: var(--on-green); border-color: transparent; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 22px;
    padding: 18px 18px 20px;
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35);
  }
  .step { display: flex; align-items: center; gap: 9px; margin: 0 0 6px; font-weight: 600; font-size: 1.02rem; }
  .num {
    flex: none; width: 24px; height: 24px; border-radius: 50%;
    display: grid; place-items: center; font-size: 12.5px;
    background: var(--green); color: var(--on-green);
  }
  li p { margin: 0 0 12px; color: var(--muted); font-size: 14.5px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 20px; border-radius: 999px;
    background: var(--green); color: var(--on-green);
    font-weight: 600; font-size: 15px; text-decoration: none;
  }
  .btn--quiet { background: var(--soft); color: var(--ink); border: 1px solid var(--line); }
  code {
    display: block; margin: 12px 0 0; padding: 11px 13px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--soft);
    font: 13px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
    word-break: break-all; user-select: all;
  }
  details { margin: 0 0 12px; font-size: 14px; color: var(--muted); }
  summary { cursor: pointer; font-weight: 600; color: var(--ink); }
  details ol { list-style: decimal; padding-left: 20px; margin: 8px 0 0; display: block; }
  details li { background: none; border: 0; padding: 0; margin: 0 0 3px; border-radius: 0; box-shadow: none; backdrop-filter: none; }
  .note { margin: 18px 2px 0; font-size: 13px; color: var(--muted); }
  .note a { color: inherit; }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Invisible Worker</p>
  <h1>Put the demo on this phone</h1>
  <p class="lede">This phone and the laptop must be on the same Wi-Fi.</p>
  <p class="status" id="trust" data-state="wait">Checking the certificate&hellip;</p>

  <ol>
    <li>
      <p class="step"><span class="num">1</span> Install the certificate</p>
      <p>Chrome only installs a web app from a trusted HTTPS address. This downloads the laptop's local certificate authority.</p>
      <a class="btn" href="/ca.crt">Download certificate</a>
      <details>
        <summary>Where is that in Settings?</summary>
        <ol>
          <li>Open the downloaded .crt file, or Settings &rarr; Security &amp; privacy &rarr; More security settings &rarr; Encryption &amp; credentials &rarr; Install a certificate &rarr; CA certificate.</li>
          <li>Pick <em>invisible-worker-ca.crt</em> from Downloads.</li>
          <li>Android warns that your network may be monitored. That is expected for a certificate you installed yourself.</li>
        </ol>
      </details>
    </li>
    <li>
      <p class="step"><span class="num">2</span> Open the app</p>
      <p>If Chrome blocks the page, step 1 is not finished yet.</p>
      <a class="btn btn--quiet" href="{{APP_URL}}">Open Invisible Worker</a>
      <code>{{APP_URL}}</code>
    </li>
    <li>
      <p class="step"><span class="num">3</span> Install it</p>
      <p>In Chrome open the three-dot menu, then <strong>Install app</strong>. The icon lands on your home screen and opens full-screen, without an address bar.</p>
    </li>
  </ol>

  <p class="note">Skipping the certificate? The demo still runs in a normal browser tab at <a href="{{HTTP_URL}}">{{HTTP_URL}}</a>.</p>
</main>
<script>
  const pill = document.getElementById("trust");
  fetch("{{APP_ORIGIN}}/health", { mode: "no-cors", cache: "no-store" })
    .then(() => {
      pill.textContent = "Certificate installed. Ready to install.";
      pill.dataset.state = "ok";
    })
    .catch(() => {
      pill.textContent = "Certificate not installed yet";
      pill.dataset.state = "wait";
    });
</script>
</body>
</html>
"""
    return (
        template.replace("{{APP_URL}}", app_url)
        .replace("{{APP_ORIGIN}}", app_origin)
        .replace("{{HTTP_URL}}", http_url)
    )


class InstallHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", install_page().encode("utf-8"))
        elif path == "/ca.crt":
            self._send(
                200,
                "application/x-x509-ca-cert",
                CA_PEM.read_bytes(),
                {"Content-Disposition": 'attachment; filename="invisible-worker-ca.crt"'},
            )
        elif path == "/health":
            self._send(200, "text/plain; charset=utf-8", b"ok")
        elif path == "/app":
            self.send_response(302)
            self.send_header("Location", str(CONF["app_url"]))
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send(404, "text/plain; charset=utf-8", b"not found")

    def _send(self, code: int, ctype: str, body: bytes, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        pass


class HelperServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: object, client_address: object) -> None:
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def print_qr(url: str) -> None:
    try:
        import qrcode

        qr = qrcode.QRCode(border=4)
        qr.add_data(url)
        qr.make()
        qr.print_ascii(invert=True)
    except Exception:
        print("(install the qrcode package to get a scannable terminal QR code)")


TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
CLOUDFLARED_DOWNLOAD = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"


def ensure_cloudflared() -> str:
    local = ROOT / "data" / "bin" / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if local.exists():
        return str(local)
    found = shutil.which("cloudflared")
    if found:
        return found
    if os.name != "nt":
        raise SystemExit("cloudflared not found. Install it and put it on PATH, then retry.")
    local.parent.mkdir(parents=True, exist_ok=True)
    print("downloading cloudflared (~55 MB, one time) ...")
    request = urllib.request.Request(CLOUDFLARED_DOWNLOAD, headers={"User-Agent": "invisible-worker-demo"})
    with urllib.request.urlopen(request, timeout=300) as response, local.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return str(local)


def ensure_local_app(port: int):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            if response.status == 200:
                print(f"reusing the app already served on port {port}")
                return None
    except Exception:
        pass

    import uvicorn

    from backend.main import app as fastapi_app

    server = uvicorn.Server(
        uvicorn.Config(fastapi_app, host="0.0.0.0", port=port, log_level="warning", access_log=False)
    )
    thread = threading.Thread(target=server.run, name="uvicorn-http", daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        if not thread.is_alive():
            raise SystemExit(f"port {port} is taken by another program; pass --http-port with a free port")
        time.sleep(0.1)
    if not server.started:
        raise SystemExit(f"the app did not start on port {port}")
    return server


def drain(stream) -> None:
    for _ in stream:
        pass


def run_tunnel(port: int) -> None:
    server = ensure_local_app(port)
    binary = ensure_cloudflared()
    process = subprocess.Popen(
        [binary, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    public = None
    try:
        deadline = time.time() + 90
        while time.time() < deadline and process.poll() is None:
            line = process.stdout.readline()
            match = TUNNEL_URL_RE.search(line)
            if match:
                public = match.group(0)
                break
        if not public:
            raise SystemExit("cloudflared did not return a public URL; check that this laptop is online")

        threading.Thread(target=drain, args=(process.stdout,), daemon=True).start()

        print()
        print("Invisible Worker - public demo")
        print(f"  phone URL   {public}/ui/")
        print("  Chrome on the phone: open that URL, then three-dot menu > Install app.")
        print("  The link is public and temporary while this window stays open.")
        print()
        print_qr(f"{public}/ui/")
        print()
        while process.poll() is None:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        if server is not None:
            server.should_exit = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ip", help="laptop LAN IP to put on the certificate (auto-detected by default)")
    parser.add_argument("--app-port", type=int, default=8443, help="HTTPS port for the app")
    parser.add_argument("--helper-port", type=int, default=8080, help="plain HTTP port for this install page")
    parser.add_argument("--no-open", action="store_true", help="do not open the install page in the local browser")
    parser.add_argument(
        "--tunnel",
        action="store_true",
        help="publish a temporary public HTTPS link (no certificate install on the phone)",
    )
    parser.add_argument("--http-port", type=int, default=8000, help="port the tunnel forwards to")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.tunnel:
        run_tunnel(args.http_port)
        return

    ip = args.ip or candidate_ips()[0]
    app_origin = f"https://{ip}:{args.app_port}"
    CONF.update(
        ip=ip,
        app_origin=app_origin,
        app_url=f"{app_origin}/ui/",
        http_url=f"http://{ip}:8000/ui/",
    )

    ensure_certificates(ip)

    sys.path.insert(0, str(ROOT))
    import uvicorn

    from backend.main import app as fastapi_app

    config = uvicorn.Config(
        fastapi_app,
        host="0.0.0.0",
        port=args.app_port,
        ssl_certfile=str(SERVER_PEM),
        ssl_keyfile=str(SERVER_KEY),
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="uvicorn-https", daemon=True)
    thread.start()

    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        if not thread.is_alive():
            raise SystemExit("the HTTPS server stopped during startup")
        time.sleep(0.1)
    if not server.started:
        raise SystemExit(f"the HTTPS server did not start on port {args.app_port}")

    helper = HelperServer(("0.0.0.0", args.helper_port), InstallHandler)
    helper_url = f"http://{ip}:{args.helper_port}/"

    print()
    print("Invisible Worker - Android install")
    print(f"  install page on the phone   {helper_url}")
    print(f"  app over HTTPS              {app_origin}/ui/")
    print(f"  app over plain HTTP         {CONF['http_url']}  (needs the normal server on port 8000)")
    print()
    print("  1. Scan the QR code below on the phone.")
    print("  2. Download the certificate and install it as a CA certificate.")
    print("  3. Open the app, then Chrome menu > Install app.")
    print("  If the phone cannot connect, allow private-network access when Windows Firewall asks.")
    print()
    print_qr(helper_url)
    print()

    if not args.no_open:
        threading.Thread(target=lambda: webbrowser.open(helper_url), daemon=True).start()

    try:
        helper.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        helper.shutdown()
        server.should_exit = True
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
