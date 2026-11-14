"""Archive an accepted quick build as a small, permanent build/test baseline."""
import hashlib
import json
import struct
import sys
import zipfile

source, output = sys.argv[1:]
with zipfile.ZipFile(source) as old, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as new:
    manifest = json.loads(old.read('manifest.json'))
    assert manifest['version'] == '1.2.51'
    exe = old.read('changeFileName.exe')
    assert hashlib.sha256(exe).hexdigest() == manifest['sha256']['changeFileName.exe']
    pe = struct.unpack_from('<I', exe, 60)[0]
    optional = pe + 24
    sections = optional + struct.unpack_from('<H', exe, pe + 20)[0]
    ranges = [{'offset': 0, 'size': struct.unpack_from('<I', exe, optional + 60)[0]}]
    for i in range(struct.unpack_from('<H', exe, pe + 6)[0]):
        p = sections + i * 40
        if exe[p:p+8].split(b'\0')[0] == b'.rsrc':
            size, offset = struct.unpack_from('<II', exe, p + 16)
            ranges.append({'offset': offset, 'size': size})
    assert len(ranges) == 2
    invariant = hashlib.sha256()
    offset = 0
    for i, part in enumerate(ranges):
        invariant.update(exe[offset:part['offset']])
        offset = part['offset'] + part['size']
        part['file'] = f'base-exe-part-{i}.bin'
        new.writestr(part['file'], exe[part['offset']:offset])
    invariant.update(exe[offset:])
    baseline = {'version': manifest['version'], 'size': len(exe), 'sha256': manifest['sha256']['changeFileName.exe'],
                'immutableSha256': invariant.hexdigest(), 'parts': ranges}
    new.writestr('baseline.json', json.dumps(baseline, indent=2))
    for name in old.namelist():
        if name in ('app.asar', 'app-update.yml', 'manifest.json') or (
            name.startswith('hongguo-player/') and not name.startswith('hongguo-player/runtime/') and not name.endswith('/')
        ):
            data = old.read(name)
            assert hashlib.sha256(data).hexdigest() == manifest['sha256'].get(name, hashlib.sha256(data).hexdigest())
            new.writestr(name, data)
print('Created small build baseline; no Electron executable body or JRE included:', output)
