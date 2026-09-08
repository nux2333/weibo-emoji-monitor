const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOG_DIR = path.join(__dirname, '..', 'logs', 'proxy-pool');

function getLogFile() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return path.join(LOG_DIR, date + '.log');
}

function formatChinaTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

function appendLog(level, args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const text = args.map(value => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ');
    fs.appendFileSync(getLogFile(), '[' + formatChinaTime() + '] [' + level + '] ' + text + '\n', 'utf8');
  } catch (error) {
    process.stderr.write('[代理池日志写入失败] ' + error.message + '\n');
  }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function consolePrefix(level) {
  return '[' + formatChinaTime() + '] [' + level + ']';
}

console.log = (...args) => {
  originalConsoleLog(
    consolePrefix('INFO'),
    ...args
  );
  appendLog('INFO', args);
};

console.error = (...args) => {
  originalConsoleError(
    consolePrefix('ERROR'),
    ...args
  );
  appendLog('ERROR', args);
};

const GOOD_POOL_FILE =
  process.env.WEIBO_GOOD_PROXY_FILE
  || path.join(
    __dirname,
    '..',
    'data',
    'weibo-good-proxies.txt'
  );

const SCORE_FILE =
  process.env.WEIBO_PROXY_SCORE_FILE
  || path.join(
    __dirname,
    '..',
    'data',
    'weibo-proxy-scores.json'
  );

const TARGET_GOOD_COUNT =
  Number(
    process.env.WEIBO_GOOD_PROXY_TARGET
  )
  || 100;

const MAX_CANDIDATES_PER_SOURCE =
  Number(
    process.env.WEIBO_PROXY_MAX_CANDIDATES_PER_SOURCE
  )
  || 300;

const TIMEOUT_MS =
  Number(
    process.env.WEIBO_GOOD_PROXY_TIMEOUT_MS
  )
  || 8000;

const CONCURRENCY =
  Math.max(
    1,
    Number(
      process.env.WEIBO_GOOD_PROXY_CONCURRENCY
    )
    || 8
  );

const WEIBO_URL =
  process.env.WEIBO_GOOD_PROXY_WEIBO_URL
  || 'https://weibo.com/p/100808f1d33f71dff693a2708cb3e8ef584a44';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/152.0.0.0 Safari/537.36';

function shuffle(values) {
  const arr = [...values];

  for (
    let i = arr.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random()
        * (i + 1)
      );

    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function normalizeProxy(rawValue, defaultScheme = 'http') {
  const raw =
    String(rawValue || '')
      .split('#')[0]
      .trim();

  if (!raw) {
    return null;
  }

  if (
    /^(?:https?|socks5):\/\//i.test(raw)
  ) {
    return raw;
  }

  return `${defaultScheme}://${raw}`;
}

function readGoodPool() {
  try {
    if (
      !fs.existsSync(
        GOOD_POOL_FILE
      )
    ) {
      return [];
    }

    return Array.from(
      new Set(
        fs.readFileSync(
          GOOD_POOL_FILE,
          'utf8'
        )
          .split(/\r?\n/)
          .map(line => normalizeProxy(line))
          .filter(Boolean)
      )
    );

  } catch (error) {
    console.log(
      `[健康池] 读取失败：${error.message}`
    );

    return [];
  }
}

function writeGoodPool(items) {
  fs.mkdirSync(
    path.dirname(
      GOOD_POOL_FILE
    ),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    GOOD_POOL_FILE,
    items.join('\n')
    + (items.length ? '\n' : ''),
    'utf8'
  );
}

function appendGoodProxy(proxy) {
  const normalized =
    normalizeProxy(proxy);

  if (!normalized) {
    return false;
  }

  const current =
    readGoodPool();

  if (
    current.includes(
      normalized
    )
  ) {
    return false;
  }

  fs.mkdirSync(
    path.dirname(
      GOOD_POOL_FILE
    ),
    {
      recursive: true
    }
  );

  fs.appendFileSync(
    GOOD_POOL_FILE,
    normalized + '\n',
    'utf8'
  );

  return true;
}

async function fetchText(url, timeoutMs = 20000) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

          headers: {
            'User-Agent':
              USER_AGENT,

            Accept:
              'text/html,application/json,text/plain,*/*'
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.text();

  } finally {
    clearTimeout(timer);
  }
}

async function fetchScdnCandidates() {
  const url =
    `https://proxy.scdn.io/api/get_proxy.php?protocol=https&count=${Math.min(20, MAX_CANDIDATES_PER_SOURCE)}`;

  const text =
    await fetchText(url);

  const json =
    JSON.parse(text);

  const list =
    Array.isArray(
      json?.data?.proxies
    )
      ? json.data.proxies
      : [];

  return list
    .map(value =>
      normalizeProxy(
        value,
        'http'
      )
    )
    .filter(Boolean);
}

async function fetchProxyCleanCandidates() {
  const text =
    await fetchText(
      'https://raw.githubusercontent.com/HankNovic/ProxyClean/refs/heads/main/SOCKS5.txt'
    );

  return shuffle(
    text
      .split(/\r?\n/)
      .map(line =>
        normalizeProxy(
          line,
          'socks5'
        )
      )
      .filter(Boolean)
  )
    .slice(
      0,
      MAX_CANDIDATES_PER_SOURCE
    );
}

async function fetch89IpCandidates() {
  const results = [];

  /*
   * 89ip 没有稳定公开JSON接口，这里抓公开分页表格。
   * 多抓几页，后续仍以微博实测为准。
   */
  const pages =
    Math.max(
      1,
      Math.min(
        20,
        Number(
          process.env.WEIBO_89IP_PAGES
        )
        || 10
      )
    );

  for (
    let page = 1;
    page <= pages;
    page++
  ) {
    try {
      const url =
        page === 1
          ? 'https://www.89ip.cn/'
          : `https://www.89ip.cn/index_${page}.html`;

      const html =
        await fetchText(url);

      const regex =
        /<td>\s*((?:\d{1,3}\.){3}\d{1,3})\s*<\/td>\s*<td>\s*(\d{2,5})\s*<\/td>/gi;

      let match;

      while (
        (
          match =
            regex.exec(html)
        )
      ) {
        results.push(
          `http://${match[1]}:${match[2]}`
        );

        if (
          results.length
          >= MAX_CANDIDATES_PER_SOURCE
        ) {
          break;
        }
      }

      if (
        results.length
        >= MAX_CANDIDATES_PER_SOURCE
      ) {
        break;
      }

    } catch (error) {
      console.log(
        `[89ip] 第${page}页获取失败：${error.message}`
      );
    }
  }

  return Array.from(
    new Set(results)
  );
}

async function fetchProxyHubCandidates() {
  const html =
    await fetchText(
      'https://proxyhub.me/zh/cn-http-proxy-list.html'
    );

  const results = [];

  /*
   * ProxyHub 表格直接展示 IP / Port / 协议。
   * 当前页面是中国 HTTP 代理列表；只把 IPv4:Port
   * 当作候选，最终仍必须通过 ipify + 微博实测。
   */
  const regex =
    /\b((?:\d{1,3}\.){3}\d{1,3})\s*(?:<[^>]+>|\s|&nbsp;)*\s*(\d{2,5})\b/g;

  let match;

  while (
    (
      match =
        regex.exec(html)
    )
  ) {
    results.push(
      `http://${match[1]}:${match[2]}`
    );

    if (
      results.length
      >= MAX_CANDIDATES_PER_SOURCE
    ) {
      break;
    }
  }

  return shuffle(
    Array.from(
      new Set(results)
    )
  );
}

async function fetchFate0Candidates() {
  const text =
    await fetchText(
      'https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list'
    );

  const results = [];

  for (
    const line
    of text.split(/\r?\n/)
  ) {
    const raw =
      String(line || '').trim();

    if (!raw) {
      continue;
    }

    try {
      const item =
        JSON.parse(raw);

      const type =
        String(
          item?.type || ''
        ).toLowerCase();

      if (
        ![
          'http',
          'https',
          'socks5'
        ].includes(type)
      ) {
        continue;
      }

      const host =
        String(
          item?.host || ''
        ).trim();

      const port =
        Number(
          item?.port
        );

      if (!host || !port) {
        continue;
      }

      const scheme =
        type === 'socks5'
          ? 'socks5'
          : 'http';

      results.push(
        `${scheme}://${host}:${port}`
      );

    } catch {
      // ignore malformed rows
    }
  }

  return shuffle(
    Array.from(
      new Set(results)
    )
  )
    .slice(
      0,
      MAX_CANDIDATES_PER_SOURCE
    );
}


async function fetchProxioCandidates() {
  const results = [];

  const sources = [
    [
      'https://raw.githubusercontent.com/proxio-io/proxy-list/main/socks5.txt',
      'socks5'
    ],
    [
      'https://raw.githubusercontent.com/proxio-io/proxy-list/main/https.txt',
      'http'
    ]
  ];

  for (const [url, scheme] of sources) {
    try {
      const text =
        await fetchText(url);

      results.push(
        ...text
          .split(/\r?\n/)
          .map(line =>
            normalizeProxy(
              line,
              scheme
            )
          )
          .filter(Boolean)
      );
    } catch (error) {
      console.log(
        `[proxio] ${scheme} 获取失败：${error.message}`
      );
    }
  }

  return shuffle(
    Array.from(
      new Set(results)
    )
  )
    .slice(
      0,
      MAX_CANDIDATES_PER_SOURCE
    );
}


async function fetchProxmintCandidates() {
  const results = [];

  const sources = [
    [
      'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/socks5.txt',
      'socks5'
    ],
    [
      'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/https.txt',
      'http'
    ],
    [
      'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt',
      'http'
    ]
  ];

  for (const [url, scheme] of sources) {
    try {
      const text =
        await fetchText(url);

      results.push(
        ...text
          .split(/\r?\n/)
          .map(line =>
            normalizeProxy(
              line,
              scheme
            )
          )
          .filter(Boolean)
      );
    } catch (error) {
      console.log(
        `[Proxmint] ${scheme} 获取失败：${error.message}`
      );
    }
  }

  return shuffle(
    Array.from(
      new Set(results)
    )
  )
    .slice(
      0,
      MAX_CANDIDATES_PER_SOURCE
    );
}


async function fetchRelayglassCandidates() {
  const results = [];

  const sources = [
    [
      'https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/socks5/socks5.txt',
      'socks5'
    ],
    [
      'https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/https/https.txt',
      'http'
    ]
  ];

  for (const [url, scheme] of sources) {
    try {
      const text =
        await fetchText(url);

      results.push(
        ...text
          .split(/\r?\n/)
          .map(line =>
            normalizeProxy(
              line,
              scheme
            )
          )
          .filter(Boolean)
      );
    } catch (error) {
      console.log(
        `[Relayglass] ${scheme} 获取失败：${error.message}`
      );
    }
  }

  /*
   * Relayglass 本身按速度排序。
   * 这里不 shuffle，优先把较快的候选送去微博实测。
   */
  return Array.from(
    new Set(results)
  )
    .slice(
      0,
      MAX_CANDIDATES_PER_SOURCE
    );
}


async function fetchPlainProxySources(sources) {
  const results = [];

  for (const [url, scheme] of sources) {
    try {
      const text = await fetchText(url);

      results.push(
        ...text
          .split(/\r?\n/)
          .map(line => normalizeProxy(line, scheme))
          .filter(Boolean)
      );
    } catch (error) {
      console.log(
        `[新代理源] ${url} 获取失败：${error.message}`
      );
    }
  }

  return shuffle(
    Array.from(new Set(results))
  ).slice(0, MAX_CANDIDATES_PER_SOURCE);
}

async function fetchProxyScrapeCandidates() {
  return fetchPlainProxySources([
    ['https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.txt', 'http'],
    ['https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/socks5/data.txt', 'socks5']
  ]);
}

async function fetchProxiflyCandidates() {
  return fetchPlainProxySources([
    ['https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt', 'http'],
    ['https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt', 'socks5']
  ]);
}

async function fetchIPLocateCandidates() {
  return fetchPlainProxySources([
    ['https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt', 'http'],
    ['https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt', 'socks5']
  ]);
}

async function fetchDatabayCandidates() {
  return fetchPlainProxySources([
    ['https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/http.txt', 'http'],
    ['https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/socks5.txt', 'socks5']
  ]);
}

async function fetchMonosansCandidates() {
  return fetchPlainProxySources([
    ['https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', 'http'],
    ['https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', 'socks5']
  ]);
}

async function fetchHProxyCandidates() {
  return fetchPlainProxySources([
    ['https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/proxies/http.txt', 'http'],
    ['https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/proxies/socks5.txt', 'socks5']
  ]);
}

async function fetchProxioCandidates() {
  const sources = [
    ['https://raw.githubusercontent.com/proxio-io/proxy-list/main/proxies/http.txt', 'http'],
    ['https://raw.githubusercontent.com/proxio-io/proxy-list/main/proxies/https.txt', 'http'],
    ['https://raw.githubusercontent.com/proxio-io/proxy-list/main/proxies/socks5.txt', 'socks5'],
    ['https://raw.githubusercontent.com/proxio-io/proxy-list/main/http.txt', 'http'],
    ['https://raw.githubusercontent.com/proxio-io/proxy-list/main/socks5.txt', 'socks5']
  ];

  return fetchPlainProxySources(sources);
}



function extractIpPorts(text, defaultScheme = 'http') {
  const results = [];
  const regex = /\b((?:\d{1,3}\.){3}\d{1,3})\s*[:\s]\s*(\d{2,5})\b/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    results.push(normalizeProxy(match[1] + ':' + match[2], defaultScheme));
    if (results.length >= MAX_CANDIDATES_PER_SOURCE) break;
  }
  return Array.from(new Set(results)).filter(Boolean);
}

