const { chromium } = require('playwright');

const SOURCE_URL =
  process.env.PROXYCLEAN_SOURCE
  || 'https://raw.githubusercontent.com/HankNovic/ProxyClean/refs/heads/main/SOCKS5.txt';

const LIMIT =
  Number(process.env.PROXYCLEAN_LIMIT)
  || 20;

const CONNECT_TIMEOUT_MS =
  Number(process.env.PROXYCLEAN_TIMEOUT_MS)
  || 8000;

const TEST_URL =
  process.env.PROXYCLEAN_TEST_URL
  || 'https://api.ipify.org';

const WEIBO_URL =
  process.env.PROXYCLEAN_WEIBO_URL
  || 'https://weibo.com';

function shuffle(values) {
  const arr = [...values];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function parseProxyLine(line) {
  const raw = String(line || '').trim();

  if (!raw || raw.startsWith('#')) {
    return null;
  }

  const noComment =
    raw.split('#')[0].trim();

  if (!noComment) {
    return null;
  }

  return /^socks5:\/\//i.test(noComment)
    ? noComment
    : `socks5://${noComment}`;
}

async function fetchProxyList() {
  const response =
    await fetch(SOURCE_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
      }
    });

  if (!response.ok) {
    throw new Error(`ProxyClean HTTP ${response.status}`);
  }

  const text =
    await response.text();

  return shuffle(
    text
      .split(/\r?\n/)
      .map(parseProxyLine)
      .filter(Boolean)
  );
}

async function testOne(proxy, index, total) {
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
      await page.goto(TEST_URL, {
        waitUntil: 'domcontentloaded',
        timeout: CONNECT_TIMEOUT_MS
      });

    const ipBody =
      String(
        await page.textContent('body')
        || ''
      ).trim();

    if (!ipResponse || !ipResponse.ok()) {
      throw new Error(
        `ipify HTTP ${ipResponse ? ipResponse.status() : 'NO_RESPONSE'}`
      );
    }

    const weiboResponse =
      await page.goto(WEIBO_URL, {
        waitUntil: 'domcontentloaded',
        timeout: CONNECT_TIMEOUT_MS
      });

    const status =
      weiboResponse
        ? weiboResponse.status()
        : 0;

    const ms =
      Date.now() - startedAt;

    console.log(
      `[${index}/${total}] PASS | ${proxy} | exit=${ipBody || '-'} | weibo=${status} | ${ms}ms`
    );

    return {
      ok: true,
      proxy,
      exitIp: ipBody,
      weiboStatus: status,
      ms
    };

  } catch (error) {
    const ms =
      Date.now() - startedAt;

    console.log(
      `[${index}/${total}] FAIL | ${proxy} | ${error.message} | ${ms}ms`
    );

    return {
      ok: false,
      proxy,
      error: error.message,
      ms
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

async function main() {
  console.log('');
  console.log('==============================================');
  console.log('ProxyClean SOCKS5 测试');
  console.log(`来源: ${SOURCE_URL}`);
  console.log(`测试数量: ${LIMIT}`);
  console.log(`单代理超时: ${CONNECT_TIMEOUT_MS}ms`);
  console.log('测试顺序: api.ipify.org -> weibo.com');
  console.log('==============================================');

  const proxies =
    await fetchProxyList();

  if (proxies.length === 0) {
    throw new Error('ProxyClean 没有返回代理');
  }

  const selected =
    proxies.slice(0, LIMIT);

  const results = [];

  for (let i = 0; i < selected.length; i++) {
    results.push(
      await testOne(
        selected[i],
        i + 1,
        selected.length
      )
    );
  }

  const passed =
    results
      .filter(item => item.ok)
      .sort((a, b) => a.ms - b.ms);

  console.log('');
  console.log('================ 结果 ================');
  console.log(`总数: ${results.length}`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${results.length - passed.length}`);
  console.log(
    `成功率: ${results.length ? ((passed.length / results.length) * 100).toFixed(1) : '0.0'}%`
  );

  if (passed.length > 0) {
    console.log('');
    console.log('可用代理（按耗时排序）:');

    for (const item of passed) {
      console.log(
        `${item.proxy} | exit=${item.exitIp} | weibo=${item.weiboStatus} | ${item.ms}ms`
      );
    }
  }
}

main().catch(error => {
  console.error('[ProxyClean测试失败]', error);
  process.exitCode = 1;
});
