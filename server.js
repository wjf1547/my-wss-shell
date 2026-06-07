const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const EXPECTED_TOKEN = "a1515629";
const PORT = process.env.PORT || 3000;

// 创建底层的 HTTP 服务器
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    // 网页端首次访问，直接返回控制台 HTML
    if (parsedUrl.query.token === EXPECTED_TOKEN && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderAdminHTML(parsedUrl.query.token));
    }
    res.writeHead(401);
    res.end('Unauthorized');
});

// 创建 WebSocket 服务器挂载到 HTTP 上
const wss = new WebSocket.Server({ server });

// 💡 核心改动：使用 Map 存储多设备 [deviceId -> socket]
const agentSockets = new Map();
// 管理网页端连接 [adminSocket -> 绑定管理的 deviceId]
const adminBindings = new Map();

wss.on('connection', (ws, req) => {
    const location = url.parse(req.url, true);
    const token = location.query.token;
    const role = location.query.role; // 'agent' 或 'admin'
    const deviceId = location.query.deviceId; // 设备的唯一标识

    if (token !== EXPECTED_TOKEN) {
        ws.close(4001, "Unauthorized");
        return;
    }

    // ==================== 1. AGENT (内网设备) 处理逻辑 ====================
    if (role === 'agent') {
        if (!deviceId) {
            ws.close(4002, "Missing deviceId");
            return;
        }
        
        // 存储或覆盖旧的同名设备连接
        agentSockets.set(deviceId, ws);
        console.log(`内网 Agent [${deviceId}] 成功建立 WSS 长连接`);
        
        // 广播通知所有网页端刷新设备列表
        broadcastDeviceList();
    } 
    // ==================== 2. ADMIN (网页控制台) 处理逻辑 ====================
    else if (role === 'admin') {
        console.log("网页 Admin 已连接，等待选择设备...");
        // 刚连接时，先发送当前在线的设备列表
        sendDeviceListToAdmin(ws);
    }

    // ==================== 3. 核心流交换 (数据中转) ====================
    ws.on('message', (message) => {
        const data = message.toString();

        if (role === 'admin') {
            // 💡 特殊指令：网页端通过发送特定 JSON 来切换/选择设备
            try {
                const json = JSON.parse(data);
                if (json.type === 'SELECT_DEVICE') {
                    const targetId = json.deviceId;
                    if (agentSockets.has(targetId)) {
                        adminBindings.set(ws, targetId); // 将当前网页连接与目标设备绑定
                        ws.send(`\r\n[系统] 已成功连接到设备: ${targetId}\r\n`);
                        // 告知 Agent 触发一次刷新，或者让终端准备好（可选）
                    } else {
                        ws.send(`\r\n[错误] 设备 ${targetId} 不在线！\r\n`);
                    }
                    return;
                }
                if (json.type === 'GET_DEVICES') {
                    sendDeviceListToAdmin(ws);
                    return;
                }
            } catch (e) {
                // 不是 JSON，说明是普通的键盘输入字节流
            }

            // 获取当前网页端绑定的目标设备
            const targetDeviceId = adminBindings.get(ws);
            const targetAgent = agentSockets.get(targetDeviceId);
            if (targetAgent && targetAgent.readyState === WebSocket.OPEN) {
                targetAgent.send(data); // 网页命令秒发给对应内网 Agent
            }
        } else if (role === 'agent') {
            // 内网结果秒发给**所有绑定了该设备**的网页端
            adminBindings.forEach((boundDeviceId, adminSocket) => {
                if (boundDeviceId === deviceId && adminSocket.readyState === WebSocket.OPEN) {
                    adminSocket.send(data);
                }
            });
        }
    });

    ws.on('close', () => {
        if (role === 'agent') {
            console.log(`内网 Agent [${deviceId}] 断开连接`);
            agentSockets.delete(deviceId);
            broadcastDeviceList(); // 广播通知设备下线
        }
        if (role === 'admin') {
            adminBindings.delete(ws);
        }
    });
});