async function fetchDocIpCandidates() {
  // 稻壳代理公开列表；页面结构变化时失败不会影响其它源。
  const urls = [
    'https://www.docip.net/data/free.json',
    'https://www.docip.net/'
  ];
  for (const url of urls) {
    try {
      const text = await fetchText(url);
      const list = extractIpPorts(text, 'http');
      if (list.length) return list;
    } catch (error) {
      console.log(`[DocIP] ${url} 获取失败：${error.message}`);
    }
  }
  return [];
}

async function fetchGoodIpsCandidates() {
  // 官方 ProxyPool 当前实现只抓首页；/free-proxy 已不存在。
  try {
    const text =
      await fetchText(
        'https://www.goodips.com/'
      );

    return extractIpPorts(
      text,
      'http'
    );
  } catch (error) {
    console.log(
      `[GoodIPs] 获取失败：${error.message}`
    );
    return [];
  }
}

async function fetchGeoNodeCandidates() {
  const url =
    'https://proxylist.geonode.com/api/proxy-list?limit='
    + Math.min(500, MAX_CANDIDATES_PER_SOURCE)
    + '&page=1&sort_by=lastChecked&sort_type=desc';

  const json = JSON.parse(await fetchText(url));
  const rows = Array.isArray(json?.data) ? json.data : [];
  const results = [];

  for (const item of rows) {
    const host = String(item?.ip || '').trim();
    const port = Number(item?.port);
    const protocols = Array.isArray(item?.protocols)
      ? item.protocols.map(v => String(v).toLowerCase())
      : [];

    if (!host || !port) continue;

    let scheme = null;
    if (protocols.includes('socks5')) scheme = 'socks5';
    else if (protocols.includes('https') || protocols.includes('http')) scheme = 'http';
    if (!scheme) continue;

    results.push(`${scheme}://${host}:${port}`);
  }

  return Array.from(new Set(results)).slice(0, MAX_CANDIDATES_PER_SOURCE);
}

