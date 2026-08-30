const $ =
  id =>
    document.getElementById(
      id
    );


let currentPage = 1;
let totalPages = 1;
let loading = false;


function esc(value) {

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
      '&#39;'
    );
}


function numberText(value) {

  return Number(
    value || 0
  ).toLocaleString(
    'zh-CN'
  );
}


async function api(
  url
) {

  const response =
    await fetch(url);

  const json =
    await response
      .json()
      .catch(
        () => ({
          success: false,
          message: '服务器返回的不是 JSON'
        })
      );


  if (
    !response.ok ||
    json.success === false
  ) {

    throw new Error(
      json.message ||
      `HTTP ${response.status}`
    );
  }


  return json;
}


function renderStats(
  stats
) {

  $('lemonCount').textContent =
    numberText(
      stats?.lemon
    );

  $('cornCount').textContent =
    numberText(
      stats?.corn
    );

  $('noneCount').textContent =
    numberText(
      stats?.none
    );
}


function renderRows(
  rows
) {

  if (
    !Array.isArray(
      rows
    ) ||
    rows.length === 0
  ) {

    $('rows').innerHTML = `
      <tr>
        <td
          colspan="5"
          class="empty"
        >
          暂无数据
        </td>
      </tr>
    `;

    return;
  }


  $('rows').innerHTML =
    rows.map(
      row => {

        const tags =
          (
            row.attributes || [
              '无属性'
            ]
          )
            .map(
              attribute => `
                <span class="attribute-tag">
                  ${esc(attribute)}
                </span>
              `
            )
            .join('');


        return `
          <tr>
            <td>
              ${esc(row.comment_id)}
            </td>

            <td>
              ${esc(
                row.buyer_nickname ||
                '-'
              )}
            </td>

            <td>
              ${esc(
                row.sku_name ||
                '-'
              )}
            </td>

            <td class="comment-content">
              ${esc(row.content)}
            </td>

            <td>
              <div class="attribute-tags">
                ${tags}
              </div>
            </td>
          </tr>
        `;
      }
    )
    .join('');
}


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
      (_, index) =>
        index + 1
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


function renderPagination(
  pagination
) {

  currentPage =
    pagination?.page || 1;

  totalPages =
    pagination?.totalPages || 1;


  $('listSummary').textContent =
    `共 ${numberText(
      pagination?.total
    )} 条`;


  const numbers =
    buildPageNumbers(
      currentPage,
      totalPages
    );


  const pageButtons =
    numbers.map(
      item => {

        if (
          item === '...'
        ) {

          return `
            <span class="page-info">
              ...
            </span>
          `;
        }


        return `
          <button
            class="button ${item === currentPage ? 'primary' : ''}"
            type="button"
            onclick="goPage(${item})"
          >
            ${item}
          </button>
        `;
      }
    )
    .join('');


  $('pagination').innerHTML = `
    <button
      class="button"
      type="button"
      ${currentPage <= 1 ? 'disabled' : ''}
      onclick="goPage(${currentPage - 1})"
    >
      上一页
    </button>

    ${pageButtons}

    <button
      class="button"
      type="button"
      ${currentPage >= totalPages ? 'disabled' : ''}
      onclick="goPage(${currentPage + 1})"
    >
      下一页
    </button>

    <span class="page-info">
      第 ${currentPage} / ${totalPages} 页
    </span>
  `;
}


async function loadDashboard() {

  if (loading) {
    return;
  }


  loading = true;


  try {

    $('rows').innerHTML = `
      <tr>
        <td
          colspan="5"
          class="loading"
        >
          加载中...
        </td>
      </tr>
    `;


    const params =
      new URLSearchParams();

    params.set(
      'page',
      currentPage
    );

    params.set(
      'pageSize',
      $('pageSize').value
    );


    const attribute =
      $('attribute').value;

    if (attribute) {

      params.set(
        'attribute',
        attribute
      );
    }


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


    const json =
      await api(
        `/api/comments-dashboard?${params.toString()}`
      );


    renderStats(
      json.stats
    );

    renderRows(
      json.data
    );

    renderPagination(
      json.pagination
    );


  } catch (error) {

    $('rows').innerHTML = `
      <tr>
        <td
          colspan="5"
          class="error"
        >
          ${esc(error.message)}
        </td>
      </tr>
    `;


  } finally {

    loading = false;
  }
}


function goPage(
  page
) {

  const target =
    Math.max(
      1,
      Math.min(
        Number(page) || 1,
        totalPages
      )
    );


  if (
    target ===
    currentPage
  ) {
    return;
  }


  currentPage =
    target;

  loadDashboard();


  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}


function changeFilter() {

  currentPage = 1;

  loadDashboard();
}


function changePageSize() {

  currentPage = 1;

  loadDashboard();
}


function searchComments() {

  currentPage = 1;

  loadDashboard();
}


function clearSearch() {

  $('keyword').value = '';

  $('attribute').value = '';

  currentPage = 1;

  loadDashboard();
}


function handleKeywordKeydown(
  event
) {

  if (
    event.key === 'Enter'
  ) {

    searchComments();
  }
}


loadDashboard();
