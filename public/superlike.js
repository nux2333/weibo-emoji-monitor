let allRows = [];
let currentPage = 1;
let pageSize = 50;
let currentKeyword = '';

let sortKey = 'post_created_at';
let sortDirection = 'desc';

const SEARCH_STATE_KEY =
  'superlike.searchState';


function saveSearchState() {
  try {
    localStorage.setItem(
      SEARCH_STATE_KEY,
      JSON.stringify({
        keyword:
          document
            .getElementById('keyword')
            ?.value
            ?? '',
        hideBlack:
          document
            .getElementById('hideBlack')
            ?.checked
            !== false,
        todayOnly:
          document
            .getElementById('todayOnly')
            ?.checked
            !== false,
        movedFilter:
          document
            .getElementById('movedFilter')
            ?.value
            || 'unmoved',
        pageSize,
        currentPage,
        sortKey,
        sortDirection
      })
    );
  } catch {
    // localStorage 不可用时不影响页面正常查询。
  }
}


function restoreSearchState() {
  try {
    const raw =
      localStorage.getItem(
        SEARCH_STATE_KEY
      );

    if (!raw) {
      return;
    }

    const state =
      JSON.parse(raw);

    const keywordInput =
      document.getElementById(
        'keyword'
      );

    if (keywordInput) {
      keywordInput.value =
        String(
          state.keyword
          ?? ''
        );
    }

    const hideBlackInput =
      document.getElementById(
        'hideBlack'
      );

    if (
      hideBlackInput
      &&
      typeof state.hideBlack
        === 'boolean'
    ) {
      hideBlackInput.checked =
        state.hideBlack;
    }

    const todayOnlyInput =
      document.getElementById(
        'todayOnly'
      );

    if (
      todayOnlyInput
      &&
      typeof state.todayOnly
        === 'boolean'
    ) {
      todayOnlyInput.checked =
        state.todayOnly;
    }

    const movedFilterInput =
      document.getElementById(
        'movedFilter'
      );

    if (
      movedFilterInput
      &&
      ['all', 'moved', 'unmoved']
        .includes(
          String(
            state.movedFilter
            || ''
          )
        )
    ) {
      movedFilterInput.value =
        String(state.movedFilter);
    }

    const restoredPageSize =
      Number(state.pageSize);

    if (
      [20, 50, 100, 200]
        .includes(
          restoredPageSize
        )
    ) {
      pageSize =
        restoredPageSize;

      const pageSizeSelect =
        document.getElementById(
          'pageSize'
        );

      if (pageSizeSelect) {
        pageSizeSelect.value =
          String(pageSize);
      }
    }

    if (
      Number(state.currentPage)
      >= 1
    ) {
      currentPage =
        Number(
          state.currentPage
        );
    }

    if (
      [
        'post_created_at',
        'comments_count',
        'uid',
        'username',
        'experience_7d'
      ].includes(
        state.sortKey
      )
    ) {
      sortKey =
        state.sortKey;
    }

    if (
      state.sortDirection
        === 'asc'
      ||
      state.sortDirection
        === 'desc'
    ) {
      sortDirection =
        state.sortDirection;
    }
  } catch {
    // 保存内容损坏时使用页面默认值。
  }
}


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
    key: 'experience_7d',
    label: 'jyz',
    defaultChecked: true
  },
  {
    key: 'comments_needed_for_80',
    label: '还差评论',
    defaultChecked: true
  },
  {
    key: 'icon_summary',
    label: '当前Icon',
    defaultChecked: true
  },
  {
    key: 'post_created_at',
    label: '发帖时间',
    defaultChecked: true
  }
]


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


async function loadEnvironmentBadge() {
  try {
    const response =
      await fetch(
        '/api/environment'
      );

    const json =
      await response.json();

    const badge =
      document.getElementById(
        'environmentBadge'
      );

    if (
      badge
      &&
      json?.isTest
    ) {
      badge.style.display =
        'inline-block';

      document.title =
        '[TEST] ' +
        document.title;
    }
  } catch {
    // 环境标识读取失败不影响页面主功能。
  }
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

  saveSearchState();


  const params =
    new URLSearchParams();


  if (currentKeyword) {

    params.set(
      'keyword',
      currentKeyword
    );
  }


  const hideBlack =
    document
      .getElementById(
        'hideBlack'
      )
      ?.checked !== false;


  params.set(
    'hideBlack',
    hideBlack
      ? '1'
      : '0'
  );

  const movedFilter =
    document
      .getElementById(
        'movedFilter'
      )
      ?.value
      || 'unmoved';

  params.set(
    'moved',
    movedFilter
  );

  const todayOnly =
    document
      .getElementById(
        'todayOnly'
      )
      ?.checked !== false;

  params.set(
    'todayOnly',
    todayOnly
      ? '1'
      : '0'
  );


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
      'todayBecameSuperLikeCount'
    )
    .textContent =
      stats.today_became_superlike
      ?? 0;


  const rawRows =
    Array.isArray(
      json.data
    )
      ? json.data
      : [];


  const blackKeywords =
    Array.isArray(
      json?.filters?.blackKeywords
    )
      ? json.filters.blackKeywords
          .map(
            value =>
              String(value || '')
                .trim()
                .toLowerCase()
          )
          .filter(Boolean)
      : [];


  if (
    hideBlack
    &&
    blackKeywords.length > 0
  ) {
    allRows =
      rawRows.filter(
        row => {
          const haystack =
            [
              row?.username,
              row?.post_text,
              row?.icon_summary
            ]
              .map(
                value =>
                  String(value || '')
                    .toLowerCase()
              )
              .join('\n');

          return !blackKeywords.some(
            keyword =>
              haystack.includes(
                keyword
              )
          );
        }
      );
  } else {
    allRows =
      rawRows;
  }

  applyCurrentSort();
  updateSortIndicators();


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

  saveSearchState();
}