async function fetchRoundProxiesCandidates() {
  // 与 jhao104/proxy_pool 2026-06-09 当前实现保持一致。
  const pageSize =
    Math.min(
      50,
      MAX_CANDIDATES_PER_SOURCE
    );

  const url =
    'https://roundproxies.com/api/get-free-proxies/'
    + '?limit=' + pageSize
    + '&page=1'
    + '&sort_by=lastChecked'
    + '&sort_type=desc';

  try {
    const json =
      JSON.parse(
        await fetchText(url)
      );

    const rows =
      Array.isArray(json?.data)
        ? json.data
        : [];

    return rows
      .map(item => {
        const host =
          String(item?.ip || '').trim();

        const port =
          Number(item?.port);

        if (!host || !port) {
          return null;
        }

        return normalizeProxy(
          host + ':' + port,
          'http'
        );
      })
      .filter(Boolean)
      .slice(
        0,
        MAX_CANDIDATES_PER_SOURCE
      );

  } catch (error) {
    console.log(
      `[RoundProxies] 获取失败：${error.message}`
    );
    return [];
  }
}

function readScores() {
  try {
    if (!fs.existsSync(SCORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeScores(scores) {
  fs.mkdirSync(path.dirname(SCORE_FILE), { recursive: true });
  fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2) + '\n', 'utf8');
}

function classifyFailure(message) {
  const s = String(message || '').toLowerCase();
  if (s.includes('418')) return 'http418';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
  if (s.includes('socks_connection_failed')) return 'socksFailed';
  return 'failed';
}

function updateScore(scores, proxy, result, source) {
  const old = scores[proxy] || {};
  const item = {
    source: source || old.source || 'unknown',
    success: Number(old.success || 0),
    failed: Number(old.failed || 0),
    http418: Number(old.http418 || 0),
    timeout: Number(old.timeout || 0),
    socksFailed: Number(old.socksFailed || 0),
    lastMs: Number(result.ms || 0),
    lastTestAt: new Date().toISOString()
  };

  if (result.ok) item.success++;
  else {
    item.failed++;
    const type = classifyFailure(result.error);
    if (type !== 'failed') item[type]++;
  }

  const total = item.success + item.failed;
  const successRate = total ? item.success / total : 0;
  const penalty = item.http418 * 8 + item.timeout * 3 + item.socksFailed * 4;
  const speedBonus = result.ok ? Math.max(0, 15 - Math.floor(result.ms / 500)) : 0;
  item.score = Math.max(
    0,
    Math.min(100, Math.round(successRate * 85 + speedBonus - penalty))
  );

  scores[proxy] = item;
}

async function collectSources() {
  const sourceFetchers = [
    // 微博实测成功率较高的源优先保留。
    ['ProxyClean', fetchProxyCleanCandidates],
    ['Proxmint', fetchProxmintCandidates],
    ['Relayglass', fetchRelayglassCandidates],
    ['Databay', fetchDatabayCandidates],
    ['Proxifly', fetchProxiflyCandidates],
    ['ProxyScrape', fetchProxyScrapeCandidates],

    // 新增 GitHub 高频更新代理源，先进入微博实测观察。
    ['Monosans', fetchMonosansCandidates],
    ['HProxy', fetchHProxyCandidates],
    ['Proxio', fetchProxioCandidates],

    // 暂无足够微博实测样本，先保留观察。
    ['DocIP', fetchDocIpCandidates],
    ['GoodIPs', fetchGoodIpsCandidates],
    ['RoundProxies', fetchRoundProxiesCandidates]
  ];

  const all = [];

  for (
    const [name, fn]
    of sourceFetchers
  ) {
    try {
      const list =
        await fn();

      console.log(
        `[来源:${name}] 候选=${list.length}`
      );

      all.push(
        ...list.map(proxy => ({
          proxy,
          source: name
        }))
      );

    } catch (error) {
      console.log(
        `[来源:${name}] 获取失败：${error.message}`
      );
    }
  }

  const dedup =
    new Map();

  for (
    const item
    of all
  ) {
    if (
      !dedup.has(
        item.proxy
      )
    ) {
      dedup.set(
        item.proxy,
        item
      );
    }
  }

  return shuffle(
    Array.from(
      dedup.values()
    )
  );
}

async function testOne(proxy) {
  const startedAt =
    Date.now();

  let browser = null;

  try {
    browser =
      await chromium.launch({
        headless: true,
        proxy: {
          server: proxy
        }
      });

    const context =
      await browser.newContext();

    const page =
      await context.newPage();

    const weiboResponse =
      await page.goto(
        WEIBO_URL,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            TIMEOUT_MS
        }
      );

    const status =
      weiboResponse
        ? weiboResponse.status()
        : 0;

    if (
      !weiboResponse
      || status >= 400
    ) {
      throw new Error(
        `weibo HTTP ${status || 'NO_RESPONSE'}`
      );
    }

    return {
      ok: true,
      proxy,
      status,
      ms:
        Date.now()
        - startedAt
    };

  } catch (error) {
    return {
      ok: false,
      proxy,
      error:
        error.message,
      ms:
        Date.now()
        - startedAt
    };

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

async function testMany(
  items,
  {
    stopAt = Infinity,
    label = '测试'
  } = {}
) {
  const list =
    Array.from(
      items || []
    );

  const passed = [];
  const scores = readScores();
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      if (
        passed.length
        >= stopAt
      ) {
        return;
      }

      const index =
        cursor++;

      if (
        index >= list.length
      ) {
        return;
      }

      const item =
        typeof list[index] === 'string'
          ? {
              proxy: list[index],
              source: 'existing'
            }
          : list[index];

      const result =
        await testOne(
          item.proxy
        );

      done++;

      updateScore(
        scores,
        item.proxy,
        result,
        item.source || 'unknown'
      );

      if (result.ok) {
        passed.push({
          ...result,
          source:
            item.source
            || 'unknown'
        });

        const writtenNow =
          appendGoodProxy(
            item.proxy
          );

        if (writtenNow) {
          console.log(
            `[健康池实时写入] ${item.proxy} | 当前文件代理=${readGoodPool().length}`
          );
        }

        console.log(
          `[${label} ${done}/${list.length}] PASS | ${item.proxy} | source=${item.source || '-'} | exit=${result.exitIp || '-'} | ${result.ms}ms`
        );

      } else {
        console.log(
          `[${label} ${done}/${list.length}] FAIL | ${item.proxy} | source=${item.source || '-'} | ${result.error} | ${result.ms}ms`
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            CONCURRENCY,
            Math.max(
              1,
              list.length
            )
          )
      },
      () => worker()
    )
  );

  writeScores(scores);

  passed.sort((a, b) => {
    const scoreA = Number(scores[a.proxy]?.score || 0);
    const scoreB = Number(scores[b.proxy]?.score || 0);
    return scoreB - scoreA || a.ms - b.ms;
  });

  return passed;
}

async function main() {
  console.log('');
  console.log('==============================================');
  console.log('微博多源健康代理池维护');
  console.log(`健康池文件: ${GOOD_POOL_FILE}`);
  console.log(`目标健康代理: ${TARGET_GOOD_COUNT}`);
  console.log(`单源最多候选: ${MAX_CANDIDATES_PER_SOURCE}`);
  console.log(`并发: ${CONCURRENCY}`);
  console.log(`测试微博: ${WEIBO_URL}`);
  console.log('==============================================');

  const oldPool =
    readGoodPool();

  let healthy = [];

  if (
    oldPool.length > 0
  ) {
    console.log('');
    console.log(
      `[健康池] 先复测已有代理 ${oldPool.length} 个...`
    );

    healthy =
      await testMany(
        oldPool,
        {
          stopAt:
            TARGET_GOOD_COUNT,

          label:
            '复测'
        }
      );
  }

  const healthySet =
    new Set(
      healthy.map(
        item => item.proxy
      )
    );

  if (
    healthySet.size
    < TARGET_GOOD_COUNT
  ) {
    console.log('');
    console.log(
      `[补池] 当前健康代理=${healthySet.size}，开始从多源免费代理池补充...`
    );

    const candidates =
      await collectSources();

    const freshCandidates =
      candidates.filter(
        item =>
          !healthySet.has(
            item.proxy
          )
      );

    console.log(
      `[补池] 去重后新候选=${freshCandidates.length}`
    );

    const need =
      TARGET_GOOD_COUNT
      - healthySet.size;

    const newPassed =
      await testMany(
        freshCandidates,
        {
          stopAt:
            need,

          label:
            '补测'
        }
      );

    for (
      const item
      of newPassed
    ) {
      healthy.push(item);
      healthySet.add(
        item.proxy
      );
    }
  }

  healthy =
    healthy
      .filter(
        (
          item,
          index,
          array
        ) =>
          array.findIndex(
            other =>
              other.proxy
              === item.proxy
          )
          === index
      )
      .sort(
        (a, b) => {
          const scores = readScores();
          const scoreA = Number(scores[a.proxy]?.score || 0);
          const scoreB = Number(scores[b.proxy]?.score || 0);
          return scoreB - scoreA || a.ms - b.ms;
        }
      )
      .slice(
        0,
        TARGET_GOOD_COUNT
      );

  /*
   * PASS 时已经实时写入文件。
   * 本轮结束再整理一次，但要和磁盘当前内容合并，
   * 避免并发 worker 已写入的代理被最终覆盖掉。
   */
  const diskPool =
    readGoodPool();

  const finalPool =
    Array.from(
      new Set([
        ...healthy.map(
          item => item.proxy
        ),
        ...diskPool
      ])
    )
      .slice(
        0,
        TARGET_GOOD_COUNT
      );

  writeGoodPool(
    finalPool
  );

  const sourceStats = {};

  for (
    const item
    of healthy
  ) {
    const key =
      item.source
      || 'existing';

    sourceStats[key] =
      (sourceStats[key] || 0)
      + 1;
  }

  console.log('');
  console.log('================ 结果 ================');
  console.log(
    `健康代理: ${healthy.length}/${TARGET_GOOD_COUNT}`
  );

  console.log(
    `已保存: ${GOOD_POOL_FILE}`
  );

  console.log(
    `来源分布: ${JSON.stringify(sourceStats)}`
  );

  if (
    healthy.length
    < TARGET_GOOD_COUNT
  ) {
    console.log('');
    console.log(
      `[提示] 免费源本轮只凑到 ${healthy.length}/${TARGET_GOOD_COUNT}；下次再次运行会先复测现有池，再继续从多源补新代理。`
    );
  }
}

const MAINTAIN_INTERVAL_MS =
  Number(
    process.env.WEIBO_PROXY_MAINTAIN_INTERVAL_MS
  )
  || 15 * 60 * 1000;

async function runForever() {
  let round = 0;

  console.log(
    `[健康池] 常驻维护已启动：每 ${Math.round(MAINTAIN_INTERVAL_MS / 60000)} 分钟拉取/复测一次。`
  );

  while (true) {
    round++;

    console.log('');
    console.log(
      `========== 健康代理池第 ${round} 轮 ==========`
    );

    try {
      await main();
    } catch (error) {
      console.error(
        '[微博健康代理池维护失败]',
        error
      );

      console.log(
        '[健康池] 本轮失败不退出，15分钟后继续下一轮。'
      );
    }

    console.log(
      `[健康池] 第 ${round} 轮结束；${Math.round(MAINTAIN_INTERVAL_MS / 60000)} 分钟后开始下一轮。`
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          MAINTAIN_INTERVAL_MS
        )
    );
  }
}

runForever().catch(error => {
  console.error(
    '[微博健康代理池常驻任务异常退出]',
    error
  );

  process.exitCode = 1;
});
