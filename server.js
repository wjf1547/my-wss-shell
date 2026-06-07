const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const EXPECTED_TOKEN = process.env.EXPECTED_TOKEN;
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.query.token === EXPECTED_TOKEN && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderAdminHTML(parsedUrl.query.token));
    }
    res.writeHead(401).end('Unauthorized');
});

const wss = new WebSocket.Server({ server });
const agentSockets = new Map();
const adminBindings = new Map();

wss.on('connection', (ws, req) => {
    const location = url.parse(req.url, true);
    const token = location.query.token;
    const role = location.query.role; 
    const deviceId = location.query.deviceId;

    if (token !== EXPECTED_TOKEN) {
        ws.close(4001, "Unauthorized");
        return;
    }

    if (role === 'agent') {
        if (!deviceId) return ws.close(4002, "Missing deviceId");
        agentSockets.set(deviceId, ws);
        console.log(`内网 Agent [${deviceId}] 已连接`);
        broadcastDeviceList();
    } else if (role === 'admin') {
        sendDeviceListToAdmin(ws);
    }

    ws.on('message', (message) => {
        // 先尝试作为字符串处理
        const dataStr = message.toString();

        if (role === 'admin') {
            try {
                const json = JSON.parse(dataStr);
                // 1. 设备切换与列表管理
                if (json.type === 'SELECT_DEVICE') {
                    if (agentSockets.has(json.deviceId)) {
                        adminBindings.set(ws, json.deviceId);
                        ws.send(`\r\n[系统] 已连接到设备: ${json.deviceId}\r\n`);
                        // 顺便让 Agent 初始化该客户端的文件列表
                        forwardToAgent(json.deviceId, { type: 'FILE_LIST', path: '.' });
                    } else {
                        ws.send(`\r\n[错误] 设备 ${json.deviceId} 不在线！\r\n`);
                    }
                    return;
                }
                if (json.type === 'GET_DEVICES') { return sendDeviceListToAdmin(ws); }

                // 2. 转发来自网页端的文件操作信令（如：查看、修改、切换目录）
                if (json.type === 'FILE_LIST' || json.type === 'FILE_READ' || json.type === 'FILE_WRITE') {
                    const targetId = adminBindings.get(ws);
                    if (targetId) forwardToAgent(targetId, json);
                    return;
                }
            } catch (e) {
                // 解析 JSON 失败说明是纯终端键盘输入字节流
            }

            // 转发纯终端输入给绑定的 Agent
            const targetDeviceId = adminBindings.get(ws);
            const targetAgent = agentSockets.get(targetDeviceId);
            if (targetAgent && targetAgent.readyState === WebSocket.OPEN) {
                // 为了区分普通终端和信令，包装一下终端输入
                targetAgent.send(JSON.stringify({ type: 'TERM_INPUT', data: dataStr }));
            }
        } 
        
        else if (role === 'agent') {
            // 收到内网 Agent 发来的数据
            try {
                const json = JSON.parse(dataStr);
                // 如果是文件相关的信令返回，转发给订阅了该设备的所有 Admin
                if (json.type === 'FILE_LIST_RES' || json.type === 'FILE_READ_RES' || json.type === 'FILE_WRITE_RES') {
                    adminBindings.forEach((boundDeviceId, adminSocket) => {
                        if (boundDeviceId === deviceId && adminSocket.readyState === WebSocket.OPEN) {
                            adminSocket.send(JSON.stringify(json));
                        }
                    });
                    return;
                }
                // 如果是 Agent 返回的纯终端输出
                if (json.type === 'TERM_OUTPUT') {
                    adminBindings.forEach((boundDeviceId, adminSocket) => {
                        if (boundDeviceId === deviceId && adminSocket.readyState === WebSocket.OPEN) {
                            adminSocket.send(json.data); // 直接发送原始字节串/字符串给 Xterm
                        }
                    });
                }
            } catch (e) {
                // 兼容老客户端不发 JSON 的情况（建议全部走新客户端协议）
            }
        }
    });

    ws.on('close', () => {
        if (role === 'agent') {
            agentSockets.delete(deviceId);
            broadcastDeviceList();
        } else if (role === 'admin') {
            adminBindings.delete(ws);
        }
    });
});

