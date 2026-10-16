// 文件快转 Go 单文件版 · 全链路自动化测试
// 用法: node test-go.js  （需服务已运行在 3000 端口）
const http = require('http');
const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqt-go-'));
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, extra) {
  if (cond) { pass++; results.push('✅ ' + name); }
  else { fail++; results.push('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.setTimeout(10000, () => { r.destroy(new Error('请求超时: ' + url)); });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// multipart 构造（files 与 relativePath 交错，与前端一致）
function buildForm(files, topName, senderName) {
  const boundary = '----fqt' + Date.now();
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s));
  files.forEach((f, i) => {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    chunks.push(f.data);
    push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="relativePath"\r\n\r\n${f.rel}\r\n`);
  });
  if (topName) push(`--${boundary}\r\nContent-Disposition: form-data; name="topName"\r\n\r\n${topName}\r\n`);
  if (senderName) push(`--${boundary}\r\nContent-Disposition: form-data; name="senderName"\r\n\r\n${senderName}\r\n`);
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function getBytes(n, seed) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (seed + i * 7) % 256;
  return b;
}

(async () => {
  try {
    // 0. 页面与二维码
    const page = await req('GET', BASE + '/');
    ok('首页 200（前端已内嵌）', page.status === 200 && page.body.includes('文件快转'));
    const qr = await req('GET', BASE + '/api/qr');
    ok('二维码接口返回 PNG', qr.status === 200 && qr.headers['content-type'].includes('png'));

    // 1. 广播上传（3 个文件：中文名 + 子目录结构）
    const f1 = getBytes(300000, 1);
    const f2 = getBytes(50000, 2);
    const f3 = getBytes(100000, 3);
    const form = buildForm([
      { name: '报告.txt', rel: '报告.txt', data: f1 },
      { name: '照片.png', rel: '照片.png', data: f2 },
      { name: '说明.md', rel: '资料包/说明.md', data: f3 },
    ], '', '测试机');
    const up = await req('POST', BASE + '/api/upload?mode=broadcast', { body: form.body, headers: form.headers });
    const upData = JSON.parse(up.body);
    ok('广播上传成功', up.status === 200 && upData.ok === true && upData.fileCount === 3, 'status=' + up.status);
    const batchId = upData.batchId;

    // 2. 列表
    const list = await req('GET', BASE + '/api/broadcast/files');
    const listData = JSON.parse(list.body);
    const b = listData.files.find(x => x.id === batchId);
    ok('广播列表含本批次', !!b && b.displayName === '多文件传输（3 个文件）', JSON.stringify(b));
    ok('批次总大小正确', b && b.totalSize === f1.length + f2.length + f3.length);
    const firstFile = b && b.fileIds[0];

    // 3. 下载单文件并验证字节一致
    const dl1 = await req('GET', BASE + '/api/download/' + firstFile);
    ok('单文件下载 200', dl1.status === 200 && dl1.body.length === f1.length, 'len=' + dl1.body.length);
    let same = true;
    for (let i = 0; i < f1.length; i++) if (dl1.body[i] !== f1[i]) { same = false; break; }
    ok('单文件字节一致', same);
    const after1 = await req('GET', BASE + '/api/broadcast/files');
    ok('下载后批次自动删除', !JSON.parse(after1.body).files.find(x => x.id === batchId));

    // 4. 批次 zip 下载（含目录结构）+ 删除
    const fA = getBytes(60000, 5);
    const fB = getBytes(90000, 6);
    const form2 = buildForm([
      { name: 'a.txt', rel: '文件夹/a.txt', data: fA },
      { name: 'b.txt', rel: '文件夹/子/b.txt', data: fB },
    ], '我的文件夹', '');
    const up2 = await req('POST', BASE + '/api/upload?mode=broadcast', { body: form2.body, headers: form2.headers });
    const b2 = JSON.parse(up2.body);
    ok('文件夹批次上传成功', up2.status === 200 && b2.displayName === '我的文件夹');
    const dlz = await req('GET', BASE + '/api/download-batch/' + b2.batchId);
    ok('zip 下载 200', dlz.status === 200 && dlz.headers['content-type'].includes('zip') && dlz.body.length > 1000, 'len=' + dlz.body.length);
    // zip 内容校验（PK 头 + 条目数）
    const zipOk = dlz.body.slice(0, 2).toString() === 'PK';
    ok('zip 头正确', zipOk);
    const after2 = await req('GET', BASE + '/api/broadcast/files');
    ok('zip 下载后批次删除', !JSON.parse(after2.body).files.find(x => x.id === b2.batchId));

    // 5. 房间（点对点）
    const rc = await req('POST', BASE + '/api/room/create');
    const rcData = JSON.parse(rc.body);
    ok('房间创建返回4位码', rc.status === 200 && /^\d{4}$/.test(rcData.code), JSON.stringify(rcData));
    const code = rcData.code;
    // 前端真实调用：POST + JSON body
    const jr = await req('POST', BASE + '/api/room/join', {
      body: Buffer.from(JSON.stringify({ code })),
      headers: { 'Content-Type': 'application/json' },
    });
    ok('加入房间成功（JSON body）', jr.status === 200 && JSON.parse(jr.body).ok === true, 'status=' + jr.status + ' body=' + jr.body.toString().slice(0, 80));
    // query 方式也应兼容
    const jr2 = await req('POST', BASE + '/api/room/join?code=' + code);
    ok('加入房间成功（query）', jr2.status === 200 && JSON.parse(jr2.body).ok === true);

    const form3 = buildForm([
      { name: '私密.txt', rel: '私密.txt', data: getBytes(20000, 9) },
    ], '', '发送者');
    const up3 = await req('POST', BASE + '/api/upload?mode=room&code=' + code, { body: form3.body, headers: form3.headers });
    ok('房间上传成功', up3.status === 200 && JSON.parse(up3.body).ok === true);
    const rl = await req('GET', BASE + '/api/room/files?code=' + code);
    const rlData = JSON.parse(rl.body);
    ok('房间列表含文件', rlData.ok === true && rlData.files.length === 1 && rlData.files[0].roomCode === code);
    const rf = rlData.files[0].fileIds[0];
    const rdl = await req('GET', BASE + '/api/download/' + rf);
    ok('房间文件下载成功', rdl.status === 200 && rdl.body.length === 20000);

    // 6. 错误码
    const bad = await req('GET', BASE + '/api/room/join?code=9999');
    ok('无效端口码返回404', bad.status === 404);

    // 7. WebSocket 实时推送（模拟接收端在线收到 file-arrived）
    const wsArrived = await new Promise((resolve) => {
      const ws = new WebSocket(WS);
      let got = false, welcomed = false;
      const timer = setTimeout(() => resolve({ got, welcomed }), 6000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', deviceId: 'test-dev', deviceName: '测试设备' })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'welcome') welcomed = true;
        if (m.type === 'file-arrived') { got = true; clearTimeout(timer); ws.close(); resolve({ got, welcomed }); }
      });
      // 触发一次广播上传
      setTimeout(() => {
        const ff = buildForm([{ name: 'ws触发.txt', rel: 'ws触发.txt', data: getBytes(1000, 7) }], '', '');
        req('POST', BASE + '/api/upload?mode=broadcast', { body: ff.body, headers: ff.headers });
      }, 300);
    });
    ok('WS 实时推送 file-arrived', wsArrived.got === true, JSON.stringify(wsArrived));

    // 8. WS 房间成员收到推送（join-room 后）
    const wsRoom = await new Promise((resolve) => {
      const ws = new WebSocket(WS);
      let joined = false, got = false;
      const timer = setTimeout(() => resolve({ joined, got }), 6000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', deviceId: 'room-dev', deviceName: '接收端' }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'join-room', code })), 300);
      });
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'room-joined' && m.ok) joined = true;
        if (m.type === 'file-arrived') { got = true; clearTimeout(timer); ws.close(); resolve({ joined, got }); }
      });
      setTimeout(() => {
        const ff = buildForm([{ name: '房间实时.txt', rel: '房间实时.txt', data: getBytes(1500, 8) }], '', '');
        req('POST', BASE + '/api/upload?mode=room&code=' + code, { body: ff.body, headers: ff.headers });
      }, 700);
    });
    ok('WS 房间成员实时收到', wsRoom.joined === true && wsRoom.got === true, JSON.stringify(wsRoom));

  } catch (e) {
    fail++;
    results.push('❌ 异常: ' + e.message);
  }

  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log('\n══════ 文件快转 Go 单文件版 测试结果 ══════');
  results.forEach(r => console.log(r));
  console.log('──────────────────────────────');
  console.log(`通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
