import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
from threading import Thread
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('updates', Path(__file__).parent.parent / 'server/updates.py')
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)
secret = b'test-secret'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not updates.handle(self, self.headers.get('Cookie') == 'session=test', secret):
            self.send_error(404)
    do_POST = do_GET
    do_HEAD = do_GET
    def log_message(self, *_):
        pass


with tempfile.TemporaryDirectory() as temporary:
    updates.ROOT = Path(temporary)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:' + str(server.server_port)
    token = ''

    def request(route, data=None, logged=True, csrf=True, origin=updates.ORIGIN, headers=None, method=None):
        fields = dict(headers or {})
        if logged:
            fields['Cookie'] = 'session=test'
        if data is not None:
            fields['Origin'] = origin
            if csrf:
                fields['X-CSRF-Token'] = token
        req = urllib.request.Request(base + route, data=data, headers=fields, method=method)
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), response.headers

    try:
        assert request('/admin/updates/api/state', logged=False)[0] == 401
        code, body, _ = request('/admin/updates/api/state')
        assert code == 200
        token = json.loads(body)['csrf']
        endpoint = '/admin/updates/api/publish'
        assert request(endpoint, b'{"version":"1.2.51"}', csrf=False)[0] == 403
        assert request(endpoint, b'{"version":"1.2.51"}', origin='https://attacker.invalid')[0] == 403
        assert request(endpoint, b'{"version":"1.2.51"}')[0] == 400
        assert request('/admin/updates/upload/../oops.exe', b'MZ')[0] == 400
        assert request('/updates/windows/files/1.2.51/%2e%2e%2fcurrent.json', logged=False)[0] == 404
        payload = b'MZ' + bytes(range(256)) * 100
        name = 'changeFileName-Setup-1.2.51.exe'
        block = b'test-blockmap'
        digest = base64.b64encode(hashlib.sha512(payload).digest()).decode()
        release = {'version': '1.2.51', 'files': [{'url': name, 'size': len(payload), 'sha512': digest}],
                   'path': name, 'sha512': digest, 'blockmapSha256': hashlib.sha256(block).hexdigest(),
                   'releaseDate': '2026-11-13T00:00:00.000Z', 'releaseNotes': '<script>never execute</script>'}
        for file, data in [(name, payload), (name + '.blockmap', block), ('release-1.2.51.json', json.dumps(release).encode())]:
            assert request('/admin/updates/upload/' + file, data)[0] == 200
        (updates.ROOT / 'uploads' / name).write_bytes(payload + b'corrupt')
        assert request(endpoint, b'{"version":"1.2.51"}')[0] == 400
        assert updates.current() is None
        assert request('/admin/updates/upload/' + name, payload)[0] == 200
        assert request(endpoint, b'{"version":"1.2.51"}')[0] == 200
        assert updates.current()['version'] == '1.2.51'
        code, body, _ = request('/updates/windows/latest.yml', logged=False)
        info = json.loads(body)
        assert code == 200 and info['files'][0]['sha512'] == digest
        file_url = '/updates/windows/' + info['files'][0]['url']
        code, body, headers = request(file_url, logged=False, headers={'Range': 'bytes=3-15'})
        assert code == 206 and body == payload[3:16] and headers['Content-Range'].startswith('bytes 3-15/')
        assert request(file_url, logged=False, method='HEAD')[2]['Content-Length'] == str(len(payload))
        assert request(file_url, logged=False, headers={'Range': 'bytes=999999-9999999'})[0] == 416
        assert request('/admin/updates/upload/' + name, payload)[0] == 400
        assert request('/admin/updates/api/withdraw', b'{"version":"1.2.50"}')[0] == 400
        assert request('/admin/updates/api/withdraw', b'{"version":"1.2.51"}')[0] == 200
        assert json.loads(request('/updates/windows/latest.yml', logged=False)[1])['version'] == '0.0.0'
        assert request(endpoint, b'{"version":"1.2.51"}')[0] == 200
        assert updates.current()['version'] == '1.2.51'
        print('PASS update server: same-login access, CSRF/origin, traversal, atomic verified publication, immutable artifacts, Range/HEAD, withdraw and republish')
    finally:
        server.shutdown()
        server.server_close()
