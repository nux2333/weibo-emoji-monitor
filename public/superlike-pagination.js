let serverPaginationState = {
  page: 1,
  pageSize,
  total: 0,
  totalPages: 1
};

function buildServerParams(page = currentPage, size = pageSize) {
  const params = new URLSearchParams();
  const keyword = getKeyword();

  if (keyword) {
    params.set('keyword', keyword);
  }

  const hideBlack = document.getElementById('hideBlack')?.checked !== false;
  const movedFilter = document.getElementById('movedFilter')?.value || 'unmoved';
  const todayOnly = document.getElementById('todayOnly')?.checked !== false;

  params.set('hideBlack', hideBlack ? '1' : '0');
  params.set('moved', movedFilter);
  params.set('todayOnly', todayOnly ? '1' : '0');
  params.set('page', String(page));
  params.set('pageSize', String(size));
  params.set('sortKey', sortKey);
  params.set('sortDirection', sortDirection);

  return params;
}

const legacyRenderTable = renderTable;
renderTable = function renderServerPageTable() {
  const savedPage = currentPage;
  const savedPageSize = pageSize;

  currentPage = 1;
  pageSize = Math.max(1, allRows.length);

  try {
    legacyRenderTable();
  } finally {
    currentPage = savedPage;
    pageSize = savedPageSize;
  }
};

loadData = async function loadServerPage(resetPage = false) {
  if (resetPage) {
    currentPage = 1;
  }

  currentKeyword = getKeyword();
  saveSearchState();

  const response = await fetch(
    '/api/superlike-posts?' + buildServerParams().toString()
  );
  const json = await response.json();

  if (!response.ok || !json.success) {
    alert(json.message || '读取失败');
    return;
  }

  const stats = json.stats || {};
  document.getElementById('totalCount').textContent = stats.total ?? 0;
  document.getElementById('todayBecameSuperLikeCount').textContent =
    stats.today_became_superlike ?? 0;

  allRows = Array.isArray(json.data) ? json.data : [];

  const pagination = json.pagination || {};
  serverPaginationState = {
    page: Number(pagination.page || currentPage || 1),
    pageSize: Number(pagination.pageSize || pageSize || 50),
    total: Number(pagination.total ?? stats.total ?? allRows.length),
    totalPages: Math.max(1, Number(pagination.totalPages || 1))
  };

  currentPage = serverPaginationState.page;
  pageSize = serverPaginationState.pageSize;

  const pageSizeSelect = document.getElementById('pageSize');
  if (pageSizeSelect) {
    pageSizeSelect.value = String(pageSize);
  }

  updateSortIndicators();
  renderTable();
  renderPagination();
  saveSearchState();
};

sortBy = function sortServerData(key) {
  if (sortKey === key) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDirection = 'asc';
  }

  currentPage = 1;
  updateSortIndicators();
  loadData(true);
};

renderPagination = function renderServerPagination() {
  const total = Number(serverPaginationState.total || 0);
  const totalPages = Math.max(1, Number(serverPaginationState.totalPages || 1));
  const start = total === 0 ? 0 : ((currentPage - 1) * pageSize) + 1;
  const end = total === 0 ? 0 : Math.min(currentPage * pageSize, total);

  document.getElementById('paginationInfo').textContent =
    `共 ${total} 条，第 ${currentPage}/${totalPages} 页，当前显示 ${start}-${end}`;

  const buttons = document.getElementById('paginationButtons');
  buttons.innerHTML = '';

  buttons.appendChild(createPageButton('首页', 1, currentPage <= 1));
  buttons.appendChild(createPageButton('上一页', currentPage - 1, currentPage <= 1));

  for (const page of buildPageNumbers(currentPage, totalPages)) {
    if (page === '...') {
      const span = document.createElement('span');
      span.textContent = '...';
      buttons.appendChild(span);
      continue;
    }

    const button = createPageButton(String(page), page, false);
    if (page === currentPage) {
      button.classList.add('page-current');
    }
    buttons.appendChild(button);
  }

  buttons.appendChild(
    createPageButton('下一页', currentPage + 1, currentPage >= totalPages)
  );
  buttons.appendChild(
    createPageButton('末页', totalPages, currentPage >= totalPages)
  );
};

createPageButton = function createServerPageButton(text, targetPage, disabled) {
  const button = document.createElement('button');
  button.textContent = text;
  button.disabled = disabled;

  button.onclick = () => {
    currentPage = targetPage;
    saveSearchState();
    loadData(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return button;
};

changePageSize = function changeServerPageSize() {
  pageSize = Number(document.getElementById('pageSize').value) || 50;
  currentPage = 1;
  saveSearchState();
  loadData(true);
};

async function fetchAllFilteredRowsForCsv() {
  const result = [];
  const exportPageSize = 200;
  let page = 1;
  let totalPages = 1;

  do {
    const response = await fetch(
      '/api/superlike-posts?' + buildServerParams(page, exportPageSize).toString()
    );
    const json = await response.json();

    if (!response.ok || !json.success) {
      throw new Error(json.message || '读取CSV数据失败');
    }

    result.push(...(Array.isArray(json.data) ? json.data : []));
    totalPages = Math.max(1, Number(json.pagination?.totalPages || 1));
    page += 1;
  } while (page <= totalPages);

  return result;
}

async function markRowsMovedInBatches(rows) {
  const ids = rows
    .map(row => Number(row.id))
    .filter(id => Number.isFinite(id) && id > 0);

  for (let i = 0; i < ids.length; i += 2000) {
    const batch = ids.slice(i, i + 2000);
    const response = await fetch('/api/superlike-posts-moved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch })
    });
    const json = await response.json();

    if (!response.ok || !json.success) {
      throw new Error(json.message || '批量标记已搬运失败');
    }
  }
}

downloadCsv = async function downloadAllFilteredCsv() {
  const columns = getSelectedCsvColumns();

  if (columns.length === 0) {
    alert('请至少选择一个 Column');
    return;
  }

  let rows;
  try {
    rows = await fetchAllFilteredRowsForCsv();
  } catch (error) {
    alert('CSV 未下载：' + error.message);
    return;
  }

  if (!rows.length) {
    alert('当前没有可导出的数据');
    return;
  }

  try {
    await markRowsMovedInBatches(rows);
  } catch (error) {
    alert('CSV 未下载：' + error.message);
    return;
  }

  const lines = [];
  lines.push(
    columns.map(column => escapeCsv(column.label)).join(',')
  );

  for (const row of rows) {
    lines.push(
      columns
        .map(column => escapeCsv(csvValue(row, column.key)))
        .join(',')
    );
  }

  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  link.href = url;
  link.download = `superlike-posts-${timestamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  await loadData(false);
};

loadData(false);
