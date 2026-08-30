const $ = id => document.getElementById(id); $('token').value = localStorage.getItem('admin_token') || '';
function saveToken() { localStorage.setItem('admin_token', $('token').value.trim()); loadMonitors(); load(); }
function token() { return localStorage.getItem('admin_token') || $('token').value.trim(); }
async function api(url, opt = {}) { const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', 'x-admin-token': token(), ...(opt.headers || {}) } }); const j = await r.json().catch(() => ({ success: false, message: '非 JSON' })); if (!r.ok || j.success === false) throw new Error(j.message || `HTTP ${r.status}`); return j; }
function esc(v) { return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-'; }
async function loadMonitors() { try { const j = await api('/api/admin/monitors'); $('monitor').innerHTML = '<option value="">全部 Monitor</option>' + j.data.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join(''); } catch (e) { } }
async function load() {
	try {
		const q = $('monitor').value ? `?monitorId=${$('monitor').value}` : ''; const j = await api('/api/admin/api-responses' + q); $('rows').innerHTML = j.data.map(r => {
			let cls = r.error_message ? 'bad' : (r.generation_status === '已全部生成' ? 'ok' : 'warn');
			return `<tr><td>${r.id}</td><td>${esc(r.monitor_name)}</td><td>${r.page_num}</td><td>${r.http_status ?? '-'}</td><td>${fmt(r.created_at)}</td><td>${r.comment_count}</td><td><span class="status ${cls}">${esc(r.generation_status)}</span>${r.comment_count ? `<small>${r.generated_count}/${r.comment_count}</small>` : ''}</td><td class="error-cell">${esc(r.error_message || '')}</td><td class="actions"><button class="button" onclick="view(${r.id})">查看</button>${!r.error_message ? `<button class="button primary" onclick="generate(${r.id})">生成</button>` : ''}</td></tr>`;
		}).join('') || '<tr><td colspan="9">暂无数据</td></tr>';
	} catch (e) { $('rows').innerHTML = `<tr><td colspan="9" class="error">${esc(e.message)}</td></tr>`; }
}
async function view(id) { try { const j = await api(`/api/admin/api-responses/${id}`); $('json').textContent = JSON.stringify(JSON.parse(j.data.response_json || 'null'), null, 2); } catch (e) { $('json').textContent = e.message; } }
async function generate(id) { if (!confirm('确定把这一条 Response 中识别出的评论写入 comments 表吗？已有 comment_id 不会重复。')) return; try { const j = await api(`/api/admin/api-responses/${id}/generate`, { method: 'POST' }); alert(j.message); load(); } catch (e) { alert(e.message); } }
loadMonitors().then(load);
