const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR =
  process.env.WEIBO_JYZ_PROFILE
    ? path.resolve(process.env.WEIBO_JYZ_PROFILE)
    : path.join(ROOT, 'data', 'weibo-jyz-browser-profile');

const HUATI_URL =
  'https://huati.weibo.cn/super/setting/icon'
  + '?page_id=100808f1d33f71dff693a2708cb3e8ef584a44'
  + '&icon_type=1'
  + '&union_id=chao_like';

(async () => {
  const context =
    await chromium.launchPersistentContext(
      PROFILE_DIR,
      {
        headless: false,
        viewport: {
          width: 1280,
          height: 900
        }
      }
    );

  const page =
    context.pages()[0]
    || await context.newPage();

  console.log(
    '[JYZ Login] 浏览器已打开。请完成微博登录，并确认最终能停留在 huati.weibo.cn 页面。'
  );

  await page.goto(
    HUATI_URL,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        30000
    }
  ).catch(() => null);

  console.log(
    '[JYZ Login] 登录完成后，在这个命令窗口按 Enter 保存并退出。'
  );

  process.stdin.setEncoding(
    'utf8'
  );

  process.stdin.resume();

  await new Promise(
    resolve =>
      process.stdin.once(
        'data',
        resolve
      )
  );

  console.log(
    '[JYZ Login] 当前页面：'
    + page.url()
  );

  await context.close();

  console.log(
    '[JYZ Login] JYZ专用persistent profile已保存：'
    + PROFILE_DIR
  );
})()
  .catch(
    error => {
      console.error(
        '[JYZ Login] 失败：',
        error
      );
      process.exitCode = 1;
    }
  );
