const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SOURCE_URL =
  process.env.PROXYCLEAN_SOURCE
  || 'https://raw.githubusercontent.com/HankNovic/ProxyClean/refs/heads/main/SOCKS5.txt';

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
  || 10;

const MAX_NEW_TESTS =
  Number(
    process.env.WEIBO_GOOD_PROXY_MAX_NEW_TESTS
  )
  || 100;

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
    || 5
  );

const TEST_URL =
  process.env.WEIBO_GOOD_PROXY_TEST_URL
  || 'https://api.ipify.org';

const WEIBO_URL =
  process.env.WEIBO_GOOD_PROXY_WEIBO_URL
  || 'https://weibo.com/p/100808f1d33f71dff693a2708cb3e8ef584a44';

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

    [
      arr[i],
      arr[j]
    ] = [
      arr[j],
      arr[i]
    ];
  }

  return arr;
}

function normalizeProxy(line) {
  const raw =
    String(line || '')
      .trim();

  if (
    !raw
    || raw.startsWith('#')
  ) {
    return null;
  }

  const noComment =
    raw.split('#')[0]
      .trim();

  if (!noComment) {
    return null;
  }

  return /^socks5:\/\//i.test(
    noComment
  )
    ? noComment
    : `socks5://${noComment}`;
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
          .map(normalizeProxy)
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
  const dir =
    path.dirname(
      GOOD_POOL_FILE
    );

  fs.mkdirSync(
    dir,
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    GOOD_POOL_FILE,
    items.join('\n')
    +
    (
      items.length
        ? '\n'
        : ''
    ),
    'utf8'
  );
}

async function fetchProxyClean() {
  const response =
    await fetch(
      SOURCE_URL,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `ProxyClean HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  return shuffle(
    Array.from(
      new Set(
        text
          .split(/\r?\n/)
          .map(normalizeProxy)
          .filter(Boolean)
      )
    )
  );
}

async function testOne(proxy) {
  const startedAt =
    Date.now();

  let browser =
    null;

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
        await page.textContent(
          'body'
        )
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
        -
        startedAt
    };

  } catch (error) {
    return {
      ok: false,
      proxy,
      error:
        error.message,
      ms:
        Date.now()
        -
        startedAt
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
  proxies,
  {
    stopAt = Infinity,
    label = '测试'
  } = {}
) {
  const list =
    Array.from(
      proxies
      || []
    );

  const passed =
    [];

  let cursor =
    0;

  let done =
    0;

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
        index >=
        list.length
      ) {
        return;
      }

      const proxy =
        list[index];

      const result =
        await testOne(
          proxy
        );

      done++;

      if (result.ok) {
        passed.push(
          result
        );

        console.log(
          `[${label} ${done}/${list.length}] PASS | ${proxy} | exit=${result.exitIp || '-'} | weibo=${result.status} | ${result.ms}ms`
        );

      } else {
        console.log(
          `[${label} ${done}/${list.length}] FAIL | ${proxy} | ${result.error} | ${result.ms}ms`
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
  console.log('微博 SOCKS5 健康代理池维护');
  console.log(`健康池文件: ${GOOD_POOL_FILE}`);
  console.log(`目标健康代理: ${TARGET_GOOD_COUNT}`);
  console.log(`最多测试新代理: ${MAX_NEW_TESTS}`);
  console.log(`并发: ${CONCURRENCY}`);
  console.log(`测试微博: ${WEIBO_URL}`);
  console.log('==============================================');

  const oldPool =
    readGoodPool();

  let healthy =
    [];

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
        item =>
          item.proxy
      )
    );

  if (
    healthySet.size
    <
    TARGET_GOOD_COUNT
  ) {
    console.log('');
    console.log(
      `[补池] 当前健康代理=${healthySet.size}，开始从 ProxyClean 补充...`
    );

    const source =
      await fetchProxyClean();

    const candidates =
      source
        .filter(
          proxy =>
            !healthySet.has(
              proxy
            )
        )
        .slice(
          0,
          MAX_NEW_TESTS
        );

    const need =
      TARGET_GOOD_COUNT
      -
      healthySet.size;

    const newPassed =
      await testMany(
        candidates,
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
      healthy.push(
        item
      );

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
      item =>
        item.proxy
    )
  );

  console.log('');
  console.log('================ 结果 ================');
  console.log(
    `健康代理: ${healthy.length}/${TARGET_GOOD_COUNT}`
  );

  console.log(
    `已保存: ${GOOD_POOL_FILE}`
  );

  if (
    healthy.length > 0
  ) {
    console.log('');
    console.log(
      '当前健康池（按本次测试耗时排序）:'
    );

    for (
      const item
      of healthy
    ) {
      console.log(
        `${item.proxy} | exit=${item.exitIp || '-'} | ${item.ms}ms`
      );
    }
  }

  if (
    healthy.length
    <
    TARGET_GOOD_COUNT
  ) {
    console.log('');
    console.log(
      `[提示] 本轮没凑满 ${TARGET_GOOD_COUNT} 个；下次再次运行会先复测现有健康池，再继续补新代理。`
    );
  }
}

main().catch(error => {
  console.error(
    '[微博健康代理池维护失败]',
    error
  );

  process.exitCode =
    1;
});
