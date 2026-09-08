const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT =
  path.join(
    __dirname,
    '..'
  );

const SOURCE_PROFILE =
  process.env.WEIBO_LOGIN_SOURCE_PROFILE
    ? path.resolve(
        process.env.WEIBO_LOGIN_SOURCE_PROFILE
      )
    : path.join(
        ROOT,
        'data',
        'superlike-browser-profile-scan'
      );

const OUTPUT =
  process.env.WEIBO_LOGIN_STATE_FILE
    ? path.resolve(
        process.env.WEIBO_LOGIN_STATE_FILE
      )
    : path.join(
        ROOT,
        'data',
        'weibo-login-state.json'
      );

(async () => {
  if (
    !fs.existsSync(
      SOURCE_PROFILE
    )
  ) {
    throw new Error(
      `主登录Profile不存在：${SOURCE_PROFILE}`
    );
  }

  const context =
    await chromium.launchPersistentContext(
      SOURCE_PROFILE,
      {
        headless:
          process.env.WEIBO_LOGIN_EXPORT_HEADLESS !== '0'
      }
    );

  try {
    const pages =
      context.pages();

    const page =
      pages[0]
      ||
      await context.newPage();

    await page.goto(
      'https://weibo.com/',
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    ).catch(() => null);

    const state =
      await context.storageState();

    const weiboCookies =
      (state.cookies || [])
        .filter(
          cookie =>
            String(
              cookie?.domain
              || ''
            ).includes(
              'weibo'
            )
        );

    await fs.promises.mkdir(
      path.dirname(
        OUTPUT
      ),
      {
        recursive: true
      }
    );

    await fs.promises.writeFile(
      OUTPUT,
      JSON.stringify(
        state,
        null,
        2
      ),
      'utf8'
    );

    console.log(
      `[WeiboLoginState] 已导出：${OUTPUT}`
    );

    console.log(
      `[WeiboLoginState] Cookie总数=${state.cookies?.length || 0} | weibo相关=${weiboCookies.length}`
    );

    if (
      weiboCookies.length === 0
    ) {
      console.log(
        '[WeiboLoginState] 警告：没有发现 weibo Cookie，主Profile可能没有登录。'
      );
    }
  } finally {
    await context.close();
  }
})()
  .catch(
    error => {
      console.error(
        '[WeiboLoginState] 导出失败：',
        error
      );
      process.exitCode = 1;
    }
  );
