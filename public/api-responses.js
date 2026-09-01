const $ = id =>
  document.getElementById(id);


const TOKEN_KEY =
  'admin_token';


let currentPage = 1;

let totalPages = 1;

let loading = false;


/**
 * ==================================================
 * Token
 * ==================================================
 *
 * 页面不再显示 Token 输入框。
 *
 * 继续读取之前已经保存到 localStorage 的：
 *
 * admin_token
 *
 * 如果之前已经成功保存过，
 * 后续无需再次输入。
 */
function token() {

  return (
    localStorage.getItem(
      TOKEN_KEY
    ) || ''
  ).trim();

}


/**
 * 保留这个方法，
 * 如果以后其他页面还调用 saveToken，
 * 不会报错。
 */
function saveToken() {

  const value =
    $('token')?.value?.trim() || '';

  if (value) {

    localStorage.setItem(
      TOKEN_KEY,
      value
    );

  }

  currentPage = 1;

  loadMonitors();

  load();

}


/**
 * ==================================================
 * API 请求
 * ==================================================
 */
async function api(
  url,
  opt = {}
) {

  const headers = {

    'Content-Type':
      'application/json',

    ...(opt.headers || {})

  };


  const adminToken =
    token();


  if (adminToken) {

    headers[
      'x-admin-token'
    ] =
      adminToken;

  }


  const r =
    await fetch(
      url,
      {
        ...opt,
        headers
      }
    );


  const j =
    await r
      .json()
      .catch(
        () => ({
          success: false,
          message: '非 JSON'
        })
      );


  if (
    !r.ok ||
    j.success === false
  ) {

    if (
      r.status === 401
    ) {

      throw new Error(
        'ADMIN_TOKEN 无效或浏览器中没有保存 admin_token'
      );

    }


    throw new Error(
      j.message ||
      `HTTP ${r.status}`
    );

  }


  return j;

}


/**
 * ==================================================
 * HTML 转义
 * ==================================================
 */
function esc(v) {

  return String(
    v ?? ''
  )
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#39;'
    );

}


/**
 * ==================================================
 * 时间格式
 * ==================================================
 */
function fmt(v) {

  return v
    ? new Date(v)
        .toLocaleString(
          'zh-CN',
          {
            hour12: false
          }
        )
    : '-';

}


/**
 * ==================================================
 * Monitor
 * ==================================================
 */
async function loadMonitors() {

  try {

    const selected =
      $('monitor').value;


    const j =
      await api(
        '/api/admin/monitors'
      );


    $('monitor').innerHTML =

      '<option value="">全部 Monitor</option>' +

      j.data

        .map(
          m =>
            `<option value="${m.id}">${esc(
              m.name
            )}</option>`
        )

        .join('');


    if (
      selected &&
      Array
        .from(
          $('monitor').options
        )
        .some(
          option =>
            option.value ===
            selected
        )
    ) {

      $('monitor').value =
        selected;

    }

  } catch (e) {

    console.warn(
      'Monitor 下拉加载失败：',
      e.message
    );

  }

}


/**
 * ==================================================
 * 筛选
 * ==================================================
 */
function changeFilter() {

  currentPage = 1;

  load();

}


function changePageSize() {

  currentPage = 1;

  load();

}


/**
 * JSON 模糊查询
 */
function searchKeyword() {

  currentPage = 1;

  load();

}


/**
 * Enter 查询
 */
function handleKeywordKeydown(
  event
) {

  if (
    event.key === 'Enter'
  ) {

    searchKeyword();

  }

}


/**
 * 清空查询
 */
function clearKeyword() {

  $('keyword').value = '';

  currentPage = 1;

  load();

}


/**
 * ==================================================
 * 分页
 * ==================================================
 */
function goPage(page) {

  const target =
    Math.max(
      1,
      Math.min(
        Number(page) || 1,
        totalPages
      )
    );


  if (
    target === currentPage &&
    totalPages > 0
  ) {

    return;

  }


  currentPage =
    target;


  load();

}