function parseSortableTime(value) {
  if (!value) {
    return 0;
  }

  let date =
    new Date(
      value
    );

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

  return Number.isNaN(
    date.getTime()
  )
    ? 0
    : date.getTime();
}


function compareRows(
  a,
  b,
  key
) {
  if (
    key === 'comments_count'
  ) {
    return (
      Number(a?.[key] ?? 0)
      -
      Number(b?.[key] ?? 0)
    );
  }

  if (
    key === 'post_created_at'
  ) {
    return (
      parseSortableTime(
        a?.[key]
      )
      -
      parseSortableTime(
        b?.[key]
      )
    );
  }

  return String(
    a?.[key] ?? ''
  ).localeCompare(
    String(
      b?.[key] ?? ''
    ),
    'zh-CN',
    {
      numeric: true,
      sensitivity: 'base'
    }
  );
}


function applyCurrentSort() {
  allRows.sort(
    (a, b) => {
      const result =
        compareRows(
          a,
          b,
          sortKey
        );

      return sortDirection === 'asc'
        ? result
        : -result;
    }
  );
}


function updateSortIndicators() {
  document
    .querySelectorAll(
      'th.sortable'
    )
    .forEach(
      th => {
        const key =
          th.dataset.sortKey;

        const indicator =
          th.querySelector(
            '.sort-indicator'
          );

        const active =
          key === sortKey;

        th.classList.toggle(
          'sort-active',
          active
        );

        if (indicator) {
          indicator.textContent =
            active
              ? (
                  sortDirection === 'asc'
                    ? '▲'
                    : '▼'
                )
              : '↕';
        }
      }
    );
}


function sortBy(key) {
  if (
    sortKey === key
  ) {
    sortDirection =
      sortDirection === 'asc'
        ? 'desc'
        : 'asc';
  } else {
    sortKey =
      key;

    sortDirection =
      'asc';
  }

  currentPage = 1;

  applyCurrentSort();
  updateSortIndicators();
  renderTable();
  renderPagination();

  saveSearchState();
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

    tr.dataset.uid =
      String(row.uid || '');

    tr.dataset.monitorId =
      String(row.monitor_id || '');

    tr.dataset.username =
      String(row.username || '');

    tr.classList.toggle(
      'is-moved',
      Number(row.moved_flag) === 1
    );

    tr.classList.toggle(
      'profile-failed',
      String(row.profile_status || '').toUpperCase() === 'PROFILE_FAILED'
    );

    tr.dataset.postRowId =
      String(row.id || '');

    tr.dataset.moved =
      Number(row.moved_flag) === 1 ? '1' : '0';


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


    tr.innerHTML = `

      <td class="uid">
        ${escapeHtml(
          row.uid || '-'
        )}
      </td>


      <td
        class="username-cell"
        title="长按用户名：标记超来客并删除候选"
      >
        ${
          row.uid
            ? `
              <a
                class="user-link"
                href="https://m.weibo.cn/p/index?containerid=231140f1d33f71dff693a2708cb3e8ef584a44_-_profile_inpage&extparam=target_uid%2523${encodeURIComponent(row.uid)}&luicode=10000011"
                target="_blank"
                rel="noopener noreferrer"
              >
                ${escapeHtml(row.username || '-')}
              </a>
            `
            : escapeHtml(row.username || '-')
        }
      </td>


      <td
        class="post-text copy-post-link"
        data-post-link="${escapeHtml(row.post_link || '')}"
        data-comments-needed="${escapeHtml(
          row.comments_needed_for_80 ?? ''
        )}"
        title="点击复制帖子链接 + 还差评论数，并标记为已搬运"
      >
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


      <td
        class="comment-low"
      >
        ${escapeHtml(
          row.comments_count
        )}
      </td>


      <td class="experience-7d">
        ${escapeHtml(
          row.experience_7d ?? '-'
        )}
      </td>


      <td>
        ${icon}
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

        <div class="link-black-fan-actions">
          <button
            type="button"
            class="black-fan-button"
            data-uid="${escapeHtml(row.uid || '')}"
            data-username="${escapeHtml(row.username || '')}"
            title="把该用户加入黑粉名单"
          >
            发现🐷
          </button>
        </div>
      </td>
    `;


    initCellLongPress(
      tr
    );

    tbody.appendChild(
      tr
    );
  }
}


