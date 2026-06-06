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
    <head>
      <title>Render Professional WebSSH</title>
      <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.min.css" />
      <script src="https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/xterm.js"></script>
    </head>
    <body style="background:#111; margin:0; padding:10px; height:100vh; box-sizing:border-box;">
      <div id="terminal" style="height:100%;"></div>

      <script>
        const token = "${token}";
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${location.host}?role=admin&token=\${token}\`);
        
        // 初始化专业终端
        const term = new Terminal({
          cursorBlink: true,
          theme: { background: '#111111', foreground: '#00ff00' },
          fontFamily: 'monospace'
        });
        term.open(document.getElementById('terminal'));
        term.write('[系统] 正在建立 WSS 实时交互安全连接...\\r\\n');

        ws.onopen = () => { term.reset(); };
        
        // 💡 收到内网发来的带颜色转义字符的数据，直接交给 Xterm.js 完美洗白和渲染
        ws.onmessage = (e) => { term.write(e.data); };
        ws.onclose = () => { term.write('\\r\\n[系统] WSS 连接已断开。\\r\\n'); };

        // 监听用户的键盘输入，实现捕获单个按键（包括回车、退格、Ctrl+C等）
        term.onData(data => {
          if (ws.readyState === WebSocket.OPEN) {
            // 实时发送按键字节，不用再点网页上的发送按钮了，真正的丝滑体验
            ws.send(data); 
          }
        });
      </script>
    </body>
    </html>
  `;
}