/**
 * 页码生成
 */
function buildPageNumbers(
  page,
  pages
) {

  if (
    pages <= 7
  ) {

    return Array.from(
      {
        length: pages
      },
      (
        _,
        i
      ) =>
        i + 1
    );

  }


  const result = [1];


  let start =
    Math.max(
      2,
      page - 2
    );


  let end =
    Math.min(
      pages - 1,
      page + 2
    );


  if (
    page <= 4
  ) {

    start = 2;

    end = 6;

  }


  if (
    page >=
    pages - 3
  ) {

    start =
      pages - 5;

    end =
      pages - 1;

  }


  if (
    start > 2
  ) {

    result.push(
      '...'
    );

  }


  for (
    let i = start;
    i <= end;
    i++
  ) {

    result.push(i);

  }


  if (
    end <
    pages - 1
  ) {

    result.push(
      '...'
    );

  }


  result.push(
    pages
  );


  return result;

}


/**
 * 分页显示
 */
function renderPagination(
  pagination
) {

  currentPage =
    pagination.page || 1;


  totalPages =
    pagination.totalPages || 1;


  const keyword =
    $('keyword').value.trim();


  let summary =
    `共 ${
      pagination.total || 0
    } 条 · 第 ${
      currentPage
    } / ${
      totalPages
    } 页`;


  if (keyword) {

    summary +=
      ` · JSON检索：${keyword}`;

  }


  $('summary').textContent =
    summary;


  const parts = [];


  parts.push(

    `<button
      class="button"
      ${
        currentPage <= 1
          ? 'disabled'
          : ''
      }
      onclick="goPage(${
        currentPage - 1
      })"
    >
      上一页
    </button>`

  );


  for (
    const item
    of buildPageNumbers(
      currentPage,
      totalPages
    )
  ) {

    if (
      item === '...'
    ) {

      parts.push(
        '<span style="padding:0 4px;">...</span>'
      );

      continue;

    }


    parts.push(

      `<button
        class="button ${
          item === currentPage
            ? 'primary'
            : ''
        }"
        onclick="goPage(${item})"
      >
        ${item}
      </button>`

    );

  }


  parts.push(

    `<button
      class="button"
      ${
        currentPage >=
        totalPages
          ? 'disabled'
          : ''
      }
      onclick="goPage(${
        currentPage + 1
      })"
    >
      下一页
    </button>`

  );


  parts.push(

    `<span style="margin-left:8px;">
      跳到
    </span>`

    +

    `<input
      id="jumpPage"
      type="number"
      min="1"
      max="${totalPages}"
      value="${currentPage}"
      style="width:80px;"
    >`

    +

    `<button
      class="button"
      onclick="goPage(
        $('jumpPage').value
      )"
    >
      确定
    </button>`

  );


  $('pagination').innerHTML =
    parts.join('');

}


/**
 * ==================================================
 * 主列表
 * ==================================================
 */
