const monitorList =
  document.getElementById(
    'monitorList'
  );


async function request(
  url
) {

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return response.json();
}


/**
 * HTML 转义
 */
function escapeHtml(
  value
) {

  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


/**
 * 格式化时间
 */
function formatDate(
  value
) {

  if (!value) {
    return '-';
  }

  try {

    return new Date(value)
      .toLocaleString(
        'zh-CN',
        {
          hour12: false
        }
      );

  } catch {

    return value;
  }
}


/**
 * 创建统计项目
 */
function createStatRow(
  name,
  value
) {

  return `
    <div class="stat-row">

      <div class="stat-name">
        ${escapeHtml(name)}
      </div>

      <div class="stat-value">
        ${Number(value || 0).toLocaleString()}
      </div>

    </div>
  `;
}


/**
 * 获取单个监控结果
 */
async function renderMonitor(
  monitor
) {

  const resultResponse =
    await request(
      `/api/monitors/${monitor.id}/result`
    );


  const result =
    resultResponse.data;


  if (!result) {

    return `
      <section class="monitor-card">

        <div class="monitor-title">
          ${escapeHtml(monitor.name)}
        </div>

        <div class="empty">
          暂时还没有抓取结果
        </div>

      </section>
    `;
  }


  const emojiStats =
    result.emoji_stats || {};


  const textStats =
    result.text_stats || {};


  const emojiRows =
    Object.entries(
      emojiStats
    )
      .map(
        ([key, value]) =>
          createStatRow(
            key,
            value
          )
      )
      .join('');


  const textRows =
    Object.entries(
      textStats
    )
      .map(
        ([key, value]) =>
          createStatRow(
            key,
            value
          )
      )
      .join('');


  return `
    <section class="monitor-card">

      <div class="monitor-title">

        ${escapeHtml(monitor.name)}

      </div>


      <div class="update-time">

        最后更新：
        ${escapeHtml(
          result.created_at
            || result.stat_date
        )}

      </div>


      <!-- 总数 -->
      <div class="summary-grid">

        <div class="summary-item">

          <div class="summary-label">
            评论总数
          </div>

          <div class="summary-value">
            ${Number(
              result.total_comments || 0
            ).toLocaleString()}
          </div>

        </div>


        <div class="summary-item">

          <div class="summary-label">
            包含指定内容
          </div>

          <div class="summary-value">
            ${Number(
              result.matched_comments || 0
            ).toLocaleString()}
          </div>

        </div>


        <div class="summary-item">

          <div class="summary-label">
            不含指定内容
          </div>

          <div class="summary-value">
            ${Number(
              result.unmatched_comments || 0
            ).toLocaleString()}
          </div>

        </div>

      </div>


      <!-- Emoji -->
      <div class="section">

        <div class="section-title">
          指定 Emoji
        </div>

        ${
          emojiRows ||
          '<div class="empty">没有指定 Emoji</div>'
        }


        <div class="total-row">

          <span>
            Emoji 合计
          </span>

          <strong>
            ${Number(
              result.emoji_total || 0
            ).toLocaleString()}
          </strong>

        </div>

      </div>


      <!-- 文本 -->
      <div class="section">

        <div class="section-title">
          指定文本
        </div>

        ${
          textRows ||
          '<div class="empty">没有指定文本</div>'
        }


        <div class="total-row">

          <span>
            文本合计
          </span>

          <strong>
            ${Number(
              result.text_total || 0
            ).toLocaleString()}
          </strong>

        </div>

      </div>


      <!-- 评论 -->
      <div class="comments-section">

        <div class="section-title">
          评论
        </div>

        <div
          class="comments"
          id="comments-${monitor.id}"
        >
          正在加载评论...
        </div>

      </div>

    </section>
  `;
}


/**
 * 加载评论
 */
async function loadComments(
  monitor
) {

  const container =
    document.getElementById(
      `comments-${monitor.id}`
    );


  if (!container) {
    return;
  }


  try {

    const response =
      await request(
        `/api/monitors/${monitor.id}/comments?limit=100`
      );


    const comments =
      response.data || [];


    if (
      comments.length === 0
    ) {

      container.innerHTML =
        '<div class="empty">暂无评论</div>';

      return;
    }


    container.innerHTML =
      comments.map(
        comment => `
          <div class="comment-item">

            <div class="comment-id">
              ID：
              ${escapeHtml(
                comment.comment_id
              )}
            </div>

            <div class="comment-content">
              ${escapeHtml(
                comment.content
              )}
            </div>

          </div>
        `
      ).join('');

  } catch (error) {

    container.innerHTML =
      '<div class="error">评论加载失败</div>';
  }
}


/**
 * 加载全部监控
 */
async function loadMonitors() {

  try {

    const response =
      await request(
        '/api/monitors'
      );


    const monitors =
      response.data || [];


    if (
      monitors.length === 0
    ) {

      monitorList.innerHTML = `
        <div class="empty-page">

          <div class="empty-icon">
            📊
          </div>

          <div>
            暂时没有监控项目
          </div>

        </div>
      `;

      return;
    }


    /**
     * 先生成页面
     */
    const html =
      await Promise.all(
        monitors.map(
          monitor =>
            renderMonitor(
              monitor
            )
        )
      );


    monitorList.innerHTML =
      html.join('');


    /**
     * 再加载评论
     */
    for (
      const monitor of monitors
    ) {

      loadComments(
        monitor
      );
    }

  } catch (error) {

    console.error(error);

    monitorList.innerHTML = `
      <div class="error">
        数据加载失败，请稍后刷新
      </div>
    `;
  }
}


/**
 * 启动
 */
loadMonitors();


/**
 * 每 60 秒刷新一次
 *
 * 注意：
 * 这里不会重新抓微博。
 *
 * 只是读取 DB。
 */
setInterval(
  loadMonitors,
  60 * 1000
);