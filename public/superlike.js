let allRows = [];
let currentPage = 1;
let pageSize = 50;
let currentKeyword = '';


const CSV_COLUMNS = [
  {
    key: 'uid',
    label: '用户ID',
    defaultChecked: true
  },
  {
    key: 'username',
    label: '用户名',
    defaultChecked: true
  },
  {
    key: 'post_text',
    label: '帖子内容',
    defaultChecked: true
  },
  {
    key: 'comments_count',
    label: '评论',
    defaultChecked: true
  },
  {
    key: 'icon_summary',
    label: '当前Icon',
    defaultChecked: true
  },
  {
    key: 'experience_7d',
    label: '近7天经验值',
    defaultChecked: true
  },
  {
    key: 'post_created_at',
    label: '发帖时间',
    defaultChecked: true
  },
  {
    key: 'first_seen_at',
    label: '首次发现',
    defaultChecked: true
  },
  {
    key: 'last_seen_at',
    label: '最后确认',
    defaultChecked: true
  },
  {
    key: 'post_link',
    label: 'Link',
    defaultChecked: true
  },
  {
    key: 'post_id',
    label: 'Post ID',
    defaultChecked: false
  },
  {
    key: 'monitor_id',
    label: 'Monitor ID',
    defaultChecked: false
  },
  {
    key: 'monitor_name',
    label: 'Monitor名称',
    defaultChecked: false
  }
];


function escapeHtml(
  value
) {

  return String(
    value ?? ''
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
      '&#039;'
    );
}


function formatTime(
  value
) {

  if (!value) {
    return '-';
  }


  const normalized =
    value.includes('T')
      ? value
      : value.replace(
          ' ',
          'T'
        ) + 'Z';


  const date =
    new Date(
      normalized
    );


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }


  return date
    .toLocaleString(
      'zh-CN'
    );
}



/*
 * 微博 post_created_at 通常类似：
 * Thu Sep 04 14:20:30 +0800 2026
 *
 * 这里按微博发布时间本身解析，并固定显示为北京时间。
 * 不使用 SQLite CURRENT_TIMESTAMP 的 UTC 处理方式。
 */
function formatPostTime(
  value
) {

  if (!value) {
    return '-';
  }


  let date =
    new Date(
      value
    );


  /*
   * 如果未来数据库保存成：
   * YYYY-MM-DD HH:mm:ss
   * 则按北京时间理解。
   */
  if (
    Number.isNaN(
      date.getTime()
    )
    &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
      String(value)
    )
  ) {
    date =
      new Date(
        String(value)
          .replace(
            ' ',
            'T'
          )
        +
        '+08:00'
      );
  }


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(
      value
    );
  }


  return date
    .toLocaleString(
      'zh-CN',
      {
        timeZone:
          'Asia/Shanghai',

        hour12:
          false
      }
    );
}


function getKeyword() {
  return document
    .getElementById(
      'keyword'
    )
    .value
    .trim();
}


async function loadData(
  resetPage = false
) {

  if (resetPage) {
    currentPage = 1;
  }


  currentKeyword =
    getKeyword();


  const params =
    new URLSearchParams();


  if (currentKeyword) {

    params.set(
      'keyword',
      currentKeyword
    );
  }


  const response =
    await fetch(
      '/api/superlike-posts?' +
      params.toString()
    );


  const json =
    await response.json();


  if (!json.success) {

    alert(
      json.message ||
      '读取失败'
    );

    return;
  }


  const stats =
    json.stats || {};


  document
    .getElementById(
      'totalCount'
    )
    .textContent =
      stats.total ?? 0;


  document
    .getElementById(
      'userCount'
    )
    .textContent =
      stats.user_count ?? 0;


  document
    .getElementById(
      'experienceKnown'
    )
    .textContent =
      stats.experience_known ?? 0;


  allRows =
    Array.isArray(
      json.data
    )
      ? json.data
      : [];


  const totalPages =
    Math.max(
      1,
      Math.ceil(
        allRows.length
        /
        pageSize
      )
    );


  if (
    currentPage >
    totalPages
  ) {
    currentPage =
      totalPages;
  }


  renderTable();
  renderPagination();
}


