const {
  createBatchLogger
} = require('../src/batch-logger');

let batchLogger = null;

if (require.main === module) {
  batchLogger =
    createBatchLogger(
      'proxy-pool'
    );
}

const fs = require('fs');
const path = require('path');
const { request, chromium } = require('playwright');

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
  || 500;

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

const MOBILE_WEIBO_URL =
  process.env.WEIBO_GOOD_PROXY_MOBILE_URL
  || 'https://m.weibo.cn/';

const MAX_LATENCY_MS =
  Number(
    process.env.WEIBO_GOOD_PROXY_MAX_LATENCY_MS
  )
  || 5000;

const SOCKS5_MAX_LATENCY_MS =
  Number(
    process.env.WEIBO_GOOD_PROXY_SOCKS5_MAX_LATENCY_MS
  )
  || 2500;

const MIN_SCORE =
  Number(
    process.env.WEIBO_GOOD_PROXY_MIN_SCORE
  )
  || 60;

const A_GRADE_SCORE =
  Number(
    process.env.WEIBO_GOOD_PROXY_A_SCORE
  )
  || 80;

const CHROMIUM_TIMEOUT_MS =
  Number(
    process.env.WEIBO_GOOD_PROXY_CHROMIUM_TIMEOUT_MS
  )
  || 10000;

const HOT_AJAX_URL =
  'https://weibo.com/ajax_proxy/chaohua/page?flowId=100808f1d33f71dff693a2708cb3e8ef584a44';

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

function getPlaywrightProxyConfig(rawValue) {
  const normalized =
    normalizeProxy(
      rawValue
    );

  if (!normalized) {
    return null;
  }

  try {
    const parsed =
      new URL(
        normalized
      );

    const proxy = {
      server:
        parsed.protocol
        + '//'
        + parsed.hostname
        + (
          parsed.port
            ? ':' + parsed.port
            : ''
        )
    };

    if (parsed.username) {
      proxy.username =
        decodeURIComponent(
          parsed.username
        );
    }

    if (parsed.password) {
      proxy.password =
        decodeURIComponent(
          parsed.password
        );
    }

    return proxy;

  } catch {
    return {
      server:
        normalized
    };
  }
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
    ['ProxyClean', fetchProxyCleanCandidates],
    ['Proxmint', fetchProxmintCandidates],
    ['Relayglass', fetchRelayglassCandidates],
    ['Monosans', fetchMonosansCandidates],
    ['Databay', fetchDatabayCandidates],
    ['ProxyScrape', fetchProxyScrapeCandidates]
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

let sharedChromiumBrowser =
  null;

async function getSharedChromiumBrowser() {
  if (
    sharedChromiumBrowser
    &&
    sharedChromiumBrowser.isConnected()
  ) {
    return sharedChromiumBrowser;
  }

  sharedChromiumBrowser =
    await chromium.launch({
      headless: true
    });

  console.log(
    '[健康池][Chromium] 已启动单个共享Headless Chromium；后续代理复用浏览器，不再反复启动进程。'
  );

  return sharedChromiumBrowser;
}


async function closeSharedChromiumBrowser() {
  if (!sharedChromiumBrowser) {
    return;
  }

  try {
    await sharedChromiumBrowser.close();
  } catch {
    // ignore
  }

  sharedChromiumBrowser =
    null;
}


async function chromiumVerify(proxy) {
  const startedAt =
    Date.now();

  let context = null;

  try {
    const proxyConfig =
      getPlaywrightProxyConfig(
        proxy
      );

    const browser =
      await getSharedChromiumBrowser();

    context =
      await browser.newContext({
        proxy:
          proxyConfig,
        userAgent:
          USER_AGENT,
        ignoreHTTPSErrors:
          true
      });

    const page =
      await context.newPage();

    await page.route(
      '**/*',
      async route => {
        const type =
          route.request()
            .resourceType();

        if (
          type === 'image'
          ||
          type === 'media'
          ||
          type === 'font'
        ) {
          await route.abort();
          return;
        }

        await route.continue();
      }
    );

    const response =
      await page.goto(
        WEIBO_URL,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            CHROMIUM_TIMEOUT_MS
        }
      );

    const status =
      response?.status?.()
      ?? null;

    if (
      status !== null
      &&
      status >= 400
    ) {
      throw new Error(
        `Chromium weibo HTTP ${status}`
      );
    }

    const ajaxResult =
      await page.evaluate(
        async url => {
          const controller =
            new AbortController();

          const timer =
            setTimeout(
              () => controller.abort(),
              7000
            );

          try {
            const r =
              await fetch(
                url,
                {
                  credentials:
                    'include',
                  signal:
                    controller.signal,
                  headers: {
                    'X-Requested-With':
                      'XMLHttpRequest'
                  }
                }
              );

            return {
              status:
                r.status,
              text:
                (await r.text())
                  .slice(0, 200)
            };
          } finally {
            clearTimeout(timer);
          }
        },
        HOT_AJAX_URL
      );

    if (
      !ajaxResult
      ||
      ajaxResult.status >= 400
    ) {
      throw new Error(
        `Chromium AJAX HTTP ${ajaxResult?.status ?? '-'} ${ajaxResult?.text || ''}`
      );
    }

    const mobilePage =
      await context.newPage();

    const mobileResponse =
      await mobilePage.goto(
        MOBILE_WEIBO_URL,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            CHROMIUM_TIMEOUT_MS
        }
      );

    const mobileStatus =
      mobileResponse?.status?.()
      ?? null;

    if (
      mobileStatus !== null
      &&
      mobileStatus >= 400
    ) {
      throw new Error(
        `Chromium m.weibo HTTP ${mobileStatus}`
      );
    }

    return {
      ok: true,
      ms:
        Date.now()
        - startedAt,
      chromiumStatus:
        status,
      ajaxStatus:
        ajaxResult.status,
      mobileStatus
    };

  } catch (error) {
    return {
      ok: false,
      error:
        error?.message
        || String(error),
      ms:
        Date.now()
        - startedAt
    };

  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}