// 向指定网页端发送当前在线设备列表
function sendDeviceListToAdmin(adminSocket) {
    if (adminSocket.readyState === WebSocket.OPEN) {
        const deviceIds = Array.from(agentSockets.keys());
        adminSocket.send(JSON.stringify({ type: 'DEVICE_LIST', devices: deviceIds }));
    }
}

// 广播给所有网页端最新的设备列表
function broadcastDeviceList() {
    adminBindings.forEach((_, adminSocket) => {
        sendDeviceListToAdmin(adminSocket);
    });
}

server.listen(PORT, () => {
    console.log(`常驻容器多设备中转端已在端口 ${PORT} 启动...`);
});

// 网页端 HTML 模板：集成了设备选择列表和 Xterm.js 终端
function renderAdminHTML(token) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Multi-Device WebSSH</title>
      <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.min.css" />
      <script src="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.js"></script>
      <style>
        body { background:#111; margin:0; padding:10px; height:100vh; box-sizing:border-box; display: flex; flex-direction: column; font-family: sans-serif; }
        #top-bar { display: flex; background: #222; padding: 10px; border-bottom: 1px solid #333; align-items: center; gap: 10px; }
        label, #device-select { color: #fff; font-size: 14px; }
        #device-select { background: #333; color: #fff; border: 1px solid #555; padding: 5px; border-radius: 4px; }
        #connect-btn { background: #007acc; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
        #connect-btn:hover { background: #0062a3; }
        #terminal-container { flex: 1; margin-top: 10px; overflow: hidden; }
        #terminal { height: 100%; }
      </style>
    </head>
    <body>
      <div id="top-bar">
        <label for="device-select">选择目标设备:</label>
        <select id="device-select">
          <option value="">-- 请选择设备 --</option>
        </select>
        <button id="connect-btn" onclick="selectDevice()">连接终端</button>
      </div>

      <div id="terminal-container">
        <div id="terminal"></div>
      </div>

      <script>
        const token = "${token}";
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${location.host}?role=admin&token=\${token}\`);
        
        let term = null;
        let isTerminalInitialized = false;

        // 初始化 Xterm.js
        function initTerminal() {
          if (isTerminalInitialized) return;
          term = new Terminal({
            cursorBlink: true,
            theme: { background: '#111111', foreground: '#00ff00' },
            fontFamily: 'monospace'
          });
          term.open(document.getElementById('terminal'));
          
          // 监听终端输入并发送
          term.onData(data => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data); 
            }
          });
          isTerminalInitialized = true;
        }

        ws.onopen = () => {
          console.log("已连接中转服务器，正在拉取设备列表...");
        };
        
        ws.onmessage = (e) => {
          // 优先判断是不是控制信令（JSON）
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'DEVICE_LIST') {
              updateDeviceSelect(msg.devices);
              return;
            }
          } catch(err) {
            // 不是 JSON 则是终端字节流，直接交给 Xterm
          }

          if (term) {
            term.write(e.data);
          }
        };

        ws.onclose = () => { 
          if (term) term.write('\\r\\n[系统] WSS 连接已断开。\\r\\n'); 
        };

        // 更新下拉框列表
        function updateDeviceSelect(devices) {
          const select = document.getElementById('device-select');
          const currentSelected = select.value;
          
          // 清空除第一项外的内容
          select.innerHTML = '<option value="">-- 请选择设备 --</option>';
          
          devices.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = id;
            if (id === currentSelected) opt.selected = true;
            select.appendChild(opt);
          });
        }

        // 点击连接设备按钮
        function selectDevice() {
          const select = document.getElementById('device-select');
          const deviceId = select.value;
          if (!deviceId) {
            alert("请先选择一个在线设备！");
            return;
          }
          
          initTerminal();
          term.reset();
          term.write(\`[系统] 正在切换至设备 \${deviceId}...\\r\\n\`);
          
          // 发送选择设备指令
          ws.send(JSON.stringify({ type: 'SELECT_DEVICE', deviceId: deviceId }));
        }
      </script>
    </body>
    </html>
  `;
}
