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

const HUATI_LOGIN_URL =
  'https://huati.weibo.cn/super/setting/icon'
  + '?page_id=100808f1d33f71dff693a2708cb3e8ef584a44'
  + '&icon_type=1'
  + '&union_id=chao_like';

const LOGIN_WAIT_MS =
  Number(
    process.env.WEIBO_LOGIN_WAIT_MS
  )
  || 5 * 60 * 1000;

function isHuatiPage(url) {
  try {
    return (
      new URL(url)
        .hostname
        .toLowerCase()
      === 'huati.weibo.cn'
    );
  } catch {
    return false;
  }
}

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

  console.log(
    '[WeiboLoginState] 请先停止正在使用旧主 Profile 的 scanner，再执行本脚本。'
  );

  const context =
    await chromium.launchPersistentContext(
      SOURCE_PROFILE,
      {
        /*
         * 默认显示浏览器，便于 passport / huati 完成一次真实登录。
         * 如确认已有 huati 登录态，可设置 WEIBO_LOGIN_EXPORT_HEADLESS=1。
         */
        headless:
          process.env.WEIBO_LOGIN_EXPORT_HEADLESS === '1',

        viewport: {
          width: 1280,
          height: 900
        }
      }
    );

  try {
    const pages =
      context.pages();

    const page =
      pages[0]
      ||
      await context.newPage();

    console.log(
      '[WeiboLoginState] 正在打开 huati.weibo.cn 超Like设置页...'
    );

    await page.goto(
      HUATI_LOGIN_URL,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    ).catch(
      error => {
        console.log(
          `[WeiboLoginState] 首次导航提示：${error.message}`
        );
      }
    );

    if (
      !isHuatiPage(
        page.url()
      )
    ) {
      console.log('');
      console.log(
        '[WeiboLoginState] 当前被跳转到微博登录页。'
      );
      console.log(
        '[WeiboLoginState] 请在弹出的浏览器里完成登录；登录成功回到 huati 页面后会自动继续。'
      );
      console.log('');

      const deadline =
        Date.now()
        + LOGIN_WAIT_MS;

      while (
        Date.now() < deadline
      ) {
        if (
          isHuatiPage(
            page.url()
          )
        ) {
          break;
        }

        await page.waitForTimeout(
          1000
        );
      }

      if (
        !isHuatiPage(
          page.url()
        )
      ) {
        throw new Error(
          `等待 huati 登录完成超时（${Math.ceil(LOGIN_WAIT_MS / 1000)}秒）。当前页面：${page.url()}`
        );
      }
    }

    /*
     * 回到 huati 后再停一会，让 SSO Cookie / 页面脚本全部落盘。
     */
    await page.waitForTimeout(
      1500
    );

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

    const huatiCookies =
      (state.cookies || [])
        .filter(
          cookie => {
            const domain =
              String(
                cookie?.domain
                || ''
              );

            return (
              domain.includes(
                'weibo.cn'
              )
              ||
              domain.includes(
                'weibo.com'
              )
            );
          }
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
      `[WeiboLoginState] huati登录已建立：${page.url()}`
    );

    console.log(
      `[WeiboLoginState] 已导出：${OUTPUT}`
    );

    console.log(
      `[WeiboLoginState] Cookie总数=${state.cookies?.length || 0} | weibo相关=${weiboCookies.length} | SSO候选=${huatiCookies.length}`
    );

    if (
      weiboCookies.length === 0
    ) {
      console.log(
        '[WeiboLoginState] 警告：仍未发现 weibo Cookie。'
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