async function testOne(proxy) {
  const startedAt =
    Date.now();

  let apiContext = null;

  try {
    const proxyConfig =
      getPlaywrightProxyConfig(
        proxy
      );

    apiContext =
      await request.newContext({
        proxy:
          proxyConfig,
        userAgent:
          USER_AGENT,
        extraHTTPHeaders: {
          Accept:
            'text/html,application/json,text/plain,*/*'
        },
        ignoreHTTPSErrors:
          true
      });

    const firstStartedAt =
      Date.now();

    const response =
      await apiContext.get(
        WEIBO_URL,
        {
          timeout:
            TIMEOUT_MS,
          failOnStatusCode:
            false
        }
      );

    const status =
      response.status();

    const pcMs =
      Date.now()
      - firstStartedAt;

    if (
      status >= 400
    ) {
      throw new Error(
        `weibo HTTP ${status}`
      );
    }

    const mobileStartedAt =
      Date.now();

    const mobileResponse =
      await apiContext.get(
        MOBILE_WEIBO_URL,
        {
          timeout:
            TIMEOUT_MS,
          failOnStatusCode:
            false
        }
      );

    const mobileStatus =
      mobileResponse.status();

    const mobileMs =
      Date.now()
      - mobileStartedAt;

    if (
      mobileStatus >= 400
    ) {
      throw new Error(
        `m.weibo HTTP ${mobileStatus}`
      );
    }

    const latencyLimit =
      /^socks5:\/\//i.test(proxy)
        ? SOCKS5_MAX_LATENCY_MS
        : MAX_LATENCY_MS;

    const worstMs =
      Math.max(
        pcMs,
        mobileMs
      );

    if (
      worstMs
      > latencyLimit
    ) {
      throw new Error(
        `latency too high: pc=${pcMs}ms mobile=${mobileMs}ms limit=${latencyLimit}ms`
      );
    }

    return {
      ok: true,
      proxy,
      status,
      mobileStatus,
      pcMs,
      mobileMs,
      ms:
        Date.now()
        - startedAt
    };

  } catch (error) {
    return {
      ok: false,
      proxy,
      error:
        error?.message
        || String(error),
      ms:
        Date.now()
        - startedAt
    };

  } finally {
    if (apiContext) {
      try {
        await apiContext.dispose();
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

      let result =
        await testOne(
          item.proxy
        );

      /*
       * SOCKS5 必须连续两次快速预检通过，避免“偶尔能通”的慢节点进入正式池。
       */
      if (
        result.ok
        &&
        /^socks5:\/\//i.test(
          item.proxy
        )
      ) {
        const second =
          await testOne(
            item.proxy
          );

        if (!second.ok) {
          result = {
            ...second,
            error:
              `SOCKS5二次预检失败: ${second.error || '-'}`
          };
        } else {
          result = {
            ...result,
            ms:
              Math.max(
                result.ms,
                second.ms
              ),
            socksDoublePass:
              true
          };
        }
      }

      /*
       * 快速预检通过后，再用真实 Chromium + 超话 AJAX + m.weibo 验证。
       */
      if (result.ok) {
        const browserResult =
          await chromiumVerify(
            item.proxy
          );

        if (!browserResult.ok) {
          result = {
            ok: false,
            proxy:
              item.proxy,
            error:
              `Chromium二次验证失败: ${browserResult.error || '-'}`,
            ms:
              browserResult.ms
          };
        } else {
          result = {
            ...result,
            chromiumMs:
              browserResult.ms,
            chromiumVerified:
              true,
            ms:
              Math.max(
                result.ms,
                browserResult.ms
              )
          };
        }
      }

      done++;

      updateScore(
        scores,
        item.proxy,
        result,
        item.source || 'unknown'
      );

      const score =
        Number(
          scores[item.proxy]?.score
          || 0
        );

      if (
        result.ok
        &&
        score >= MIN_SCORE
      ) {
        passed.push({
          ...result,
          score,
          grade:
            score >= A_GRADE_SCORE
              ? 'A'
              : 'B',
          source:
            item.source
            || 'unknown'
        });

        console.log(
          `[${label} ${done}/${list.length}] PASS-${score >= A_GRADE_SCORE ? 'A' : 'B'} | score=${score} | ${item.proxy} | source=${item.source || '-'} | ${result.ms}ms`
        );

      } else {
        console.log(
          `[${label} ${done}/${list.length}] FAIL | score=${score} | ${item.proxy} | source=${item.source || '-'} | ${result.error || 'score too low'} | ${result.ms}ms`
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
  console.log(`测试微博PC: ${WEIBO_URL}`);
  console.log(`测试微博Mobile: ${MOBILE_WEIBO_URL}`);
  console.log(`HTTP延迟上限: ${MAX_LATENCY_MS}ms`);
  console.log(`SOCKS5延迟上限: ${SOCKS5_MAX_LATENCY_MS}ms（必须连续通过2次）`);
  console.log(`Chromium二次验证超时: ${CHROMIUM_TIMEOUT_MS}ms`);
  console.log(`正式池最低分: ${MIN_SCORE} | A级>=${A_GRADE_SCORE} | B级=${MIN_SCORE}-${A_GRADE_SCORE - 1}`);
  console.log('==============================================');
  console.log('');

  let healthy = [];

  const existing =
    readGoodPool();

  if (existing.length) {
    console.log(
      `[健康池] 先复测已有代理 ${existing.length} 个...`
    );

    healthy =
      await testMany(
        existing,
        {
          stopAt:
            TARGET_GOOD_COUNT,

          label:
            '复测'
        }
      );
  }

  if (
    healthy.length
    < TARGET_GOOD_COUNT
  ) {
    console.log('');
    console.log(
      `[补池] 当前健康代理=${healthy.length}，开始从多源免费代理池补充...`
    );

    const candidates =
      await collectSources();

    const existingSet =
      new Set(
        existing
      );

    const freshCandidates =
      candidates.filter(
        item =>
          !existingSet.has(
            item.proxy
          )
      );

    console.log(
      `[补池] 去重后新候选=${freshCandidates.length}`
    );

    const needed =
      Math.max(
        0,
        TARGET_GOOD_COUNT
        - healthy.length
      );

    const newlyPassed =
      await testMany(
        freshCandidates,
        {
          stopAt:
            needed,

          label:
            '补测'
        }
      );

    healthy.push(
      ...newlyPassed
    );
  }

  const dedup =
    new Map();

  for (
    const item
    of healthy
  ) {
    if (
      item?.proxy
      &&
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

  healthy =
    Array.from(
      dedup.values()
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
   * 这里只保存“本轮实际复测通过”的代理。
   * 旧逻辑会把 diskPool 再拼回来，导致本轮已经失败的旧代理重新进入健康池，
   * 这是健康池可用率低的主要原因之一。
   */
  const finalPool =
    Array.from(
      new Set(
        healthy.map(
          item => item.proxy
        )
      )
    )
      .slice(
        0,
        TARGET_GOOD_COUNT
      );

  writeGoodPool(
    finalPool
  );

  const sourceCount = {};

  for (
    const item
    of healthy
  ) {
    const source =
      item.source
      || 'unknown';

    sourceCount[source] =
      Number(
        sourceCount[source]
        || 0
      )
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
    `来源分布: ${JSON.stringify(sourceCount)}`
  );

  const gradeCount = {
    A:
      healthy.filter(
        item =>
          Number(item.score || 0)
          >= A_GRADE_SCORE
      ).length,
    B:
      healthy.filter(
        item =>
          Number(item.score || 0)
          >= MIN_SCORE
          &&
          Number(item.score || 0)
          < A_GRADE_SCORE
      ).length
  };

  console.log(
    `等级分布: A=${gradeCount.A} B=${gradeCount.B}`
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

async function runForever() {
  let round = 0;

  console.log(
    '[健康池] 常驻维护已启动：每 15 分钟拉取/复测一次。'
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
        `[健康池] 第 ${round} 轮异常：`,
        error
      );
    }

    console.log(
      `[健康池] 第 ${round} 轮结束；15 分钟后开始下一轮。`
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          15 * 60 * 1000
        )
    );
  }
}

if (
  require.main
  === module
) {
  runForever()
    .catch(async error => {
      console.error(error);

      await closeSharedChromiumBrowser();

      if (batchLogger) {
        try {
          await batchLogger.close();
        } catch {
          // ignore
        }
      }

      process.exitCode = 1;
    });
}

module.exports = {
  main,
  runForever,
  closeSharedChromiumBrowser
};