function renderTable() {

  const tbody =
    document
      .getElementById(
        'tbody'
      );


  tbody.innerHTML = '';


  if (
    allRows.length === 0
  ) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="8"
          style="text-align:center;color:#999;padding:30px"
        >
          没有符合条件的数据
        </td>
      </tr>
    `;

    return;
  }


  const start =
    (
      currentPage
      -
      1
    )
    *
    pageSize;


  const end =
    start
    +
    pageSize;


  const pageRows =
    allRows.slice(
      start,
      end
    );


  for (
    const row
    of pageRows
  ) {

    const tr =
      document.createElement(
        'tr'
      );


    const icon =
      row.icon_summary &&
      row.icon_summary !== '无'

        ? `
          <span class="icon-tag">
            ${escapeHtml(
              row.icon_summary
            )}
          </span>
        `

        : `
          <span class="no-icon">
            无
          </span>
        `;


    const experience =
      row.experience_7d === null ||
      row.experience_7d === undefined

        ? `
          <span class="unknown-exp">
            —
          </span>
        `

        : escapeHtml(
            row.experience_7d
          );


    tr.innerHTML = `

      <td class="uid">
        ${escapeHtml(
          row.uid || '-'
        )}
      </td>


      <td>
        ${escapeHtml(
          row.username || '-'
        )}
      </td>


      <td class="post-text">
        ${escapeHtml(
          row.post_text || ''
        )}
      </td>


      <td class="time">
        ${escapeHtml(
          formatPostTime(
            row.post_created_at
          )
        )}
      </td>


      <td class="comment-low">
        ${escapeHtml(
          row.comments_count
        )}
      </td>


      <td>
        ${icon}
      </td>


      <td>
        ${experience}
      </td>


      <td>

        ${
          row.post_link

            ? `
              <a
                class="link-button"
                href="${escapeHtml(
                  row.post_link
                )}"
                target="_blank"
                rel="noopener noreferrer"
              >
                打开帖子
              </a>
            `

            : '-'
        }

      </td>
    `;


    tbody.appendChild(
      tr
    );
  }
}


function renderPagination() {

  const total =
    allRows.length;


  const totalPages =
    Math.max(
      1,
      Math.ceil(
        total
        /
        pageSize
      )
    );


  const start =
    total === 0
      ? 0
      : (
          (
            currentPage
            -
            1
          )
          *
          pageSize
        )
        +
        1;


  const end =
    Math.min(
      currentPage
      *
      pageSize,
      total
    );


  document
    .getElementById(
      'paginationInfo'
    )
    .textContent =
      `共 ${total} 条，第 ${currentPage}/${totalPages} 页，当前显示 ${start}-${end}`;


  const buttons =
    document
      .getElementById(
        'paginationButtons'
      );


  buttons.innerHTML = '';


  buttons.appendChild(
    createPageButton(
      '首页',
      1,
      currentPage <= 1
    )
  );


  buttons.appendChild(
    createPageButton(
      '上一页',
      currentPage - 1,
      currentPage <= 1
    )
  );


  const pageNumbers =
    buildPageNumbers(
      currentPage,
      totalPages
    );


  for (
    const page
    of pageNumbers
  ) {

    if (
      page === '...'
    ) {

      const span =
        document.createElement(
          'span'
        );

      span.textContent =
        '...';

      buttons.appendChild(
        span
      );

      continue;
    }


    const button =
      createPageButton(
        String(page),
        page,
        false
      );


    if (
      page === currentPage
    ) {
      button.classList.add(
        'page-current'
      );
    }


    buttons.appendChild(
      button
    );
  }


  buttons.appendChild(
    createPageButton(
      '下一页',
      currentPage + 1,
      currentPage >= totalPages
    )
  );


  buttons.appendChild(
    createPageButton(
      '末页',
      totalPages,
      currentPage >= totalPages
    )
  );
}


function createPageButton(
  text,
  targetPage,
  disabled
) {

  const button =
    document.createElement(
      'button'
    );


  button.textContent =
    text;


  button.disabled =
    disabled;


  button.onclick =
    () => {
      currentPage =
        targetPage;

      renderTable();
      renderPagination();

      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    };


  return button;
}


function buildPageNumbers(
  current,
  total
) {

  if (
    total <= 7
  ) {

    return Array.from(
      {
        length: total
      },
      (
        _,
        index
      ) =>
        index + 1
    );
  }


  const result =
    [1];


  if (
    current > 4
  ) {
    result.push(
      '...'
    );
  }


  const start =
    Math.max(
      2,
      current - 2
    );


  const end =
    Math.min(
      total - 1,
      current + 2
    );


  for (
    let page = start;
    page <= end;
    page++
  ) {

    result.push(
      page
    );
  }


  if (
    current <
    total - 3
  ) {
    result.push(
      '...'
    );
  }


  result.push(
    total
  );


  return result;
}


function searchData() {

  currentPage = 1;

  loadData(
    true
  );
}


function clearSearch() {

  document
    .getElementById(
      'keyword'
    )
    .value = '';


  currentPage = 1;


  loadData(
    true
  );
}


function changePageSize() {

  pageSize =
    Number(
      document
        .getElementById(
          'pageSize'
        )
        .value
    )
    ||
    50;


  currentPage = 1;


  renderTable();
  renderPagination();
}


/* ============================================================
 * CSV
 * ============================================================ */

function initCsvColumns() {

  const container =
    document
      .getElementById(
        'csvColumns'
      );


  container.innerHTML = '';


  for (
    const column
    of CSV_COLUMNS
  ) {

    const label =
      document.createElement(
        'label'
      );


    label.innerHTML = `
      <input
        type="checkbox"
        class="csv-column-checkbox"
        value="${escapeHtml(
          column.key
        )}"
        ${
          column.defaultChecked
            ? 'checked'
            : ''
        }
      >
      ${escapeHtml(
        column.label
      )}
    `;


    container.appendChild(
      label
    );
  }
}


function toggleCsvPanel(
  force
) {

  const panel =
    document
      .getElementById(
        'csvPanel'
      );


  if (
    force === false
  ) {

    panel.classList.remove(
      'open'
    );

    return;
  }


  panel.classList.toggle(
    'open'
  );
}


function selectAllCsvColumns() {

  document
    .querySelectorAll(
      '.csv-column-checkbox'
    )
    .forEach(
      checkbox => {
        checkbox.checked =
          true;
      }
    );
}


function clearAllCsvColumns() {

  document
    .querySelectorAll(
      '.csv-column-checkbox'
    )
    .forEach(
      checkbox => {
        checkbox.checked =
          false;
      }
    );
}


function getSelectedCsvColumns() {

  const selectedKeys =
    Array.from(
      document.querySelectorAll(
        '.csv-column-checkbox:checked'
      )
    )
    .map(
      checkbox =>
        checkbox.value
    );


  return CSV_COLUMNS
    .filter(
      column =>
        selectedKeys.includes(
          column.key
        )
    );
}


function csvValue(
  row,
  key
) {

  if (
    key === 'post_created_at'
  ) {

    return formatPostTime(
      row[key]
    );
  }


  if (
    key === 'first_seen_at'
    ||
    key === 'last_seen_at'
  ) {

    return formatTime(
      row[key]
    );
  }


  const value =
    row[key];


  if (
    value === null
    ||
    value === undefined
  ) {

    return '';
  }


  return String(
    value
  );
}


function escapeCsv(
  value
) {

  const text =
    String(
      value ?? ''
    );


  if (
    text.includes('"')
    ||
    text.includes(',')
    ||
    text.includes('\n')
    ||
    text.includes('\r')
  ) {

    return (
      '"'
      +
      text.replaceAll(
        '"',
        '""'
      )
      +
      '"'
    );
  }


  return text;
}


function downloadCsv() {

  const columns =
    getSelectedCsvColumns();


  if (
    columns.length === 0
  ) {

    alert(
      '请至少选择一个 Column'
    );

    return;
  }


  if (
    allRows.length === 0
  ) {

    alert(
      '当前没有可导出的数据'
    );

    return;
  }


  const lines = [];


  lines.push(
    columns
      .map(
        column =>
          escapeCsv(
            column.label
          )
      )
      .join(',')
  );


  for (
    const row
    of allRows
  ) {

    lines.push(
      columns
        .map(
          column =>
            escapeCsv(
              csvValue(
                row,
                column.key
              )
            )
        )
        .join(',')
    );
  }


  /*
   * UTF-8 BOM：
   * Excel 打开中文 CSV 不容易乱码。
   */
  const csv =
    '\uFEFF'
    +
    lines.join(
      '\r\n'
    );


  const blob =
    new Blob(
      [csv],
      {
        type:
          'text/csv;charset=utf-8;'
      }
    );


  const url =
    URL.createObjectURL(
      blob
    );


  const link =
    document.createElement(
      'a'
    );


  const timestamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        '-'
      );


  link.href =
    url;


  link.download =
    `superlike-posts-${timestamp}.csv`;


  document.body.appendChild(
    link
  );


  link.click();


  link.remove();


  URL.revokeObjectURL(
    url
  );
}


/* ============================================================
 * Events
 * ============================================================ */

document
  .getElementById(
    'keyword'
  )
  .addEventListener(
    'keydown',
    event => {

      if (
        event.key === 'Enter'
      ) {

        searchData();
      }
    }
  );


initCsvColumns();

loadData(
  true
);


/*
 * 页面每30秒自动刷新一次。
 *
 * 保留当前页，不强制跳回第1页。
 */
setInterval(
  () => loadData(false),
  30000
);