async function toggleMovedRow(tr) {
  if (!tr || tr.dataset.movedBusy === '1') {
    return;
  }

  const id = Number(tr.dataset.postRowId);
  const currentMoved = tr.dataset.moved === '1';
  const nextMoved = !currentMoved;

  if (!id) {
    return;
  }

  tr.dataset.movedBusy = '1';

  try {
    const response = await fetch(
      '/api/superlike-post-moved',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id,
          moved: nextMoved
        })
      }
    );

    const json = await response.json();

    if (!response.ok || !json.success) {
      throw new Error(
        json.message || '更新搬运状态失败'
      );
    }

    const row = allRows.find(
      item => Number(item.id) === id
    );

    if (row) {
      row.moved_flag = json.moved_flag;
    }

    tr.dataset.moved =
      json.moved_flag === 1 ? '1' : '0';

    tr.classList.toggle(
      'is-moved',
      json.moved_flag === 1
    );

    const oldBubble =
      document.querySelector('.copy-toast');

    if (oldBubble) {
      oldBubble.remove();
    }

    const bubble =
      document.createElement('div');

    bubble.className = 'copy-toast';
    bubble.textContent =
      json.moved_flag === 1
        ? '已搬运'
        : '已取消搬运';

    bubble.style.left = '50%';
    bubble.style.top = '20px';
    bubble.style.transform = 'translateX(-50%)';

    document.body.appendChild(bubble);

    requestAnimationFrame(
      () => bubble.classList.add('show')
    );

    setTimeout(() => {
      bubble.classList.remove('show');
      setTimeout(() => bubble.remove(), 180);
    }, 700);
  } catch (error) {
    alert(
      '更新失败：' +
      error.message
    );
  } finally {
    tr.dataset.movedBusy = '0';
  }
}


async function markBlackFan(button) {
  if (!button || button.disabled) {
    return;
  }

  const uid =
    String(
      button.dataset.uid
      || ''
    ).trim();

  const username =
    String(
      button.dataset.username
      || ''
    ).trim();

  if (!uid) {
    return;
  }

  const confirmed =
    window.confirm(
      '确定他是🐷吗？'
    );

  if (!confirmed) {
    return;
  }

  button.disabled = true;

  try {
    const response =
      await fetch(
        '/api/black-fan-user',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body:
            JSON.stringify({
              uid,
              username
            })
        }
      );

    const json =
      await response.json();

    if (
      !response.ok
      || !json.success
    ) {
      throw new Error(
        json.message
        || '标记黑粉失败'
      );
    }

    button.textContent =
      '已发现🐷';

    /*
     * 默认勾选“屏蔽🐷屎”时，
     * 标记完成后刷新，当前用户会立即从列表消失。
     * 如果用户关闭了屏蔽，则按钮会保留为已标记状态直到下次刷新。
     */
    const hideBlack =
      document
        .getElementById(
          'hideBlack'
        )
        ?.checked !== false;

    if (hideBlack) {
      await loadData(false);
    }
  } catch (error) {
    alert(
      '操作失败：' +
      error.message
    );

    button.disabled = false;
  }
}


async function copyPostLink(cell) {
  const link = cell?.dataset?.postLink || '';

  if (!link) {
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = link;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  /*
   * 复制成功后，同时把当前帖子标记为“已搬运”。
   * 如果本来已经是已搬运，不反向取消。
   */
  const tr = cell.closest('tr');

  if (
    tr
    &&
    tr.dataset.moved !== '1'
    &&
    tr.dataset.movedBusy !== '1'
  ) {
    const id =
      Number(tr.dataset.postRowId);

    if (id) {
      tr.dataset.movedBusy = '1';

      try {
        const response =
          await fetch(
            '/api/superlike-post-moved',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  id,
                  moved: true
                })
            }
          );

        const json =
          await response.json();

        if (
          !response.ok
          || !json.success
        ) {
          throw new Error(
            json.message
            || '标记已搬运失败'
          );
        }

        const row =
          allRows.find(
            item =>
              Number(item.id)
              === id
          );

        if (row) {
          row.moved_flag = 1;
        }

        tr.dataset.moved = '1';
        tr.classList.add('is-moved');
      } catch (error) {
        console.error(
          '[SuperLike] 复制成功，但标记已搬运失败：',
          error
        );
      } finally {
        tr.dataset.movedBusy = '0';
      }
    }
  }

  // 点击位置附近显示一个短暂的 Copied! 小气泡。
  const oldBubble = document.querySelector('.copy-toast');
  if (oldBubble) {
    oldBubble.remove();
  }

  const bubble = document.createElement('div');
  bubble.className = 'copy-toast';
  bubble.textContent = '已复制 · 已搬运';

  const rect = cell.getBoundingClientRect();
  bubble.style.left = Math.min(
    window.innerWidth - 90,
    Math.max(8, rect.left + rect.width / 2 - 36)
  ) + 'px';
  bubble.style.top = Math.max(8, rect.top - 34) + 'px';

  document.body.appendChild(bubble);

  requestAnimationFrame(() => {
    bubble.classList.add('show');
  });

  setTimeout(() => {
    bubble.classList.remove('show');
    setTimeout(() => bubble.remove(), 180);
  }, 700);
}


