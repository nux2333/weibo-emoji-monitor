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
 * project/
 * ├─ src/
 * │  ├─ config.js
 * │  ├─ monitor.js
 * │  └─ db.js
 * │
 * └─ config/
 *    └─ monitors.json
 */
const CONFIG_FILE =
  path.join(
    __dirname,
    '..',
    'config',
    'monitors.json'
  );


/**
 * ==========================================
 * 读取 monitors.json
 * ==========================================
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


  /**
   * monitors.json 必须直接是数组：
   *
   * [
   *   {...},
   *   {...}
   * ]
   */
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
 * ==========================================
 * 校验单个 Monitor 配置
 * ==========================================
 */
function validateMonitorConfig(
  monitor,
  index
) {

  if (
    !monitor ||
    typeof monitor !== 'object' ||
    Array.isArray(monitor)
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


  /**
   * URL 格式检查
   */
  try {

    new URL(
      monitor.url
    );

  } catch (error) {

    throw new Error(
      `monitors.json 第 ${index + 1} 项 URL 无效：${monitor.url}`
    );
  }


  /**
   * emojis 必须是数组
   */
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


  /**
   * texts 必须是数组
   */
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


  /**
   * monitor_type
   *
   * 当前只允许：
   *
   * comments
   * superlike
   *
   * 没写则默认 comments。
   */
  if (
    monitor.monitor_type !== undefined
  ) {

    const type =
      String(
        monitor.monitor_type
      )
        .trim()
        .toLowerCase();


    if (
      type !== 'comments' &&
      type !== 'superlike'
    ) {

      throw new Error(
        `monitors.json 第 ${index + 1} 项 monitor_type 无效：${monitor.monitor_type}，只允许 comments 或 superlike`
      );
    }
  }
}


/**
 * ==========================================
 * 规范化 monitor_type
 * ==========================================
 */
function normalizeMonitorType(
  value
) {

  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {

    return 'comments';
  }


  return String(value)
    .trim()
    .toLowerCase();
}


/**
 * ==========================================
 * 同步 monitors.json → SQLite
 * ==========================================
 */
function syncMonitorsFromConfig() {

  /**
   * 确保数据库已初始化。
   *
   * db.js 会自动补：
   *
   * monitors.monitor_type
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
      ).trim();


    const url =
      String(
        config.url
      ).trim();


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


    /**
     * enabled 不写默认 true。
     */
    const enabled =
      config.enabled !== false;


    /**
     * ★ 新增
     *
     * 没写 monitor_type：
     *
     * 默认 comments。
     */
    const monitorType =
      normalizeMonitorType(
        config.monitor_type
      );


    /**
     * 当前仍然按照 URL 判断是否已经存在。
     */
    const existing =
      getMonitorByUrl(
        url
      );


    if (
      !existing
    ) {

      /**
       * ======================================
       * 新增 Monitor
       * ======================================
       */
      const id =
        createMonitor({

          name,

          url,

          emojis,

          texts,

          enabled,

          monitor_type:
            monitorType

        });


      console.log(
        `新增 Monitor：${name} (ID=${id}, type=${monitorType})`
      );


    } else {

      /**
       * ======================================
       * 已存在 Monitor
       *
       * 更新：
       *
       * name
       * url
       * emojis
       * texts
       * enabled
       * monitor_type
       *
       * 不删除历史 comments。
       * ======================================
       */
      updateMonitor(
        existing.id,
        {

          name,

          url,

          emojis,

          texts,

          enabled,

          monitor_type:
            monitorType

        }
      );


      console.log(
        `更新 Monitor：${name} (ID=${existing.id}, type=${monitorType})`
      );
    }
  }


  /**
   * 注意：
   *
   * 如果 monitors.json 里删除了一条配置，
   * 不会自动 DELETE 数据库里的 Monitor。
   *
   * 避免误删历史数据。
   */
  console.log(
    '========================================'
  );


  return getMonitors();
}


module.exports = {

  CONFIG_FILE,

  loadMonitorConfig,

  validateMonitorConfig,

  normalizeMonitorType,

  syncMonitorsFromConfig

};