const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const GOOD_POOL_FILE =
  process.env.WEIBO_GOOD_PROXY_FILE
  || path.join(
    __dirname,
    '..',
    'data',
    'weibo-good-proxies.txt'
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

const TEST_URL =
  process.env.WEIBO_GOOD_PROXY_TEST_URL
  || 'https://api.ipify.org';

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

async function collectSources() {
  const sourceFetchers = [
    ['SCDN', fetchScdnCandidates],
    ['ProxyClean', fetchProxyCleanCandidates],
    ['89ip', fetch89IpCandidates],
    ['fate0', fetchFate0Candidates]
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

    const ipResponse =
      await page.goto(
        TEST_URL,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            TIMEOUT_MS
        }
      );

    if (
      !ipResponse
      || !ipResponse.ok()
    ) {
      throw new Error(
        `ipify HTTP ${ipResponse ? ipResponse.status() : 'NO_RESPONSE'}`
      );
    }

    const exitIp =
      String(
        await page.textContent('body')
        || ''
      ).trim();

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
      exitIp,
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

      if (result.ok) {
        passed.push({
          ...result,
          source:
            item.source
            || 'unknown'
        });

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
      `[补池] 当前健康代理=${healthySet.size}，开始从4个免费源补充...`
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
        (a, b) =>
          a.ms - b.ms
      )
      .slice(
        0,
        TARGET_GOOD_COUNT
      );

  writeGoodPool(
    healthy.map(
      item => item.proxy
    )
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
      `[提示] 免费源本轮只凑到 ${healthy.length}/${TARGET_GOOD_COUNT}；下次再次运行会先复测现有池，再继续从4个源补新代理。`
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
