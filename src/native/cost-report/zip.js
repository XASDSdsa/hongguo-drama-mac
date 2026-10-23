'use strict';
// Word 文件（.docx）就是一个 zip。这里只做填报告要用的最小读写：按中央目录读出每个文件，改完再原样打包。
// 不支持 zip64 和加密（Word 存出来的报告用不到）。
const zlib = require('node:zlib');

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

/** zip → [{ name, data }]（按原来的顺序）。 */
function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('不是 Word 文件（docx）：读不到文件目录');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error('Word 文件目录坏了');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error('Word 文件加密了，读不了');
    if (buf.readUInt32LE(offset) !== LOCAL) throw new Error('Word 文件内容坏了');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Word 文件里有不认识的压缩方式（${method}）`);
    entries.push({ name, data });
  }
  return entries;
}

/** [{ name, data }] → zip（[Content_Types].xml 要排第一个，Word 才认）。 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 固定时间（1980-01-01）：同样的内容打出来的文件一模一样
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = zlib.crc32(body) >>> 0;
    const deflated = zlib.deflateRawSync(body, { level: 9 });
    const store = deflated.length >= body.length;
    const payload = store ? body : deflated;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(payload.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += head.length + nameBuf.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

module.exports = { readZip, writeZip };
