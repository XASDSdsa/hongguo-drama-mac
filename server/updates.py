"""Self-hosted update releases, served by the existing owner login gateway."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
from threading import Lock
from urllib.parse import unquote, urlsplit
from uuid import uuid4

ROOT = Path(os.environ.get('UPDATE_DATA', '/data/updates'))
ORIGIN = 'https://license.91.200.243.95.sslip.io'
VERSION = r'[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}'
NAME = re.compile(rf'(?:changeFileName-Setup-({VERSION})\.exe(?:\.blockmap)?|release-({VERSION})\.json)\Z')
MAX_SIZE = 3 * 1024**3
LOCK = Lock()


def read_json(path):
    return json.loads(path.read_text('utf-8'))


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid4().hex)
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def current():
    try:
        version = read_json(ROOT / 'current.json')['version']
        if not re.fullmatch(VERSION, version):
            return None
        return read_json(ROOT / 'releases' / version / 'release.json')
    except (OSError, ValueError, KeyError, TypeError):
        return None


def csrf(handler, secret):
    return hmac.new(secret, b'updates:' + handler.headers.get('Cookie', '').encode(), hashlib.sha256).hexdigest()


def send(handler, status, body=b'', content_type='application/json; charset=utf-8', headers=()):
    handler.send_response(status)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
    for key, value in headers:
        handler.send_header(key, value)
    handler.end_headers()
    if handler.command != 'HEAD':
        handler.wfile.write(body)


def json_response(handler, status, data):
    send(handler, status, json.dumps(data, ensure_ascii=False).encode())


def file_response(handler, path):
    size = path.stat().st_size
    start, end, status = 0, size - 1, 200
    value = handler.headers.get('Range', '')
    if value:
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
        if not match or not any(match.groups()):
            send(handler, 416, headers=[('Content-Range', f'bytes */{size}')])
            return
        if match[1]:
            start = int(match[1])
            end = min(int(match[2]), end) if match[2] else end
        else:
            start = max(0, size - int(match[2]))
        if start > end or start >= size:
            send(handler, 416, headers=[('Content-Range', f'bytes */{size}')])
            return
        status = 206
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/octet-stream')
    handler.send_header('Content-Length', str(end - start + 1))
    handler.send_header('Accept-Ranges', 'bytes')
    handler.send_header('Cache-Control', 'public, max-age=31536000, immutable')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if status == 206:
        handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
    handler.end_headers()
    if handler.command == 'HEAD':
        return
    with path.open('rb') as source:
        source.seek(start)
        remaining = end - start + 1
        while remaining:
            block = source.read(min(1024**2, remaining))
            if not block:
                break
            handler.wfile.write(block)
            remaining -= len(block)


def publish(version, notes=None):
    if not isinstance(version, str) or not re.fullmatch(VERSION, version):
        raise ValueError('版本号格式不正确')
    folder = ROOT / 'releases' / version
    if (folder / 'release.json').is_file():
        release = read_json(folder / 'release.json')
    else:
        uploads = ROOT / 'uploads'
        release = read_json(uploads / f'release-{version}.json')
        name = f'changeFileName-Setup-{version}.exe'
        files = release.get('files', [])
        if (release.get('version') != version or len(files) != 1 or files[0].get('url') != name or
                release.get('path') != name or release.get('sha512') != files[0].get('sha512')):
            raise ValueError('更新说明与安装包不匹配')
        if release.get('updateType') == 'application-patch':
            size = files[0].get('size')
            if not isinstance(size, int) or not 0 < size <= 25 * 1024**2:
                raise ValueError('应用小包不得超过 25 MiB，不能用完整安装包替代')
            if not re.fullmatch(VERSION, str(release.get('minimumVersion', ''))):
                raise ValueError('小包缺少有效的最低兼容版本')
        installer = uploads / name
        blockmap = uploads / (name + '.blockmap')
        # A stopped promotion may already have moved one file; verify and resume it.
        if not installer.exists():
            installer = folder / name
        if not blockmap.exists():
            blockmap = folder / (name + '.blockmap')
        if not installer.is_file() or not blockmap.is_file():
            raise ValueError('请同时上传安装程序、blockmap 和 release JSON 三个文件')
        if installer.stat().st_size != files[0].get('size'):
            raise ValueError('安装包大小不匹配，不能发布')
        with installer.open('rb') as f:
            if f.read(2) != b'MZ':
                raise ValueError('安装包不是 Windows 程序')
            f.seek(0)
            digest = base64.b64encode(hashlib.file_digest(f, 'sha512').digest()).decode()
        with blockmap.open('rb') as f:
            block_digest = hashlib.file_digest(f, 'sha256').hexdigest()
        if digest != files[0]['sha512'] or block_digest != release.get('blockmapSha256'):
            raise ValueError('文件完整性校验失败，不能发布')
        if not isinstance(release.get('releaseNotes', ''), str) or len(release.get('releaseNotes', '')) > 10000:
            raise ValueError('更新说明无效')
        if notes is not None:
            if not isinstance(notes, str) or len(notes) > 10000:
                raise ValueError('更新说明无效')
            release['releaseNotes'] = notes
        folder.mkdir(parents=True, exist_ok=True)
        for source in [installer, blockmap]:
            os.replace(source, folder / source.name)
        atomic_json(folder / 'release.json', release)
        (uploads / f'release-{version}.json').unlink(missing_ok=True)
    atomic_json(ROOT / 'current.json', {'version': version})
    return release


def handle(handler, authenticated, secret):
    route = unquote(urlsplit(handler.path).path)
    public = route.startswith('/updates/windows/')
    admin = route == '/manage' or route.startswith('/admin/updates')
    if not public and not admin:
        return False
    try:
        if public:
            if handler.command not in ('GET', 'HEAD'):
                send(handler, 405)
            elif route == '/updates/windows/latest.yml':
                release = current()
                if not release:
                    release = {'version': '0.0.0', 'files': [], 'releaseDate': '2026-01-01T00:00:00.000Z'}
                else:
                    release = {**release, 'files': [{**release['files'][0], 'url': f"files/{release['version']}/{release['files'][0]['url']}"}],
                               'path': f"files/{release['version']}/{release['path']}"}
                send(handler, 200, json.dumps(release, ensure_ascii=False).encode(), 'application/yaml')
            else:
                match = re.fullmatch(rf'/updates/windows/files/({VERSION})/([^/]+)', route)
                file = ROOT / 'releases' / match[1] / match[2] if match and NAME.fullmatch(match[2]) else None
                if not file or not file.is_file() or file.suffix == '.json':
                    send(handler, 404)
                else:
                    file_response(handler, file)
            return True
        if not authenticated:
            if '/api/' in route or '/upload/' in route:
                json_response(handler, 401, {'error': '请先登录后台'})
            else:
                send(handler, 303, headers=[('Location', '/owner-login')])
            return True
        if handler.command in ('GET', 'HEAD'):
            if route in ('/manage', '/admin/updates', '/admin/updates/'):
                send(handler, 200, Path(__file__).with_name('updates.html').read_bytes(), 'text/html; charset=utf-8')
            elif route == '/admin/updates/ui.js':
                send(handler, 200, Path(__file__).with_name('updates-ui.js').read_bytes(), 'text/javascript; charset=utf-8')
            elif route == '/admin/updates/api/state':
                versions = [read_json(p) for p in sorted((ROOT / 'releases').glob('*/release.json'), key=lambda p: p.stat().st_mtime, reverse=True)]
                json_response(handler, 200, {'active': current(), 'versions': versions, 'csrf': csrf(handler, secret)})
            else:
                send(handler, 404)
            return True
        if (handler.command != 'POST' or handler.headers.get('Origin') != ORIGIN or
                handler.headers.get('Sec-Fetch-Site') == 'cross-site' or
                not hmac.compare_digest(handler.headers.get('X-CSRF-Token', ''), csrf(handler, secret))):
            send(handler, 403)
            return True
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_SIZE:
            raise ValueError('上传大小无效')
        if route.startswith('/admin/updates/upload/'):
            name = route.removeprefix('/admin/updates/upload/')
            match = NAME.fullmatch(name)
            if not match:
                raise ValueError('只接受本软件的安装程序、blockmap 和 release JSON')
            version = match[1] or match[2]
            if (ROOT / 'releases' / version / 'release.json').exists():
                raise ValueError('这个版本已发布，请使用新的版本号')
            if name.endswith('.json') and length > 64 * 1024:
                raise ValueError('更新说明过大')
            ROOT.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(ROOT).free < length + 256 * 1024**2:
                raise ValueError('服务器剩余空间不足')
            target = ROOT / 'uploads' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(name + '.' + uuid4().hex + '.part')
            try:
                handler.connection.settimeout(120)
                with temporary.open('xb') as f:
                    remaining = length
                    while remaining:
                        block = handler.rfile.read(min(1024**2, remaining))
                        if not block:
                            raise ValueError('上传中断，请重新上传')
                        f.write(block)
                        remaining -= len(block)
                with LOCK:
                    if (ROOT / 'releases' / version / 'release.json').exists():
                        raise ValueError('版本已发布，不允许覆盖')
                    os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            json_response(handler, 200, {'success': True, 'version': version, 'name': name})
        elif route in ('/admin/updates/api/publish', '/admin/updates/api/withdraw'):
            if length > 4096:
                raise ValueError('请求过大')
            data = json.loads(handler.rfile.read(length))
            with LOCK:
                if route.endswith('/publish'):
                    publish(data.get('version'), data.get('notes'))
                else:
                    active = current()
                    if not active or active['version'] != data.get('version'):
                        raise ValueError('当前发布版本已变化，请刷新后重试')
                    (ROOT / 'current.json').unlink(missing_ok=True)
            json_response(handler, 200, {'success': True})
        else:
            send(handler, 404)
    except (OSError, ValueError, KeyError, TypeError) as error:
        json_response(handler, 400, {'error': str(error) if isinstance(error, ValueError) else '文件不完整或格式不正确，请检查后重试'})
    return True
