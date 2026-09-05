const fs = require('fs');
const path = require('path');
const readline = require('readline');

const endpoints = [
  ['31.59.20.176', 6754],
  ['45.38.107.97', 6014],
  ['198.105.121.200', 6462],
  ['64.137.96.74', 6641],
  ['198.23.243.226', 6361],
  ['38.154.185.97', 6370],
  ['84.247.60.125', 6095],
  ['142.111.67.146', 5611],
  ['191.96.254.138', 6185],
  ['31.58.9.4', 6077]
];

function ask(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(String(answer || '').trim()));
  });
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log('');
    console.log('Webshare 免费代理池初始化');
    console.log('将写入 data/webshare-proxies.json（data/ 已被 gitignore）');
    console.log('');

    const username = await ask(rl, 'Webshare Username: ');
    const password = await ask(rl, 'Webshare Password: ');

    if (!username || !password) {
      throw new Error('Username / Password 不能为空');
    }

    const data = {
      provider: 'webshare',
      created_at: new Date().toISOString(),
      proxies: endpoints.map(([host, port]) => ({
        host,
        port,
        username,
        password
      }))
    };

    const dataDir = path.join(__dirname, '..', 'data');
    const filePath = path.join(dataDir, 'webshare-proxies.json');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(data, null, 2),
      'utf8'
    );

    console.log('');
    console.log(`已保存：${filePath}`);
    console.log(`代理数量：${data.proxies.length}`);
    console.log('Scan 和 Mode2 下次启动时会自动读取这个代理池。');
    console.log('Mode3 / Mode4 仍默认使用本地 IP。');
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error('[setup-proxies] 失败：', error.message);
  process.exit(1);
});
