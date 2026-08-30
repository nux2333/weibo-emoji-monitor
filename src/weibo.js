const {chromium}=require('playwright');
const MAX=Number(process.env.MAX_COMMENTS_PER_SOURCE||5000);
function textOf(o){ if(!o) return ''; if(typeof o==='string') return o; if(typeof o.text==='string') return o.text; if(typeof o.content==='string') return o.content; if(typeof o.comment==='string') return o.comment; return ''; }
function normalizeArray(arr){
 const out=[]; for(const o of arr||[]){ if(!o||typeof o!=='object'||Array.isArray(o)) continue; const id=o.id??o.comment_id??o.commentId??o.cid??o.commentIdStr; const content=textOf(o.text)||textOf(o.content)||textOf(o.comment); if(id!=null&&content){out.push({id:String(id),content});} } return out;
}
function walk(node, out){
 if(!node||typeof node!=='object') return;
 if(Array.isArray(node)){ const a=normalizeArray(node); if(a.length) out.push(...a); for(const x of node.slice(0,200)) walk(x,out); return; }
 for(const [k,v] of Object.entries(node)){ const key=k.toLowerCase(); if(v&&typeof v==='object'&&(key.includes('comment')||key.includes('review')||key==='data'||key.includes('list'))) walk(v,out); }
}
async function fetchComments(url){
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'});
 const page=await context.newPage(); const found=new Map();
 page.on('response',async r=>{
   const ct=r.headers()['content-type']||''; if(!/(json|text|javascript)/i.test(ct)) return;
   try{ const body=await r.text(); if(body.length>8_000_000) return; let json=null; try{json=JSON.parse(body);}catch{const m=body.match(/^[^(]+\((\{[\s\S]*\})\)\s*;?$/); if(m) try{json=JSON.parse(m[1])}catch{}}
     if(json){const a=[]; walk(json,a); for(const c of a) if(!found.has(c.id)&&found.size<MAX) found.set(c.id,c);}
   }catch{}
 });
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(6000);
 for(let i=0;i<12&&found.size<MAX;i++){await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); await page.waitForTimeout(1200);}
 const dom=await page.locator('body').innerText().catch(()=> '');
 await browser.close();
 if(found.size===0) throw new Error('没有识别到评论数据。需要针对该微博小店页面确认实际评论接口/JSON结构。');
 return [...found.values()];
}
module.exports={fetchComments};
