const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const EXPECTED_TOKEN = "你的自定义强密码_SECRET_TOKEN";
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

let agentSocket = null;
let adminSocket = null;

wss.on('connection', (ws, req) => {
    const location = url.parse(req.url, true);
    const token = location.query.token;
    const role = location.query.role; // 'agent' 或 'admin'

    if (token !== EXPECTED_TOKEN) {
        ws.close(4001, "Unauthorized");
        return;
    }

    if (role === 'agent') {
        agentSocket = ws;
        console.log("内网 Agent 成功建立 WSS 长连接");
        if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
            adminSocket.send("[系统] 内网 Agent 已上线！开始输入命令：");
        }
    } else if (role === 'admin') {
        adminSocket = ws;
        console.log("网页 Admin 成功建立 WSS 长连接");
        if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
            adminSocket.send("[系统] 内网 Agent 在线，准备就绪。");
        } else {
            adminSocket.send("[警告] 内网 Agent 当前离线！");
        }
    }

    // 核心流交换：纯内存 WSS 管道中转，坚决不轮询
    ws.on('message', (message) => {
        const data = message.toString();
        if (role === 'admin' && agentSocket && agentSocket.readyState === WebSocket.OPEN) {
            agentSocket.send(data); // 网页命令秒发给内网
        } else if (role === 'agent' && adminSocket && adminSocket.readyState === WebSocket.OPEN) {
            adminSocket.send(data); // 内网结果秒发给网页
        }
    });

    ws.on('close', () => {
        if (role === 'agent') agentSocket = null;
        if (role === 'admin') adminSocket = null;
    });
});

server.listen(PORT, () => {
    console.log(`常驻容器中转端已在端口 ${PORT} 启动...`);
});

function renderAdminHTML(token) {
    return `
    <!DOCTYPE html>
    <html>
    <head><title>Render WSS Shell</title></head>
    <body style="background:#111; color:#0f0; font-family:monospace; padding:20px;">
      <h3>常驻内存 WSS 远程控制台 (0延迟版)</h3>
      <div id="output" style="white-space:pre-wrap; height:75vh; overflow-y:auto; border:1px solid #333; padding:10px; margin-bottom:10px;">[系统] 正在建立 WSS 安全连接...</div>
      <input id="cmd" style="width:80%; background:#222; color:#0f0; border:1px solid #444; padding:5px;" placeholder="输入命令后回车..." autofocus/>
      <script>
        const token = "${token}";
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${location.host}?role=admin&token=\${token}\`);
        
        const output = document.getElementById('output');
        const cmdInput = document.getElementById('cmd');

        ws.onopen = () => { output.innerText = '[系统] 成功连接中转服务器。\\n'; };
        ws.onmessage = (e) => { output.innerText += e.data + '\\n'; output.scrollTop = output.scrollHeight; };
        ws.onclose = () => { output.innerText += '[系统] WSS 连接已断开。\\n'; };

        cmdInput.addEventListener('keydown', (e) => {
          if(e.key === 'Enter') {
            if(!cmdInput.value.trim()) return;
            ws.send(cmdInput.value);
            output.innerText += '\\n> ' + cmdInput.value + '\\n';
            cmdInput.value = '';
          }
        });
      </script>
    </body>
    </html>
    `;
}