async function load() {

  if (loading) {

    return;

  }


  loading = true;


  $('message').textContent =
    '加载中...';


  try {

    const params =
      new URLSearchParams();


    /**
     * Monitor
     */
    if (
      $('monitor').value
    ) {

      params.set(
        'monitorId',
        $('monitor').value
      );

    }


    /**
     * 生成状态
     */
    if (
      $('status').value
    ) {

      params.set(
        'generationStatus',
        $('status').value
      );

    }


    /**
     * JSON 模糊查询
     */
    const keyword =
      $('keyword')
        .value
        .trim();


    if (keyword) {

      params.set(
        'keyword',
        keyword
      );

    }


    /**
     * 分页
     */
    params.set(
      'page',
      String(
        currentPage
      )
    );


    params.set(
      'pageSize',
      $('pageSize').value ||
      '50'
    );


    const j =
      await api(

        '/api/admin/api-responses?' +
        params.toString()

      );


    const pagination =
      j.pagination || {

        page: 1,

        pageSize:
          Number(
            $('pageSize').value ||
            50
          ),

        total:
          j.data.length,

        totalPages: 1

      };


    currentPage =
      pagination.page;


    totalPages =
      pagination.totalPages;


    $('rows').innerHTML =

      j.data

        .map(
          r => {

            let cls =

              r.error_message
                ? 'bad'
                : (
                    r.generation_status ===
                    '已全部生成'
                  )
                  ? 'ok'
                  : 'warn';


            const canGenerate =

              !r.error_message &&

              r.comment_count > 0 &&

              r.generation_status !==
              '已全部生成';


            return `

              <tr>

                <td>
                  ${r.id}
                </td>


                <td>
                  ${esc(
                    r.monitor_name
                  )}
                </td>


                <td>
                  ${r.page_num}
                </td>


                <td>
                  ${
                    r.http_status ??
                    '-'
                  }
                </td>


                <td>
                  ${fmt(
                    r.created_at
                  )}
                </td>


                <td>
                  ${
                    r.comment_count
                  }
                </td>


                <td>

                  <span
                    class="status ${cls}"
                  >
                    ${esc(
                      r.generation_status
                    )}
                  </span>


                  ${
                    r.comment_count

                      ? `<small>
                          ${
                            r.generated_count
                          }/${
                            r.comment_count
                          }
                        </small>`

                      : ''
                  }

                </td>


                <td
                  class="error-cell"
                >
                  ${esc(
                    r.error_message ||
                    ''
                  )}
                </td>


                <td
                  class="actions"
                >

                  <button
                    class="button"
                    onclick="view(${r.id})"
                  >
                    查看
                  </button>


                  ${
                    canGenerate

                      ? `<button
                          class="button primary"
                          onclick="generate(${r.id})"
                        >
                          生成
                        </button>`

                      : ''
                  }

                </td>

              </tr>

            `;

          }
        )

        .join('')

      ||

      `<tr>
        <td
          colspan="9"
          style="
            text-align:center;
            padding:30px;
          "
        >
          暂无数据
        </td>
      </tr>`;


    renderPagination(
      pagination
    );


    $('message').textContent =
      '';

  } catch (e) {

    $('rows').innerHTML =

      `<tr>

        <td
          colspan="9"
          class="error"
        >
          ${esc(
            e.message
          )}
        </td>

      </tr>`;


    $('message').textContent =
      e.message;


    $('summary').textContent =
      '';


    $('pagination').innerHTML =
      '';

  } finally {

    loading = false;

  }

}


/**
 * ==================================================
 * 查看 Response JSON
 * ==================================================
 */
async function view(id) {

  try {

    const j =
      await api(

        `/api/admin/api-responses/${id}`

      );


    let value;


    try {

      value =
        JSON.parse(
          j.data.response_json ||
          'null'
        );

    } catch {

      value =
        j.data.response_json;

    }


    $('json').textContent =

      typeof value ===
      'string'

        ? value

        : JSON.stringify(
            value,
            null,
            2
          );


    /**
     * 自动滚动到 JSON
     */
    $('json')
      .scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

  } catch (e) {

    $('json').textContent =
      e.message;

  }

}


/**
 * ==================================================
 * 生成 comments
 * ==================================================
 */
async function generate(id) {

  if (

    !confirm(

      '确定把这一条 Response 中识别出的评论写入 comments 表吗？已有 comment_id 不会重复。'

    )

  ) {

    return;

  }


  try {

    const j =
      await api(

        `/api/admin/api-responses/${id}/generate`,

        {
          method: 'POST'
        }

      );


    alert(
      j.message
    );


    await load();

  } catch (e) {

    alert(
      e.message
    );

  }

}


/**
 * ==================================================
 * 页面初始化
 * ==================================================
 */
window.addEventListener(
  'DOMContentLoaded',
  async () => {

    /**
     * Token input 是 hidden，
     * 这里只为了兼容现有代码。
     */
    if ($('token')) {

      $('token').value =
        token();

    }


    await loadMonitors();

    await load();

  }
);