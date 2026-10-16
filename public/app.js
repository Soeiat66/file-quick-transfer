/* 文件快转 —— 前端交互逻辑 */
(function () {
  'use strict';

  // ---------------- 基础工具 ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2600);
  }

  function uuid() {
    return (crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));
  }

  // ---------------- 设备身份 ----------------
  const DEVICE_ID_KEY = 'fqt_device_id';
  const DEVICE_NAME_KEY = 'fqt_device_name';
  let deviceId = localStorage.getItem(DEVICE_ID_KEY) || (localStorage.setItem(DEVICE_ID_KEY, uuid()), localStorage.getItem(DEVICE_ID_KEY));
  let deviceName = localStorage.getItem(DEVICE_NAME_KEY) || '我的设备-' + Math.floor(1000 + Math.random() * 9000);

  const nameInput = $('#device-name');
  nameInput.value = deviceName;
  nameInput.addEventListener('change', () => {
    deviceName = nameInput.value.trim() || deviceName;
    localStorage.setItem(DEVICE_NAME_KEY, deviceName);
    sendHello();
    toast('设备名已更新');
  });

  // ---------------- WebSocket ----------------
  const API = location.origin;
  let ws = null;
  let wsOnline = false;

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  }

  function sendHello() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'hello', deviceId, deviceName }));
    }
  }

  function connectWs() {
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      wsOnline = true;
      setNetStatus(true);
      sendHello();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleWs(msg);
    };
    ws.onclose = () => {
      wsOnline = false;
      setNetStatus(false);
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* 忽略 */ } };
  }

  let reconnectTimer = null;
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 2000);
  }

  function setNetStatus(ok) {
    const el = $('#net-status');
    const txt = $('#net-status-text');
    if (ok) {
      el.classList.remove('offline');
      txt.textContent = '已连接服务';
      const st = $('#recv-live-status');
      if (st) { st.classList.remove('offline'); st.lastElementChild.textContent = '已连接，等待文件送达…'; }
    } else {
      el.classList.add('offline');
      txt.textContent = '连接断开，正在重连…';
      const st = $('#recv-live-status');
      if (st) { st.classList.add('offline'); st.lastElementChild.textContent = '连接断开，正在重连…'; }
    }
  }

  // ---------------- 状态 ----------------
  // 广播接收列表：batchId -> batch
  const liveBatches = new Map();
  // 房间接收列表：batchId -> batch
  const roomBatches = new Map();
  let currentRoomCode = null;

  function handleWs(msg) {
    switch (msg.type) {
      case 'welcome':
        updateDevices(msg.devices);
        break;
      case 'devices':
        updateDevices(msg.devices);
        break;
      case 'file-arrived': {
        const b = msg.batch;
        if (b.scope === 'broadcast') {
          liveBatches.set(b.id, b);
          renderLiveRecv();
          renderLiveDone(b);
          notifyArrived(b);
        } else if (b.scope === 'room' && currentRoomCode && b.roomCode === currentRoomCode) {
          roomBatches.set(b.id, b);
          renderRoomRecv();
          renderRoomDone(b);
          notifyArrived(b);
        } else if (b.scope === 'room') {
          // 属于其他房间的文件：仅当发送端自己创建的房间时提示
        }
        break;
      }
      case 'file-removed': {
        if (liveBatches.has(msg.batchId)) {
          liveBatches.delete(msg.batchId);
          renderLiveRecv();
        }
        if (roomBatches.has(msg.batchId)) {
          roomBatches.delete(msg.batchId);
          renderRoomRecv();
        }
        break;
      }
      case 'room-joined': {
        if (msg.ok) {
          currentRoomCode = msg.code;
          roomBatches.clear();
          (msg.files || []).forEach(b => roomBatches.set(b.id, b));
          renderRoomRecv();
          toast('已加入端口码 ' + msg.code + '，新文件将实时出现');
          $('#recv-room-hint').textContent = '已加入端口码 ' + msg.code + '，对方新上传的文件将实时出现。';
        } else {
          toast(msg.error || '加入失败');
        }
        break;
      }
    }
  }

  function updateDevices(devices) {
    const n = Array.isArray(devices) ? devices.length : 0;
    $('#online-count').textContent = n;
    if (n === 0) {
      $('#recv-devices').innerHTML = '<span style="color:var(--text-3)">暂无其他在线设备</span>';
    } else {
      $('#recv-devices').textContent = devices.map(d => d.name + (d.ip ? `（${d.ip}）` : '')).join('、');
    }
  }

  // ---------------- 视图切换 ----------------
  const views = { home: $('#view-home'), send: $('#view-send'), receive: $('#view-receive') };
  function go(view) {
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== view));
    window.scrollTo(0, 0);
    if (view === 'receive' && liveBatches.size === 0) refreshBroadcastList();
  }
  $$('[data-go]').forEach(btn => btn.addEventListener('click', () => go(btn.dataset.go)));

  // 标签切换
  $$('.tabs').forEach(tabs => {
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      const panelId = tab.dataset.tab;
      $$('#' + tabs.closest('.view').id + ' .tab-panel').forEach(p => {
        p.classList.toggle('hidden', p.id !== panelId);
      });
    });
  });

  // ---------------- 文件选择 ----------------
  // 递归读取拖拽进来的文件夹结构（Chrome/Edge/桌面 Safari 支持）
  async function readEntry(entry, base) {
    if (entry.isFile) {
      return await new Promise((resolve) => {
        entry.file((file) => {
          resolve([{ file, relPath: base ? base + '/' + entry.name : entry.name, display: base ? base + '/' + entry.name : entry.name }]);
        }, () => resolve([]));
      });
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch = [];
      while (true) {
        const chunk = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!chunk.length) break;
        batch = batch.concat(chunk);
      }
      const results = [];
      for (const child of batch) {
        results.push(...await readEntry(child, base ? base + '/' + entry.name : entry.name));
      }
      return results;
    }
    return [];
  }

  function makePicker(pickFilesBtn, pickDirBtn, fileInput, dirInput, selectedEl, onClear) {
    let items = [];
    const state = { items };

    function render() {
      if (!items.length) { selectedEl.innerHTML = ''; return; }
      selectedEl.innerHTML = '';
      items.forEach((it, idx) => {
        const div = document.createElement('div');
        div.className = 'file-item';
        const isDir = it.relPath.includes('/');
        div.innerHTML = `
          <div class="fi-ico">${isDir ? '📁' : (it.file.type ? '📄' : '📄')}</div>
          <div class="fi-main">
            <div class="fi-name">${escapeHtml(it.display)}</div>
            <div class="fi-meta">${fmtSize(it.file.size)}${it.children ? ' · 共 ' + it.children + ' 项' : ''}</div>
          </div>
          <button class="fi-del" data-idx="${idx}" aria-label="移除">×</button>`;
        selectedEl.appendChild(div);
      });
      selectedEl.querySelectorAll('.fi-del').forEach(btn => {
        btn.addEventListener('click', () => {
          items.splice(Number(btn.dataset.idx), 1);
          render();
          onClear && onClear();
        });
      });
    }

    function addFiles(fileList, basePath, isDirMode) {
      const map = new Map();
      for (const f of fileList) {
        const rel = isDirMode ? f.webkitRelativePath : f.name;
        map.set(rel, f);
      }
      // 文件夹模式：汇总子项数
      for (const [rel, f] of map) {
        const item = { file: f, relPath: rel, display: rel };
        items.push(item);
      }
      render();
      onClear && onClear();
    }

    fileInput.addEventListener('change', () => {
      addFiles(fileInput.files, '', false);
      fileInput.value = '';
    });
    dirInput.addEventListener('change', () => {
      addFiles(dirInput.files, '', true);
      dirInput.value = '';
    });

    function supportsDir() {
      const i = document.createElement('input');
      return 'webkitdirectory' in i;
    }

    pickFilesBtn.addEventListener('click', () => fileInput.click());
    pickDirBtn.addEventListener('click', () => {
      if (!supportsDir()) {
        toast('当前浏览器（如 iOS Safari）不支持选择文件夹，请改用多选文件或使用电脑浏览器');
        return;
      }
      dirInput.click();
    });

    // 拖拽上传：支持文件与文件夹（文件夹通过 FileSystemEntry 递归读取）
    async function addFromDataTransfer(dt) {
      let newItems = [];
      const dtItems = dt && dt.items;
      if (dtItems && dtItems.length && typeof dtItems[0].webkitGetAsEntry === 'function') {
        const tasks = [];
        for (const it of dtItems) {
          if (it.kind !== 'file') continue;
          const entry = it.webkitGetAsEntry();
          if (entry) tasks.push(readEntry(entry, ''));
          else {
            const f = it.getAsFile();
            if (f) newItems.push({ file: f, relPath: f.name, display: f.name });
          }
        }
        const nested = await Promise.all(tasks);
        for (const arr of nested) newItems.push(...arr);
      } else if (dt && dt.files) {
        for (const f of dt.files) newItems.push({ file: f, relPath: f.name, display: f.name });
      }
      if (!newItems.length) return;
      items.push(...newItems);
      render();
      onClear && onClear();
    }

    return {
      get items() { return items; },
      clear() { items = []; render(); },
      render,
      isEmpty() { return items.length === 0; },
      addFromDataTransfer,
    };
  }

  // 绑定拖拽区域
  function bindDropZone(zone, picker) {
    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      picker.addFromDataTransfer(e.dataTransfer).then(() => {
        if (!picker.isEmpty()) toast('已添加拖入的文件');
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- 上传 ----------------
  function uploadFiles(items, url, progressFill, pctEl, progressBox, onDone, onError) {
    const fd = new FormData();
    // 文件夹场景：所有文件共享同一顶层目录
    const firstRel = items[0] ? items[0].relPath : '';
    let topName = '';
    if (firstRel.includes('/')) {
      const top = firstRel.split('/')[0];
      if (items.every(it => it.relPath.startsWith(top + '/'))) topName = top;
    }
    for (const it of items) {
      fd.append('files', it.file, it.file.name);
      fd.append('relativePath', it.relPath);
    }
    fd.append('topName', topName);
    fd.append('senderName', deviceName);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      progressFill.style.width = pct + '%';
      pctEl.textContent = pct + '%';
    };
    xhr.onload = () => {
      progressBox.classList.add('hidden');
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* 忽略 */ }
      if (xhr.status === 200 && data && data.ok) {
        onDone && onDone(data);
      } else {
        onError && onError(data && data.error ? data.error : '上传失败（' + xhr.status + '）');
      }
    };
    xhr.onerror = () => {
      progressBox.classList.add('hidden');
      onError && onError('网络错误，上传失败');
    };
    progressBox.classList.remove('hidden');
    progressFill.style.width = '0%';
    pctEl.textContent = '0%';
    xhr.send(fd);
  }

  // ---------------- 批次卡片 ----------------
  function batchCard(b, extraClass) {
    const isSingle = b.fileCount === 1;
    const div = document.createElement('div');
    div.className = 'recv-item' + (extraClass ? ' ' + extraClass : '');
    div.dataset.batchId = b.id;
    div.innerHTML = `
      <div class="ri-head">
        <div class="ri-ico ${isSingle ? '' : 'batch'}">${isSingle ? '📄' : '📁'}</div>
        <div class="ri-main">
          <div class="ri-name">${escapeHtml(b.displayName)}</div>
          <div class="ri-meta">${b.fileCount} 个文件 · ${fmtSize(b.totalSize)} · ${b.senderName} · ${fmtTime(b.uploadedAt)}</div>
        </div>
        <div class="ri-actions"><button class="dl-btn small">下载</button></div>
      </div>`;
    div.querySelector('.dl-btn').addEventListener('click', () => downloadBatch(b));
    return div;
  }

  function emptyTip(text) {
    return `<div class="empty-tip">${text}</div>`;
  }

  function downloadBatch(b) {
    const url = b.fileCount === 1
      ? API + '/api/download/' + b.firstFileId
      : API + '/api/download-batch/' + b.id;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
    toast('开始下载：' + b.displayName);
  }

  // ---------------- 广播：接收 & 发送 ----------------
  function renderLiveRecv() {
    const box = $('#recv-live-files');
    if (!liveBatches.size) {
      box.innerHTML = emptyTip('暂无文件。等待同一网络下的发送端上传…');
      return;
    }
    box.innerHTML = '';
    [...liveBatches.values()].sort((a, b) => a.uploadedAt - b.uploadedAt).forEach(b => box.appendChild(batchCard(b)));
  }

  function renderLiveDone(b) {
    // 发送端"已完成"列表
    const box = $('#live-done');
    box.prepend(batchCard(b, 'done-item'));
  }

  function notifyArrived(b) {
    toast('📥 收到新文件：' + b.displayName, 3200);
  }

  function refreshBroadcastList() {
    fetch(API + '/api/broadcast/files').then(r => r.json()).then(data => {
      if (data && data.ok) {
        liveBatches.clear();
        (data.files || []).forEach(b => liveBatches.set(b.id, b));
        renderLiveRecv();
      }
    }).catch(() => { /* 忽略 */ });
  }

  // 广播发送
  const livePicker = makePicker(
    $('#live-pick-files'), $('#live-pick-dir'), $('#live-files'), $('#live-dir'),
    $('#live-selected'),
    () => $('#live-send').disabled = livePicker.isEmpty()
  );
  bindDropZone($('#send-live'), livePicker);
  $('#live-send').addEventListener('click', () => {
    if (livePicker.isEmpty()) return;
    $('#live-send').disabled = true;
    uploadFiles(livePicker.items, API + '/api/upload?mode=broadcast',
      $('#live-progress .prog-fill'), $('#live-progress .pct'), $('#live-progress'),
      (data) => {
        livePicker.clear();
        $('#live-send').disabled = false;
        toast('✅ 已发送：' + data.displayName);
      },
      (err) => { $('#live-send').disabled = false; toast('❌ ' + err); }
    );
  });

  // ---------------- 点对点：发送 ----------------
  let myRoomCode = null;

  $('#room-create').addEventListener('click', async () => {
    try {
      const r = await fetch(API + '/api/room/create', { method: 'POST' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || '创建失败');
      myRoomCode = data.code;
      $('#room-code-text').textContent = myRoomCode;
      $('#room-start').classList.add('hidden');
      $('#room-active').classList.remove('hidden');
      // 发送端自己也加入房间，以便实时看到文件状态变化
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join-room', code: myRoomCode }));
      }
      toast('端口码已生成：' + myRoomCode);
    } catch (e) {
      toast('❌ ' + e.message);
    }
  });

  const roomPicker = makePicker(
    $('#room-pick-files'), $('#room-pick-dir'), $('#room-files'), $('#room-dir'),
    $('#room-selected'),
    () => $('#room-send').disabled = roomPicker.isEmpty()
  );
  bindDropZone($('#send-room'), roomPicker);
  $('#room-send').addEventListener('click', () => {
    if (roomPicker.isEmpty() || !myRoomCode) return;
    $('#room-send').disabled = true;
    uploadFiles(roomPicker.items, API + '/api/upload?mode=room&code=' + myRoomCode,
      $('#room-progress .prog-fill'), $('#room-progress .pct'), $('#room-progress'),
      (data) => {
        roomPicker.clear();
        $('#room-send').disabled = false;
        toast('✅ 已上传到端口码 ' + myRoomCode);
      },
      (err) => { $('#room-send').disabled = false; toast('❌ ' + err); }
    );
  });

  function renderRoomDone(b) {
    const box = $('#room-done');
    box.prepend(batchCard(b, 'done-item'));
  }

  // ---------------- 点对点：接收 ----------------
  $('#recv-room-join').addEventListener('click', async () => {
    const code = $('#recv-room-code').value.trim();
    if (!/^\d{4}$/.test(code)) { toast('请输入 4 位数字端口码'); return; }
    try {
      const r = await fetch(API + '/api/room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await r.json();
      if (!data.ok) {
        toast(data.error || '加入失败');
        return;
      }
      currentRoomCode = code;
      roomBatches.clear();
      (data.files || []).forEach(b => roomBatches.set(b.id, b));
      renderRoomRecv();
      // 通过 WS 订阅该房间的实时更新
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join-room', code }));
      } else {
        toast('已加入端口码 ' + code + '（实时更新需等服务恢复）');
      }
      $('#recv-room-hint').textContent = '已加入端口码 ' + code + '，对方新上传的文件将实时出现。';
    } catch (e) {
      toast('❌ ' + e.message);
    }
  });

  $('#recv-room-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  function renderRoomRecv() {
    const box = $('#recv-room-files');
    if (!currentRoomCode) {
      box.innerHTML = '';
      return;
    }
    if (!roomBatches.size) {
      box.innerHTML = emptyTip('该端口码下暂无文件，等待发送方上传…');
      return;
    }
    box.innerHTML = '';
    [...roomBatches.values()].sort((a, b) => a.uploadedAt - b.uploadedAt).forEach(b => box.appendChild(batchCard(b)));
  }

  // ---------------- 启动 ----------------
  connectWs();
  refreshBroadcastList();
})();