function initCellLongPress(tr) {
  const usernameCell = tr.querySelector('.username-cell');

  function bindLongPress(element, action) {
    if (!element) return;

    let timer = null;
    let startX = 0;
    let startY = 0;
    let triggered = false;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const start = event => {
      triggered = false;
      const point = event.touches?.[0] || event;
      startX = Number(point.clientX || 0);
      startY = Number(point.clientY || 0);
      clear();

      timer = setTimeout(async () => {
        triggered = true;
        clear();
        try {
          await action();
        } catch (error) {
          alert('操作失败：' + error.message);
        }
      }, 700);
    };

    const move = event => {
      const point = event.touches?.[0] || event;
      const dx = Math.abs(Number(point.clientX || 0) - startX);
      const dy = Math.abs(Number(point.clientY || 0) - startY);
      if (dx > 10 || dy > 10) clear();
    };

    const end = () => clear();

    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchmove', move, { passive: true });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
    element.addEventListener('mousedown', start);
    element.addEventListener('mousemove', move);
    element.addEventListener('mouseup', end);
    element.addEventListener('mouseleave', end);

    element.addEventListener('click', event => {
      if (triggered) {
        event.preventDefault();
        event.stopPropagation();
        triggered = false;
      }
    }, true);
  }

  bindLongPress(
    usernameCell,
    async () => {
      const uid = tr.dataset.uid;
      const monitorId = Number(tr.dataset.monitorId);
      const username = tr.dataset.username || uid;

      if (!uid || !monitorId) return;

      const confirmed = window.confirm(
        '确认把「' + username + '」标记为超来客并从候选池删除吗？'
      );

      if (!confirmed) return;

      const response = await fetch(
        '/api/superlike-mark-user',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monitorId, uid })
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || '操作失败');
      }

      await loadData(false);
    }
  );

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
      saveSearchState();

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


function changeHideBlack() {

  currentPage = 1;

  loadData(
    true
  );
}


function changeTodayOnly() {

  currentPage = 1;

  loadData(
    true
  );
}


function changeMovedFilter() {

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
  saveSearchState();
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
    key === 'moved_flag'
  ) {
    return Number(row[key]) === 1
      ? '已搬运'
      : '未搬运';
  }


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


async function downloadCsv() {

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


  /*
   * 下载 CSV 代表这批帖子将被搬运到微博群：
   * 先把当前搜索结果整批写入数据库为“已搬运”，
   * 成功后再生成 CSV，确保多人看到的状态一致。
   */
  const ids =
    allRows
      .map(row => Number(row.id))
      .filter(id => Number.isFinite(id) && id > 0);

  try {
    const response = await fetch(
      '/api/superlike-posts-moved',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          ids
        })
      }
    );

    const json =
      await response.json();

    if (!response.ok || !json.success) {
      throw new Error(
        json.message ||
        '批量标记已搬运失败'
      );
    }

    for (const row of allRows) {
      row.moved_flag = 1;
    }

    renderTable();
  } catch (error) {
    alert(
      'CSV 未下载：' +
      error.message
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
  .getElementById('tbody')
  .addEventListener('click', event => {
    const blackFanButton =
      event.target.closest(
        '.black-fan-button'
      );

    if (blackFanButton) {
      event.preventDefault();
      event.stopPropagation();
      markBlackFan(
        blackFanButton
      );
      return;
    }

    const movedButton =
      event.target.closest('.moved-toggle');

    if (movedButton) {
      event.preventDefault();
      event.stopPropagation();
      toggleMovedStatus(movedButton);
      return;
    }

    const cell = event.target.closest('.copy-post-link');

    if (cell) {
      copyPostLink(cell);
    }
  });




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

restoreSearchState();

loadEnvironmentBadge();

loadData(
  false
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
