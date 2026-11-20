"""Web login for the Keygate owner. This service is reachable only through Caddy."""
import base64
from collections import OrderedDict
import hashlib
import hmac
import html
import json
import os
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
import time
from urllib.parse import parse_qs, urlsplit
import updates

gateway = os.environ['OWNER_GATEWAY_TOKEN']
signing = os.environ['JWT_SECRET'].encode()
owner = json.loads(os.environ['OWNER_ACCOUNT'])
password_hash = bytes.fromhex(os.environ['OWNER_PASSWORD_SHA256'])
origin = 'https://license.91.200.243.95.sslip.io'
ttl = 3600
header = b'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
entries = ('/', '/owner-login', '/login')
attempts = OrderedDict()
lock = Lock()

def encoded(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')

def authenticated(cookie_header):
    try:
        cookies = SimpleCookie()
        cookies.load(cookie_header)
        token = cookies['session'].value.encode('ascii')
        if len(token) > 4096:
            return False
        alg, payload, sig = token.split(b'.')
        if alg != header:
            return False
        expected = encoded(hmac.new(signing, alg + b'.' + payload, hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return False
        claims = json.loads(base64.urlsafe_b64decode(payload + b'=' * (-len(payload) % 4)))
        return claims.get('uid') == owner['uid'] and claims.get('exp', 0) > time.time()
    except (KeyError, ValueError, TypeError, UnicodeError, CookieError):
        return False

def limited(ip, record=False):
    now = time.monotonic()
    with lock:
        count, expires = attempts.get(ip, (0, now + 300))
        if expires <= now:
            count, expires = 0, now + 300
        if record:
            attempts[ip] = (count + 1, expires)
            attempts.move_to_end(ip)
            while len(attempts) > 1024:
                attempts.popitem(last=False)
        return count >= 8

page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>changeFileName 管理后台</title>
<style>
:root{color-scheme:light dark;font:16px system-ui;color:#172337;background:#f2f5fa}
main{max-width:360px;margin:12vh auto 0;padding:28px;border:1px solid #97a7bd;border-radius:14px;background:Canvas}
h1{font-size:24px;margin:0 0 12px}p{line-height:1.55}
label{display:block;margin:16px 0 6px;font-weight:600}
input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border-radius:8px}
input{border:1px solid #8191a8;background:Field;color:FieldText}
button{margin-top:18px;color:white;background:#2357b5;border:none;cursor:pointer}
.error{color:#b33a41}
@media(prefers-color-scheme:dark){:root{background:#171d29;color:#eee}.error{color:#ffa2a2}}
</style>
<main><h1>changeFileName 管理后台</h1><p>登录后管理授权码与软件更新。</p>
<form method="post" action="/owner-login">
<label for="username">管理员</label>
<input id="username" name="username" value="license-owner" autocomplete="username" readonly>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">登录后台</button>
{error}
</form></main></html>'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def finish_response(self, status, body=b'', headers=()):
        self.send_response(status)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def allowed(self):
        if not hmac.compare_digest(self.headers.get('X-Owner-Gateway', '').encode(), gateway.encode()):
            self.finish_response(403)
            return False
        return True

    def form(self, status=200, message=''):
        error = '<p class="error" role="alert">' + html.escape(message) + '</p>' if message else ''
        body = page.replace('{error}', error).encode()
        self.finish_response(status, body, [('Content-Type', 'text/html; charset=utf-8')])

    def do_GET(self):
        if not self.allowed():
            return
        route = urlsplit(self.path).path
        logged_in = authenticated(self.headers.get('Cookie', ''))
        if updates.handle(self, logged_in, signing):
            return
        if route == '/_owner-verify':
            if logged_in:
                self.finish_response(204)
            elif self.headers.get('X-Forwarded-Uri', '').startswith('/api/'):
                self.finish_response(401, b'{"success":false,"error":{"code":"UNAUTHORIZED","message":"Sign in first"}}',
                                     [('Content-Type', 'application/json')])
            else:
                self.finish_response(303, headers=[('Location', '/owner-login')])
        elif route in entries:
            if logged_in:
                self.finish_response(303, headers=[('Location', '/manage')])
            else:
                self.form()
        else:
            self.finish_response(404)

    def do_POST(self):
        if not self.allowed():
            return
        if updates.handle(self, authenticated(self.headers.get('Cookie', '')), signing):
            return
        if self.path != '/owner-login':
            self.finish_response(404)
            return
        if (self.headers.get('Origin', origin) != origin or
            self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            self.finish_response(403)
            return
        ip = self.headers.get('X-Owner-Client', '')[:80]
        if limited(ip):
            self.form(429, '尝试次数过多，请几分钟后再试。')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096 or self.headers.get_content_type() != 'application/x-www-form-urlencoded':
                raise ValueError
            self.connection.settimeout(5)
            fields = parse_qs(self.rfile.read(length).decode('ascii'), max_num_fields=4)
            password = fields.get('password', [''])[0]
        except (ValueError, UnicodeError, TimeoutError):
            self.form(400, '登录请求无效，请重试。')
            return
        if not hmac.compare_digest(hashlib.sha256(password.encode()).digest(), password_hash):
            limited(ip, record=True)
            self.form(401, '密码不正确，请重新输入。')
            return
        with lock:
            attempts.pop(ip, None)
        now = int(time.time())
        claims = {**owner, 'adm': True, 'iat': now, 'exp': now + ttl}
        payload = encoded(json.dumps(claims, separators=(',', ':')).encode())
        signed = header + b'.' + payload
        jwt = (signed + b'.' + encoded(hmac.new(signing, signed, hashlib.sha256).digest())).decode()
        self.finish_response(303, headers=[
            ('Location', '/manage'),
            ('Set-Cookie', f'session={jwt}; Max-Age={ttl}; Path=/; HttpOnly; Secure; SameSite=Lax'),
        ])

    def do_HEAD(self):
        self.do_GET()

ThreadingHTTPServer(('0.0.0.0', 9100), Handler).serve_forever()
