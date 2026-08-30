const express = require('express');
const path = require('path');
const {
  initDatabase,getMonitors,getMonitor,createMonitor,updateMonitor,deleteMonitor,
  getMonitorResult,getDailyStats,getComments,getAllApiResponses,getApiResponses,
  getApiResponseById,getCommentIds,saveComments
} = require('./src/db');
const { syncMonitorsFromConfig } = require('./src/config');
const { runMonitor,runAllMonitors,startScheduler,normalizeComments } = require('./src/monitor');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));

function checkAdmin(req,res,next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({success:false,message:'未授权'});
  next();
}
function safeJson(v,fallback) { try { return JSON.parse(v || ''); } catch { return fallback; } }

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/api-responses',(req,res)=>res.sendFile(path.join(__dirname,'public','api-responses.html')));

app.get('/api/monitors',(req,res)=>{
  try { res.json({success:true,data:getMonitors(true).map(m=>({id:m.id,name:m.name,emojis:safeJson(m.emojis,[]),texts:safeJson(m.texts,[]),enabled:!!m.enabled,last_run_at:m.last_run_at,last_status:m.last_status}))}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get('/api/monitors/:id/result',(req,res)=>{
  try { const r=getMonitorResult(Number(req.params.id)); if(r){r.emoji_stats=safeJson(r.emoji_stats,{});r.text_stats=safeJson(r.text_stats,{});} res.json({success:true,data:r||null}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get('/api/monitors/:id/history',(req,res)=>{
  try { const limit=Math.min(Number(req.query.limit)||30,365); res.json({success:true,data:getDailyStats(Number(req.params.id),limit).map(x=>({...x,emoji_stats:safeJson(x.emoji_stats,{}),text_stats:safeJson(x.text_stats,{})}))}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get('/api/monitors/:id/comments',(req,res)=>{
  try { res.json({success:true,data:getComments(Number(req.params.id),Math.min(Number(req.query.limit)||100,1000))}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get('/api/admin/monitors',checkAdmin,(req,res)=>{
  try { res.json({success:true,data:getMonitors(false).map(m=>({...m,emojis:safeJson(m.emojis,[]),texts:safeJson(m.texts,[]),enabled:!!m.enabled}))}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post('/api/admin/monitors',checkAdmin,(req,res)=>{
  try {
    const {name,url,emojis=[],texts=[],enabled=true}=req.body;
    if(!name||!url) return res.status(400).json({success:false,message:'名称和 URL 不能为空'});
    const id=createMonitor({name,url,emojis,texts,enabled});
    setImmediate(()=>runMonitor(id).catch(e=>console.error(e)));
    res.json({success:true,id});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put('/api/admin/monitors/:id',checkAdmin,(req,res)=>{
  try {
    const id=Number(req.params.id); const m=getMonitor(id); if(!m) return res.status(404).json({success:false,message:'监控项目不存在'});
    const {name,url,emojis=[],texts=[],enabled=true}=req.body;
    updateMonitor(id,{name,url,emojis,texts,enabled});
    setImmediate(()=>runMonitor(id).catch(e=>console.error(e)));
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete('/api/admin/monitors/:id',checkAdmin,(req,res)=>{
  try { deleteMonitor(Number(req.params.id)); res.json({success:true}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post('/api/admin/monitors/:id/run',checkAdmin,(req,res)=>{
  const id=Number(req.params.id); if(!getMonitor(id)) return res.status(404).json({success:false,message:'监控项目不存在'});
  setImmediate(()=>runMonitor(id).catch(e=>console.error(e)));
  res.json({success:true,message:'已开始抓取'});
});

// Response 管理页面数据：包含 Monitor 名称、是否成功、是否已经生成 comments。
app.get('/api/admin/api-responses',checkAdmin,(req,res)=>{
  try {
    const monitorId=req.query.monitorId ? Number(req.query.monitorId) : null;
    const rows=monitorId ? getApiResponses(monitorId,500) : getAllApiResponses(500);
    const cache=new Map();
    const data=rows.map(row=>{
      let comments=[]; let generatedCount=0; let status='失败';
      if(row.response_json){
        try { comments=normalizeComments(JSON.parse(row.response_json)); } catch {}
      }
      if(row.error_message){ status='请求失败'; }
      else if(!comments.length){ status='无评论数据'; }
      else {
        if(!cache.has(row.monitor_id)) cache.set(row.monitor_id,getCommentIds(row.monitor_id));
        const ids=cache.get(row.monitor_id);
        generatedCount=comments.filter(c=>ids.has(String(c.commentId))).length;
        status=generatedCount===comments.length?'已全部生成':generatedCount>0?'部分已生成':'未生成';
      }
      return {...row,comment_count:comments.length,generated_count:generatedCount,generation_status:status};
    });
    res.json({success:true,data});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get('/api/admin/api-responses/:id',checkAdmin,(req,res)=>{
  try { const row=getApiResponseById(Number(req.params.id)); if(!row)return res.status(404).json({success:false,message:'Response 不存在'}); res.json({success:true,data:row}); }
  catch(e){res.status(500).json({success:false,message:e.message});}
});

// 手动把某条 response JSON 解析并写入 comments。已有 comment_id 不会重复插入，只会更新 last_seen_at。
app.post('/api/admin/api-responses/:id/generate',checkAdmin,(req,res)=>{
  try {
    const row=getApiResponseById(Number(req.params.id));
    if(!row) return res.status(404).json({success:false,message:'Response 不存在'});
    if(!row.response_json) return res.status(400).json({success:false,message:'这条 Response 没有 JSON 数据'});
    let raw; try { raw=JSON.parse(row.response_json); } catch { return res.status(400).json({success:false,message:'response_json 不是有效 JSON'}); }
    const comments=normalizeComments(raw);
    if(!comments.length) return res.status(400).json({success:false,message:'没有从 Response 中识别到评论'});
    saveComments(row.monitor_id,comments);
    res.json({success:true,message:`已生成 ${comments.length} 条评论`,count:comments.length});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

async function start(){
  initDatabase();
  syncMonitorsFromConfig();
  app.listen(PORT,async()=>{
    console.log('====================================');
    console.log('Weibo Emoji Monitor');
    console.log(`http://localhost:${PORT}`);
    console.log(`http://localhost:${PORT}/admin`);
    console.log(`http://localhost:${PORT}/api-responses`);
    console.log('====================================');
    try { await runAllMonitors(); } catch(e){ console.error('启动时抓取失败:',e); }
    startScheduler();
  });
}
start().catch(e=>{console.error('Server startup failed:',e);process.exit(1);});
