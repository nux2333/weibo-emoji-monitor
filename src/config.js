const fs = require('fs');
const path = require('path');

const {
  initDatabase,
  getMonitors,
  getMonitorByUrl,
  createMonitor,
  updateMonitor
} = require('./db');


/**
 * monitors.json 的位置
 *
 * 如果你的项目结构是：
 *
 * project/
 * ├─ src/
 * │  ├─ config.js
 * │  ├─ monitor.js
 * │  └─ db.js
 * │
 * └─ config/
 *    └─ monitors.json
 *
 * 就是这里。
 */
const CONFIG_FILE =
  path.join(
    __dirname,
    '..',
    'config',
    'monitors.json'
  );


/**
 * =========================
 * 读取 JSON
 * =========================
 */
function loadMonitorConfig() {

  if (
    !fs.existsSync(
      CONFIG_FILE
    )
  ) {

    throw new Error(
      `找不到配置文件：${CONFIG_FILE}`
    );
  }


  const text =
    fs.readFileSync(
      CONFIG_FILE,
      'utf8'
    );


  let config;


  try {

    config =
      JSON.parse(text);

  } catch (error) {

    throw new Error(
      `monitors.json JSON 格式错误：${error.message}`
    );
  }


  if (
    !Array.isArray(config)
  ) {

    throw new Error(
      'monitors.json 必须是数组 []'
    );
  }


  return config;
}


/**
 * =========================
 * 校验配置
 * =========================
 */
function validateMonitorConfig(
  monitor,
  index
) {

  if (
    !monitor ||
    typeof monitor !== 'object'
  ) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项不是对象`
    );
  }


  if (
    !monitor.name
  ) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项缺少 name`
    );
  }


  if (
    !monitor.url
  ) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项缺少 url`
    );
  }


  try {

    new URL(
      monitor.url
    );

  } catch (error) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项 URL 无效：${monitor.url}`
    );
  }


  if (
    monitor.emojis !== undefined &&
    !Array.isArray(
      monitor.emojis
    )
  ) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项 emojis 必须是数组`
    );
  }


  if (
    monitor.texts !== undefined &&
    !Array.isArray(
      monitor.texts
    )
  ) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项 texts 必须是数组`
    );
  }
}


/**
 * =========================
 * 同步配置到数据库
 * =========================
 */
function syncMonitorsFromConfig() {

  /**
   * 确保数据库已经初始化
   */
  initDatabase();


  const configs =
    loadMonitorConfig();


  console.log('');
  console.log(
    '========== 同步 Monitor 配置 =========='
  );


  for (
    let i = 0;
    i < configs.length;
    i++
  ) {

    const config =
      configs[i];


    validateMonitorConfig(
      config,
      i
    );


    const name =
      String(
        config.name
      );


    const url =
      String(
        config.url
      );


    const emojis =
      Array.isArray(
        config.emojis
      )
        ? config.emojis
        : [];


    const texts =
      Array.isArray(
        config.texts
      )
        ? config.texts
        : [];


    const enabled =
      config.enabled !== false;


    /**
     * 通过 URL 判断是不是已经存在
     */
    const existing =
      getMonitorByUrl(
        url
      );


    if (
      !existing
    ) {

      const id =
        createMonitor({

          name,

          url,

          emojis,

          texts,

          enabled
        });


      console.log(
        `新增 Monitor：${name} (ID=${id})`
      );


    } else {

      /**
       * 已存在：
       *
       * 更新名称 / Emoji / 文本 / enabled。
       *
       * 评论不会被删除。
       */
      updateMonitor(

        existing.id,

        {

          name,

          url,

          emojis,

          texts,

          enabled
        }
      );


      console.log(
        `更新 Monitor：${name} (ID=${existing.id})`
      );
    }
  }


  /**
   * 注意：
   *
   * JSON 里删除某个 Monitor，
   * 不会删除数据库里的 Monitor。
   *
   * 这样可以避免误删历史评论。
   */
  console.log(
    '========================================'
  );


  return getMonitors();
}


module.exports = {

  CONFIG_FILE,

  loadMonitorConfig,

  syncMonitorsFromConfig
};