function forwardToAgent(deviceId, jsonPayload) {
    const agent = agentSockets.get(deviceId);
    if (agent && agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(jsonPayload));
    }
}

function sendDeviceListToAdmin(adminSocket) {
    if (adminSocket.readyState === WebSocket.OPEN) {
        adminSocket.send(JSON.stringify({ type: 'DEVICE_LIST', devices: Array.from(agentSockets.keys()) }));
    }
}

function broadcastDeviceList() {
    adminBindings.forEach((_, adminSocket) => { sendDeviceListToAdmin(adminSocket); });
}

server.listen(PORT, () => console.log(`多功能中转端已在端口 ${PORT} 启动...`));

function renderAdminHTML(token) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Multi-Device WebSSH & FileManager</title>
      <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.min.css" />
      <script src="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.js"></script>
      <style>
        body { background:#111; margin:0; padding:10px; height:100vh; box-sizing:border-box; display: flex; flex-direction: column; font-family: sans-serif; color: #fff;}
        #top-bar { display: flex; background: #222; padding: 10px; border-bottom: 1px solid #333; align-items: center; gap: 10px; }
        #device-select { background: #333; color: #fff; border: 1px solid #555; padding: 5px; border-radius: 4px; }
        button { background: #007acc; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0062a3; }
        #main-container { flex: 1; display: flex; gap: 15px; margin-top: 10px; overflow: hidden; }
        #terminal-container { flex: 1; height: 100%; display: flex; flex-direction: column; }
        #file-container { width: 450px; background: #1e1e1e; border: 1px solid #333; display: flex; flex-direction: column; padding: 10px; box-sizing: border-box;}
        #file-list { flex: 1; overflow-y: auto; list-style: none; padding: 0; margin: 5px 0; border: 1px solid #444; background: #111;}
        #file-list li { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid #222; display: flex; justify-content: space-between; font-size: 13px;}
        #file-list li:hover { background: #2a2a2a; }
        #editor-pane { display:none; position: fixed; top:10%; left:20%; width:60%; height:75%; background:#2d2d2d; border:2px solid #555; box-shadow: 0 0 15px rgba(0,0,0,0.5); padding:15px; flex-direction:column; z-index:100;}
        #editor-text { flex:1; background:#1e1e1e; color:#fff; border:1px solid #444; font-family:monospace; padding:10px; resize:none;}
        .folder-item { color: #e6a23c; font-weight: bold; }
        .file-item { color: #409eff; }
      </style>
    </head>
    <body>
      <div id="top-bar">
        <label>选择目标设备:</label>
        <select id="device-select"><option value="">-- 请选择设备 --</option></select>
        <button onclick="selectDevice()">连接并打开文件管理</button>
      </div>

      <div id="main-container">
        <div id="terminal-container">
          <div id="terminal" style="height:100%"></div>
        </div>
        
        <div id="file-container">
          <h3 style="margin:0 0 5px 0;">远程文件浏览器</h3>
          <div style="font-size:12px; color:#aaa; margin-bottom:5px; word-break:break-all;">当前路径: <span id="current-path">.</span></div>
          <ul id="file-list"><li>请先选择并连接设备...</li></ul>
        </div>
      </div>

      <div id="editor-pane">
        <h3 id="editor-title" style="margin:0 0 10px 0;">编辑文件</h3>
        <textarea id="editor-text"></textarea>
        <div style="margin-top:10px; text-align:right; gap:10px; display:flex; justify-content:flex-end;">
          <button style="background:#67c23a;" onclick="saveFile()">保存并写入</button>
          <button style="background:#909399;" onclick="closeEditor()">取消</button>
        </div>
      </div>

      <script>
        const token = "${token}";
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${location.host}?role=admin&token=\${token}\`);
        
        let term = null;
        let currentPath = ".";
        let editingFilePath = "";

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'DEVICE_LIST') { updateDeviceSelect(msg.devices); return; }
            if (msg.type === 'FILE_LIST_RES') { renderFileList(msg.path, msg.files); return; }
            if (msg.type === 'FILE_READ_RES') { openEditor(msg.path, msg.content); return; }
            if (msg.type === 'FILE_WRITE_RES') { alert(msg.success ? "文件保存成功！" : "文件保存失败: " + msg.error); return; }
          } catch(err) {}
          if (term) term.write(e.data); // 终端流数据
        };

        function updateDeviceSelect(devices) {
          const select = document.getElementById('device-select');
          const curr = select.value;
          select.innerHTML = '<option value="">-- 请选择设备 --</option>';
          devices.forEach(id => {
            const opt = document.createElement('option'); opt.value = id; opt.innerText = id;
            if (id === curr) opt.selected = true;
            select.appendChild(opt);
          });
        }

        function selectDevice() {
          const deviceId = document.getElementById('device-select').value;
          if (!deviceId) return alert("请先选择设备！");
          if (!term) {
            term = new Terminal({ cursorBlink: true, theme: { background: '#111', foreground: '#00ff00' } });
            term.open(document.getElementById('terminal'));
            term.onData(data => ws.send(data));
          }
          term.reset();
          ws.send(JSON.stringify({ type: 'SELECT_DEVICE', deviceId: deviceId }));
        }

        // 渲染右侧文件列表
        function renderFileList(path, files) {
          currentPath = path;
          document.getElementById('current-path').innerText = path;
          const list = document.getElementById('file-list');
          list.innerHTML = "";

          // 返回上级目录项
          const backLi = document.createElement('li');
          backLi.innerHTML = "<span class='folder-item'>📁 .. (返回上级)</span>";
          backLi.onclick = () => ws.send(JSON.stringify({ type: 'FILE_LIST', path: currentPath + "/.." }));
          list.appendChild(backLi);

          files.forEach(f => {
            const li = document.createElement('li');
            const fullPath = currentPath + "/" + f.name;
            if (f.is_dir) {
              li.innerHTML = \`<span class="folder-item">📁 \${f.name}</span><span>目录</span>\`;
              li.onclick = () => ws.send(JSON.stringify({ type: 'FILE_LIST', path: fullPath }));
            } else {
              li.innerHTML = \`<span class="file-item">📄 \${f.name}</span>
                               <div>
                                 <button onclick="event.stopPropagation(); readFile('\${fullPath}')" style="padding:2px 6px; font-size:11px; margin-right:5px;">查看/改</button>
                                 <button onclick="event.stopPropagation(); downloadFile('\${fullPath}', '\${f.name}')" style="padding:2px 6px; font-size:11px; background:#e6a23c;">下载</button>
                               </div>\`;
            }
            list.appendChild(li);
          });
        }

        function readFile(path) {
          ws.send(JSON.stringify({ type: 'FILE_READ', path: path }));
        }

        function openEditor(path, content) {
          editingFilePath = path;
          document.getElementById('editor-title').innerText = "编辑: " + path;
          document.getElementById('editor-text').value = content;
          document.getElementById('editor-pane').style.display = "flex";
        }

        function closeEditor() { document.getElementById('editor-pane').style.display = "none"; }

        function saveFile() {
          const content = document.getElementById('editor-text').value;
          ws.send(JSON.stringify({ type: 'FILE_WRITE', path: editingFilePath, content: content }));
          closeEditor();
        }

        // 文件下载：通过 WSS 读取内容后，用前端 Blob 触发浏览器本地下载
        function downloadFile(path, name) {
          // 巧妙复用 FILE_READ 信令
          const handler = (e) => {
             try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'FILE_READ_RES' && msg.path === path) {
                    const blob = new Blob([msg.content], { type: 'application/octet-stream' });
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = name;
                    link.click();
                    ws.removeEventListener('message', handler); // 解绑避免重复
                }
             } catch(err){}
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ type: 'FILE_READ', path: path }));
        }
      </script>
    </body>
    </html>
  `;
}
