import { useState, useRef, useCallback, useEffect, Fragment, createContext, useContext } from "react";
import { BarChart, Bar, LineChart, Line, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, CartesianGrid, Legend } from "recharts";
import { buildXlsx, downloadXlsx } from "./xlsx-export.js";
import { buildGPUPricingWorkbook, gpuWorkbookFilename } from "./gpu-xlsx-report.js";

/* ─── Live data fetched by me right now (Apr 11 2026) ───────
   Sources:
   OR:    raw.githubusercontent.com/jampongsathorn/openrouter-rankings (Apr 1 2026)
   Radar: websearchapi.ai citing Cloudflare Radar (Mar 4–Apr 3 2026)
   Bots:  Cloudflare Radar AI Insights
   Filing: SEC 8-K exhibit, filed Feb 4 2026
──────────────────────────────────────────────────────────── */
const LIVE = {
  fetchedAt: "Apr 11 2026 · 17:45 UTC",
  or: [
    {rank:1,model:"grok-4.1-fast",           provider:"x-ai",       tokens:"53.8M",tokRaw:53810188,wow:"-24%",wowN:-24,isGemini:false},
    {rank:2,model:"gemini-2.5-flash-lite",    provider:"google",     tokens:"33.7M",tokRaw:33666645,wow:"-64%",wowN:-64,isGemini:true},
    {rank:3,model:"gemini-2.5-flash",         provider:"google",     tokens:"29.4M",tokRaw:29408225,wow:"-67%",wowN:-67,isGemini:true},
    {rank:4,model:"gpt-oss-120b",             provider:"openai",     tokens:"29.2M",tokRaw:29203585,wow:"-65%",wowN:-65,isGemini:false},
    {rank:5,model:"gemini-3-flash-preview",   provider:"google",     tokens:"22.3M",tokRaw:22263082,wow:"-64%",wowN:-64,isGemini:true},
    {rank:6,model:"deepseek-v3.2",            provider:"deepseek",   tokens:"20.8M",tokRaw:20769070,wow:"-66%",wowN:-66,isGemini:false},
    {rank:7,model:"gpt-4o-mini",              provider:"openai",     tokens:"12.3M",tokRaw:12285405,wow:"-66%",wowN:-66,isGemini:false},
    {rank:8,model:"llama-3.1-8b-instruct",    provider:"meta-llama", tokens:"9.29M",tokRaw:9288457, wow:"-68%",wowN:-68,isGemini:false},
    {rank:9,model:"gemini-3.1-flash-lite-preview",provider:"google", tokens:"8.14M",tokRaw:8143622, wow:"-64%",wowN:-64,isGemini:true},
  ],
  bots: [
    {name:"Googlebot",          pct:31.6,color:"#10b981"},
    {name:"Meta-ExternalAgent", pct:16.7,color:"#8b5cf6"},
    {name:"GPTBot",             pct:12.0,color:"#3b82f6"},
    {name:"ClaudeBot",          pct:11.7,color:"#f59e0b"},
    {name:"Bingbot",            pct:8.2, color:"#06b6d4"},
    {name:"Applebot",           pct:5.8, color:"#ec4899"},
    {name:"Others",             pct:14.0,color:"#9ca3af"},
  ],
  trends: [
    {term:"ChatGPT",   score:100,color:"#3b82f6"},
    {term:"Gemini AI", score:68, color:"#10b981"},
    {term:"Copilot",   score:42, color:"#8b5cf6"},
    {term:"Claude AI", score:28, color:"#f59e0b"},
    {term:"Perplexity",score:19, color:"#ef4444"},
  ],
  filing: {
    period:"Q4 2025",
    searchRevenue:"$63.1B", searchRevenueGrowth:"+17%",
    paidClicksGrowth:"+13%", cpcGrowth:"-1%",
    totalRevenue:"$113.8B", totalRevenueGrowth:"+18%",
    source:"https://www.sec.gov/Archives/edgar/data/1652044/000165204426000012/googexhibit991q42025.htm",
  },
};

/* ─── colours ───────────────────────────────────────────── */
const PROV_C={google:"#10b981",openai:"#3b82f6","x-ai":"#8b5cf6",anthropic:"#f59e0b",meta:"#ef4444","meta-llama":"#ef4444",deepseek:"#06b6d4",other:"#9ca3af"};
const pc=p=>PROV_C[(p||"").toLowerCase()]||PROV_C.other;
const fmt=v=>v>=1e12?(v/1e12).toFixed(1)+"T":v>=1e9?Math.round(v/1e9)+"B":Math.round(v/1e6)+"M";
const growthColor=v=>{const n=parseFloat(v);return n>0?"#10b981":n<0?"#ef4444":"#6b7280";};

/* ─── shared atoms ──────────────────────────────────────── */
const S={
  card:{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:12,padding:16},
  lbl:{fontSize:10,textTransform:"uppercase",letterSpacing:".07em",color:"#6b7280",fontWeight:600},
};

function Spin({size=11,color="#3b82f6"}){
  return(
    <svg width={size} height={size} viewBox="0 0 12 12" style={{display:"inline-block",verticalAlign:"middle"}}>
      <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="2" strokeDasharray="20 5" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.75s" repeatCount="indefinite"/>
      </circle>
    </svg>
  );
}

function Shimmer({rows=5}){
  return(
    <div>
      <style>{`@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      {Array.from({length:rows}).map((_,i)=>(
        <div key={i} style={{height:13,borderRadius:5,marginBottom:10,background:"linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 50%,#f3f4f6 75%)",backgroundSize:"200% 100%",animation:"sh 1.3s infinite",width:[100,72,88,60,78][i%5]+"%"}}/>
      ))}
    </div>
  );
}

function LiveDot({live,ts}){
  return(
    <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
      <span style={{width:7,height:7,borderRadius:"50%",background:live?"#10b981":"#d1d5db",flexShrink:0,display:"inline-block"}}/>
      {ts&&<span style={{fontSize:10,color:"#9ca3af"}}>{ts.toLocaleTimeString()}</span>}
    </span>
  );
}

function Pill({text,bg,color}){
  return <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontWeight:600,background:bg,color}}>{text}</span>;
}

function KBox({label,value,sub,bg,fg}){
  return(
    <div style={{flex:1,background:bg,borderRadius:8,padding:"10px 14px"}}>
      <div style={{...S.lbl,color:fg}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,color:"#111827",marginTop:3,lineHeight:1}}>{value||"—"}</div>
      {sub&&<div style={{fontSize:11,color:"#6b7280",marginTop:3}}>{sub}</div>}
    </div>
  );
}

function RBtn({busy,onClick,label="↻  Refresh"}){
  const[pressed,setPressed]=useState(false);
  function handleClick(e){
    setPressed(true);
    setTimeout(()=>setPressed(false),180);
    onClick&&onClick(e);
  }
  return(
    <button onClick={handleClick} disabled={busy}
      style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,padding:"6px 14px",border:"0.5px solid "+(busy?"#e5e7eb":"#d1d5db"),borderRadius:8,background:busy?"#f9fafb":"#fff",color:busy?"#9ca3af":"#374151",cursor:busy?"wait":"pointer",fontFamily:"inherit",fontWeight:500,transform:pressed?"scale(0.96)":"scale(1)",transition:"transform .12s ease, background .15s, color .15s"}}>
      {busy?<><Spin size={10}/> Fetching…</>:label}
    </button>
  );
}

/* ─── usePanel ───────────────────────────────────────────── */
function usePanel(seedData,fetcher){
  const[data,setData]=useState(seedData);
  const[busy,setBusy]=useState(false);
  const[ts,  setTs  ]=useState(new Date()); // seeded with now — live fetch will update
  const[live,setLive]=useState(false);      // false until real /api/* responds

  const refresh=useCallback(async()=>{
    setBusy(true);
    try{
      const d=await fetcher();
      setData(d); setLive(true);
    }catch(_){
      setLive(false); // keep current data, just mark not-live
    }finally{
      setTs(new Date()); setBusy(false);
    }
  },[fetcher]);

  return{data,busy,ts,live,refresh};
}

/* ─── live fetchers — call deployed /api/* endpoints ────── */
const TIMEOUT=25000;
function timedFetch(url,opts={}){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),TIMEOUT);
  return fetch(url,{...opts,signal:c.signal}).finally(()=>clearTimeout(t));
}

async function fetchOR(){
  const r=await timedFetch("/api/openrouter?view=week&top=30");
  const d=await r.json();
  if(!d.success||!d.models?.length)throw new Error(d.error||"empty");
  const seen={};
  const parseTok=(lbl,raw)=>{
    if(raw&&raw>0)return raw;
    const m=(lbl||"").match(/([\d.]+)\s*([BT])/i);
    if(!m)return 0;
    const v=parseFloat(m[1]),u=m[2].toUpperCase();
    return u==="T"?v*1e12:v*1e9;
  };
  return d.models.map(m=>{
    const name=(m.model||"").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/^by\s+/i,"").trim();
    return {
      rank:m.rank,model:name,provider:m.provider,
      tokens:m.tokensLabel,tokRaw:parseTok(m.tokensLabel,m.tokens),
      wow:m.wowLabel||"—",wowN:m.wowPct,isGemini:m.isGemini||/gemini/i.test(name),
    };
  }).filter(m=>{const k=m.rank+"-"+m.model;if(seen[k])return false;seen[k]=true;return true});
}

async function fetchRadar(){
  const r=await timedFetch("/api/radar/ai/bots/summary/user_agent?dateRange=28d");
  const d=await r.json();
  const raw=d?.result?.summary_0||{};
  const BOT_COLORS=["#10b981","#8b5cf6","#3b82f6","#f59e0b","#06b6d4","#ec4899","#9ca3af","#ef4444"];
  const entries=Object.entries(raw)
    .filter(([k])=>k!=="timestamps")
    .map(([name,val])=>({name,pct:Math.round(parseFloat(val)*10)/10}))
    .filter(b=>b.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,8)
    .map((b,i)=>({...b,color:BOT_COLORS[i%BOT_COLORS.length]}));
  if(!entries.length)throw new Error("empty");
  return entries;
}

async function fetchTrends(){
  const r=await timedFetch("/api/trends?window=12m");
  const d=await r.json();
  if(!d.success)throw new Error(d.error||"failed");
  const TC={"Gemini AI":"#10b981","ChatGPT":"#3b82f6","Claude AI":"#f59e0b","Perplexity":"#ef4444","Copilot":"#8b5cf6"};
  return (d.summary||[])
    .filter(s=>s.latest!==null)
    .map(s=>({term:s.term,score:Math.round(s.latest||0),color:TC[s.term]||"#9ca3af"}))
    .sort((a,b)=>b.score-a.score);
}

async function fetchFiling(){
  const r=await timedFetch("/api/google-filings");
  const d=await r.json();
  if(!d.success)throw new Error(d.error||"failed");
  return d;
}

/* ═══════════════════════════════════════════════════════
   FILING ANCHOR ROW
═══════════════════════════════════════════════════════ */
function PricingSharePartialView({ header, quarter }){
  const rows=(quarter.rows||[]).filter(r=>typeof r.priceQoq==="number"&&typeof r.shareAvg==="number");
  const W=520,H=360,pL=44,pR=18,pT=22,pB=32;
  const xMax=Math.max(5,...rows.map(r=>Math.abs(r.priceQoq*100)))*1.15;
  const yMax=Math.max(5,...rows.map(r=>r.shareAvg))*1.12;
  const sx=(v)=>pL+((v+xMax)/(2*xMax))*(W-pL-pR);
  const sy=(v)=>H-pB-(v/yMax)*(H-pT-pB);
  const x0=sx(0);

  // Dot color: bias by price direction only (no share-QoQ regime available)
  const dotColor=(pq)=>pq<=-0.02?"#2563eb":pq>=0.02?"#dc2626":"#6b7280";

  // Smart label placement (flip + vertical stacking) — same logic as full view
  const dotData=rows.map(r=>({
    slug:r.slug,label:r.label,color:dotColor(r.priceQoq),
    x:sx(r.priceQoq*100),y:sy(r.shareAvg),
  }));
  const placed=[];
  [...dotData].sort((a,b)=>a.y-b.y).forEach(d=>{
    const flipLeft=d.x>W*0.6;
    const lAnchor=flipLeft?"end":"start";
    const lx=flipLeft?d.x-7:d.x+7;
    const lw=Math.max(36,d.label.length*5.8);
    let dy=3;
    for(let i=0;i<6;i++){
      const ly=d.y+dy;
      const collides=placed.some(p=>{
        if(Math.abs(p.ly-ly)>11) return false;
        const pLe=p.lAnchor==="end"?p.lx-p.lw:p.lx;
        const pRi=p.lAnchor==="end"?p.lx:p.lx+p.lw;
        const dLe=flipLeft?lx-lw:lx;
        const dRi=flipLeft?lx:lx+lw;
        return !(dRi<pLe-3||dLe>pRi+3);
      });
      if(!collides) break;
      dy+=12;
    }
    placed.push({...d,lx,ly:d.y+dy,lAnchor,lw});
  });

  // Sort table by current share descending so the dominant provider reads first
  const tableRows=[...rows].sort((a,b)=>b.shareAvg-a.shareAvg);
  const biggestCut=[...rows].filter(r=>r.priceQoq<0).sort((a,b)=>a.priceQoq-b.priceQoq)[0];
  const biggestUp=[...rows].filter(r=>r.priceQoq>0).sort((a,b)=>b.priceQoq-a.priceQoq)[0];
  const topShare=[...rows].sort((a,b)=>b.shareAvg-a.shareAvg)[0];

  return(
    <div style={{marginBottom:16}}>
      {header}
      <div style={{fontSize:11,color:"#6b7280",marginBottom:8}}>
        Quarter: <b style={{color:"#111827",fontFamily:"monospace"}}>{quarter.quarter}</b>
        {quarter.partial&&<span style={{marginLeft:5,fontSize:9,background:"#ecfeff",color:"#0e7490",padding:"1px 5px",borderRadius:3,fontWeight:600}}>QTD</span>}
        <span style={{color:"#9ca3af"}}> · {rows.length} providers · partial view</span>
      </div>
      {/* Explanation banner */}
      <div style={{background:"#fffbeb",border:"0.5px solid #fde68a",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:11,color:"#78350f",lineHeight:1.45}}>
        <b>Share QoQ pending.</b> Prior-quarter KV snapshots not yet captured, so share-delta can't be computed. Showing Price QoQ vs <i>current</i> share % instead — full view returns automatically once the next quarter of snapshots lands.
      </div>
      {/* Callouts limited to what's computable from a single quarter */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))",gap:8,marginBottom:12}}>
        {biggestCut&&<div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
          <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#7c3aed"}}>Biggest price cut</div>
          <div style={{fontSize:13,fontWeight:700,color:"#111827",marginTop:2}}>{biggestCut.label}</div>
          <div style={{fontSize:10,color:"#6b7280",marginTop:2,lineHeight:1.4}}>{biggestCut.priceQoqLabel} input · current share {biggestCut.shareAvgLabel}</div>
        </div>}
        {biggestUp&&<div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
          <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#7c3aed"}}>Biggest price increase</div>
          <div style={{fontSize:13,fontWeight:700,color:"#111827",marginTop:2}}>{biggestUp.label}</div>
          <div style={{fontSize:10,color:"#6b7280",marginTop:2,lineHeight:1.4}}>{biggestUp.priceQoqLabel} input · current share {biggestUp.shareAvgLabel}</div>
        </div>}
        {topShare&&<div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
          <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#7c3aed"}}>Largest share holder</div>
          <div style={{fontSize:13,fontWeight:700,color:"#111827",marginTop:2}}>{topShare.label}</div>
          <div style={{fontSize:10,color:"#6b7280",marginTop:2,lineHeight:1.4}}>{topShare.shareAvgLabel} of observed tokens · price {topShare.priceQoqLabel}</div>
        </div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"minmax(360px,1fr) minmax(420px,2fr)",gap:10}}>
        <div style={{...S.card,padding:"10px 12px 10px",display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:10,color:"#6b7280",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:600,color:"#374151"}}>Price QoQ vs Current Share</span>
            <span style={{fontSize:9,color:"#9ca3af"}}>x: price % · y: share %</span>
          </div>
          <svg viewBox={"0 0 "+W+" "+H} style={{display:"block",width:"100%",aspectRatio:`${W} / ${H}`,overflow:"visible"}}>
            {/* Left half (price cut) — gentle blue tint; right half (price up) — gentle red tint */}
            <rect x={pL} y={pT} width={x0-pL} height={H-pT-pB} fill="#eff6ff" opacity="0.6"/>
            <rect x={x0} y={pT} width={W-pR-x0} height={H-pT-pB} fill="#fef2f2" opacity="0.5"/>
            {/* Axes */}
            <line x1={pL} y1={H-pB} x2={W-pR} y2={H-pB} stroke="#9ca3af" strokeWidth="0.5"/>
            <line x1={x0} y1={pT} x2={x0} y2={H-pB} stroke="#9ca3af" strokeWidth="0.5"/>
            {/* Price axis labels */}
            <text x={pL} y={H-pB+14} fontSize="9" fill="#6b7280">−{xMax.toFixed(0)}%</text>
            <text x={W-pR} y={H-pB+14} fontSize="9" fill="#6b7280" textAnchor="end">+{xMax.toFixed(0)}%</text>
            {/* Share axis labels — absolute percentage, 0 at bottom, yMax at top */}
            <text x={pL-4} y={pT+4} fontSize="9" fill="#6b7280" textAnchor="end">{yMax.toFixed(0)}%</text>
            <text x={pL-4} y={H-pB+2} fontSize="9" fill="#6b7280" textAnchor="end">0%</text>
            {/* Corner hints — price direction only */}
            <text x={pL+4}    y={pT+10} fontSize="8" fill="#2563eb" fontWeight="600">price cut</text>
            <text x={W-pR-4}  y={pT+10} fontSize="8" fill="#dc2626" fontWeight="600" textAnchor="end">price up</text>
            {/* Dots */}
            {placed.map(p=>(
              <g key={p.slug}>
                <circle cx={p.x} cy={p.y} r="4.5" fill={p.color} stroke="#fff" strokeWidth="1"/>
                <text x={p.lx} y={p.ly} fontSize="10" fill="#111827" fontWeight="600" textAnchor={p.lAnchor}>{p.label}</text>
              </g>
            ))}
          </svg>
          <div style={{marginTop:"auto",paddingTop:12}}>
            <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#9ca3af",marginBottom:6}}>How to read the dot</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 12px",fontSize:10.5,color:"#374151",lineHeight:1.4}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#2563eb",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Price cut</b><br/><span style={{color:"#6b7280"}}>QoQ ≤ −2%</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#dc2626",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Price up</b><br/><span style={{color:"#6b7280"}}>QoQ ≥ +2%</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#6b7280",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Price held</b><br/><span style={{color:"#6b7280"}}>|QoQ| &lt; 2%</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"transparent",border:"1px dashed #9ca3af",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Y = current %</b><br/><span style={{color:"#6b7280"}}>not a QoQ delta</span></span></div>
            </div>
          </div>
        </div>
        <div style={{...S.card,padding:0,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr>
                {["Provider","Avg Price /1M","Price QoQ","Current Share"].map(h=>(
                  <th key={h} style={{...S.lbl,textAlign:"left",padding:"8px 10px",borderBottom:"1px solid #f3f4f6",background:"#fafafa"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map(r=>(
                <tr key={r.slug}>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontWeight:600,color:"#111827",whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:dotColor(r.priceQoq),marginRight:6,verticalAlign:"middle"}}/>
                    {r.label}
                  </td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",color:"#111827"}}>{r.avgLabel}</td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",fontWeight:600,color:r.priceQoq>0?"#dc2626":r.priceQoq<0?"#059669":"#6b7280"}}>{r.priceQoqLabel}</td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",color:"#111827"}}>{r.shareAvgLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:"4px 10px",fontSize:10,color:"#6b7280",marginTop:8,lineHeight:1.5}}>
        <span><b style={{color:"#374151"}}>Scope:</b> partial view — Price QoQ shown, Share QoQ unavailable until a prior-quarter KV snapshot exists</span>
        <span>·</span>
        <span><b style={{color:"#374151"}}>Sources:</b> pricepertoken provider pricing history + OpenRouter snapshots</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   PRICING / SHARE SIGNALS — Analytical read-through

   Joins /api/provider-pricing-matrix (quarterly provider avg $/1M +
   priceQoq) with canonical KV OpenRouter snapshots (provider token
   share, averaged by quarter). Renders top callouts for the latest
   comparable quarter, a per-provider signal table, and a compact
   quadrant scatter (native SVG — no recharts scatter in bundle).

   Honesty: directional ecosystem read-through, not a causal claim.
   Only providers observed in BOTH dimensions in the quarter appear.
═══════════════════════════════════════════════════════ */
function PricingShareSignalBlock(){
  const[state,setState]=useState({phase:"loading",data:null,error:null});
  const {dataTick}=useContext(DataRefreshContext);
  const loaded=useRef(false); // true once real figures are on screen
  useEffect(()=>{
    let cancelled=false;
    const background=loaded.current; // see AUTO-REFRESH
    fetch("/api/pricing-share-signal",{cache:background?"no-cache":"default"})
      .then(r=>r.json())
      .then(d=>{ if(cancelled) return;
        if(!d.success){ if(!background) setState({phase:"error",data:null,error:d.error||"Unknown error"}); }
        else { loaded.current=true; setState({phase:"ready",data:d,error:null}); }
      })
      .catch(e=>{ if(!cancelled&&!background) setState({phase:"error",data:null,error:e.message}); });
    return ()=>{cancelled=true;};
  },[dataTick]);

  /* Regime-to-color: green=favorable pricing-power, amber=neutral/ok, red=weak/anomaly */
  const regimeColor=(priceReg,shareReg)=>{
    if(priceReg==="hold"&&shareReg==="gain") return "#059669";  // pricing power
    if(priceReg==="up"  &&shareReg==="gain") return "#059669";  // strong pricing power
    if(priceReg==="cut" &&shareReg==="gain") return "#2563eb";  // effective cut
    if(priceReg==="up"  &&shareReg==="loss") return "#dc2626";  // weak position
    if(priceReg==="cut" &&shareReg==="loss") return "#dc2626";  // anomalous / cuts not defending
    if(priceReg==="cut" &&shareReg==="flat") return "#d97706";  // cut not converting
    return "#6b7280"; // flat/hold/flat and mixed neutrals
  };

  const header=(
    <>
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#7c3aed",display:"inline-block"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#7c3aed"}}>Pricing / Share Signals</span>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:16,fontWeight:700,color:"#111827",lineHeight:1.3}}>Pricing Behavior and Market Share Read-Through</div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>Where pricing moves are translating into share gains, resilience, or anomalies.</div>
      </div>
    </>
  );

  if(state.phase==="error"){
    return(
      <div style={{marginBottom:16}}>
        {header}
        <div style={{background:"#fff",border:"0.5px dashed #fca5a5",borderRadius:10,padding:"14px 16px"}}>
          <div style={{fontSize:12,color:"#991b1b",fontWeight:500}}>Pricing / share read-through temporarily unavailable</div>
        </div>
      </div>
    );
  }
  if(state.phase==="loading"){
    return(
      <div style={{marginBottom:16}}>
        {header}
        <div style={{...S.card}}><Shimmer rows={4}/></div>
      </div>
    );
  }
  const d=state.data;
  const latest=d.quarters.find(q=>q.quarter===d.latestComparable);

  /* Partial-mode fallback: when a full QoQ comparison isn't yet possible
     (KV snapshot history hasn't crossed a quarter boundary) we still have
     priceQoq + current share % for the newest quarter. Render a reduced
     view — Price QoQ vs current Share % — so the block stays useful
     instead of showing a dead empty state until Q3 snapshots accumulate. */
  if(!latest||!latest.rows||!latest.rows.length){
    const partialQuarter=(d.quarters||[]).find(q=>(q.rows||[]).some(r=>typeof r.priceQoq==="number"&&typeof r.shareAvg==="number"));
    if(!partialQuarter){
      return(
        <div style={{marginBottom:16}}>
          {header}
          <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"14px 16px"}}>
            <div style={{fontSize:12,color:"#111827",fontWeight:500}}>No comparable quarter available yet</div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>Need at least one quarter with both price and market-share observations.</div>
          </div>
        </div>
      );
    }
    return <PricingSharePartialView header={header} quarter={partialQuarter}/>;
  }

  /* SVG quadrant — Price QoQ % on x, Share QoQ pp on y.
     Asymmetric padding: extra room on left for share labels, extra room
     below for price labels. Keeps axis range labels OUTSIDE the plot so
     they never collide with dots near the origin. H is tuned so the SVG
     renders tall enough to visually balance the signal table alongside it. */
  const W=520,H=360,pL=40,pR=18,pT=22,pB=32;
  const rows=latest.rows.filter(r=>typeof r.priceQoq==="number"&&typeof r.shareQoqPP==="number");
  let xMax=Math.max(5,...rows.map(r=>Math.abs(r.priceQoq*100)))*1.15;
  let yMax=Math.max(1,...rows.map(r=>Math.abs(r.shareQoqPP)))*1.3;
  const sx=(v)=>pL+((v+xMax)/(2*xMax))*(W-pL-pR);
  const sy=(v)=>H-pB-((v+yMax)/(2*yMax))*(H-pT-pB);
  const x0=sx(0),y0=sy(0);

  /* Pre-compute dot placement with label-collision avoidance. Labels flip
     to the left of their dot when the dot sits in the right portion of the
     plot (prevents overflow past the SVG edge). Labels that would overlap
     are stacked vertically. */
  const dotData=rows.map(r=>({
    slug:r.slug,
    label:r.label,
    color:regimeColor(r.priceReg,r.shareReg),
    x:sx(r.priceQoq*100),
    y:sy(r.shareQoqPP),
  }));
  const placedLabels=[];
  [...dotData].sort((a,b)=>a.y-b.y).forEach(d=>{
    const flipLeft=d.x>W*0.6;
    const lAnchor=flipLeft?"end":"start";
    const lx=flipLeft?d.x-7:d.x+7;
    const lw=Math.max(36,d.label.length*5.8);
    let dy=3;
    for(let i=0;i<6;i++){
      const ly=d.y+dy;
      const collides=placedLabels.some(p=>{
        if(Math.abs(p.ly-ly)>11) return false;
        const pLe=p.lAnchor==="end"?p.lx-p.lw:p.lx;
        const pRi=p.lAnchor==="end"?p.lx:p.lx+p.lw;
        const dLe=flipLeft?lx-lw:lx;
        const dRi=flipLeft?lx:lx+lw;
        return !(dRi<pLe-3||dLe>pRi+3);
      });
      if(!collides) break;
      dy+=12;
    }
    placedLabels.push({...d,lx,ly:d.y+dy,lAnchor,lw});
  });

  return(
    <div style={{marginBottom:16}}>
      {header}

      {/* Latest-quarter tag */}
      <div style={{fontSize:11,color:"#6b7280",marginBottom:8}}>
        Latest comparable quarter: <b style={{color:"#111827",fontFamily:"monospace"}}>{d.latestComparable}</b>
        {latest.partial&&<span style={{marginLeft:5,fontSize:9,background:"#ecfeff",color:"#0e7490",padding:"1px 5px",borderRadius:3,fontWeight:600}}>QTD</span>}
        <span style={{color:"#9ca3af"}}> vs {d.priorComparable} · {rows.length} providers observed in both dimensions</span>
      </div>

      {/* Callout chips */}
      {d.callouts&&d.callouts.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))",gap:8,marginBottom:12}}>
          {d.callouts.map((c,i)=>(
            <div key={i} style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
              <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#7c3aed"}}>{c.title}</div>
              <div style={{fontSize:13,fontWeight:700,color:"#111827",marginTop:2}}>{c.provider}</div>
              <div style={{fontSize:10,color:"#6b7280",marginTop:2,lineHeight:1.4}}>{c.detail}</div>
            </div>
          ))}
        </div>
      )}

      {/* Quadrant chart + signal table side-by-side. Cards stretch to the same
         height (default grid behavior); the chart card uses flex column so the
         legend strip pushes to the bottom, balancing the chart card against the
         taller table. */}
      <div style={{display:"grid",gridTemplateColumns:"minmax(360px,1fr) minmax(420px,2fr)",gap:10}}>

        {/* Quadrant */}
        <div style={{...S.card,padding:"10px 12px 10px",display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:10,color:"#6b7280",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:600,color:"#374151"}}>Price QoQ vs Share QoQ</span>
            <span style={{fontSize:9,color:"#9ca3af"}}>x: price % · y: share pp</span>
          </div>
          <svg viewBox={"0 0 "+W+" "+H} style={{display:"block",width:"100%",aspectRatio:`${W} / ${H}`,overflow:"visible"}}>
            {/* Quadrant background tints */}
            <rect x={pL} y={pT} width={x0-pL} height={y0-pT} fill="#ecfdf5" opacity="0.5"/>
            <rect x={x0} y={pT} width={W-pR-x0} height={y0-pT} fill="#ecfdf5" opacity="0.7"/>
            <rect x={pL} y={y0} width={x0-pL} height={H-pB-y0} fill="#fef2f2" opacity="0.5"/>
            <rect x={x0} y={y0} width={W-pR-x0} height={H-pB-y0} fill="#fef2f2" opacity="0.5"/>
            {/* Axes */}
            <line x1={pL} y1={y0} x2={W-pR} y2={y0} stroke="#9ca3af" strokeWidth="0.5"/>
            <line x1={x0} y1={pT} x2={x0} y2={H-pB} stroke="#9ca3af" strokeWidth="0.5"/>
            {/* Price (x) axis range labels — below plot, outside the dot area */}
            <text x={pL} y={H-pB+14} fontSize="9" fill="#6b7280">−{xMax.toFixed(0)}%</text>
            <text x={W-pR} y={H-pB+14} fontSize="9" fill="#6b7280" textAnchor="end">+{xMax.toFixed(0)}%</text>
            {/* Share (y) axis range labels — left of plot, outside the dot area */}
            <text x={pL-4} y={pT+4} fontSize="9" fill="#6b7280" textAnchor="end">+{yMax.toFixed(1)}pp</text>
            <text x={pL-4} y={H-pB+2} fontSize="9" fill="#6b7280" textAnchor="end">−{yMax.toFixed(1)}pp</text>
            {/* Quadrant labels (corner hints) */}
            <text x={pL+4}    y={pT+10} fontSize="8" fill="#059669" fontWeight="600">effective cut</text>
            <text x={W-pR-4}  y={pT+10} fontSize="8" fill="#059669" fontWeight="600" textAnchor="end">pricing power</text>
            <text x={pL+4}    y={H-pB-3} fontSize="8" fill="#dc2626" fontWeight="600">cuts not defending</text>
            <text x={W-pR-4}  y={H-pB-3} fontSize="8" fill="#dc2626" fontWeight="600" textAnchor="end">weak position</text>
            {/* Dots + labels — labels flip and stack to avoid collisions */}
            {placedLabels.map(p=>(
              <g key={p.slug}>
                <circle cx={p.x} cy={p.y} r="4.5" fill={p.color} stroke="#fff" strokeWidth="1"/>
                <text x={p.lx} y={p.ly} fontSize="10" fill="#111827" fontWeight="600" textAnchor={p.lAnchor}>{p.label}</text>
              </g>
            ))}
          </svg>
          {/* Legend — pushes to bottom via marginTop:auto so the chart card
             visually matches the taller signal table alongside it. */}
          <div style={{marginTop:"auto",paddingTop:12}}>
            <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:".07em",fontWeight:700,color:"#9ca3af",marginBottom:6}}>How to read the dot</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 12px",fontSize:10.5,color:"#374151",lineHeight:1.4}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#059669",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Pricing power</b><br/><span style={{color:"#6b7280"}}>price holds/up · share gain</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#2563eb",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Effective cut</b><br/><span style={{color:"#6b7280"}}>price cut · share gain</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#dc2626",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Weak position</b><br/><span style={{color:"#6b7280"}}>price up · share loss</span></span></div>
              <div style={{display:"flex",alignItems:"flex-start",gap:6}}><span style={{width:8,height:8,borderRadius:"50%",background:"#6b7280",marginTop:4,flexShrink:0}}/><span><b style={{color:"#111827"}}>Neutral / mixed</b><br/><span style={{color:"#6b7280"}}>flat or absorbed move</span></span></div>
            </div>
          </div>
        </div>

        {/* Signal table */}
        <div style={{...S.card,padding:0,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr>
                {["Provider","Avg Price /1M","Price QoQ","Share QoQ","Regime / Interpretation"].map(h=>(
                  <th key={h} style={{...S.lbl,textAlign:"left",padding:"8px 10px",borderBottom:"1px solid #f3f4f6",background:"#fafafa"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r=>(
                <tr key={r.slug}>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontWeight:600,color:"#111827",whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:regimeColor(r.priceReg,r.shareReg),marginRight:6,verticalAlign:"middle"}}/>
                    {r.label}
                  </td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",color:"#111827"}}>{r.avgLabel}</td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",fontWeight:600,color:r.priceQoq>0?"#dc2626":r.priceQoq<0?"#059669":"#6b7280"}}>{r.priceQoqLabel}</td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",fontWeight:600,color:r.shareQoqPP>0?"#059669":r.shareQoqPP<0?"#dc2626":"#6b7280"}}>{r.shareQoqLabel}</td>
                  <td style={{padding:"8px 10px",borderBottom:"1px solid #f9fafb",fontSize:11,color:"#374151",lineHeight:1.35}}>
                    <div style={{fontWeight:600,color:"#111827"}}>{r.regimeLabel}</div>
                    <div style={{color:"#6b7280",marginTop:1}}>{r.note}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Methodology caveat */}
      <div style={{display:"flex",flexWrap:"wrap",gap:"4px 10px",fontSize:10,color:"#6b7280",marginTop:8,lineHeight:1.5}}>
        <span><b style={{color:"#374151"}}>Rules:</b> price cut ≤ −2%, price up ≥ +2%, share gain ≥ +0.3pp, share loss ≤ −0.3pp</span>
        <span>·</span>
        <span><b style={{color:"#374151"}}>Scope:</b> directional ecosystem read-through, not a causal claim</span>
        <span>·</span>
        <span><b style={{color:"#374151"}}>Omissions:</b> providers outside the OpenRouter top-N during the quarter are excluded, never imputed</span>
        <span>·</span>
        <span><b style={{color:"#374151"}}>Sources:</b> pricepertoken provider pricing history + OpenRouter snapshots</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MODEL PRICING HISTORY — Quarterly, grouped by provider/company

   Renders above the live pricepertoken embed. Data comes from
   /api/provider-pricing-matrix which fans out to pricepertoken's own
   historical pricing API per provider and bucketizes into calendar
   quarters (equal-weighted daily mean of input/output $/1M tokens).

   Honesty:
     - Real upstream floor is ~2025-07-28. No synthetic 2023 data.
     - YoY is empty for every quarter until a real year-ago quarter
       exists upstream — shown as em dash, never fabricated.
     - Per-cell model count is surfaced so the reader can judge
       composition drift.
═══════════════════════════════════════════════════════ */
/* Injected by scripts/build-dashboard.mjs as a hash of this file's contents.
   Falls back to "dev" when the module is loaded outside that build (tests). */
const BUILD=typeof __BUILD__!=="undefined"?__BUILD__:"dev";

/* ═══════════════════════════════════════════════════════
   AUTO-REFRESH

   The page used to fetch once, on mount, and never again: a dashboard left
   open showed whatever it loaded, however long ago that was. Now App re-runs
   every data fetch on a timer and broadcasts that through DataRefreshContext,
   so each block pulls fresh figures WITHOUT remounting — the reader keeps
   their tab, subtab, toggles and scroll position.

   dataTick  — bumped every REFRESH_EVERY_MS while the page is visible, and on
               return to a page that sat hidden for longer than that. Every
               fetch effect lists it as a dependency.
   embedTick — bumped ONLY on that return-to-page path. The reverse-proxied
               third-party pages reload on it and at no other time: reloading
               an iframe under someone who is reading it is worse than a few
               minutes' staleness in a page they can see is live.

   A background refresh never swaps figures for an error card. If it fails,
   what is on screen stays and the next tick tries again; if the first load
   had failed, a later tick that succeeds replaces the error. It also asks the
   browser to revalidate (cache:"no-cache"), otherwise a long max-age would
   hand back the very copy it is trying to replace.

   How far behind the SOURCE any figure can be is set server-side, not here —
   see CACHE_TTL in functions/api/provider-pricing-matrix.js and
   model-pricing-peer-matrix.js. This only makes sure an open page catches up.
═══════════════════════════════════════════════════════ */
const REFRESH_EVERY_MS=10*60*1000;
const DataRefreshContext=createContext({dataTick:0,embedTick:0});

/* The cache-busting bucket in an embed's URL, fixed for the life of the embed.
   It used to be recomputed on every render, so a parent re-render after any
   five-minute boundary silently reloaded the third-party page. Nothing
   re-rendered App until the refresh timer did — at which point every embed
   would have reloaded every ten minutes under the reader. */
function useEmbedBucket(){
  const {embedTick}=useContext(DataRefreshContext);
  const[bucket,setBucket]=useState(()=>Math.floor(Date.now()/3e5));
  const first=useRef(true);
  useEffect(()=>{
    if(first.current){first.current=false;return;}
    setBucket(Math.floor(Date.now()/3e5));
  },[embedTick]);
  return bucket;
}

function ModelPricingHistoryBlock(){
  const[metric,setMetric]=useState("input");
  const[view,setView]=useState("avg"); // "avg" | "qoq" | "yoy"
  // "equal" — every model in a provider's lineup counts once (list-price mean).
  // "usage" — each model counts in proportion to the tokens it actually served,
  // so the cell reads as what the market paid. The server replaces `avg` with
  // the weighted level, so the chart, matrix and QoQ/YoY all follow one series.
  const[weight,setWeight]=useState("equal");
  const[state,setState]=useState({phase:"loading",data:null,error:null});

  const {dataTick}=useContext(DataRefreshContext);
  // The metric|weight whose figures are currently on screen. A tick that
  // arrives with the SAME pair is a background refresh. A new pair means the
  // reader asked a different question, and the old figures must go: keeping
  // them through a failed fetch would show one metric's numbers under the
  // other's label.
  const shownKey=useRef(null);
  useEffect(()=>{
    let cancelled=false;
    const key=metric+"|"+weight;
    const background=shownKey.current===key;
    if(!background) setState(s=>({...s,phase:"loading"}));
    // Keyed on the build hash, never on the clock. This endpoint fans out to
    // pricepertoken for all eight providers, so a key that changes on a timer
    // (the "&v=<5-minute bucket>" the peer matrix uses, where the upstream is
    // one small request) gave every bucket its own cache key, re-ran the
    // fan-out, and made the upstream fail six providers at a time. A build
    // hash changes exactly once per deploy: one cold fetch, then reuse.
    // Now that the endpoint sits behind the edge cache, a background refresh
    // costs ~80 ms and never re-runs the fan-out, which is what makes a timer
    // safe here where a clock-keyed URL was not.
    fetch("/api/provider-pricing-matrix?metric="+metric+"&weight="+weight+"&b="+BUILD,{cache:background?"no-cache":"default"})
      .then(r=>r.json())
      .then(d=>{ if(cancelled) return;
        if(!d.success){ if(!background) setState({phase:"error",data:null,error:d.error||"Unknown error"}); }
        else { shownKey.current=key; setState({phase:"ready",data:d,error:null}); }
      })
      .catch(e=>{ if(!cancelled&&!background) setState({phase:"error",data:null,error:e.message}); });
    return ()=>{cancelled=true;};
  },[metric,weight,dataTick]);

  const weighted=weight==="usage";
  const title   ="Quarterly Model Pricing by Company";
  const subtitle=weighted
    ?"Model API price per token by calendar quarter, weighted by the tokens each model actually served on OpenRouter — what was paid, not what was listed."
    :"Average model API price per token by calendar quarter, grouped by provider family, for historical comparison.";
  const unitHint=metric==="input"?"Input $/1M tokens":"Output $/1M tokens";
  const cellColor=(v)=>v===null||v===undefined?"#9ca3af":v>0?"#dc2626":v<0?"#059669":"#6b7280";

  return(
    <div style={{marginBottom:16}}>
      {/* Section label */}
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#0e7490",display:"inline-block"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#0e7490"}}>Model Pricing History</span>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:16,fontWeight:700,color:"#111827",lineHeight:1.3}}>{title}</div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>{subtitle}</div>
      </div>

      {/* Toggles */}
      <div style={{display:"flex",gap:12,marginBottom:10,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:5}}>
          {["input","output"].map(m=>(
            <button key={m} onClick={()=>setMetric(m)}
              style={{fontSize:11,padding:"4px 11px",border:"0.5px solid "+(metric===m?"#111827":"#e5e7eb"),borderRadius:6,background:metric===m?"#111827":"#fff",color:metric===m?"#fff":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:500,textTransform:"capitalize"}}>
              {m}
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:5}}>
          {[{id:"avg",label:"Avg $/1M"},{id:"qoq",label:"QoQ"},{id:"yoy",label:"YoY"}].map(v=>(
            <button key={v.id} onClick={()=>setView(v.id)}
              style={{fontSize:11,padding:"4px 11px",border:"0.5px solid "+(view===v.id?"#0e7490":"#e5e7eb"),borderRadius:6,background:view===v.id?"#0e7490":"#fff",color:view===v.id?"#fff":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>
              {v.label}
            </button>
          ))}
        </div>
        {/* Weighting toggle — the question is "average of what?": every model
           once, or every model in proportion to the traffic it carried. */}
        <div style={{display:"inline-flex",border:"0.5px solid #e5e7eb",borderRadius:6,overflow:"hidden",background:"#fff"}}>
          {[{id:"equal",label:"Model-day weight"},{id:"usage",label:"Usage weighted"}].map(w=>(
            <button key={w.id} onClick={()=>setWeight(w.id)}
              title={w.id==="equal"
                ?"Every (model, day) price observation counts once — a model priced on more days of the quarter carries proportionally more of the mean."
                :"Each model counts in proportion to the tokens it served on OpenRouter, charged at the price in force that week."}
              style={{fontSize:11,padding:"4px 11px",border:"none",background:weight===w.id?"#111827":"#fff",color:weight===w.id?"#fff":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>
              {w.label}
            </button>
          ))}
        </div>
        {state.phase==="loading"&&<span><Spin size={10}/></span>}
      </div>

      {/* Per-provider upstream failure note — partial data still renders */}
      {state.data?.providerErrors?.length>0&&(
        <div style={{fontSize:11,color:"#92400e",background:"#fef3c7",border:"0.5px solid #fde68a",borderRadius:6,padding:"6px 10px",marginBottom:8,lineHeight:1.4}}>
          Partial data · upstream temporarily unavailable for {state.data.providerErrors.map(e=>e.slug).join(", ")} — other providers render as normal.
        </div>
      )}

      {/* The Quarterly Pricing Trend chart was removed here. It plotted only
         measured values, so once withheld cells began carrying estimates it
         drew three sparse lines with gaps directly above a matrix where all
         forty cells were filled — the two disagreed on screen, and the chart
         was the one that was wrong. The matrix below carries the same series
         with its coverage and basis per cell. */}
      {/* ── Matrix section header (kept minimal — methodology lives at bottom) ── */}
      {state.phase==="ready"&&state.data?.quarters?.length>0&&(
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4,marginTop:4}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:"#0e7490",display:"inline-block",opacity:0.7}}/>
          <span style={{fontSize:9,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#0e7490"}}>Quarterly Pricing Matrix</span>
        </div>
      )}

      {/* Content */}
      {state.phase==="error"?(
        <div style={{background:"#fff",border:"0.5px dashed #fca5a5",borderRadius:10,padding:"20px 16px",textAlign:"center"}}>
          <div style={{fontSize:13,color:"#991b1b",fontWeight:500,marginBottom:4}}>Provider-grouped pricing history temporarily unavailable</div>
        </div>
      ):state.phase==="loading"?(
        <div style={{...S.card}}><Shimmer rows={5}/></div>
      ):state.data&&state.data.quarters&&state.data.quarters.length?(
        <div style={{...S.card,padding:0,overflow:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:700}}>
            <thead>
              <tr>
                <th style={{...S.lbl,textAlign:"left",padding:"10px 12px",borderBottom:"1px solid #f3f4f6",background:"#fafafa",position:"sticky",left:0,zIndex:1}}>Quarter</th>
                {state.data.providers.map(p=>(
                  <th key={p.slug} style={{...S.lbl,textAlign:"right",padding:"10px 10px",borderBottom:"1px solid #f3f4f6",background:"#fafafa"}}>{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.data.quarters.map(q=>(
                <tr key={q.quarter} style={{background:q.partial?"rgba(14,116,144,0.04)":"transparent"}}>
                  <td style={{padding:"10px 12px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",color:"#111827",fontWeight:600,whiteSpace:"nowrap",background:q.partial?"rgba(14,116,144,0.04)":"#fff",position:"sticky",left:0,zIndex:1}}>
                    {q.quarter}
                    {q.partial&&<span style={{marginLeft:6,fontSize:9,background:"#ecfeff",color:"#0e7490",padding:"1px 5px",borderRadius:3,fontWeight:600}}>QTD</span>}
                  </td>
                  {q.cells.map(c=>{
                    let main,sub,color="#111827";
                    // A withheld weighted cell is not the same as missing data, so it
                    // reads differently: the sub-label names the gate, and the tooltip
                    // explains it in full rather than leaving a bare dash to interpret.
                    const withheld=weighted&&c.avg===null&&!!c.gate;
                    // An estimate is offered only where the measured value was withheld AND the
// server produced one. Two bases, and the sub-label says which: "provisional"
// is real arithmetic on evidence too thin to publish as measured; "modelled"
// had no usage at all and is inferred from this provider's own measured
// weighted-to-list ratio (or peers', which is weaker still).
                    const showEst=weighted&&c.avg===null&&c.estimateAvgLabel&&view==="avg";
                    const GATE_SHORT={"series-unavailable":"weights unavailable","no-usage":"no paid OR volume","too-few-models":(c.weightedModelCount||1)+" model only","coverage-unknown":"coverage not measurable","low-coverage":"coverage "+(c.coverageLabel||"low"),"single-model-dominated":"1 model is "+(c.topWeightShareLabel||"most")};
                    if(view==="qoq"){ main=c.qoqLabel||"—"; color=cellColor(c.qoq); sub=c.avgLabel; }
                    else if(view==="yoy"){ main=c.yoyLabel||"—"; color=cellColor(c.yoy); sub=c.avgLabel; }
                    else {
                      main=c.avgLabel;
                      sub=weighted
                        ?(withheld
                          ?(GATE_SHORT[c.gate]||"withheld")
                          :(c.weightedModelCount?c.weightedModelCount+(c.weightedModelCount===1?" model · ":" models · ")+(c.coverageLabel||"—")+" covered":"—"))
                        :(c.modelCount?c.modelCount+" models":"—");
                      // Where the measured value is withheld, show the estimate
                      // rather than a hole.
                      if(showEst){
                        main=c.estimateAvgLabel;
                        // Presented in the measured format at the owner's explicit
                        // direction. Only real metadata is shown — a model count
                        // and coverage where the weighting produced them, nothing
                        // otherwise. No figure here is invented to dress the cell.
                        sub=c.weightedModelCount
                          ?c.weightedModelCount+(c.weightedModelCount===1?" model":" models")+(c.coverageLabel?" · "+c.coverageLabel+" covered":"")
                          :"";
                      }
                    }
                    // Grey marks an EMPTY cell, not an estimated one. An estimate is
                    // rendered in the measured colour at the owner's explicit
                    // direction, so it cannot be read as weaker data on a slide.
                    if(withheld&&!showEst) color="#9ca3af";
                    const EST_WHY={
                      "measured-ratio":"this provider's own measured weighted-to-list ratio",
                      "provisional-ratio":"this provider's partial usage data, which was too thin to publish as measured",
                      "peer-ratio":"the median weighted-to-list ratio across providers that could be measured",
                    };
                    const tip=weighted
                      ?(showEst
                        ?"ESTIMATE, not measured — "+c.estimateAvgLabel+", from "+
                          (EST_WHY[c.estimateBasis]||"an inferred ratio")+
                          " ("+(c.estimateRatio!=null?"x"+c.estimateRatio.toFixed(2):"—")+
                          " of the $"+(c.equalAvg!=null?c.equalAvg.toFixed(3):"—")+" list price). "+
                          "Measured value withheld because: "+(c.gateReason||"it did not clear the gate")
                      :withheld
                        ?"Withheld — "+(c.gateReason||"did not clear the coverage gate")+
                          " Equal-weighted for reference: "+(c.equalAvgLabel||"—")+"."
                        :(c.avgLabel||"—")+" token-weighted across "+(c.weightedModelCount||0)+
                          " priced model"+(c.weightedModelCount===1?"":"s")+
                          " covering "+(c.coverageLabel||"—")+" of this provider's OpenRouter tokens"+
                          (c.topWeightShareLabel?" · largest model is "+c.topWeightShareLabel+" of the weight":"")+
                          " · equal-weighted "+(c.equalAvgLabel||"—")+
                          " · "+(c.modelCount||0)+" models priced in this quarter"+
                          (c.qoqLabel?" · QoQ "+c.qoqLabel:"")+(c.yoyLabel?" · YoY "+c.yoyLabel:""))
                      :(c.avgLabel||"—")+" avg · "+(c.modelCount||0)+" models in this quarter · "+(c.obsCount||0)+" daily observations"+(c.qoqLabel?" · QoQ "+c.qoqLabel:"")+(c.yoyLabel?" · YoY "+c.yoyLabel:"");
                    return(
                      <td key={c.slug} style={{padding:"10px 10px",borderBottom:"1px solid #f9fafb",fontFamily:"monospace",textAlign:"right",fontWeight:600,color,whiteSpace:"nowrap"}}
                          title={tip}>
                        <div>{main}</div>
                        <div style={{fontSize:9,color:withheld&&!showEst?"#d1d5db":"#9ca3af",fontWeight:400,marginTop:1}}>{sub}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ):(
        <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"20px 16px",textAlign:"center"}}>
          <div style={{fontSize:13,color:"#111827",fontWeight:500,marginBottom:4}}>No provider-grouped history available</div>
          <div style={{fontSize:11,color:"#6b7280"}}>Upstream source returned no rows.</div>
        </div>
      )}

      {/* Footnote — one line. The full methodology used to live here as nine
         chained clauses, which nobody reads and which crowded the table it was
         meant to support. What a reader actually needs at a glance is the unit,
         whether a number is measured or estimated, and where it came from.
         Every cell still carries its own coverage, model count and — for an
         estimate — its basis, on hover. */}
      <div style={{fontSize:10,color:"#6b7280",marginTop:8,lineHeight:1.5}}>
        <b style={{color:"#374151"}}>{unitHint}</b>
        {" · "}pricepertoken list prices{weighted?", weighted by OpenRouter token volume":""}
        {weighted&&<>{" · "}hover any cell for its coverage and basis</>}
        {" · from "}{state.data?.earliestDateObserved||"2025-07-28"}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MODEL PRICING — finance-model price matrix, by class & period
   First detailed section in the Model Pricing tab. Rows = comparable
   model class (Frontier vs Fast/Cost-efficient) per provider; columns
   = calendar quarters with quarter-end labels (Mar/Jun/Sep/Dec). Same
   visual language as the OpenRouter Token Demand table and the GPU
   Hardware Pricing financial-correlation table.

   Data source: /api/model-pricing-peer-matrix. That endpoint proxies
   pricepertoken.com's own historical pricing API (same upstream that
   /api/provider-pricing-matrix uses) and filters to a fixed peer-pair
   set so QoQ math reflects real repricing on the same model class
   instead of a drifting lineup average. The fixed peer mapping and the
   model-name normalization rules live server-side in the endpoint —
   this component just renders.

   Pricing color convention: a price drop is favorable for buyers, so
   negative changes render green / positive changes render red — the
   inverse of the OpenRouter Token Demand growth table where positive
   = green growth. Same parenthesized magnitude formatting either way.
═══════════════════════════════════════════════════════ */
function quarterIdToLabel(qid){
  const m=qid.match(/^(\d{4})-Q(\d)$/);
  if(!m)return qid;
  const y=parseInt(m[1],10),q=parseInt(m[2],10);
  return ["Mar","Jun","Sep","Dec"][q-1]+"-"+String(y).slice(2);
}
const MONTH_ABBR=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthIdToLabel(mid){
  const m=mid.match(/^(\d{4})-(\d{2})$/);
  if(!m)return mid;
  return MONTH_ABBR[parseInt(m[2],10)-1]+"-"+String(m[1]).slice(2);
}
/* One label formatter for both granularities so the header cells, the
   Frontier Reference header and the section labels can't drift apart. */
function periodIdToLabel(pid,gran){
  return gran==="month"?monthIdToLabel(pid):quarterIdToLabel(pid);
}

/* Field-name map per granularity. The endpoint emits quarterly and monthly
   series side by side under parallel keys, so switching the view is a key
   swap — no refetch, no second round-trip. */
const GRAN={
  quarter:{
    periodsKey:"quarters",
    price:{input:"input",output:"output"},
    chg:{input:"qoqInput",output:"qoqOutput"},
    yoy:{input:"yoyInput",output:"yoyOutput"},
    frontierCells:"cells",
    frontierPrice:{input:"input",output:"output"},
    frontierChg:{input:"chgInput",output:"chgOutput"},
    chgLabel:"QoQ",
    partialBadge:"QTD",
    yoyAvailableKey:"quarterlyYoYAvailable",
    bucketWord:"calendar quarter",
  },
  month:{
    periodsKey:"months",
    price:{input:"inputMonthly",output:"outputMonthly"},
    chg:{input:"momInput",output:"momOutput"},
    yoy:{input:"yoyInputMonthly",output:"yoyOutputMonthly"},
    frontierCells:"cellsMonthly",
    frontierPrice:{input:"inputMonthly",output:"outputMonthly"},
    frontierChg:{input:"momInput",output:"momOutput"},
    chgLabel:"MoM",
    partialBadge:"MTD",
    yoyAvailableKey:"monthlyYoYAvailable",
    bucketWord:"calendar month",
  },
};

function ModelPricingMatrixTable(){
  const[state,setState]=useState({phase:"loading",data:null,error:null});
  const[diagOpen,setDiagOpen]=useState(false);
  // Granularity: quarter is the default finance view; month exposes the
  // step changes a quarterly average blurs (Google's July-2026 50% cuts
  // read as a soft -44% quarter but a clean 2x step month-over-month)
  // and is currently the only granularity where YoY is computable at all.
  const[gran,setGran]=useState("quarter");
  const {dataTick}=useContext(DataRefreshContext);
  const loaded=useRef(false); // true once real figures are on screen
  useEffect(()=>{
    let cancelled=false;
    // Source: /api/model-pricing-peer-matrix proxies pricepertoken's own
    // historical pricing API (the same upstream provider-pricing-matrix uses)
    // and filters to a fixed peer-pair set so QoQ math reflects real provider
    // repricing on the same model class. This is REAL upstream historical
    // data — not the canonical KV snapshot store, which only reaches back as
    // far as the dashboard has been running.
    //
    // Keyed on the build hash, not the clock. This endpoint answers with
    // Cache-Control: public, max-age=86400, but the old "?v=<5-minute bucket>"
    // minted a brand-new URL every five minutes, so the browser never had an
    // entry to reuse and threw that day of caching away. Measured on the live
    // site: 13 ms from browser cache inside a bucket, 3,513 ms the moment the
    // bucket rolled over — for data that only changes daily. A build hash
    // changes exactly once per deploy: one cold fetch, then reuse. Same
    // reasoning as ModelPricingHistoryBlock above, which already does this.
    const background=loaded.current; // see AUTO-REFRESH
    fetch("/api/model-pricing-peer-matrix?b="+BUILD,{cache:background?"no-cache":"default"})
      .then(r=>r.ok?r.json():Promise.reject(new Error("HTTP "+r.status)))
      .then(d=>{
        if(cancelled)return;
        if(!d||d.success===false){if(!background)setState({phase:"error",data:null,error:d?.error||"Unknown error"});return;}
        loaded.current=true;
        setState({phase:"ready",data:d,error:null});
      })
      .catch(e=>{if(!cancelled&&!background)setState({phase:"error",data:null,error:e.message||"Fetch failed"});});
    return()=>{cancelled=true;};
  },[dataTick]);

  const G=GRAN[gran];

  const SegToggle=({value,onChange,options})=>(
    <div style={{display:"inline-flex",border:"0.5px solid #e5e7eb",borderRadius:6,overflow:"hidden",background:"#fff",flexShrink:0}}>
      {options.map(o=>{
        const active=value===o.v;
        return(
          <button key={o.v} onClick={()=>onChange(o.v)}
            style={{fontSize:11,padding:"4px 12px",border:"none",background:active?"#111827":"#fff",color:active?"#fff":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>
            {o.label}
          </button>
        );
      })}
    </div>
  );

  const header=(
    <>
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#0e7490",display:"inline-block"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#0e7490"}}>Model Pricing Matrix</span>
      </div>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 auto",minWidth:0}}>
          <div style={{fontSize:16,fontWeight:700,color:"#111827",lineHeight:1.3}}>Model Pricing by Provider</div>
          <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>
            {gran==="month"
              ?"Month-aligned price per token comparison across comparable model classes — real pricing history only."
              :"Quarter-aligned price per token comparison across comparable model classes — real pricing history only."}
          </div>
        </div>
        <SegToggle value={gran} onChange={setGran} options={[{v:"quarter",label:"Quarterly"},{v:"month",label:"Monthly"}]}/>
      </div>
    </>
  );

  if(state.phase==="loading"){
    return(<div style={{marginBottom:16}}>{header}<div style={{...S.card}}><Shimmer rows={6}/></div></div>);
  }
  if(state.phase==="error"){
    return(
      <div style={{marginBottom:16}}>{header}
        <div style={{background:"#fff",border:"0.5px dashed #fca5a5",borderRadius:10,padding:"14px 16px"}}>
          <div style={{fontSize:12,color:"#991b1b",fontWeight:500}}>Pricing matrix temporarily unavailable</div>
        </div>
      </div>
    );
  }

  const data=state.data;
  const periods=(data?.[G.periodsKey]||[]);
  const allReps=(data?.reps||[]);
  // Filter out reps that have no upstream data in the CURRENT granularity —
  // happens when an entire candidate list whiffs (e.g. provider has no
  // Legacy variants in the upstream window). Per spec: don't render an
  // all-`—` row.
  const reps=allReps.filter(rep=>{
    if(rep.hasData===false)return false;
    const hasAnyInput =Object.values(rep[G.price.input] ||{}).some(v=>v!=null);
    const hasAnyOutput=Object.values(rep[G.price.output]||{}).some(v=>v!=null);
    return hasAnyInput||hasAnyOutput;
  });
  const frontierRef=(data?.frontierReference||[]);
  const externalCatalog=data?.externalCatalog||null;
  const coverage=data?.coverage||null;
  const yoyAvailable=coverage?coverage[G.yoyAvailableKey]!==false:true;
  if(!periods.length||!reps.length){
    return(
      <div style={{marginBottom:16}}>{header}
        <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"14px 16px"}}>
          <div style={{fontSize:12,color:"#111827",fontWeight:500}}>Matrix populates as upstream historical pricing data becomes available</div>
          <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>This view filters pricepertoken.com's historical pricing API to comparable peer models per provider.</div>
        </div>
      </div>
    );
  }

  const fmtPrice=v=>{
    if(v==null||!isFinite(v))return"—";
    if(v>=10)return"$"+v.toFixed(2);
    if(v>=1) return"$"+v.toFixed(2);
    return "$"+v.toFixed(3);
  };
  // Pricing change colors are INVERTED from the growth table convention:
  // a price drop is favorable for the buyer (green), a price hike is
  // cost pressure (red). Magnitude format mirrors finance: negatives in
  // parentheses, positives prefixed with +.
  const fmtChange=v=>{
    if(v==null||!isFinite(v))return<span style={{color:"#d1d5db"}}>—</span>;
    const pct=v*100;
    const str=pct<0?"("+Math.abs(pct).toFixed(1)+"%)":(pct>0?"+":"")+pct.toFixed(1)+"%";
    const color=pct>0?"#dc2626":pct<0?"#059669":"#6b7280";
    return <span style={{color}}>{str}</span>;
  };

  const STICKY_BG="#f3f4f6";
  const STICKY_SHADOW="2px 0 0 #e5e7eb, 6px 0 6px -4px rgba(17,24,39,0.08)";
  const FIRST_COL_W=260;
  const COL_W=110;
  const stickyFirstBase={position:"sticky",left:0,background:STICKY_BG,boxShadow:STICKY_SHADOW,minWidth:FIRST_COL_W,maxWidth:FIRST_COL_W,width:FIRST_COL_W};
  const stickySectionBase={position:"sticky",left:0,background:STICKY_BG};
  const thMain={textAlign:"right",padding:"5px 10px",fontSize:10,color:"#6b7280",fontWeight:600,whiteSpace:"nowrap",minWidth:COL_W};
  const thFirst={...stickyFirstBase,textAlign:"left",padding:"5px 10px",fontSize:10,color:"#6b7280",fontWeight:600,whiteSpace:"nowrap",zIndex:3};
  const tdMain={textAlign:"right",padding:"4px 10px",fontSize:12,color:"#111827",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap",minWidth:COL_W};
  const tdDim ={textAlign:"right",padding:"4px 10px",fontSize:12,color:"#6b7280",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap",minWidth:COL_W};
  const tdFirst={...stickyFirstBase,textAlign:"left",padding:"6px 10px 6px 18px",fontSize:11,whiteSpace:"nowrap",zIndex:2};
  const sectionTh={...stickySectionBase,textAlign:"left",padding:"10px 10px 4px",fontSize:11,color:"#111827",fontWeight:700,textDecoration:"underline",textUnderlineOffset:"3px",zIndex:1};

  const periodHeaderCells=(bg)=>periods.map(p=>(
    <th key={p.id} style={bg?{...thMain,background:bg}:thMain}>
      {periodIdToLabel(p.id,gran)}
      {p.partial&&<span style={{marginLeft:3,fontSize:8,color:"#b45309",fontWeight:500}}>{G.partialBadge}</span>}
    </th>
  ));

  const renderSectionRow=(label,note)=>(
    <tr key={"sec-"+label}>
      <td style={sectionTh}>
        {label}
        {note&&<div style={{fontWeight:400,fontSize:9,color:"#9ca3af",textDecoration:"none",marginTop:1,whiteSpace:"normal",lineHeight:1.35}}>{note}</div>}
      </td>
      {periods.map(p=>(<td key={p.id} style={{padding:"10px 10px 4px",background:"#f3f4f6",minWidth:COL_W}}/>))}
    </tr>
  );
  const renderModelLabel=rep=>{
    const matchedSummary=(rep.matchedModels||[]).length
      ? rep.matchedModels.length+" upstream variant"+(rep.matchedModels.length===1?"":"s")+" matched: "+rep.matchedModels.join(", ")
      : "no upstream model matched";
    return(
      <td style={tdFirst} title={matchedSummary}>
        <div style={{lineHeight:1.25}}>
          <div style={{fontWeight:600,color:"#111827"}}>{rep.label}</div>
          <div style={{fontSize:10,color:"#9ca3af",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>{rep.modelDisplay}</div>
        </div>
      </td>
    );
  };
  const renderPriceRow=(rep,metricKey)=>(
    <tr key={metricKey+"-"+rep.key}>
      {renderModelLabel(rep)}
      {periods.map(p=>{
        const val=rep[metricKey]?.[p.id];
        return(<td key={p.id} style={tdMain}>{fmtPrice(val)}</td>);
      })}
    </tr>
  );
  const renderChangeRow=(rep,key)=>(
    <tr key={key+"-"+rep.key}>
      {renderModelLabel(rep)}
      {periods.map(p=>{
        const val=rep[key]?.[p.id];
        return(<td key={p.id} style={tdDim}>{fmtChange(val)}</td>);
      })}
    </tr>
  );
  const spacerRow=k=>(<tr key={k}><td colSpan={periods.length+1} style={{height:8,background:"#f9fafb"}}></td></tr>);

  return(
    <div style={{marginBottom:16}}>
      {header}
      <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#f9fafb"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,background:"#f3f4f6",minWidth:FIRST_COL_W+COL_W*periods.length}}>
            <thead>
              <tr>
                <th style={thFirst}></th>
                {periodHeaderCells()}
              </tr>
            </thead>
            <tbody>
              {renderSectionRow("Input Price / 1M Tokens")}
              {reps.map(rep=>renderPriceRow(rep,G.price.input))}

              {spacerRow("sp1")}

              {renderSectionRow("Output Price / 1M Tokens")}
              {reps.map(rep=>renderPriceRow(rep,G.price.output))}

              {spacerRow("sp2")}

              {renderSectionRow(G.chgLabel+" Price Change (input)")}
              {reps.map(rep=>renderChangeRow(rep,G.chg.input))}

              {spacerRow("sp3")}

              {renderSectionRow(G.chgLabel+" Price Change (output)")}
              {reps.map(rep=>renderChangeRow(rep,G.chg.output))}

              {spacerRow("sp4")}

              {renderSectionRow("YoY Price Change (input)",
                yoyAvailable?null:"No comparator yet — upstream history starts "+(data.earliestDateObserved||"mid-2025")+", so no full "+G.bucketWord+" has a year-ago pair. Populates automatically.")}
              {reps.map(rep=>renderChangeRow(rep,G.yoy.input))}

              {spacerRow("sp5")}

              {renderSectionRow("YoY Price Change (output)",
                yoyAvailable?null:"Same coverage limit as YoY input above.")}
              {reps.map(rep=>renderChangeRow(rep,G.yoy.output))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Frontier Reference by Period — which model was each provider's
         frontier in each period AND what it cost there. The customer's
         "the frontier today is not the same model as 12 quarters ago" point
         is answered here without contaminating the fixed-rep math above.
         Because the underlying model changes between periods, the change row
         measures the cost of the frontier MOVING, not a provider repricing
         one model — that distinction is called out in the subtitle. */}
      {frontierRef.length>0&&(
        <div style={{marginTop:12,marginBottom:6}}>
          <div style={{fontSize:11,fontWeight:700,color:"#374151",lineHeight:1.3}}>Frontier Reference by Period</div>
          <div style={{fontSize:10,color:"#9ca3af",marginTop:2,marginBottom:6,lineHeight:1.45}}>Reference only: the highest-tier model observed per provider in each period, and its price there. Auto-detected from the upstream catalog by model line and version — new releases appear here on their own, with no code change, and each period keeps whatever was frontier at the time. The model changes between periods, so the change rows show what the frontier costs as it moves — not a provider repricing one model. Read the matrix above for same-model repricing.</div>
          {/* Current frontier per provider + parser drift. Drift is the
             signal that a provider has adopted a naming scheme the detector
             does not recognize — surfaced rather than silently narrowing
             what the table can see, which is how the previous hand-kept
             priority list went months out of date unnoticed. */}
          {(()=>{
            const current=frontierRef.filter(r=>r.currentFrontier).map(r=>r.providerLabel.replace(" / Gemini","")+": "+r.currentFrontier.display);
            const drift=frontierRef.filter(r=>(r.unclassifiedModels||[]).length>0);
            if(!current.length&&!drift.length)return null;
            return(
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginTop:-2,marginBottom:7}}>
                {current.length>0&&<span style={{fontSize:10,color:"#6b7280"}}>Current frontier — <b style={{color:"#374151",fontWeight:600}}>{current.join(" · ")}</b></span>}
                {drift.length>0&&(
                  <span title={drift.map(r=>r.providerLabel+": "+r.unclassifiedModels.join(", ")).join(" | ")}
                    style={{fontSize:10,fontWeight:500,padding:"2px 7px",borderRadius:3,background:"#fef3c7",color:"#92400e"}}>
                    {drift.reduce((n,r)=>n+r.unclassifiedModels.length,0)} unrecognized model name{drift.reduce((n,r)=>n+r.unclassifiedModels.length,0)===1?"":"s"} — review detector
                  </span>
                )}
              </div>
            );
          })()}
          <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#fafafa"}}>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,background:"#fafafa",minWidth:FIRST_COL_W+COL_W*periods.length}}>
                <thead>
                  <tr>
                    <th style={{...thFirst,background:"#fafafa"}}></th>
                    {periodHeaderCells("#fafafa")}
                  </tr>
                </thead>
                <tbody>
                  {[
                    {label:"Frontier Model",         kind:"label"},
                    {label:"Input Price / 1M",       kind:"price",  key:G.frontierPrice.input},
                    {label:"Output Price / 1M",      kind:"price",  key:G.frontierPrice.output},
                    {label:G.chgLabel+" Change (input)", kind:"change", key:G.frontierChg.input},
                  ].map(section=>(
                    <Fragment key={"fsec-"+section.label}>
                      <tr>
                        <td style={{...sectionTh,background:"#fafafa"}}>{section.label}</td>
                        {periods.map(p=>(<td key={p.id} style={{padding:"10px 10px 4px",background:"#fafafa",minWidth:COL_W}}/>))}
                      </tr>
                      {frontierRef.map(row=>(
                        <tr key={"ref-"+section.label+"-"+row.providerSlug}>
                          <td style={{...tdFirst,background:"#fafafa"}}>
                            <div style={{lineHeight:1.25,fontWeight:600,color:"#111827"}}>{row.providerLabel}</div>
                          </td>
                          {periods.map(p=>{
                            const cell=row[G.frontierCells]?.[p.id];
                            if(section.kind==="label"){
                              const variantsTitle=cell?.matchedVariants?.length
                                ? cell.matchedVariants.length+" upstream variant"+(cell.matchedVariants.length===1?"":"s")+" matched: "+cell.matchedVariants.join(", ")
                                : undefined;
                              return(
                                <td key={p.id} title={variantsTitle} style={{textAlign:"right",padding:"6px 10px",fontSize:11,color:cell?"#374151":"#d1d5db",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap",minWidth:COL_W}}>
                                  {cell?cell.display:"—"}
                                </td>
                              );
                            }
                            const val=row[section.key]?.[p.id];
                            return(
                              <td key={p.id} style={section.kind==="price"?tdMain:tdDim}>
                                {section.kind==="price"?fmtPrice(val):fmtChange(val)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div style={{fontSize:10,color:"#9ca3af",lineHeight:1.5,marginTop:6}}>
        <b style={{color:"#6b7280",fontWeight:600}}>Methodology:</b> Prices use pricepertoken historical model-level rows, averaged by {G.bucketWord} and shown as $/1M tokens. {G.chgLabel}/YoY compare only valid full historical periods; {G.partialBadge} growth is suppressed. Fixed representative models keep growth math comparable; the Frontier Reference shows how the latest frontier label — and its price — change by period. Alternate-billing SKUs (<code style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>:batch</code>, <code style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>:beta</code>, <code style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>:thinking</code>) and sibling product lines (GPT-5 Pro vs GPT-5, <code style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>-customtools</code>, <code style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>-fast</code>) are excluded from every average — each would otherwise register as a price move when only the upstream catalog changed. Firecrawl is used only as an advisory model-discovery signal, never for pricing math.
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   TAB: Model Pricing
   Two internal subtabs (matches GPU Hardware Pricing's pill bar):
     1) Pricing Matrix          — existing matrix + signal + ppt embed
     2) Quality / Value Scatter — live reverse-proxy of sanand0.github.io/llmpricing
═══════════════════════════════════════════════════════ */
function ModelPricingTab(){
  const[subtab,setSubtab]=useState("matrix");
  return(
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <Pill text="Model Pricing · pricepertoken.com + LLM Pricing scatter" bg="#ecfeff" color="#0e7490"/>
        </div>
      </div>

      {/* Subtab switcher — same pattern + visual weight as GPU Hardware Pricing */}
      <div style={{display:"flex",gap:4,marginBottom:14,borderBottom:"0.5px solid #e5e7eb",paddingBottom:0}}>
        {[
          {id:"matrix", label:"Pricing Matrix",          sub:"peer-pair table · signal · live ppt embed"},
          {id:"scatter",label:"Quality / Value Scatter", sub:"ELO × input-token cost · live · sanand0 llmpricing"},
        ].map(t=>{
          const active=subtab===t.id;
          return(
            <button key={t.id} onClick={()=>setSubtab(t.id)}
              style={{fontSize:12,padding:"8px 16px",border:"none",borderBottom:active?"2px solid #111827":"2px solid transparent",marginBottom:-1,background:"transparent",color:active?"#111827":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:active?600:500,display:"flex",flexDirection:"column",alignItems:"flex-start",gap:1}}>
              <span>{t.label}</span>
              <span style={{fontSize:9,fontWeight:400,color:active?"#6b7280":"#9ca3af",textTransform:"lowercase"}}>{t.sub}</span>
            </button>
          );
        })}
      </div>

      {subtab==="matrix"
        ? <ModelPricingMatrixSubtab/>
        : <LLMPricingScatterSubtab/>
      }
    </>
  );
}

/* Pricing Matrix subtab — the existing Model Pricing layout
   (matrix → signal → live ppt embed). The quarterly history block that used to
   sit between the signal and the embed now has a tab of its own; see
   PricingHistoryTab. Nothing else about this subtab changed. */
function ModelPricingMatrixSubtab(){
  const[err,setErr]=useState(false);
  const bucket=useEmbedBucket();
  return(
    <>
      <ModelPricingMatrixTable/>
      <PricingShareSignalBlock/>
      {err?(
        <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"32px 16px",textAlign:"center"}}>
          <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>Model pricing embed temporarily unavailable</div>
          <button onClick={()=>setErr(false)}
            style={{marginTop:10,fontSize:11,padding:"5px 14px",border:"0.5px solid #d1d5db",borderRadius:6,background:"#fff",color:"#374151",cursor:"pointer",fontFamily:"inherit"}}>
            Retry
          </button>
        </div>
      ):(
        <div style={{borderRadius:8,overflow:"hidden",border:"0.5px solid #e5e7eb",background:"#fff"}}>
          <iframe
            src={"/api/pricepertoken-proxy?v="+bucket}
            title="Price Per Token — Model Pricing"
            loading="lazy"
            onError={()=>setErr(true)}
            style={{border:0,display:"block",width:"100%",height:"calc(100vh - 240px)",minHeight:700}}
          />
        </div>
      )}
      <div style={{fontSize:10,color:"#9ca3af",marginTop:6}}>
        Source: pricepertoken.com · per-token LLM API pricing across 300+ models · updated daily
      </div>
    </>
  );
}

/* Quality / Value Scatter subtab — live clipped iframe over the sanand0
   llmpricing scatter (?quality=overall by default). The reverse-proxy at
   /api/llmpricing-proxy/[[path]] handles the HTML shell and all asset/data
   relative URLs (script.js, README.md, elo.csv, narrative.json) so the chart
   renders entirely through our origin. Trailing slash on the iframe src is
   intentional: it makes every relative URL the page emits land back on the
   same proxy. */
function LLMPricingScatterSubtab(){
  const[err,setErr]=useState(false);
  const bucket=useEmbedBucket();
  return(
    <>
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#0e7490",display:"inline-block"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#0e7490"}}>Model Pricing · live quality/value scatter</span>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:16,fontWeight:700,color:"#111827",lineHeight:1.3}}>LLM Pricing Quality / Value Scatter</div>
        <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>
          Live model quality vs pricing comparison using ELO score and input-token cost.
        </div>
      </div>

      {err?(
        <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"32px 16px",textAlign:"center"}}>
          <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>LLM pricing scatter temporarily unavailable.</div>
          <button onClick={()=>setErr(false)}
            style={{marginTop:10,fontSize:11,padding:"5px 14px",border:"0.5px solid #d1d5db",borderRadius:6,background:"#fff",color:"#374151",cursor:"pointer",fontFamily:"inherit"}}>
            Retry
          </button>
        </div>
      ):(
        <div style={{borderRadius:8,overflow:"hidden",border:"0.5px solid #e5e7eb",background:"#fff"}}>
          <iframe
            src={"/api/llmpricing-proxy/?quality=overall&v="+bucket}
            title="LLM Pricing — Quality / Value Scatter"
            loading="lazy"
            onError={()=>setErr(true)}
            style={{border:0,display:"block",width:"100%",height:"calc(100vh - 280px)",minHeight:640}}
          />
        </div>
      )}
      <div style={{fontSize:10,color:"#9ca3af",marginTop:6}}>
        External live proxy · source: sanand0.github.io/llmpricing · directional quality/value comparison, not a filed financial metric.
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   TAB: GPU Hardware Pricing (getdeploying.com reverse-proxy embed
   + /api/gpu-hardware-pricing-data parsed-data summary)
═══════════════════════════════════════════════════════ */

// Strategic SKU order for the comparison table. Matches decision-weight
// (H/B class trainers first, then mid-training + inference workhorses).
// Must stay name-for-name identical to GPU_TRACKED_SKUS in
// functions/api/_gpu-tracked-skus.js: that list decides which SKUs the server
// fetches board power for. A name here that is missing there renders a blank
// $/kW cell; a name there that is missing here fetches a detail page nobody
// shows. They are separate files because functions/ is not in the client
// bundle's module graph.
const GPU_STRATEGIC_ORDER=[
  "Nvidia H100","Nvidia H200","Nvidia B200","Nvidia GB200",
  "Nvidia A100","Nvidia L40S",
];
// KPI cards want just the cheapest by SKU — uses same canonical names.
const GPU_KPI_SKUS=["Nvidia H100","Nvidia H200","Nvidia B200","Nvidia A100"];

function fmtUSD(v){
  if(v==null||!isFinite(v))return"—";
  if(v<1)return"$"+v.toFixed(2);
  if(v<10)return"$"+v.toFixed(2);
  return"$"+v.toFixed(2);
}

function GPUHardwarePricingTab(){
  const[err,setErr]=useState(false);
  const[data,setData]=useState(null);
  const[loadErr,setLoadErr]=useState(false);
  const[hist,setHist]=useState(null);       // daily
  const[histErr,setHistErr]=useState(false);
  const[qHist,setQHist]=useState(null);     // quarter-close (operational)
  const[qHistErr,setQHistErr]=useState(false);
  const[fHist,setFHist]=useState(null);     // financial (period-average)
  const[fHistErr,setFHistErr]=useState(false);
  const[histView,setHistView]=useState("quarter");   // quarter | daily (inside Infra subtab)
  const[gpuSubtab,setGpuSubtab]=useState("financial"); // "financial" default per investor framing

  const {dataTick}=useContext(DataRefreshContext);
  // Per series: true once that series has real figures on screen.
  const loaded=useRef({data:false,hist:false,qHist:false,fHist:false});
  useEffect(()=>{
    let cancelled=false;
    // Each series refreshes on its own (see AUTO-REFRESH). Once a series has
    // loaded, a failed refresh leaves it on screen rather than raising that
    // series' error; a success always clears a prior error, so a page whose
    // first load failed heals itself on the next tick.
    const load=(name,url,ok,set,setErr)=>{
      const background=loaded.current[name];
      fetch(url,{cache:background?"no-cache":"default"})
        .then(r=>r.ok?r.json():Promise.reject(r.status))
        .then(j=>{
          if(cancelled)return;
          if(ok(j)){loaded.current[name]=true;set(j);setErr(false);}
          else if(!background)setErr(true);
        })
        .catch(()=>{if(!cancelled&&!background)setErr(true);});
    };
    // Build-hash keyed for the same reason as the peer matrix above. This one
    // answers with max-age=300, so a returning reader inside five minutes is
    // served from browser cache instead of re-running the upstream scrape.
    load("data","/api/gpu-hardware-pricing-data?b="+BUILD,j=>j&&j.ok,setData,setLoadErr);
    load("hist","/api/gpu-hardware-pricing-history?window=60",j=>j&&j.success,setHist,setHistErr);
    load("qHist","/api/gpu-hardware-pricing-history?view=quarter&window=400",j=>j&&j.success,setQHist,setQHistErr);
    load("fHist","/api/gpu-hardware-pricing-history?view=financial&window=400",j=>j&&j.success,setFHist,setFHistErr);
    return()=>{cancelled=true;};
  },[dataTick]);

  const updatedTxt=data?.sourceUpdatedAt?.text||null;

  return(
    <>
      <style>{`@keyframes gpupulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>

      {/* Page header — rendered once, above the subtab switcher */}
      <div style={{marginBottom:10}}>
        <div style={{fontSize:16,fontWeight:700,color:"#111827",lineHeight:1.3}}>GPU Hardware Pricing</div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>
          Two lenses on the same strategic GPU basket · daily snapshots underneath captured since <b style={{color:"#6b7280",fontWeight:600}}>{fHist?.trackingSinceRealDate||"—"}</b>
        </div>
      </div>

      {/* Subtab switcher */}
      <div style={{display:"flex",gap:4,marginBottom:14,borderBottom:"0.5px solid #e5e7eb",paddingBottom:0}}>
        {[
          {id:"financial",label:"Financial Correlation",sub:"period averages · QoQ · YoY"},
          {id:"infra",    label:"Infra Monitoring",     sub:"live pricing · quarter-close · operational history"},
        ].map(t=>{
          const active=gpuSubtab===t.id;
          return(
            <button key={t.id} onClick={()=>setGpuSubtab(t.id)}
              style={{fontSize:12,padding:"8px 16px",border:"none",borderBottom:active?"2px solid #111827":"2px solid transparent",marginBottom:-1,background:"transparent",color:active?"#111827":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:active?600:500,display:"flex",flexDirection:"column",alignItems:"flex-start",gap:1}}>
              <span>{t.label}</span>
              <span style={{fontSize:9,fontWeight:400,color:active?"#6b7280":"#9ca3af",textTransform:"lowercase"}}>{t.sub}</span>
            </button>
          );
        })}
      </div>

      {gpuSubtab==="financial"
        ? <GPUFinancialSubtab fHist={fHist} fHistErr={fHistErr}/>
        : <GPUInfraMonitoringSubtab
            data={data} loadErr={loadErr} updatedTxt={updatedTxt}
            histView={histView} setHistView={setHistView}
            qHist={qHist} qHistErr={qHistErr}
            hist={hist} histErr={histErr}
            embedErr={err} setEmbedErr={setErr}
          />
      }
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   SUBTAB: Financial Correlation (investor lens)
   - No live KPI cards (those are infra monitoring)
   - Period averages only · QoQ · YoY
   - Primary rows (B200/H200/H100) always visible
   - Secondary rows (A100/GB200/L40S) behind "Show more" expansion
═══════════════════════════════════════════════════════ */
function GPUFinancialSubtab({fHist,fHistErr}){
  return(
    <>
      {/* Section label */}
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#1d4ed8",display:"inline-block"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#1d4ed8"}}>Investor lens — financial correlation</span>
      </div>

      {/* Title + subtitle */}
      <div style={{marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:700,color:"#111827",lineHeight:1.3}}>Period-average GPU pricing for equity correlation</div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>
          Arithmetic mean of the daily headline price by calendar period — real historical GPU pricing only, no estimates.
        </div>
      </div>

      {/* Financial matrix */}
      <GPUFinancialCorrelationBlock fHist={fHist} fHistErr={fHistErr}/>
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   SUBTAB: Infra Monitoring (live market plumbing)
   - Live KPI cards (current spot minimums)
   - Strategic SKU comparison (live lowest / highest $/hr)
   - Operational GPU Pricing History (quarter-close / QTD / daily)
   - Live reverse-proxied getdeploying table
═══════════════════════════════════════════════════════ */
function GPUInfraMonitoringSubtab({data,loadErr,updatedTxt,histView,setHistView,qHist,qHistErr,hist,histErr,embedErr,setEmbedErr}){
  const bucket=useEmbedBucket();
  const rows=data?.rows||[];
  const byName={};
  for(const r of rows)if(!byName[r.gpuModel])byName[r.gpuModel]=r;

  const kpiCards=GPU_KPI_SKUS.map(sku=>{
    const r=byName[sku];
    // No card when the SKU is absent from the feed entirely — an empty card would
    // claim we track something we do not. A SKU that IS in the feed but carries no
    // price keeps its card and shows a dash, so "not tracked" and "tracked,
    // unpriced" stay distinguishable instead of both being silence. Guarding on
    // minPricePerHour is what made all four cards vanish once the source stopped
    // publishing a vendor range.
    if(!r)return null;
    const short=sku.replace(/^Nvidia\s+/i,"");
    const basis=r.dailyBasis?FIN_BASIS_SHORT[r.dailyBasis]:null;
    return{
      // "cheapest" was only true of the old floor measure. The label now names
      // whichever measure the row actually carries.
      sku,label:short+(basis?" "+basis:"")+" $/hr",
      value:fmtUSD(r.dailyPrice),
      // Says what this feed shows, not what the source did: a row can be priceless
      // because the source omitted a price or because the parser missed one, and
      // the two are indistinguishable from here.
      sub:r.dailyPrice==null?"no price in this feed"
        :(r.providerCount?"across "+r.providerCount+" providers":null),
    };
  }).filter(Boolean);

  const totalProviders=rows.reduce((m,r)=>Math.max(m,r.providerCount||0),0);
  const modelCount=rows.length;
  const tableRows=GPU_STRATEGIC_ORDER.map(n=>byName[n]).filter(Boolean);

  // The source has published this listing as a vendor min-max range and as a single
  // median, and those are different statistics. The column is NAMED from what the
  // rows actually carry rather than hard-coded, so a change of measure renames the
  // column instead of printing a median under a label that says floor. Null when
  // the rows disagree — then each row states its own.
  const tableBases=new Set(tableRows.map(r=>r.dailyBasis).filter(Boolean));
  const tableBasis=tableBases.size===1?Array.from(tableBases)[0]:null;
  const tableBasisHeading=tableBasis
    ?FIN_BASIS_SHORT[tableBasis].replace(/^./,c=>c.toUpperCase())+"\u00a0$/hr"
    :"$/hr";

  return(
    <>
      {/* Section label */}
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:"#0e7490",display:"inline-block",animation:"gpupulse 2s infinite"}}/>
        <span style={{fontSize:10,textTransform:"uppercase",letterSpacing:".09em",fontWeight:700,color:"#0e7490"}}>Live infra signal — current market plumbing</span>
      </div>

      {/* Title + subtitle */}
      <div style={{marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:700,color:"#111827",lineHeight:1.3}}>Live provider pricing, quarter-close history, and vendor table</div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>
          Current $/hr per SKU across the providers listing it · operational history uses quarter-close (last real snapshot in quarter).
          {updatedTxt&&<> · <b style={{color:"#6b7280",fontWeight:600}}>Source updated {updatedTxt}</b></>}
        </div>
      </div>

      {/* KPI cards */}
      {loadErr?(
        <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"14px 16px",marginBottom:14}}>
          <div style={{fontSize:11,color:"#6b7280"}}>Summary metrics unavailable — parser temporarily offline. Live embed below still loads.</div>
        </div>
      ):!data?(
        <div style={{marginBottom:14}}>
          <Shimmer rows={2}/>
        </div>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:8,marginBottom:10}}>
            {kpiCards.map(c=>(
              <KBox key={c.sku} label={c.label} value={c.value} sub={c.sub} bg="#ecfeff" fg="#0e7490"/>
            ))}
            <KBox label="Providers tracked"       value={totalProviders?totalProviders+"+":"—"} sub="across all SKUs"      bg="#f0fdf4" fg="#059669"/>
            <KBox label="GPU models tracked"      value={modelCount||"—"}                       sub="parsed from source" bg="#eff6ff" fg="#1d4ed8"/>
          </div>

          {/* Strategic comparison table */}
          {tableRows.length>0&&(
            <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",marginBottom:14,background:"#fff"}}>
              <div style={{padding:"9px 14px",borderBottom:"0.5px solid #f3f4f6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:11,fontWeight:600,color:"#111827"}}>Strategic SKU comparison</span>
                <span style={{fontSize:10,color:"#9ca3af"}}>ordered by decision weight · training → inference</span>
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr style={{background:"#fafafa"}}>
                      <th style={gpuTh}>GPU</th>
                      <th style={gpuTh}>VRAM</th>
                      <th style={{...gpuTh,textAlign:"right"}} title={tableBasis?"Measured as the "+FIN_BASIS_LABEL[tableBasis]:undefined}>{tableBasisHeading}</th>
                      <th style={{...gpuTh,textAlign:"right"}}
                          title={"Hourly price divided by the card's rated board power, as published by getdeploying. "+
                                 "The price of a unit of installed power capacity — NOT an electricity cost. "+
                                 "Read it per row: the rows are not on one form-factor basis, so this is not an efficiency ranking."}>
                        $/kW&#8209;hr<div style={{fontSize:9,fontWeight:500,color:"#9ca3af",textTransform:"none",letterSpacing:0}}>rated board power</div>
                      </th>
                      <th style={{...gpuTh,textAlign:"right"}}>Providers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(r=>(
                      <tr key={r.gpuModel} style={{borderTop:"0.5px solid #f3f4f6"}}>
                        <td style={gpuTd}><span style={{fontWeight:600,color:"#111827"}}>{r.gpuModel}</span></td>
                        <td style={{...gpuTd,color:"#6b7280"}}>{r.vram||"—"}</td>
                        <td style={{...gpuTd,textAlign:"right",color:"#111827",fontWeight:600}}
                            title={r.dailyBasis?"Measured as the "+FIN_BASIS_LABEL[r.dailyBasis]:undefined}>
                          {fmtUSD(r.dailyPrice)}
                          {!tableBasis&&r.dailyBasis&&<div style={{fontSize:9,fontWeight:500,color:r.dailyBasis==="median"?"#1d4ed8":"#9ca3af"}}>{FIN_BASIS_SHORT[r.dailyBasis]}</div>}
                        </td>
                        <td style={{...gpuTd,textAlign:"right",color:"#374151"}}
                            title={r.boardPowerWatts==null
                              ?"No rated board power published for this card, so this cannot be computed."
                              :r.boardPowerWatts+" W rated"+(r.boardPowerVariant?" · "+r.boardPowerVariant:"")+
                               (r.dailyPrice!=null?" · "+fmtUSD(r.dailyPrice)+"/hr":"")}>
                          {r.pricePerKilowattHour!=null?"$"+r.pricePerKilowattHour.toFixed(2):"—"}
                          {r.boardPowerWatts!=null&&(
                            <div style={{fontSize:9,fontWeight:500,color:"#9ca3af"}}>
                              {r.boardPowerWatts}&#8239;W{r.boardPowerVariant?" "+r.boardPowerVariant:""}
                            </div>
                          )}
                        </td>
                        <td style={{...gpuTd,textAlign:"right",color:"#6b7280"}}>{r.providerCount??"—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{padding:"8px 14px",borderTop:"0.5px solid #f3f4f6",fontSize:10,color:"#9ca3af",lineHeight:1.5}}>
                <b style={{color:"#6b7280",fontWeight:600}}>$/kW&#8209;hr</b> is the hourly price divided by the card's rated
                board power — what a unit of installed power capacity costs to rent. It is <b style={{color:"#6b7280",fontWeight:600}}>not
                an electricity cost</b>. Read each row on its own: board power is a nameplate figure published per card by
                getdeploying, and the card it names differs by row — their H100 figure is the SXM part, their A100 figure the
                PCIe one, and the PCIe H100 draws half what the SXM does. The hourly price alongside it is a median across
                every provider listing that model, PCIe and SXM machines together. So the column compares a blended price
                against one variant's nameplate, and the order it implies is <b style={{color:"#6b7280",fontWeight:600}}>not an
                efficiency ranking</b>.
              </div>
            </div>
          )}
        </>
      )}

      {/* Operational history (quarter-close / QTD bootstrap / daily) */}
      <GPUHistoryShell
        histView={histView} setHistView={setHistView}
        qHist={qHist} qHistErr={qHistErr}
        hist={hist} histErr={histErr}
      />

      {/* Live embed */}
      {embedErr?(
        <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"32px 16px",textAlign:"center"}}>
          <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>getdeploying GPU pricing live embed temporarily unavailable</div>
          <button onClick={()=>setEmbedErr(false)}
            style={{marginTop:10,fontSize:11,padding:"5px 14px",border:"0.5px solid #d1d5db",borderRadius:6,background:"#fff",color:"#374151",cursor:"pointer",fontFamily:"inherit"}}>
            Retry
          </button>
        </div>
      ):(
        <div style={{borderRadius:8,overflow:"hidden",border:"0.5px solid #e5e7eb",background:"#fff"}}>
          <iframe
            src={"/api/getdeploying-gpus-proxy?v="+bucket}
            title="GetDeploying — GPU Hardware Pricing"
            loading="lazy"
            onError={()=>setEmbedErr(true)}
            style={{border:0,display:"block",width:"100%",height:"calc(100vh - 240px)",minHeight:720}}
          />
        </div>
      )}
      <div style={{fontSize:10,color:"#9ca3af",marginTop:6}}>
        Source: getdeploying.com/gpus (live reverse-proxied embed · summary parsed from SSR HTML)
      </div>
    </>
  );
}

const gpuTh={textAlign:"left",padding:"7px 12px",fontSize:10,textTransform:"uppercase",letterSpacing:".06em",color:"#6b7280",fontWeight:600};
const gpuTd={padding:"7px 12px",verticalAlign:"middle"};

/* ─── GPU Financial Correlation Block ─────────────────────
   Analyst-worksheet matrix: period-AVERAGE $/hr (not close), with QoQ
   and YoY growth rows directly underneath, quarter-end-month column
   labels (Mar/Jun/Sep/Dec-YY). Uses real-only data; partial periods are
   labeled QTD/MTD; growth cells only populate when both periods have
   real averages. Sits above the existing operational history block. */

// Primary visible rows ordered by generation (A100 oldest → GB200 newest), per
// the customer's investor framing: "from A100 to … Grace Blackwell". A100 is
// promoted from secondary because the customer named it explicitly as a major
// generation marker. AMD MI3xx, Rubin, Groq and other accelerators are NOT
// included here because the upstream getdeploying.com basket does not yet
// track them — adding empty rows would violate "do not include empty future
// rows just to show the names".
const GPU_FIN_PRIMARY_ROWS=[
  {sku:"Nvidia A100",   shortLabel:"A100 40/80GB HBM2e"},
  {sku:"Nvidia H100",   shortLabel:"H100 80GB HBM3"},
  {sku:"Nvidia H200",   shortLabel:"H200 141GB HBM3e"},
  {sku:"Nvidia B200",   shortLabel:"B200 192GB HBM3e"},
  {sku:"Nvidia GB200",  shortLabel:"GB200 (Grace Blackwell)"},
];
const GPU_FIN_SECONDARY_ROWS=[
  {sku:"Nvidia L40S",   shortLabel:"L40S 48GB GDDR6"},
];

/* Illustrative / design-preview values — NOT sourced from live data.
   Rendered only when the user explicitly flips the toggle ON. Never
   persisted to KV, never sent through the real pipeline, never mixed
   with real snapshots. An amber warning banner is shown whenever this
   data is visible. These values were supplied by the operator as a
   layout/shape preview for the Financial Correlation matrix. */
const GPU_FIN_ILLUSTRATIVE_QUARTERS=[
  {period:"2024-Q1", label:"Mar-24"},
  {period:"2024-Q2", label:"Jun-24"},
  {period:"2024-Q3", label:"Sep-24"},
  {period:"2024-Q4", label:"Dec-24"},
  {period:"2025-Q1", label:"Mar-25"},
  {period:"2025-Q2", label:"Jun-25"},
  {period:"2025-Q3", label:"Sep-25"},
  {period:"2025-Q4", label:"Dec-25"},
  {period:"2026-Q1", label:"Mar-26"},
  {period:"2026-Q2", label:"Jun-26"},
];
const GPU_FIN_ILLUSTRATIVE_PRICING={
  "Nvidia B200":[10.00, 2.00, 4.00, 5.00,12.00,10.00,5.00,1.00,2.00,3.53],
  "Nvidia H200":[ 8.00, 7.00, 6.00, 5.00, 4.50, 4.00,2.00,1.75,2.00,2.20],
  "Nvidia H100":[ 4.00, 3.60, 3.00, 2.50, 1.85, 1.75,1.55,1.25,1.75,1.54],
};

/* Synthesize an fHist-shaped payload from the illustrative pricing values.
   Quarterly-only. QoQ = pct change vs period N-1. YoY = pct change vs period
   N-4. Partial flags are always false (these are purely display values, not
   captured snapshots). */
function buildIllustrativeFHist(){
  const qLabels=GPU_FIN_ILLUSTRATIVE_QUARTERS;
  const series={};
  const qoq={};
  const yoy={};
  for(const[sku,values]of Object.entries(GPU_FIN_ILLUSTRATIVE_PRICING)){
    series[sku]=values.map((v,i)=>({
      period:qLabels[i].period,
      label:qLabels[i].label,
      avgMinPricePerHour:v,
      isQTD:false,
      isPartialQuarter:false,
      daysCoveredInQuarter:null,
      quarterDayCount:null,
      coverageRatioWithinQuarter:null,
    }));
    qoq[sku]={};
    yoy[sku]={};
    for(let i=0;i<values.length;i++){
      const cur=values[i];
      const prior=i>0?values[i-1]:null;
      const yoyPrior=i>=4?values[i-4]:null;
      qoq[sku][qLabels[i].period]=(prior!=null&&prior!==0)
        ?+(((cur-prior)/prior)*100).toFixed(1):null;
      yoy[sku][qLabels[i].period]=(yoyPrior!=null&&yoyPrior!==0)
        ?+(((cur-yoyPrior)/yoyPrior)*100).toFixed(1):null;
    }
  }
  return{
    success:true,
    view:"financial",
    include:"illustrative",
    isIllustrative:true,
    trackingSinceRealDate:null,
    quarterly:{labels:qLabels,series,qoq,yoy},
    monthly:{labels:[],series:{},mom:{},yoy:{}}, // not supported in illustrative mode
  };
}

const finTh={textAlign:"right",padding:"5px 10px",fontSize:10,color:"#6b7280",fontWeight:600,whiteSpace:"nowrap"};
const finThRow={textAlign:"left",padding:"5px 10px",fontSize:10,color:"#6b7280",fontWeight:600,whiteSpace:"nowrap"};
const finTd={textAlign:"right",padding:"4px 10px",fontSize:12,color:"#2563eb",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap"};
const finTdRow={textAlign:"left",padding:"4px 10px",fontSize:11,color:"#111827",fontWeight:600,whiteSpace:"nowrap"};
const finTdDim={textAlign:"right",padding:"4px 10px",fontSize:12,color:"#6b7280",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap"};
const finSectionTh={textAlign:"left",padding:"10px 10px 4px",fontSize:11,color:"#111827",fontWeight:700,textDecoration:"underline",textUnderlineOffset:"3px"};

function fmtMoney(v){
  if(v==null||!isFinite(v))return"—";
  if(v<1)return"$"+v.toFixed(2);
  return"$"+v.toFixed(2);
}

/* ─── Period-axis helpers ───────────────────────────────────
   The column axis is now continuous (the API emits every calendar period
   from the first observed one through today, including ones with no
   captures at all), so a stalled feed shows up as a visible gap column
   instead of quietly shortening the table. Growth and resilience therefore
   must resolve the *calendar* prior period by id — walking back one array
   slot silently compares across a gap. */
function finPriorPeriodId(periodId){
  if(typeof periodId!=="string")return null;
  const q=/^(\d{4})-Q([1-4])$/.exec(periodId);
  if(q){
    const y=+q[1],n=+q[2];
    return n===1?(y-1)+"-Q4":y+"-Q"+(n-1);
  }
  const m=/^(\d{4})-(\d{2})$/.exec(periodId);
  if(m){
    const y=+m[1],n=+m[2];
    return n===1?(y-1)+"-12":y+"-"+String(n-1).padStart(2,"0");
  }
  return null;
}
// The YoY row's comparator is the period one YEAR back, not the one before
// it. The growth renderer draws both rows, so it has to be told which — using
// the immediate prior for the YoY row attributes an empty cell to whatever
// happened last month, which is how an Aug-26 YoY cell with no Aug-25 to
// compare against ended up reading "measure changed".
function finYearPriorPeriodId(periodId){
  if(typeof periodId!=="string")return null;
  const q=/^(\d{4})-Q([1-4])$/.exec(periodId);
  if(q)return (+q[1]-1)+"-Q"+q[2];
  const m=/^(\d{4})-(\d{2})$/.exec(periodId);
  if(m)return (+m[1]-1)+"-"+m[2];
  return null;
}

// A period is only comparable if it actually carries priced days. The feed
// can deliver provider counts with a null minPricePerHour (which is exactly
// what happened from 2026-07-28 onward), so "we have rows for this month" is
// not the same question as "we have prices for this month".
function finPricedCoverage(rec){
  if(!rec)return null;
  const v=rec.pricedCoverageRatioWithinMonth!=null?rec.pricedCoverageRatioWithinMonth
         :rec.pricedCoverageRatioWithinQuarter!=null?rec.pricedCoverageRatioWithinQuarter:null;
  if(v!=null)return v;
  // Older payloads (and the illustrative preview) predate the priced-coverage
  // fields — fall back to raw coverage so those paths keep rendering.
  const c=rec.coverageRatioWithinMonth!=null?rec.coverageRatioWithinMonth
         :rec.coverageRatioWithinQuarter!=null?rec.coverageRatioWithinQuarter:null;
  return c;
}
function finHasPrice(rec){
  if(!rec)return false;
  if(typeof rec.hasPrice==="boolean")return rec.hasPrice;
  return finPrice(rec)!=null;
}

// The headline price for a period, and how it was measured. The upstream
// listing replaced its min-max range with a single median part-way through
// this history, so a period carries one or the other. The API publishes both
// the number and its basis; older payloads predate the field and fall back
// to the floor, which is what they contained.
function finPrice(rec){
  if(!rec)return null;
  const v=rec.headlinePricePerHour!=null?rec.headlinePricePerHour:rec.avgMinPricePerHour;
  return v!=null&&isFinite(v)?v:null;
}
function finBasis(rec){
  if(!rec)return null;
  if(rec.priceBasis)return rec.priceBasis;
  return finPrice(rec)!=null?"floor":null;
}
const FIN_BASIS_LABEL={median:"median $/hr across providers",floor:"floor of the vendor range (min $/hr)"};
const FIN_BASIS_SHORT={median:"median",floor:"floor (min)"};

/* ─── Price-basis boundary ──────────────────────────────────
   The source changed WHAT IT PUBLISHES on 2026-07-28: a vendor min-max range
   became a single vendor median. The floor of a range and a median are not
   the same measure — H100 read $0.40 as a floor and $3.39 as a median on
   consecutive days — so the step in the price row is a change of units, not
   a market move.

   The matrix used to render both sides of that change as identical blue
   numbers in one row, with the growth cell merely blank. A reader has no way
   to see a units change in a blank cell, so it read as an unexplained jump.
   These helpers find the boundary from the data (never a hard-coded date, so
   the next shape change explains itself) and the render draws a rule at it. */
function finBasisByPeriod(series,periods,rows){
  const out={};
  for(const p of periods){
    let b=null;
    for(const r of rows){
      const rec=finPeriodRec(series,r.sku,p.period);
      const rb=finBasis(rec);
      if(!rb)continue;
      if(b==null)b=rb;
      else if(b!==rb){b="mixed";break;}
    }
    if(b)out[p.period]=b;
  }
  return out;
}
// Index of the first column that sits on a different basis than the column
// before it. The divider is drawn on that column's left edge.
function finBasisBoundaryIndex(basisByPeriod,periods){
  let lastSeen=null;
  for(let i=0;i<periods.length;i++){
    const b=basisByPeriod[periods[i].period];
    if(!b)continue;
    if(lastSeen!=null&&b!==lastSeen)return i;
    lastSeen=b;
  }
  return -1;
}
// Left border marking the boundary column. Applied to every cell in that
// column so the rule runs the full height of the table.
const FIN_BOUNDARY_BORDER="1.5px dashed #b45309";
function finBoundaryStyle(isBoundary){
  return isBoundary?{borderLeft:FIN_BOUNDARY_BORDER}:null;
}
function finIsPartial(rec,partialKey){
  if(!rec)return false;
  return !!rec[partialKey];
}
// Below this share of priced days a period average is still shown, but every
// number derived from it is marked — a 10-day April stub is not a month.
const FIN_LOW_COVERAGE=0.75;

function finPeriodRec(series,sku,periodId){
  const arr=series[sku]||[];
  for(const x of arr)if(x.period===periodId)return x;
  return null;
}
// GPU price growth — color convention is buyer/cost-analysis: a price drop
// is favorable, so negatives render green and increases render red. Same
// inverted convention as the Model Pricing matrix; matches customer spec
// for this tab. (Resilience-signal callout below the growth rows still
// flags "stable/up" GREEN to convey the investor-side ROI read.)
function fmtGrowth(v){
  if(v==null||!isFinite(v))return<span style={{color:"#d1d5db"}}>—</span>;
  const str=v<0?"("+Math.abs(v).toFixed(1)+"%)":(v>0?"+":"")+v.toFixed(1)+"%";
  const color=v>0?"#dc2626":v<0?"#059669":"#6b7280";
  return <span style={{color}}>{str}</span>;
}

/* ─── Feed integrity banner ─────────────────────────────────
   The matrix renders a missing price and a real $0.00 identically: as an
   em-dash. That is fine when one cell is empty and actively misleading when
   a whole column is, because the table still *looks* complete — it just gets
   shorter or sprouts blanks. This banner states the feed's actual condition
   above the matrix so a stalled capture can never be read as a flat market.

   Two failure modes are reported separately because they have different
   fixes: the GPU block no longer arriving at all (capture/cron side), versus
   the block still arriving with minPricePerHour null (upstream shape change,
   provider counts keep updating while prices go blank). */
function GPUFeedIntegrityBanner({dq,periodNoun}){
  if(!dq)return null;
  const notes=[];
  if(dq.priceFieldDroppedWhileFeedLive&&dq.latestPricedObservationDate){
    notes.push({
      k:"pricefield",
      sev:"high",
      head:"Price field missing from the feed since "+dq.latestPricedObservationDate,
      body:"GPU rows kept arriving after that date — provider counts are still updating — but minPricePerHour came back empty, so every price cell from then on is blank. "
           +dq.unpricedDays+" of "+dq.observationDays+" captured days carry no price.",
    });
  }else if(dq.priceFieldStale&&dq.latestPricedObservationDate){
    notes.push({
      k:"pricestale",
      sev:"high",
      head:"No new price observed since "+dq.latestPricedObservationDate,
      body:"Price cells reflect data that is "+dq.daysSinceLatestPricedObservation+" days old.",
    });
  }
  if(dq.gpuFeedStale&&dq.latestGPUObservationDate){
    notes.push({
      k:"feedstale",
      sev:"high",
      head:"GPU capture stalled — last observation "+dq.latestGPUObservationDate,
      body:"That is "+dq.daysSinceLatestGPUObservation+" days ago. Nothing after that date has been captured for any SKU, so the most recent "
           +periodNoun+" columns are empty rather than flat.",
    });
  }
  // A run of days with no capture at all. The month columns just look thin
  // when this happens, which reads as a quiet market rather than a missing
  // one — the 2026-08-22 → 2026-09-10 outage is why Sep-26 rests on six days.
  for(const g of (dq.significantCaptureGaps||[])){
    notes.push({
      k:"capgap-"+g.afterDate,
      sev:"med",
      head:g.missingDays+" days with no capture: "+g.afterDate+" → "+g.beforeDate,
      body:"The months either side of the gap rest on fewer days than their length suggests, so their averages are thinner than the column label implies.",
    });
  }
  // The capture writing prices into the wrong field is what blanked August in
  // the first place. It is repaired on read, but if this count starts growing
  // again the capture has regressed and the matrix would otherwise look fine.
  if(dq.remappedPriceDays>0){
    notes.push({
      k:"remap",
      sev:"low",
      head:dq.remappedPriceDays+" day"+(dq.remappedPriceDays===1?"":"s")+" recovered from the feed's max field",
      body:"Those captures landed with the price in maxPricePerHour because the source swapped its range for a single figure. They are reclassified as medians on read; the stored snapshots are untouched. A rising count means the capture has regressed.",
    });
  }
  if(dq.monthsMissing?.length||dq.quartersMissing?.length){
    const miss=[...(dq.monthsMissing||[]),...(dq.quartersMissing||[])];
    notes.push({
      k:"gaps",
      sev:"med",
      head:"Gap "+(miss.length===1?"period":"periods")+": "+miss.join(", "),
      body:"Shown as empty columns rather than dropped from the axis, so the hole stays visible.",
    });
  }
  if(dq.monthsUnpriced?.length||dq.quartersUnpriced?.length){
    const un=[...(dq.monthsUnpriced||[]),...(dq.quartersUnpriced||[])];
    notes.push({
      k:"unpriced",
      sev:"med",
      head:"Captured but unpriced: "+un.join(", "),
      body:"These columns have provider counts but no price, so they contribute nothing to growth or resilience.",
    });
  }
  if(!notes.length)return null;
  const high=notes.some(n=>n.sev==="high");
  return(
    <div style={{background:high?"#fef2f2":"#fffbeb",border:"1px solid "+(high?"#fca5a5":"#fcd34d"),borderRadius:8,padding:"10px 12px",marginBottom:8}}>
      <div style={{fontWeight:700,textTransform:"uppercase",letterSpacing:".04em",fontSize:10,color:high?"#991b1b":"#92400e",marginBottom:5}}>
        {high?"⚠ Feed integrity — matrix is not current":"Feed integrity notes"}
      </div>
      {notes.map(n=>(
        <div key={n.k} style={{fontSize:11,color:high?"#7f1d1d":"#92400e",lineHeight:1.5,marginTop:3}}>
          <b style={{fontWeight:600}}>{n.head}.</b> {n.body}
        </div>
      ))}
    </div>
  );
}

function GPUFinancialCorrelationBlock({fHist,fHistErr}){
  const[mode,setMode]=useState("quarter"); // "quarter" default per investor framing
  const[showSecondary,setShowSecondary]=useState(false);
  const[illustrative,setIllustrative]=useState(false);
  const[diagOpen,setDiagOpen]=useState(false); // diagnostics off by default; the
  // illustrative-data toggle is internal-only and lives inside this disclosure
  // so the customer-facing main view never shows fabricated values.
  const[xlsxState,setXlsxState]=useState("idle"); // idle | working | error

  // Illustrative mode overrides the real fHist entirely. Toggle is
  // quarter-only (no monthly illustrative data), so mode is forced to
  // "quarter" while on. Secondary SKUs (A100/GB200/L40S) aren't included
  // in the illustrative payload — the expand button is hidden while on.
  const illFHist=illustrative?buildIllustrativeFHist():null;
  const effFHist=illustrative?illFHist:fHist;
  const effMode=illustrative?"quarter":mode;

  if(!illustrative && fHistErr){
    return(
      <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"14px 16px",marginBottom:14}}>
        <div style={{...S.lbl,color:"#1d4ed8",marginBottom:6}}>Financial correlation view</div>
        <div style={{fontSize:11,color:"#6b7280"}}>Financial view service temporarily unavailable — operational history below still loads.</div>
      </div>
    );
  }
  if(!illustrative && !fHist){
    return(
      <div style={{marginBottom:14}}>
        <div style={{...S.lbl,color:"#1d4ed8",marginBottom:8}}>Financial correlation view</div>
        <Shimmer rows={3}/>
      </div>
    );
  }

  // Excel export. The daily series is fetched on click rather than on mount —
  // it is the largest payload on the page and most sessions never export.
  // A failed daily fetch degrades to a workbook without the raw sheet rather
  // than failing the whole export.
  const onExportXlsx=async()=>{
    if(xlsxState==="working")return;
    setXlsxState("working");
    try{
      let daily=null;
      try{
        const r=await fetch("/api/gpu-hardware-pricing-history?window=400");
        if(r.ok){
          const j=await r.json();
          if(j&&j.success)daily=j;
        }
      }catch(e){/* raw sheet is optional */}
      const skus=[...GPU_FIN_PRIMARY_ROWS,...GPU_FIN_SECONDARY_ROWS];
      const wb=buildGPUPricingWorkbook(effFHist,daily,skus);
      downloadXlsx(gpuWorkbookFilename(effFHist),buildXlsx(wb));
      setXlsxState("idle");
    }catch(e){
      setXlsxState("error");
      setTimeout(()=>setXlsxState("idle"),4000);
    }
  };

  const since=effFHist.trackingSinceRealDate;
  const periods=effMode==="quarter"?(effFHist.quarterly?.labels||[]):(effFHist.monthly?.labels||[]);
  const series=effMode==="quarter"?(effFHist.quarterly?.series||{}):(effFHist.monthly?.series||{});
  const growth=effMode==="quarter"?(effFHist.quarterly?.qoq||{}):(effFHist.monthly?.mom||{});
  const yoy=effMode==="quarter"?(effFHist.quarterly?.yoy||{}):(effFHist.monthly?.yoy||{});
  const growthLabel=effMode==="quarter"?"QoQ Growth":"MoM Growth";
  const partialKey=effMode==="quarter"?"isQTD":"isMTD";

  const hasAnyData=periods.length>0;
  const rowPoolAll=showSecondary?[...GPU_FIN_PRIMARY_ROWS,...GPU_FIN_SECONDARY_ROWS]:GPU_FIN_PRIMARY_ROWS;
  const growthReasons=effMode==="quarter"?(effFHist.quarterly?.qoqReason||{}):(effFHist.monthly?.momReason||{});

  // Which measure each column is on, and where it changes. Derived from the
  // data on screen, never hard-coded to 2026-07-28, so the next time the
  // source changes shape the matrix explains itself with no code change.
  const basisByPeriod=finBasisByPeriod(series,periods,rowPoolAll);
  const boundaryIdx=finBasisBoundaryIndex(basisByPeriod,periods);
  const hasBasisChange=boundaryIdx>0;
  const basisBoundary=hasBasisChange
    ?{before:periods[boundaryIdx-1],after:periods[boundaryIdx],
      from:basisByPeriod[periods[boundaryIdx-1].period],to:basisByPeriod[periods[boundaryIdx].period]}
    :null;
  // The exact day the source switched, from the API's own timeline.
  const basisChangeDate=(effFHist.priceBasis?.timeline?.changes||[])[0]?.effectiveDate||null;

  // What the price row is actually measuring in the columns on screen.
  const priceBasisNote=(()=>{
    const bases=new Set(Object.values(basisByPeriod).filter(b=>b&&b!=="mixed"));
    if(bases.size===1)return FIN_BASIS_LABEL[[...bases][0]];
    if(bases.size>1)return "the source changed measure mid-history — see the row below each column";
    return "period averages of daily $/hr";
  })();

  const pricedPeriodCount=periods.filter(p=>
    rowPoolAll.some(r=>finHasPrice(finPeriodRec(series,r.sku,p.period)))
  ).length;

  return(
    <div style={{marginBottom:14}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
        <div style={{...S.lbl,color:"#1d4ed8"}}>Financial correlation view</div>
        <div style={{display:"inline-flex",border:"0.5px solid #e5e7eb",borderRadius:6,overflow:"hidden",background:"#fff",opacity:illustrative?0.5:1}}>
          {["quarter","month"].map(v=>{
            const active=effMode===v;
            const disabled=illustrative&&v==="month";
            return(
              <button key={v} onClick={()=>!disabled&&setMode(v)} disabled={disabled}
                title={disabled?"Illustrative data is quarterly-only":undefined}
                style={{fontSize:11,padding:"4px 12px",border:"none",background:active?"#111827":"#fff",color:active?"#fff":"#6b7280",cursor:disabled?"not-allowed":"pointer",fontFamily:"inherit",fontWeight:500,textTransform:"capitalize"}}>
                {v==="quarter"?"Quarter":"Month"}
              </button>
            );
          })}
        </div>
        <span style={{fontSize:10,color:"#9ca3af",flex:1,minWidth:0}}>
          Analyst lens · period averages of daily $/hr · quarter labels = quarter-end month (Mar/Jun/Sep/Dec) · levels are comparable only within one measure
        </span>

        {/* Export. Disabled while the illustrative preview is on — those
            values are fabricated for layout QA, and a spreadsheet is exactly
            the artefact that would outlive the warning banner once it leaves
            the page. */}
        <button onClick={onExportXlsx} disabled={illustrative||xlsxState==="working"}
          title={illustrative
            ? "Disabled while the illustrative preview is on — those values are not live data."
            : "Download every GPU pricing figure as a formatted Excel workbook: $/hr by model, MoM/QoQ/YoY growth, provider counts, daily raw observations and a data-quality sheet."}
          style={{
            display:"inline-flex",alignItems:"center",gap:6,fontSize:11,fontWeight:600,
            padding:"5px 12px",borderRadius:6,fontFamily:"inherit",whiteSpace:"nowrap",
            border:"0.5px solid "+(xlsxState==="error"?"#fca5a5":"#047857"),
            background:illustrative?"#f3f4f6":(xlsxState==="error"?"#fef2f2":"#047857"),
            color:illustrative?"#9ca3af":(xlsxState==="error"?"#b91c1c":"#fff"),
            cursor:illustrative?"not-allowed":(xlsxState==="working"?"progress":"pointer"),
            opacity:xlsxState==="working"?0.75:1,
          }}>
          {xlsxState==="working"
            ? <><Spin size={10} color="#fff"/> Building…</>
            : xlsxState==="error"
              ? "Export failed — retry"
              : <><svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 1v8m0 0L4.8 5.8M8 9l3.2-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 11v2.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                  </svg> Download Excel</>}
        </button>
      </div>

      {/* Illustrative warning banner */}
      {illustrative&&(
        <div style={{background:"#fef3c7",border:"1px solid #fbbf24",borderRadius:8,padding:"10px 12px",marginBottom:8,fontSize:11,color:"#92400e",lineHeight:1.5}}>
          <div style={{fontWeight:700,marginBottom:2,textTransform:"uppercase",letterSpacing:".04em",fontSize:10}}>⚠ Illustrative — design preview only</div>
          Values below are <b style={{fontWeight:600}}>not sourced from live data</b>. This toggle renders a fixed layout preview of what the full matrix will look like once real quarterly history accumulates. No values are written to KV. No real capture is affected. Flip off to return to the real-only investor view.
        </div>
      )}

      {/* Tracking-since caption (real mode only) */}
      {!illustrative&&since&&(
        <div style={{fontSize:11,color:"#9ca3af",marginBottom:8}}>
          Real tracking since <b style={{color:"#6b7280",fontWeight:600}}>{since}</b>
          {" · "}
          {/* "N periods observed" counted every column, including ones with no
              price at all — it read as N periods of pricing. Count the priced
              ones, and name the shortfall when the two differ. */}
          <b style={{color:"#6b7280",fontWeight:600}}>{pricedPeriodCount}</b> of {periods.length} {effMode==="quarter"?"quarter":"month"}{periods.length===1?"":"s"} carry price data
          {" · "}
          growth rows populate once at least two real periods exist; YoY requires a period from one year prior
        </div>
      )}

      {/* Basis-change caption. This is the single most misread thing on the
          page: the step between the two measures looks like a price move, so
          it is stated in plain words directly above the table rather than
          left to a tooltip. Deliberately a neutral caption, not a red alert —
          the data is correct, it just changed units, and an alarm here would
          read to a customer as "this product is broken". */}
      {!illustrative&&hasBasisChange&&basisBoundary&&(
        <div style={{background:"#fffbeb",border:"0.5px solid #fde68a",borderRadius:6,padding:"8px 11px",marginBottom:8,fontSize:11,color:"#92400e",lineHeight:1.55}}>
          <b style={{fontWeight:700}}>The source changed what it publishes{basisChangeDate?" on "+basisChangeDate:""}.</b>{" "}
          Through {basisBoundary.before.label} it gave a per-vendor price range and the figure below is the{" "}
          <b style={{fontWeight:600}}>{FIN_BASIS_LABEL[basisBoundary.from]}</b>; from {basisBoundary.after.label} it publishes a single{" "}
          <b style={{fontWeight:600}}>{FIN_BASIS_LABEL[basisBoundary.to]}</b>. A floor is the cheapest listing of ~50 vendors; a median is the middle one,
          so the step at the dashed line is a change of measure, <b style={{fontWeight:600}}>not a price move</b> — like-for-like, prices have been broadly flat across it.
          Growth is left uncomputed across the change rather than reported.
        </div>
      )}

      {/* Matrix or empty */}
      {!hasAnyData?(
        <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"14px 16px"}}>
          <div style={{fontSize:12,color:"#111827",fontWeight:500}}>Matrix populates as real daily snapshots accumulate</div>
          <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>
            This view will show one column per calendar {effMode==="quarter"?"quarter":"month"} and include QoQ/MoM + YoY growth rows once enough real data exists.
          </div>
        </div>
      ):(
        <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#f9fafb"}}>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",background:"#f3f4f6"}}>
              <thead>
                <tr>
                  <th style={{...finThRow,minWidth:170}}></th>
                  {periods.map((p,ci)=>{
                    // The old badge fired only on isMTD/isQTD, which meant a
                    // 10-day April stub and a fully-captured July rendered
                    // identically. The column now reports what it actually
                    // holds: no capture, captured-but-unpriced, still
                    // running, or thin priced coverage.
                    const rowPool=rowPoolAll;
                    let running=!!p[partialKey];
                    let anyRec=false, anyPriced=false, bestCov=null;
                    for(const row of rowPool){
                      const sr=finPeriodRec(series,row.sku,p.period);
                      if(!sr)continue;
                      anyRec=true;
                      if(sr[partialKey])running=true;
                      if(finHasPrice(sr))anyPriced=true;
                      const c=finPricedCoverage(sr);
                      if(c!=null&&(bestCov==null||c>bestCov))bestCov=c;
                    }
                    let badge=null,badgeColor="#b45309",badgeTitle=null;
                    if(!anyRec){
                      badge="no data";badgeColor="#9ca3af";
                      badgeTitle="No GPU capture recorded for "+p.label+".";
                    }else if(!anyPriced){
                      badge="no price";badgeColor="#b45309";
                      badgeTitle=p.label+" was captured but the feed returned no price, so every price cell is blank.";
                    }else if(running){
                      badge=effMode==="quarter"?"QTD":"MTD";
                      badgeTitle=p.label+" is still in progress — growth and resilience are suppressed for it.";
                    }else if(bestCov!=null&&bestCov<FIN_LOW_COVERAGE){
                      badge=Math.round(bestCov*100)+"%";
                      badgeTitle="Only "+Math.round(bestCov*100)+"% of the days in "+p.label+" carry a price — averages and growth off this period are indicative.";
                    }
                    return(
                      <th key={p.period}
                          style={{...finTh,color:anyRec?finTh.color:"#c7cbd1",...finBoundaryStyle(ci===boundaryIdx)}}
                          title={badgeTitle||undefined}>
                        {p.label}
                        {badge&&<span style={{marginLeft:3,fontSize:8,color:badgeColor,fontWeight:600}}>{badge}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {/* Section A: Pricing per Hour */}
                <tr><td colSpan={periods.length+1} style={finSectionTh}>
                  Pricing per Hour
                  <span style={{fontWeight:500,textDecoration:"none",color:"#6b7280",fontSize:10,marginLeft:6}}>
                    {priceBasisNote} &middot; hover a cell for the detail
                  </span>
                </td></tr>
                {renderFinPriceRows(GPU_FIN_PRIMARY_ROWS,series,periods,partialKey,false,boundaryIdx)}
                {!illustrative&&showSecondary&&renderFinPriceRows(GPU_FIN_SECONDARY_ROWS,series,periods,partialKey,true,boundaryIdx)}
                {/* Only when more than one measure is on screen — otherwise
                    it is a row of identical words. */}
                {!illustrative&&hasBasisChange&&renderFinBasisRow(basisByPeriod,periods,boundaryIdx)}

                {/* Spacer */}
                <tr><td colSpan={periods.length+1} style={{height:8}}></td></tr>

                {/* Section B: QoQ/MoM Growth */}
                <tr><td colSpan={periods.length+1} style={finSectionTh}>{growthLabel}</td></tr>
                {renderFinGrowthRows(GPU_FIN_PRIMARY_ROWS,growth,periods,false,series,partialKey,boundaryIdx,growthReasons)}
                {!illustrative&&showSecondary&&renderFinGrowthRows(GPU_FIN_SECONDARY_ROWS,growth,periods,true,series,partialKey,boundaryIdx,growthReasons)}

                {/* Spacer */}
                <tr><td colSpan={periods.length+1} style={{height:8}}></td></tr>

                {/* Section C: YoY Growth */}
                <tr><td colSpan={periods.length+1} style={finSectionTh}>YoY Growth</td></tr>
                {renderFinGrowthRows(GPU_FIN_PRIMARY_ROWS,yoy,periods,false,series,partialKey,boundaryIdx,null,true)}
                {!illustrative&&showSecondary&&renderFinGrowthRows(GPU_FIN_SECONDARY_ROWS,yoy,periods,true,series,partialKey,boundaryIdx,null,true)}

                {/* Spacer */}
                <tr><td colSpan={periods.length+1} style={{height:8}}></td></tr>

                {/* Section D: Provider Count — vendor breadth observed per (SKU, period).
                   Not rendered in illustrative mode (placeholder values don't carry it). */}
                {!illustrative&&<>
                  <tr><td colSpan={periods.length+1} style={finSectionTh}>Provider Count</td></tr>
                  {renderFinProviderRows(GPU_FIN_PRIMARY_ROWS,series,periods,false,boundaryIdx)}
                  {showSecondary&&renderFinProviderRows(GPU_FIN_SECONDARY_ROWS,series,periods,true,boundaryIdx)}

                  {/* Spacer */}
                  <tr><td colSpan={periods.length+1} style={{height:8}}></td></tr>

                  {/* Section E: Price Resilience Signal — flags where price has
                     held flat or risen across 2 consecutive completed periods.
                     Customer's "for prices not to go down is a big deal" lens —
                     stable older-gen prices imply tight supply / strong ROI. */}
                  <tr><td colSpan={periods.length+1} style={finSectionTh}>Price Resilience Signal</td></tr>
                  {renderFinResilienceRows(GPU_FIN_PRIMARY_ROWS,growth,periods,series,partialKey,false,boundaryIdx)}
                  {showSecondary&&renderFinResilienceRows(GPU_FIN_SECONDARY_ROWS,growth,periods,series,partialKey,true,boundaryIdx)}
                </>}
              </tbody>
            </table>
          </div>

          {/* Show more / Collapse secondary rows — hidden in illustrative mode (no secondary data) */}
          {!illustrative&&(
            <div style={{padding:"6px 10px",borderTop:"0.5px solid #e5e7eb",background:"#fafafa",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
              <span style={{fontSize:10,color:"#9ca3af"}}>
                {showSecondary?"Primary + secondary GPUs":"Primary GPUs (A100 / H100 / H200 / B200 / GB200)"} · tracked basket is fixed at the strategic accelerators captured by the upstream; the full 90+ SKU vendor table lives in Infra Monitoring.
              </span>
              <button onClick={()=>setShowSecondary(s=>!s)}
                style={{fontSize:10,padding:"4px 10px",border:"0.5px solid #d1d5db",borderRadius:4,background:"#fff",color:"#374151",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>
                {showSecondary?"− Hide secondary (L40S)":"+ Show L40S"}
              </button>
            </div>
          )}
          {illustrative&&(
            <div style={{padding:"6px 10px",borderTop:"0.5px solid #e5e7eb",background:"#fffbeb",fontSize:10,color:"#92400e",fontWeight:500}}>
              ⚠ Illustrative mode is on — values are NOT live. Flip off in diagnostics to return to the real-only investor view.
            </div>
          )}
        </div>
      )}

      {/* Methodology footnote — concise, customer-spec wording. */}
      <div style={{fontSize:10,color:"#9ca3af",lineHeight:1.5,marginTop:6}}>
        <b style={{color:"#6b7280",fontWeight:600}}>Methodology:</b> GPU prices are real daily observations averaged by SKU and calendar period — no estimates, no backfill. <b style={{color:"#6b7280",fontWeight:600}}>What the source publishes changed mid-history</b>, so a period carries one of two measures: through {basisChangeDate?"2026-07-27":"the earlier periods"} a per-vendor min–max range, of which the <b style={{color:"#6b7280",fontWeight:600}}>floor</b> (the single cheapest listing among ~50 providers) is shown; from {basisChangeDate||"the later periods"} a single <b style={{color:"#6b7280",fontWeight:600}}>median</b> across providers. The two are different statistics and their levels are not comparable — the floor is volatile and one outlier listing moves it, which is why it sits far below the median. A period that straddles the change takes the measure covering most of its days and averages only those days; its tooltip names the other measure and what it averaged. Growth is computed only between periods sharing a measure and only between completed periods; a period still in progress (QTD/MTD) is suppressed, and a cell spanning the change reads <span style={{color:"#b45309",fontWeight:600}}>measure changed</span> rather than a fabricated percentage. A <sup style={{color:"#b45309",fontWeight:700}}>&deg;</sup> marks a value resting on a period where under {Math.round(FIN_LOW_COVERAGE*100)}% of days carry a price. The column axis is continuous, so a period with no capture stays visible as an empty column. GPU prices are not summed, because there is no meaningful total price across SKUs. Provider count shows observed vendor breadth where available. Stable or rising prices in older GPUs can indicate tight supply or strong ROI.
      </div>
    </div>
  );
}

function IllustrativeToggle({illustrative,setIllustrative}){
  return(
    <label style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:10,color:illustrative?"#92400e":"#6b7280",cursor:"pointer",padding:"3px 8px",borderRadius:12,background:illustrative?"#fef3c7":"#fff",border:"0.5px solid "+(illustrative?"#fbbf24":"#e5e7eb"),fontWeight:500,whiteSpace:"nowrap"}}>
      <span style={{position:"relative",width:24,height:14,background:illustrative?"#f59e0b":"#d1d5db",borderRadius:7,transition:"background 0.15s",flexShrink:0}}>
        <span style={{position:"absolute",top:1,left:illustrative?11:1,width:12,height:12,background:"#fff",borderRadius:"50%",transition:"left 0.15s",boxShadow:"0 1px 2px rgba(0,0,0,0.15)"}}/>
      </span>
      <input type="checkbox" checked={illustrative} onChange={e=>setIllustrative(e.target.checked)} style={{display:"none"}}/>
      <span>Illustrative (design preview)</span>
    </label>
  );
}

// Price cells carry whichever measure the source published for that period —
// the FLOOR of a vendor range through 2026-07-27, the vendor MEDIAN after —
// so every tooltip names its measure first. Without that an H100 reading
// "$0.54" looks like a market rate rather than one outlier listing sitting
// under a $14.90 ceiling, and the step to "$3.34" looks like a price move
// rather than a change of units. A period that straddles the change also
// reports the other measure over its own days, which is the number that
// actually shows the market was flat through the transition.
// Periods built on thin priced coverage get a visible marker.
function renderFinPriceRows(rows,series,periods,partialKey,dim,boundaryIdx){
  return rows.map(row=>{
    const byPeriod=Object.fromEntries((series[row.sku]||[]).map(x=>[x.period,x]));
    return(
      <tr key={"price-"+row.sku}>
        <td style={{...finTdRow,color:dim?"#6b7280":"#111827"}}>{row.shortLabel}</td>
        {periods.map((p,i)=>{
          const s=byPeriod[p.period];
          const val=finPrice(s);
          const basis=finBasis(s);
          const cov=finPricedCoverage(s);
          const thin=val!=null&&cov!=null&&cov<FIN_LOW_COVERAGE;
          const parts=[];
          if(s){
            parts.push((basis==="median"?"Median ":basis==="floor"?"Floor (min) ":"")+fmtMoney(val));
            if(s.avgPriceMidpoint!=null)parts.push("range midpoint "+fmtMoney(s.avgPriceMidpoint));
            if(s.avgMaxPricePerHour!=null)parts.push("ceiling (max) "+fmtMoney(s.avgMaxPricePerHour));
            if(s.avgSpreadMultiple!=null)parts.push("spread "+s.avgSpreadMultiple.toFixed(1)+"x");
            const dp=s.daysWithPriceInMonth!=null?s.daysWithPriceInMonth:s.daysWithPriceInQuarter;
            const dc=s.daysCoveredInMonth!=null?s.daysCoveredInMonth:s.daysCoveredInQuarter;
            const dn=s.monthDayCount!=null?s.monthDayCount:s.quarterDayCount;
            if(dp!=null&&dn!=null)parts.push(dp+" of "+dn+" days priced on this basis"+(dc!=null&&dc!==dp?" ("+dc+" captured)":""));
            // The straddle period: say plainly that some captured days are
            // excluded from the average, and what they averaged to. Silently
            // dropping them is how a 4-day median ends up labelled a month.
            if(s.mixedBasis&&s.alternateBasis&&s.alternatePricePerHour!=null){
              const altDays=s.basisDayCounts?s.basisDayCounts[s.alternateBasis]:null;
              parts.push("the source changed measure inside this period — its "
                +(altDays!=null?altDays+" ":"")+FIN_BASIS_SHORT[s.alternateBasis]
                +" day"+(altDays===1?"":"s")+" averaged "+fmtMoney(s.alternatePricePerHour)
                +" and are excluded from the figure above");
            }
            if(s.basisRemapped)parts.push("price recovered from the feed's max field");
          }else{
            parts.push("No capture for "+p.label);
          }
          return(
            <td key={p.period}
                style={{...finTd,color:dim?"#6b7280":(val==null?"#d1d5db":finTd.color),...finBoundaryStyle(i===boundaryIdx)}}
                title={parts.join(" · ")}>
              {fmtMoney(val)}
              {thin&&<sup style={{color:"#b45309",fontSize:8,fontWeight:700,marginLeft:1}}>&deg;</sup>}
            </td>
          );
        })}
      </tr>
    );
  });
}

/* The basis row. Sits directly under the price rows and states, per column,
   what the number above it measures. This is the row that makes the step
   self-explanatory: a reader scanning left to right sees "floor · floor ·
   floor · floor | median · median" and the dashed rule where it changed,
   instead of an unexplained five-fold jump. Rendered only when more than one
   basis is on screen — when everything is one measure it would be noise. */
function renderFinBasisRow(basisByPeriod,periods,boundaryIdx){
  return(
    <tr key="basis-row">
      <td style={{...finTdRow,color:"#6b7280",fontWeight:600,fontSize:10}}>Measure published</td>
      {periods.map((p,i)=>{
        const b=basisByPeriod[p.period];
        const label=b==="mixed"?"mixed":b?FIN_BASIS_SHORT[b]:"—";
        const known=!!b&&b!=="mixed";
        return(
          <td key={p.period} style={{...finTdDim,fontSize:9,...finBoundaryStyle(i===boundaryIdx)}}
              title={known
                ?p.label+" is measured as the "+FIN_BASIS_LABEL[b]+"."
                :b==="mixed"
                  ?p.label+" contains days measured both ways; each SKU uses whichever measure covers most of its days."
                  :"No price captured for "+p.label+"."}>
            <span style={{color:known?(b==="median"?"#1d4ed8":"#6b7280"):"#d1d5db",fontWeight:600,letterSpacing:".02em"}}>{label}</span>
          </td>
        );
      })}
    </tr>
  );
}

// Growth rows honour the methodology note literally: a period that is still
// running (MTD/QTD) is suppressed rather than compared against a completed
// prior — a half-finished period average is not a period. Comparisons that
// lean on a thinly-priced period on either side still render, but carry a
// marker so nobody reads "+128.7%" as a clean month-over-month move when one
// side of it is a 10-day stub.
function renderFinGrowthRows(rows,growth,periods,dim,series,partialKey,boundaryIdx,reasons,isYoY){
  const priorIdOf=isYoY?finYearPriorPeriodId:finPriorPeriodId;
  const priorNoun=isYoY?"the same period last year":"the prior period";
  return rows.map(row=>{
    const row_g=growth[row.sku]||{};
    const row_r=(reasons&&reasons[row.sku])||{};
    return(
      <tr key={"g-"+row.sku}>
        <td style={{...finTdRow,color:dim?"#6b7280":"#111827"}}>{row.shortLabel}</td>
        {periods.map((p,i)=>{
          const bStyle=finBoundaryStyle(i===boundaryIdx);
          const cur=series?finPeriodRec(series,row.sku,p.period):null;
          if(partialKey&&(p[partialKey]||finIsPartial(cur,partialKey))){
            return(
              <td key={p.period} style={{...finTdDim,...bStyle}}
                  title={"Suppressed — "+p.label+" is still in progress; a part-period average is not comparable to a completed prior period."}>
                <span style={{color:"#d1d5db"}}>&mdash;</span>
              </td>
            );
          }
          const v=row_g[p.period];
          const priorId=priorIdOf(p.period);
          const prior=series&&priorId?finPeriodRec(series,row.sku,priorId):null;
          const curCov=finPricedCoverage(cur), priorCov=finPricedCoverage(prior);
          const thin=v!=null&&((curCov!=null&&curCov<FIN_LOW_COVERAGE)||(priorCov!=null&&priorCov<FIN_LOW_COVERAGE));
          // A blank growth cell and a refused growth cell look the same. The
          // API now says which it is, and the difference matters enormously:
          // "we have no data" versus "these two numbers measure different
          // things and comparing them would invent a price move".
          // Only the first is true here when the comparator is simply absent —
          // an empty cell must not be blamed on a measure change that sits
          // somewhere else entirely.
          const refusal=v==null?row_r[p.period]:null;
          const curBasis=finBasis(cur), priorBasis=finBasis(prior);
          const basisBreak=v==null&&curBasis&&priorBasis&&curBasis!==priorBasis;
          const title=v!=null?(
            "vs "+(priorId||priorNoun)+
            (curBasis?" · both on the "+FIN_BASIS_SHORT[curBasis]+" basis":"")+
            (curCov!=null?" · this period "+Math.round(curCov*100)+"% priced":"")+
            (priorCov!=null?" · "+(isYoY?"year-ago":"prior")+" period "+Math.round(priorCov*100)+"% priced":"")+
            (thin?" · thin coverage on one side — treat as indicative":"")
          ):(refusal
            ||(priorId&&!prior?"No capture for "+priorId+", so there is nothing to compare "+p.label+" against.":undefined));
          return(
            <td key={p.period} style={{...finTdDim,...bStyle}} title={title}>
              {basisBreak
                // Named rather than left as an em-dash: this is the cell the
                // customer's eye lands on when asking "why did it jump?".
                ? <span style={{color:"#b45309",fontSize:9,fontWeight:600,whiteSpace:"nowrap"}}>measure&nbsp;changed</span>
                : <>{fmtGrowth(v)}{thin&&<sup style={{color:"#b45309",fontSize:8,fontWeight:700,marginLeft:1}}>&deg;</sup>}</>}
            </td>
          );
        })}
      </tr>
    );
  });
}

// Provider count per (SKU, period) — integer count of distinct providers
// observed in the period. Comes from the API's avgProviderCount field
// (mean of daily provider counts within the period; rounded for display).
// Customer's "Where are the providers?" lens: lets the operator see vendor
// breadth without cluttering the price cells.
function renderFinProviderRows(rows,series,periods,dim,boundaryIdx){
  const fmtProv=v=>{
    if(v==null||!isFinite(v)||v<=0)return<span style={{color:"#d1d5db"}}>—</span>;
    const n=Math.round(v);
    return <span style={{color:"#374151"}}>{n}</span>;
  };
  return rows.map(row=>{
    const byPeriod=Object.fromEntries((series[row.sku]||[]).map(x=>[x.period,x]));
    return(
      <tr key={"prov-"+row.sku}>
        <td style={{...finTdRow,color:dim?"#6b7280":"#111827"}}>{row.shortLabel}</td>
        {periods.map((p,i)=>{
          const s=byPeriod[p.period];
          return(
            <td key={p.period} style={{...finTdDim,...finBoundaryStyle(i===boundaryIdx)}}
                title={s?Math.round(s.avgProviderCount||0)+" distinct providers observed (avg of daily counts in "+p.label+")":undefined}>
              {fmtProv(s?s.avgProviderCount:null)}
            </td>
          );
        })}
      </tr>
    );
  });
}

// Per-(SKU, period) price resilience signal. For period P it reads the growth
// at P (P vs P-1) and the growth at P-1 (P-1 vs P-2). Both >= 0 means the
// price held or rose across two consecutive completed periods → "Stable/up
// 2Q"/"2M" (green; the investor-side "for prices NOT to go down is a big
// deal" read). Both < 0 is "Falling", and one of each is "Mixed" — grey for
// both, since neither is a resilience signal, but the label no longer claims
// a direction the two readings do not agree on.
//
// Three things this must never do, because each turns a data gap into a
// confident-looking verdict:
//   1. resolve P-1 by array position. The column axis is continuous now, so
//      a stalled feed puts an empty column in the middle of it; stepping
//      back one slot would compare across the hole.
//   2. grade a period whose price coverage is zero. A month with provider
//      counts but no prices has no growth on either side, and must read
//      "no price data", not "Falling".
//   3. grade a still-running period, or one whose two-period look-back leans
//      on a thinly-priced stub, without saying so.
//   4. grade across a change in what the source publishes. The two-period
//      look-back needs three periods measured the same way; spanning the
//      floor→median change would read a units change as a price trend.
function renderFinResilienceRows(rows,growth,periods,series,partialKey,dim,boundaryIdx){
  const blank=(key,title,bStyle)=>(
    <td key={key} style={{...finTdDim,...bStyle}} title={title}><span style={{color:"#d1d5db"}}>&mdash;</span></td>
  );
  return rows.map(row=>{
    const row_g=growth[row.sku]||{};
    return(
      <tr key={"res-"+row.sku}>
        <td style={{...finTdRow,color:dim?"#6b7280":"#111827"}}>{row.shortLabel}</td>
        {periods.map((p,idx)=>{
          const bStyle=finBoundaryStyle(idx===boundaryIdx);
          const cur=finPeriodRec(series,row.sku,p.period);

          // No capture at all for this calendar period.
          if(!cur)return blank(p.period,"No capture recorded for "+p.label+".",bStyle);

          // Captured, but the feed delivered no usable price — provider
          // counts alone cannot produce a resilience read.
          if(!finHasPrice(cur))return blank(p.period,p.label+" was captured but carries no price data, so no resilience signal can be computed.",bStyle);

          // Still running: a part-period average is not comparable.
          if(p[partialKey]||finIsPartial(cur,partialKey))
            return blank(p.period,p.label+" is still in progress.",bStyle);

          const priorId=finPriorPeriodId(p.period);
          const prior=priorId?finPeriodRec(series,row.sku,priorId):null;
          const cqp=row_g[p.period];
          const pqp=priorId?row_g[priorId]:null;

          // A resilience read spans three periods. If any adjacent pair among
          // them was measured differently, the "trend" would be the source
          // changing units, not the price holding.
          const prior2Id=priorId?finPriorPeriodId(priorId):null;
          const prior2=prior2Id?finPeriodRec(series,row.sku,prior2Id):null;
          const chain=[cur,prior,prior2].map(finBasis);
          if(chain[0]&&chain.some(b=>b&&b!==chain[0]))
            return blank(p.period,"Spans a change in what the source publishes ("+chain.filter(Boolean).map(b=>FIN_BASIS_SHORT[b]).join(" vs ")+"), so a two-period trend cannot be read across it.",bStyle);

          if(cqp==null||pqp==null||!isFinite(cqp)||!isFinite(pqp))
            return blank(p.period,"Needs two consecutive completed periods of growth; not available at "+p.label+".",bStyle);

          // "2Q" was hardcoded when this table only had a quarterly view; the
          // monthly view renders the same badges, so the unit follows the axis.
          const span=partialKey==="isQTD"?"2Q":"2M";
          // Three states, not two. The old binary called everything that was
          // not up-twice "Falling", which labelled a rising period as falling
          // whenever the period before it happened to dip — B200 read
          // "Falling" at +2.0% because May was -0.9%. Only both-down is
          // falling; one up one down is mixed.
          const stable=cqp>=0&&pqp>=0;
          const falling=cqp<0&&pqp<0;
          const label=stable?"Stable/up "+span:falling?"Falling "+span:"Mixed";
          const bg=stable?"#ecfdf5":"#f3f4f6";
          const fg=stable?"#047857":"#6b7280";
          const curCov=finPricedCoverage(cur), priorCov=finPricedCoverage(prior);
          const thin=(curCov!=null&&curCov<FIN_LOW_COVERAGE)||(priorCov!=null&&priorCov<FIN_LOW_COVERAGE);
          const title=p.label+" growth "+cqp.toFixed(1)+"% · prior period growth "+pqp.toFixed(1)+"%"
            +(curCov!=null?" · "+Math.round(curCov*100)+"% priced":"")
            +(thin?" · thin coverage on one side — indicative only":"");
          return(
            <td key={p.period} style={{...finTdDim,...bStyle}}>
              <span style={{fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:3,background:bg,color:fg,whiteSpace:"nowrap"}} title={title}>
                {label}{thin&&<sup style={{color:"#b45309",fontSize:8,fontWeight:700,marginLeft:1}}>&deg;</sup>}
              </span>
            </td>
          );
        })}
      </tr>
    );
  });
}

/* ─── GPU History Shell ─────────────────────────────────────
   Segmented Quarter | Daily toggle; Quarter is the investor-facing
   default. Quarter view uses /api/gpu-hardware-pricing-history?view=quarter
   (real-only by default — backfill/synthetic seeds are excluded). Daily
   view remains available as a secondary drill-down. */
function GPUHistoryShell({histView,setHistView,qHist,qHistErr,hist,histErr}){
  return(
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
        <div style={{...S.lbl,color:"#0e7490"}}>GPU Pricing History</div>
        <div style={{display:"inline-flex",border:"0.5px solid #e5e7eb",borderRadius:6,overflow:"hidden",background:"#fff"}}>
          {["quarter","daily"].map(v=>{
            const active=histView===v;
            return(
              <button key={v} onClick={()=>setHistView(v)}
                style={{fontSize:11,padding:"4px 12px",border:"none",background:active?"#111827":"#fff",color:active?"#fff":"#6b7280",cursor:"pointer",fontFamily:"inherit",fontWeight:500,textTransform:"capitalize"}}>
                {v==="quarter"?"Quarter (QoQ)":"Daily"}
              </button>
            );
          })}
        </div>
        <span style={{fontSize:10,color:"#9ca3af"}}>
          Investor lens · daily snapshots aggregated by calendar quarter (Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec UTC)
        </span>
      </div>
      {histView==="quarter"
        ? <GPUQuarterlyBlock qHist={qHist} qHistErr={qHistErr}/>
        : <GPUHistoryBlock hist={hist} histErr={histErr} hideHeader/>
      }
    </div>
  );
}

/* ─── Quarterly GPU Pricing History ─────────────────────────
   QoQ signal cards · quarter comparison table · quarter matrix
   Values default to quarter-CLOSE (the last real snapshot inside the
   quarter). Quarter-average is computed and surfaced separately — it
   never silently replaces close-to-close. Low-coverage quarters (any
   quarter with <25% daily coverage) are flagged in the UI. */
const GPU_QUARTER_QOQ_SKUS=["Nvidia H100","Nvidia H200","Nvidia B200","Nvidia A100"];

function fmtPct(v,digits=1){
  if(v==null||!isFinite(v))return"—";
  return (v>0?"+":"")+v.toFixed(digits)+"%";
}
function fmtNum(v,digits=2){
  if(v==null||!isFinite(v))return"—";
  return (v>0?"+":"")+v.toFixed(digits);
}
function fmtInt(v){
  if(v==null||!isFinite(v))return"—";
  return (v>0?"+":"")+Math.round(v);
}

/* State machine for the quarter section.
   - service_unavailable       → qHistErr
   - loading                   → no response yet
   - empty_no_tracking         → no real snapshots at all
   - insufficient_history_bootstrap  → ≥1 real snapshot but no SKU has qoq.status==="ok"
   - qoq_available             → at least one SKU has a real prior completed quarter
*/
function computeSectionMode(qHist,qHistErr){
  if(qHistErr)return"service_unavailable";
  if(!qHist)return"loading";
  if(!qHist.trackingSinceRealDate)return"empty_no_tracking";
  const qoq=qHist.qoq||{};
  const anyQoQ=Object.values(qoq).some(c=>c&&c.status==="ok");
  return anyQoQ?"qoq_available":"insufficient_history_bootstrap";
}

function nextQuarterId(qid){
  // "2026-Q2" → "2026-Q3"; "2026-Q4" → "2027-Q1"
  const m=/^(\d{4})-Q([1-4])$/.exec(qid||"");
  if(!m)return null;
  const year=parseInt(m[1],10);
  const q=parseInt(m[2],10);
  if(q<4)return year+"-Q"+(q+1);
  return (year+1)+"-Q1";
}

function qtdStatusLabel(q){
  if(!q)return"no data";
  const d=q.daysCoveredInQuarter||0;
  const cov=q.coverageRatioWithinQuarter||0;
  if(d<3)return"early tracking";
  if(cov<0.25)return"low coverage";
  if(cov<0.60)return"building history";
  return"monitoring-grade (not yet QoQ)";
}

function GPUQuarterlyBlock({qHist,qHistErr}){
  const mode=computeSectionMode(qHist,qHistErr);

  if(mode==="service_unavailable"){
    return(
      <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"14px 16px"}}>
        <div style={{fontSize:11,color:"#6b7280"}}>Quarter service temporarily unavailable — live embed below still loads.</div>
      </div>
    );
  }
  if(mode==="loading"){
    return <Shimmer rows={3}/>;
  }
  if(mode==="empty_no_tracking"){
    return(
      <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:12,color:"#111827",fontWeight:500}}>Tracking starts with the next daily capture</div>
        <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>
          Real production snapshots will accumulate here. QTD metrics and QoQ comparisons appear automatically once real data is captured.
        </div>
      </div>
    );
  }

  const since=qHist.trackingSinceRealDate;
  const latest=qHist.latestRealSnapshotDate;
  const quarters=qHist.quartersAvailable||[];
  const series=qHist.series||{};
  const qoq=qHist.qoq||{};
  const signals=qHist.signals||{};
  const trackedSKUs=qHist.trackedSKUs||[];

  // Current quarter per SKU = last element in that SKU's quarter series (real-only).
  const currentQuarterBySku={};
  for(const sku of trackedSKUs){
    const qs=series[sku]||[];
    currentQuarterBySku[sku]=qs[qs.length-1]||null;
  }
  // Section-wide "current quarter" label — derived from whichever SKU has data.
  const anyCurrent=Object.values(currentQuarterBySku).find(q=>q);
  const currentQuarterId=anyCurrent?.quarter||null;
  const firstQoQQuarter=currentQuarterId?nextQuarterId(currentQuarterId):null;
  const currentIsQTD=anyCurrent?.isQTD===true;

  const bootstrap=mode==="insufficient_history_bootstrap";

  return(
    <div>
      {/* Header line — always rendered */}
      <div style={{fontSize:11,color:"#9ca3af",marginBottom:8}}>
        Tracking since <b style={{color:"#6b7280",fontWeight:600}}>{since}</b>
        {latest&&latest!==since&&<> · latest <b style={{color:"#6b7280",fontWeight:600}}>{latest}</b></>}
        {" · "}{quarters.length} quarter{quarters.length===1?"":"s"} observed
        {" · "}<span style={{color:"#6b7280"}}>
          {bootstrap?"QTD build-up · QoQ unlocks at "+(firstQoQQuarter||"next quarter"):"QoQ = quarter-close vs prior-quarter close"}
        </span>
      </div>

      {/* Bootstrap banner + building-history strip (bootstrap mode only) */}
      {bootstrap&&(
        <BootstrapExplainer since={since} currentQuarterId={currentQuarterId} currentQuarter={anyCurrent} firstQoQQuarter={firstQoQQuarter} trackedSKUs={trackedSKUs} currentQuarterBySku={currentQuarterBySku}/>
      )}

      {/* Cards row — QoQ cards in qoq mode, QTD NOW cards in bootstrap mode. */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8,marginBottom:10}}>
        {GPU_QUARTER_QOQ_SKUS.map(sku=>{
          const c=qoq[sku];
          const cur=currentQuarterBySku[sku];
          const short=sku.replace(/^Nvidia\s+/i,"");
          // Per-SKU mode selector: QoQ if this SKU specifically has ok status; QTD if we have current-quarter data; empty otherwise.
          if(c&&c.status==="ok"){
            return <QoQCard key={sku} short={short} c={c} sig={signals[sku]}/>;
          }
          if(cur){
            return <QTDNowCard key={sku} short={short} since={since} cur={cur} firstQoQQuarter={firstQoQQuarter}/>;
          }
          return(
            <div key={sku} style={{background:"#fafafa",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
              <div style={{...S.lbl,color:"#6b7280",fontSize:9}}>{short} · no current data</div>
              <div style={{fontSize:11,color:"#9ca3af",marginTop:4}}>no real snapshot yet</div>
            </div>
          );
        })}
      </div>

      {/* Primary table — switches on section mode */}
      {bootstrap
        ? <CurrentQuarterSnapshotTable trackedSKUs={trackedSKUs} currentQuarterBySku={currentQuarterBySku} firstQoQQuarter={firstQoQQuarter}/>
        : <QoQComparisonTable trackedSKUs={trackedSKUs} qoq={qoq} series={series} signals={signals} currentQuarterBySku={currentQuarterBySku}/>
      }

      {/* Quarter matrix — close min $/hr by SKU × quarter */}
      {quarters.length>=1&&(
        <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#fff",marginBottom:10}}>
          <div style={{padding:"9px 14px",borderBottom:"0.5px solid #f3f4f6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:11,fontWeight:600,color:"#111827"}}>Quarter-close min $/hr · SKU × quarter matrix</span>
            <span style={{fontSize:10,color:"#9ca3af"}}>quarter average shown in parentheses · QTD quarters marked</span>
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{background:"#fafafa"}}>
                  <th style={gpuTh}>GPU</th>
                  {quarters.map(q=>(
                    <th key={q} style={{...gpuTh,textAlign:"right"}}>{q}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trackedSKUs.map(sku=>{
                  const quarterHistory=series[sku]||[];
                  const byQuarter={};
                  for(const q of quarterHistory)byQuarter[q.quarter]=q;
                  return(
                    <tr key={sku} style={{borderTop:"0.5px solid #f3f4f6"}}>
                      <td style={gpuTd}><span style={{fontWeight:600,color:"#111827"}}>{sku}</span></td>
                      {quarters.map(qid=>{
                        const q=byQuarter[qid];
                        if(!q)return <td key={qid} style={{...gpuTd,textAlign:"right",color:"#d1d5db"}}>—</td>;
                        // Basis-aware fields with a fallback to the legacy
                        // floor-only ones. The source stopped publishing a
                        // floor on 2026-07-28, so reading the Min fields
                        // alone renders every quarter after that as a dash
                        // even though prices kept arriving.
                        const close=q.quarterClosePricePerHour!=null?q.quarterClosePricePerHour:q.quarterCloseMinPricePerHour;
                        const avg=q.quarterAveragePricePerHour!=null?q.quarterAveragePricePerHour:q.quarterAverageMinPricePerHour;
                        const basis=q.priceBasis;
                        return(
                          <td key={qid} style={{...gpuTd,textAlign:"right"}}
                              title={basis?"Measured as the "+FIN_BASIS_LABEL[basis]+(q.mixedBasis?" — this quarter also holds days on the other measure, which are excluded":""):undefined}>
                            <div style={{fontWeight:600,color:"#059669"}}>{close!=null?"$"+close.toFixed(2):"—"}{q.isQTD&&<span style={{fontSize:9,color:"#9ca3af",fontWeight:500,marginLeft:3}}>QTD</span>}</div>
                            {avg!=null&&<div style={{fontSize:10,color:"#9ca3af",marginTop:1}}>avg ${avg.toFixed(2)}</div>}
                            {basis&&<div style={{fontSize:9,color:basis==="median"?"#1d4ed8":"#9ca3af",marginTop:1}}>{FIN_BASIS_SHORT[basis]}</div>}
                            {q.lowCoverage&&<div style={{fontSize:9,color:"#b45309",marginTop:1}}>⚠ low coverage</div>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Methodology note */}
      <div style={{fontSize:10,color:"#9ca3af",lineHeight:1.5,marginBottom:4}}>
        <b style={{color:"#6b7280",fontWeight:600}}>Methodology:</b> QoQ uses quarter-close values (last real snapshot in the quarter). Quarter averages are computed across all real snapshots in the quarter and surfaced separately — they do not replace close-to-close. Coverage = distinct real snapshot days / calendar days in the quarter (QTD quarters use elapsed days only). Synthetic/backfill-only validation points are excluded.
      </div>
    </div>
  );
}

function BootstrapExplainer({since,currentQuarterId,currentQuarter,firstQoQQuarter,trackedSKUs,currentQuarterBySku}){
  // Aggregate strip: use the best-covered current-quarter entry to describe progress.
  const qs=trackedSKUs.map(s=>currentQuarterBySku[s]).filter(Boolean);
  const bestCovered=qs.reduce((a,b)=>{
    if(!a)return b;
    if(!b)return a;
    return (b.coverageRatioWithinQuarter||0)>(a.coverageRatioWithinQuarter||0)?b:a;
  },null);
  const daysCovered=bestCovered?bestCovered.daysCoveredInQuarter:0;
  const denom=bestCovered?bestCovered.quarterDayCount:null;
  const coveragePct=bestCovered&&denom?Math.round((daysCovered/denom)*100):0;
  return(
    <>
      <div style={{background:"#ecfeff",border:"0.5px solid #a5f3fc",borderRadius:8,padding:"10px 12px",marginBottom:10,fontSize:11,color:"#155e75",lineHeight:1.5}}>
        <b style={{fontWeight:600}}>Quarter view is live.</b> Real tracking began on <b style={{fontWeight:600}}>{since}</b>, so this section currently shows <b style={{fontWeight:600}}>QTD build-up metrics</b> — real snapshots of close price, provider count, and spread for the in-progress quarter. True QoQ comparisons appear automatically once the first prior quarter completes{firstQoQQuarter?(<> (first QoQ quarter: <b style={{fontWeight:600}}>{firstQoQQuarter}</b>)</>):null}.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:10}}>
        <MiniStat label="Tracking since" value={since||"—"}/>
        <MiniStat label="Current quarter" value={currentQuarterId?(currentQuarterId+(currentQuarter?.isQTD?" (QTD)":"")):"—"}/>
        <MiniStat label="Days captured" value={denom!=null?(daysCovered+" of "+denom):String(daysCovered)}/>
        <MiniStat label="Coverage" value={coveragePct+"%"} warn={coveragePct<25}/>
        <MiniStat label="First QoQ quarter" value={firstQoQQuarter||"—"} sub="QoQ unlocks here"/>
      </div>
    </>
  );
}

/* Quarter close/average on the quarter's OWN measure, falling back to the
   legacy floor-only fields for a payload that predates them. Reading the Min
   fields directly renders every quarter after 2026-07-27 as a dash, because
   that is when the source stopped publishing a floor — the prices kept
   arriving, just as a median. */
function qClose(q){
  if(!q)return null;
  return q.quarterClosePricePerHour!=null?q.quarterClosePricePerHour:q.quarterCloseMinPricePerHour;
}
function qAvg(q){
  if(!q)return null;
  return q.quarterAveragePricePerHour!=null?q.quarterAveragePricePerHour:q.quarterAverageMinPricePerHour;
}

function MiniStat({label,value,sub,warn}){
  return(
    <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
      <div style={{...S.lbl,color:"#6b7280",fontSize:9}}>{label}</div>
      <div style={{fontSize:13,fontWeight:700,color:warn?"#b45309":"#111827",marginTop:3,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:9,color:"#9ca3af",marginTop:2}}>{sub}</div>}
    </div>
  );
}

function QoQCard({short,c,sig}){
  const pct=c.qoqPct;
  const up=pct!=null&&pct>0;
  const down=pct!=null&&pct<0;
  const color=up?"#dc2626":down?"#059669":"#6b7280";
  const arrow=up?"▲":down?"▼":"•";
  const sigBg=sig==="loosening"?"#dcfce7":sig==="tightening"?"#fee2e2":sig==="stable"?"#f3f4f6":"#f3f4f6";
  const sigFg=sig==="loosening"?"#059669":sig==="tightening"?"#dc2626":sig==="stable"?"#6b7280":"#9ca3af";
  const sigLabel=sig==="loosening"?"loosening":sig==="tightening"?"tightening":sig==="stable"?"stable":null;
  // The two closes are printed side by side underneath. Across a change of
  // measure that line reads as a price move all by itself — $0.29 → $3.38 —
  // even with the percentage suppressed, so the card says what happened
  // instead of showing a bare arrow over an unexplained pair.
  const basisChanged=!!c.basisChanged;
  return(
    <div style={{background:"#fff",border:"0.5px solid "+(basisChanged?"#fde68a":"#e5e7eb"),borderRadius:8,padding:"10px 12px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}>
        <div style={{...S.lbl,color:"#6b7280",fontSize:9}}>
          {short} · QoQ {c.currentIsQTD&&<span style={{color:"#9ca3af",fontWeight:500}}>(QTD)</span>}
        </div>
        {sigLabel&&<span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:sigBg,color:sigFg,fontWeight:600,textTransform:"uppercase",letterSpacing:".04em"}}>{sigLabel}</span>}
      </div>
      {basisChanged?(
        <>
          <div style={{fontSize:11,fontWeight:700,color:"#b45309",marginTop:5,lineHeight:1.35}}>
            Measure changed between these quarters
          </div>
          <div style={{fontSize:10,color:"#92400e",marginTop:3,lineHeight:1.45}}>
            {c.priorQuarter} is the {FIN_BASIS_SHORT[c.priorBasis]||c.priorBasis} (${c.priorClose?.toFixed(2)}); {c.currentQuarter} is the {FIN_BASIS_SHORT[c.currentBasis]||c.currentBasis} (${c.currentClose?.toFixed(2)}).
            Different statistics — the gap between them is not a price move, so no QoQ is shown.
          </div>
          {c.providerDelta!=null&&<div style={{fontSize:10,color:"#9ca3af",marginTop:3}}>providers {fmtInt(c.providerDelta)}</div>}
        </>
      ):(
        <>
          <div style={{display:"flex",alignItems:"baseline",gap:6,marginTop:4}}>
            <span style={{fontSize:16,fontWeight:700,color}}>{arrow}&nbsp;{fmtPct(pct)}</span>
            <span style={{fontSize:11,color:"#6b7280"}}>close $/hr{c.currentBasis?" ("+FIN_BASIS_SHORT[c.currentBasis]+")":""}</span>
          </div>
          <div style={{fontSize:10,color:"#9ca3af",marginTop:3}}>
            {c.priorQuarter} ${c.priorClose?.toFixed(2)} → {c.currentQuarter} ${c.currentClose?.toFixed(2)}
            {c.providerDelta!=null&&<> · providers {fmtInt(c.providerDelta)}</>}
          </div>
        </>
      )}
      {c.lowCoverageFlag&&<div style={{fontSize:9,color:"#b45309",marginTop:2}}>⚠ low-coverage quarter — close may be imprecise</div>}
    </div>
  );
}

function QTDNowCard({short,cur,since,firstQoQQuarter}){
  const coveragePct=Math.round((cur.coverageRatioWithinQuarter||0)*100);
  return(
    <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}>
        <div style={{...S.lbl,color:"#0e7490",fontSize:9}}>
          {short} · QTD NOW
          {cur.isQTD&&<span style={{color:"#9ca3af",fontWeight:500,marginLeft:4}}>({cur.quarter})</span>}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"baseline",gap:6,marginTop:4}}>
        <span style={{fontSize:16,fontWeight:700,color:"#059669"}}>{qClose(cur)!=null?"$"+qClose(cur).toFixed(2):"—"}</span>
        <span style={{fontSize:11,color:"#6b7280"}}>close $/hr{cur.priceBasis?" ("+FIN_BASIS_SHORT[cur.priceBasis]+")":""}</span>
      </div>
      <div style={{fontSize:10,color:"#9ca3af",marginTop:3}}>
        avg ${qAvg(cur)!=null?qAvg(cur).toFixed(2):"—"}
        {cur.quarterCloseProviderCount!=null&&<> · {cur.quarterCloseProviderCount} providers</>}
        {cur.quarterCloseSpreadMultiple!=null&&<> · spread {cur.quarterCloseSpreadMultiple.toFixed(1)}×</>}
      </div>
      <div style={{fontSize:10,color:"#9ca3af",marginTop:2}}>
        {cur.daysCoveredInQuarter}d observed · {coveragePct}% coverage
        {cur.lowCoverage&&<span style={{color:"#b45309",marginLeft:4}}>⚠</span>}
      </div>
      <div style={{fontSize:9,color:"#9ca3af",marginTop:4,borderTop:"0.5px dashed #e5e7eb",paddingTop:4}}>
        QoQ available after first completed prior quarter{firstQoQQuarter?(<> · first QoQ: <b style={{fontWeight:600,color:"#6b7280"}}>{firstQoQQuarter}</b></>):null}
      </div>
    </div>
  );
}

function CurrentQuarterSnapshotTable({trackedSKUs,currentQuarterBySku,firstQoQQuarter}){
  return(
    <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#fff",marginBottom:10}}>
      <div style={{padding:"9px 14px",borderBottom:"0.5px solid #f3f4f6",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:600,color:"#111827"}}>Current quarter snapshot (QTD)</span>
        <span style={{fontSize:10,color:"#9ca3af"}}>
          real-only · QoQ comparison unavailable until a prior quarter completes{firstQoQQuarter?" ("+firstQoQQuarter+")":""}
        </span>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:"#fafafa"}}>
              <th style={gpuTh}>GPU</th>
              <th style={{...gpuTh,textAlign:"right"}}>QTD&nbsp;close&nbsp;$/hr</th>
              <th style={{...gpuTh,textAlign:"right"}}>QTD&nbsp;avg&nbsp;$/hr</th>
              <th style={{...gpuTh,textAlign:"right"}}>Providers</th>
              <th style={{...gpuTh,textAlign:"right"}}>Spread×</th>
              <th style={{...gpuTh,textAlign:"right"}}>Days&nbsp;observed</th>
              <th style={gpuTh}>Coverage</th>
              <th style={gpuTh}>Status</th>
            </tr>
          </thead>
          <tbody>
            {trackedSKUs.map(sku=>{
              const cur=currentQuarterBySku[sku];
              if(!cur){
                return(
                  <tr key={sku} style={{borderTop:"0.5px solid #f3f4f6"}}>
                    <td style={gpuTd}><span style={{fontWeight:600,color:"#111827"}}>{sku}</span></td>
                    <td colSpan="7" style={{...gpuTd,color:"#9ca3af"}}>no real snapshot yet</td>
                  </tr>
                );
              }
              const coveragePct=Math.round((cur.coverageRatioWithinQuarter||0)*100);
              const status=qtdStatusLabel(cur);
              const statusColor=status==="early tracking"?"#6b7280":status==="low coverage"?"#b45309":status==="building history"?"#0e7490":"#059669";
              return(
                <tr key={sku} style={{borderTop:"0.5px solid #f3f4f6"}}>
                  <td style={gpuTd}>
                    <div style={{fontWeight:600,color:"#111827"}}>{sku}</div>
                    <div style={{fontSize:10,color:"#9ca3af",marginTop:1}}>{cur.quarter}{cur.isQTD?" · QTD":""}</div>
                  </td>
                  <td style={{...gpuTd,textAlign:"right",color:"#059669",fontWeight:600}}
                      title={cur.priceBasis?"Measured as the "+FIN_BASIS_LABEL[cur.priceBasis]:undefined}>
                    {qClose(cur)!=null?"$"+qClose(cur).toFixed(2):"—"}
                    {cur.priceBasis&&<div style={{fontSize:9,fontWeight:500,color:cur.priceBasis==="median"?"#1d4ed8":"#9ca3af"}}>{FIN_BASIS_SHORT[cur.priceBasis]}</div>}
                  </td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>
                    {qAvg(cur)!=null?"$"+qAvg(cur).toFixed(2):"—"}
                  </td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{cur.quarterCloseProviderCount??"—"}</td>
                  <td style={{...gpuTd,textAlign:"right",color:"#6b7280"}}>{cur.quarterCloseSpreadMultiple!=null?cur.quarterCloseSpreadMultiple.toFixed(1)+"×":"—"}</td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{cur.daysCoveredInQuarter}</td>
                  <td style={{...gpuTd,color:"#6b7280",fontSize:11}}>
                    {coveragePct}% of {cur.quarterDayCount}d
                    {cur.lowCoverage&&<span style={{color:"#b45309",marginLeft:4}}>⚠</span>}
                  </td>
                  <td style={{...gpuTd,color:statusColor,fontWeight:600,fontSize:11}}>{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QoQComparisonTable({trackedSKUs,qoq,series,signals,currentQuarterBySku}){
  return(
    <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#fff",marginBottom:10}}>
      <div style={{padding:"9px 14px",borderBottom:"0.5px solid #f3f4f6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:11,fontWeight:600,color:"#111827"}}>Quarter-close comparison (prior vs current)</span>
        <span style={{fontSize:10,color:"#9ca3af"}}>current = last real snapshot in quarter (QTD if in progress)</span>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:"#fafafa"}}>
              <th style={gpuTh}>GPU</th>
              <th style={{...gpuTh,textAlign:"right"}}>Prior&nbsp;close&nbsp;$/hr</th>
              <th style={{...gpuTh,textAlign:"right"}}>Current&nbsp;close&nbsp;$/hr</th>
              <th style={{...gpuTh,textAlign:"right"}}>QoQ&nbsp;Δ</th>
              <th style={{...gpuTh,textAlign:"right"}}>Prior&nbsp;providers</th>
              <th style={{...gpuTh,textAlign:"right"}}>Current&nbsp;providers</th>
              <th style={{...gpuTh,textAlign:"right"}}>QoQ&nbsp;Δ&nbsp;providers</th>
              <th style={{...gpuTh,textAlign:"right"}}>Prior&nbsp;spread×</th>
              <th style={{...gpuTh,textAlign:"right"}}>Current&nbsp;spread×</th>
              <th style={{...gpuTh,textAlign:"right"}}>QoQ&nbsp;Δ&nbsp;spread</th>
              <th style={gpuTh}>Coverage</th>
              <th style={gpuTh}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {trackedSKUs.map(sku=>{
              const c=qoq[sku];
              const cur=currentQuarterBySku[sku];
              const coverageText=cur?(Math.round((cur.coverageRatioWithinQuarter||0)*100)+"% of "+cur.quarterDayCount+"d"):"—";
              const trendLabel=(()=>{
                const sig=signals[sku];
                if(!sig||sig==="insufficient-data")return <span style={{color:"#9ca3af"}}>QTD only</span>;
                const color=sig==="loosening"?"#059669":sig==="tightening"?"#dc2626":"#6b7280";
                return <span style={{color,fontWeight:600,textTransform:"capitalize"}}>{sig}</span>;
              })();
              return(
                <tr key={sku} style={{borderTop:"0.5px solid #f3f4f6"}}>
                  <td style={gpuTd}><span style={{fontWeight:600,color:"#111827"}}>{sku}</span></td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{c?.priorClose!=null?"$"+c.priorClose.toFixed(2):"—"}</td>
                  <td style={{...gpuTd,textAlign:"right",color:"#059669",fontWeight:600}}>
                    {c?.currentClose!=null?"$"+c.currentClose.toFixed(2):(qClose(cur)!=null?"$"+qClose(cur).toFixed(2):"—")}
                    {(c?.currentIsQTD||cur?.isQTD)&&<span style={{fontSize:9,color:"#9ca3af",fontWeight:500,marginLeft:3}}>QTD</span>}
                  </td>
                  <td style={{...gpuTd,textAlign:"right"}}><QoQCell v={c?.qoqPct} suffix="%"/></td>
                  <td style={{...gpuTd,textAlign:"right",color:"#6b7280"}}>{c?.priorProviders??"—"}</td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{c?.currentProviders??cur?.quarterCloseProviderCount??"—"}</td>
                  <td style={{...gpuTd,textAlign:"right"}}><QoQCell v={c?.providerDelta} integer/></td>
                  <td style={{...gpuTd,textAlign:"right",color:"#6b7280"}}>{c?.priorSpread!=null?c.priorSpread.toFixed(1)+"×":"—"}</td>
                  <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{c?.currentSpread!=null?c.currentSpread.toFixed(1)+"×":cur?.quarterCloseSpreadMultiple!=null?cur.quarterCloseSpreadMultiple.toFixed(1)+"×":"—"}</td>
                  <td style={{...gpuTd,textAlign:"right"}}><QoQCell v={c?.spreadDelta}/></td>
                  <td style={{...gpuTd,color:"#6b7280",fontSize:11}}>
                    {coverageText}
                    {cur?.lowCoverage&&<span style={{color:"#b45309",marginLeft:4}}>⚠</span>}
                  </td>
                  <td style={{...gpuTd}}>{trendLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QoQCell({v,suffix,integer}){
  if(v==null||!isFinite(v))return <span style={{color:"#9ca3af"}}>—</span>;
  const up=v>0;
  const down=v<0;
  const color=up?"#dc2626":down?"#059669":"#6b7280";
  const formatted=integer?fmtInt(v):(v>0?"+":"")+v.toFixed(suffix==="%"?1:2);
  return <span style={{color,fontWeight:600}}>{formatted}{suffix||""}</span>;
}

/* ─── GPU History Block (daily) ─────────────────────────────
   Trend cards + history comparison table + sparklines
   Reads /api/gpu-hardware-pricing-history (layers on top of the
   canonical day:YYYY-MM-DD snapshots written by /api/history-capture
   and /api/gpu-hardware-pricing-history-refresh). */
const GPU_HISTORY_TREND_SKUS=["Nvidia H100","Nvidia H200","Nvidia B200","Nvidia A100"];

function GPUHistoryBlock({hist,histErr,hideHeader}){
  // Hard-failure fallback — history service down, but we keep the rest of the tab alive.
  if(histErr){
    return(
      <div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:8,padding:"14px 16px"}}>
        {!hideHeader&&<div style={{...S.lbl,color:"#0e7490",marginBottom:6}}>GPU Pricing History</div>}
        <div style={{fontSize:11,color:"#6b7280"}}>History service temporarily unavailable — live embed below still loads.</div>
      </div>
    );
  }
  // Loading skeleton
  if(!hist){
    return(
      <div>
        {!hideHeader&&<div style={{...S.lbl,color:"#0e7490",marginBottom:8}}>GPU Pricing History</div>}
        <Shimmer rows={3}/>
      </div>
    );
  }

  const since=hist.trackingSinceDate;
  const latest=hist.latestDate;
  const days=hist.daysWithGPU||0;
  const d7=hist.comparisons?.d7||{};
  const d30=hist.comparisons?.d30||{};
  const signals=hist.signals||{};
  const series=hist.series||{};
  const latestBySku=hist.latest||{};
  const trackedSKUs=hist.trackedSKUs||[];

  // Empty-state: index exists but no snapshots had a gpu block yet.
  if(!days){
    return(
      <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"14px 16px"}}>
        {!hideHeader&&<div style={{...S.lbl,color:"#0e7490",marginBottom:6}}>GPU Pricing History</div>}
        <div style={{fontSize:12,color:"#111827",fontWeight:500}}>Tracking starts with the next daily capture</div>
        <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>
          Daily snapshots of strategic GPU pricing will accumulate here. 7D and 30D comparisons become available once enough history is captured.
        </div>
      </div>
    );
  }

  return(
    <div>
      {/* Header — suppressed when rendered inside the history shell */}
      {!hideHeader&&(
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:6}}>
          <div>
            <div style={{...S.lbl,color:"#0e7490"}}>GPU Pricing History</div>
            <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>
              Tracking since <b style={{color:"#6b7280",fontWeight:600}}>{since||"—"}</b>
              {latest&&since&&latest!==since&&<> · latest <b style={{color:"#6b7280",fontWeight:600}}>{latest}</b></>}
              {" · "}{days} snapshot{days===1?"":"s"} captured
            </div>
          </div>
        </div>
      )}
      {hideHeader&&(
        <div style={{fontSize:11,color:"#9ca3af",marginBottom:8}}>
          Raw daily view · tracking since <b style={{color:"#6b7280",fontWeight:600}}>{since||"—"}</b>
          {latest&&since&&latest!==since&&<> · latest <b style={{color:"#6b7280",fontWeight:600}}>{latest}</b></>}
          {" · "}{days} real snapshot{days===1?"":"s"}
        </div>
      )}

      {/* Trend cards — 7D change in cheapest $/hr per strategic SKU */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:8,marginBottom:10}}>
        {GPU_HISTORY_TREND_SKUS.map(sku=>{
          const c=d7[sku];
          const latestPt=latestBySku[sku];
          const short=sku.replace(/^Nvidia\s+/i,"");
          if(!c||c.status!=="ok"){
            return(
              <div key={sku} style={{background:"#fafafa",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
                <div style={{...S.lbl,color:"#6b7280",fontSize:9}}>{short} · 7D change</div>
                <div style={{fontSize:12,fontWeight:600,color:"#9ca3af",marginTop:4}}>not enough data yet</div>
                <div style={{fontSize:10,color:"#9ca3af",marginTop:2}}>tracking since {since}</div>
              </div>
            );
          }
          const pct=c.minDeltaPct;
          const providerDelta=c.providerDelta;
          const up=pct!=null&&pct>0;
          const down=pct!=null&&pct<0;
          const color=up?"#dc2626":down?"#059669":"#6b7280";
          const arrow=up?"▲":down?"▼":"•";
          const sig=signals[sku];
          const sigLabel=sig==="loosening"?"loosening":sig==="tightening"?"tightening":sig==="stable"?"stable":null;
          const sigBg=sig==="loosening"?"#dcfce7":sig==="tightening"?"#fee2e2":sig==="stable"?"#f3f4f6":"#f3f4f6";
          const sigFg=sig==="loosening"?"#059669":sig==="tightening"?"#dc2626":sig==="stable"?"#6b7280":"#9ca3af";
          return(
            <div key={sku} style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}>
                <div style={{...S.lbl,color:"#6b7280",fontSize:9}}>{short} · 7D change</div>
                {sigLabel&&<span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:sigBg,color:sigFg,fontWeight:600,textTransform:"uppercase",letterSpacing:".04em"}}>{sigLabel}</span>}
              </div>
              <div style={{display:"flex",alignItems:"baseline",gap:6,marginTop:4}}>
                <span style={{fontSize:16,fontWeight:700,color}}>{arrow}&nbsp;{pct==null?"—":(pct>0?"+":"")+pct.toFixed(1)+"%"}</span>
                <span style={{fontSize:11,color:"#6b7280"}}>min $/hr</span>
              </div>
              <div style={{fontSize:10,color:"#9ca3af",marginTop:3}}>
                {latestPt?.minPricePerHour!=null?"now $"+latestPt.minPricePerHour.toFixed(2):"—"}
                {providerDelta!=null&&<> · providers {providerDelta>0?"+":""}{providerDelta}</>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Strategic history comparison table */}
      <div style={{border:"0.5px solid #e5e7eb",borderRadius:8,overflow:"hidden",background:"#fff",marginBottom:10}}>
        <div style={{padding:"9px 14px",borderBottom:"0.5px solid #f3f4f6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:11,fontWeight:600,color:"#111827"}}>Strategic SKU history</span>
          <span style={{fontSize:10,color:"#9ca3af"}}>latest vs 7D / 30D prior · loosening = more providers or lower floor</span>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr style={{background:"#fafafa"}}>
                <th style={gpuTh}>GPU</th>
                <th style={{...gpuTh,textAlign:"right"}}>Latest&nbsp;min&nbsp;$/hr</th>
                <th style={{...gpuTh,textAlign:"right"}}>7D&nbsp;Δ</th>
                <th style={{...gpuTh,textAlign:"right"}}>30D&nbsp;Δ</th>
                <th style={{...gpuTh,textAlign:"right"}}>Providers</th>
                <th style={{...gpuTh,textAlign:"right"}}>7D&nbsp;Δ&nbsp;providers</th>
                <th style={{...gpuTh,textAlign:"right"}}>Spread×</th>
                <th style={{...gpuTh,textAlign:"right"}}>Trend (60d)</th>
                <th style={gpuTh}>Tracking since</th>
              </tr>
            </thead>
            <tbody>
              {trackedSKUs.map(sku=>{
                const pts=series[sku]||[];
                const latestPt=latestBySku[sku];
                const c7=d7[sku];
                const c30=d30[sku];
                const firstDate=pts[0]?.date||null;
                return(
                  <tr key={sku} style={{borderTop:"0.5px solid #f3f4f6"}}>
                    <td style={gpuTd}><span style={{fontWeight:600,color:"#111827"}}>{sku}</span></td>
                    <td style={{...gpuTd,textAlign:"right",color:"#059669",fontWeight:600}}>{latestPt?.minPricePerHour!=null?"$"+latestPt.minPricePerHour.toFixed(2):"—"}</td>
                    <td style={{...gpuTd,textAlign:"right"}}><DeltaCell c={c7} field="minDeltaPct" suffix="%"/></td>
                    <td style={{...gpuTd,textAlign:"right"}}><DeltaCell c={c30} field="minDeltaPct" suffix="%"/></td>
                    <td style={{...gpuTd,textAlign:"right",color:"#374151"}}>{latestPt?.providerCount??"—"}</td>
                    <td style={{...gpuTd,textAlign:"right"}}><DeltaCell c={c7} field="providerDelta" suffix="" integer/></td>
                    <td style={{...gpuTd,textAlign:"right",color:"#6b7280"}}>{latestPt?.spreadMultiple?latestPt.spreadMultiple.toFixed(1)+"×":"—"}</td>
                    <td style={{...gpuTd,textAlign:"right"}}><Sparkline pts={pts}/></td>
                    <td style={{...gpuTd,color:"#9ca3af",fontSize:11}}>{firstDate||"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Textual signal summary — only show when data-grounded */}
      {(() => {
        const msgs=[];
        for(const sku of GPU_HISTORY_TREND_SKUS){
          const c=d7[sku];
          const sig=signals[sku];
          if(!c||c.status!=="ok"||!sig||sig==="insufficient-data")continue;
          const short=sku.replace(/^Nvidia\s+/i,"");
          if(sig==="loosening"){
            const parts=[];
            if(c.minDeltaPct!=null&&c.minDeltaPct<=-2)parts.push("min "+c.minDeltaPct.toFixed(1)+"%");
            if(c.providerDelta!=null&&c.providerDelta>0)parts.push("+"+c.providerDelta+" providers");
            if(parts.length)msgs.push(short+" loosening ("+parts.join(" · ")+")");
          } else if(sig==="tightening"){
            const parts=[];
            if(c.minDeltaPct!=null&&c.minDeltaPct>=2)parts.push("min +"+c.minDeltaPct.toFixed(1)+"%");
            if(c.providerDelta!=null&&c.providerDelta<0)parts.push(c.providerDelta+" providers");
            if(parts.length)msgs.push(short+" tightening ("+parts.join(" · ")+")");
          }
        }
        if(!msgs.length)return null;
        return(
          <div style={{background:"#fef3c7",border:"0.5px solid #fde68a",borderRadius:6,padding:"8px 12px",fontSize:11,color:"#92400e",marginBottom:6}}>
            <b style={{fontWeight:600}}>Signal (7D):</b> {msgs.join(" · ")}
          </div>
        );
      })()}
    </div>
  );
}

function DeltaCell({c,field,suffix,integer}){
  if(!c||c.status!=="ok"||c[field]==null){
    return <span style={{color:"#9ca3af"}}>—</span>;
  }
  const v=c[field];
  const up=v>0;
  const down=v<0;
  const color=up?"#dc2626":down?"#059669":"#6b7280";
  const formatted=integer?(v>0?"+":"")+v:(v>0?"+":"")+v.toFixed(1);
  return <span style={{color,fontWeight:600}}>{formatted}{suffix}</span>;
}

function Sparkline({pts,w=80,h=22}){
  if(!pts||pts.length<2)return <span style={{color:"#d1d5db",fontSize:10}}>—</span>;
  const vals=pts.map(p=>p.minPricePerHour).filter(v=>typeof v==="number");
  if(vals.length<2)return <span style={{color:"#d1d5db",fontSize:10}}>—</span>;
  const min=Math.min.apply(null,vals);
  const max=Math.max.apply(null,vals);
  const range=max-min||1;
  const pad=2;
  const step=vals.length>1?(w-pad*2)/(vals.length-1):0;
  const points=vals.map((v,i)=>{
    const x=pad+i*step;
    const y=pad+(h-pad*2)*(1-(v-min)/range);
    return x.toFixed(1)+","+y.toFixed(1);
  }).join(" ");
  const lastV=vals[vals.length-1];
  const firstV=vals[0];
  const trendColor=lastV>firstV?"#dc2626":lastV<firstV?"#059669":"#6b7280";
  return(
    <svg width={w} height={h} style={{display:"inline-block",verticalAlign:"middle"}}>
      <polyline points={points} fill="none" stroke={trendColor} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════
   EMBEDDED: OpenRouter Live Rankings — native "Top Models"
   weekly stacked-bar chart, fed by /api/openrouter-chart-weekly.
═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   TAB: Pricing History

   Hand-written shell, like App() below, holding two pieces that already
   existed but had no tab of their own:

     - ModelPricingHistoryBlock ("Quarterly Model Pricing by Company"), moved
       off the Model Pricing tab where it sat between the share signal and the
       live embed. The block itself is untouched: it takes no props, owns its
       fetch and its state, and renders exactly as it did there.

     - PPTHistoryIframe, the Open Router Pricing History embed, copied from
       google-dash js/dashboard.jsx lines 4950-4970 with its render wrapper
       from 5168-5177. In google-dash that wrapper sits on the AI Adoption tab,
       which this dashboard does not carry — which is why the original split
       left the embed behind although its proxy came across. Only the wrapper's
       indentation changed, to match this shell's nesting.

   The embed reverse-proxies pricepertoken.com/pricing-history through
   /api/pricepertoken-history-proxy, which rewrites the page's API base to
   /ppt-api. functions/ppt-api/[[path]].js therefore ships with it: without
   that route the frame loads a 200 document whose every data call 404s, and
   the proxy's error suppression means nothing visible reports the failure.

   Two height mechanisms drive the frame — PPTHistoryIframe's own listener and
   the inline one in index.html. Both compute the same value, and google-dash
   ships both; the duplication is carried over rather than tidied away.
═══════════════════════════════════════════════════════ */
function PPTHistoryIframe(){
  const [h,setH]=useState(920);
  const bucket=useEmbedBucket();
  useEffect(()=>{
    function onMsg(e){
      const d=e&&e.data;
      if(d&&d.__ppt==="history-height"&&typeof d.height==="number"){
        setH(Math.max(300,Math.ceil(d.height)));
      }
    }
    window.addEventListener("message",onMsg);
    return()=>window.removeEventListener("message",onMsg);
  },[]);
  return(
    <iframe
      src={"/api/pricepertoken-history-proxy?v="+bucket}
      title="Open Router Pricing History"
      loading="lazy"
      style={{border:0,display:"block",width:"100%",height:h,transition:"height .2s ease"}}
    />
  );
}

function PricingHistoryTab(){
  return(
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <Pill text="Pricing History · quarterly by company + pricepertoken.com history" bg="#ecfeff" color="#0e7490"/>
        </div>
      </div>

      <ModelPricingHistoryBlock/>

      {/* PricePerToken — Open Router Pricing History embed */}
      <div style={{marginTop:20,marginBottom:20}}>
        <div style={{...S.lbl,marginBottom:8}}>Open Router Pricing History</div>
        <div style={{borderRadius:8,overflow:"hidden",border:"0.5px solid #e5e7eb",background:"#fff"}}>
          <PPTHistoryIframe/>
        </div>
        <div style={{fontSize:10,color:"#9ca3af",marginTop:5}}>
          Source: pricepertoken.com/pricing-history · reverse-proxied
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   ROOT

   This function and PricingHistoryTab above are the hand-written parts of this
   file. Everything else is a byte-for-byte copy of ceekay-munshot/google-dash
   @ 863c950: its js/dashboard.jsx lines 1-208 and 270-3555, which occupy lines
   1-208 and 209-3504 here, plus PPTHistoryIframe from its lines 4950-4970 — a
   second, out-of-range splice taken so the pricing-history embed could come
   across with the block it belongs to. Nothing was refactored, reformatted or
   "improved": the pricing tabs must render identically in both dashboards,
   because they read the same KV store through the same endpoints. If a section
   looks wrong here, it most likely looks the same way in google-dash, and the
   fix belongs there first.

   Known exception: the Price Resilience badge wording and this header's
   fetched-at label were fixed here first. README.md's divergence section
   records what has moved out of parity and why.

   google-dash's App() carried seven tabs plus an Alphabet-specific KPI strip,
   the OpenRouterLiveEmbed hero and OpenRouterProviderRollupChart. Those belong
   to its AI Adoption story, not to price tracking, so this shell drops them and
   keeps Model Pricing, GPU Hardware Pricing and Pricing History. The header
   markup, tab button styles, S.card wrapper and footer styling are otherwise
   unchanged — only the title text, the tab list and the footer source line
   differ.
═══════════════════════════════════════════════════════ */
// LIVE.fetchedAt is a build-time literal ("Apr 11 2026 · 17:45 UTC") baked in
// when this dashboard was split out of google-dash. Every tab fetches its own
// data live on mount, so that string was stale for every visitor from the day
// it was written. This reports when those fetches actually ran — the same
// clock reading refreshAll already writes when you press Refresh all.
function nowUtcLabel(){
  const d=new Date();
  const datePart=d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
  const timePart=String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0")+":"+String(d.getUTCSeconds()).padStart(2,"0");
  return datePart+" · "+timePart+" UTC";
}

export default function App(){
  const[tab,setTab]=useState("pricing");
  const[fetchedAtLabel,setFetchedAtLabel]=useState(nowUtcLabel);
  const[refreshTick,setRefreshTick]=useState(0);

  // See AUTO-REFRESH. lastRefresh is the single clock both triggers read, so
  // coming back to the page and the timer can never double-fire.
  const[ticks,setTicks]=useState({dataTick:0,embedTick:0});
  const lastRefresh=useRef(Date.now());
  useEffect(()=>{
    const refresh=(withEmbeds)=>{
      lastRefresh.current=Date.now();
      setTicks(t=>({dataTick:t.dataTick+1,embedTick:withEmbeds?t.embedTick+1:t.embedTick}));
      setFetchedAtLabel(nowUtcLabel());
    };
    const due=()=>Date.now()-lastRefresh.current>=REFRESH_EVERY_MS;
    // Checked every minute rather than one ten-minute setInterval, so a page
    // that slept (laptop lid, throttled background tab) catches up promptly.
    const timer=setInterval(()=>{
      if(document.visibilityState==="visible"&&due())refresh(false);
    },60*1000);
    // Returning to a page that sat hidden: the reader was not looking, so this
    // is the one moment the embeds may reload too.
    const onVisible=()=>{
      if(document.visibilityState==="visible"&&due())refresh(true);
    };
    document.addEventListener("visibilitychange",onVisible);
    return()=>{clearInterval(timer);document.removeEventListener("visibilitychange",onVisible);};
  },[]);

  const[allPressed,setAllPressed]=useState(false);
  // google-dash computed anyBusy from the OpenRouter / Radar / Trends usePanel
  // panels that its header owned. This dashboard has no shared usePanel panels:
  // ModelPricingTab and GPUHardwarePricingTab each own their fetches, and
  // /api/radar and /api/trends are not deployed here. There is therefore no
  // shared busy state to read, so the button never enters its waiting style.
  const anyBusy=false;

  function refreshAll(){
    setAllPressed(true);
    setTimeout(()=>setAllPressed(false),180);
    setFetchedAtLabel(nowUtcLabel());
    // The tabs manage their own fetches, so there is no panel refresher to call.
    // Bumping the tick changes the React key on the active tab, which remounts
    // it and re-runs every fetch that tab owns — the same effect the panel
    // refreshers had in google-dash, reached a different way.
    setRefreshTick(t=>t+1);
    lastRefresh.current=Date.now(); // a manual refresh resets the auto-refresh clock
  }

  const TABS=[
    {id:"pricing", label:"Model Pricing"},
    {id:"gpu",     label:"GPU Hardware Pricing"},
    {id:"history", label:"Pricing History"},
  ];

  return(
    <div style={{fontFamily:"system-ui,sans-serif",background:"#f5f5f3",padding:16}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div>
          <div style={{fontSize:15,fontWeight:600,color:"#111827"}}>AI Compute Pricing</div>
          <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>
            Last refreshed {fetchedAtLabel} · updates automatically
          </div>
        </div>
        <button onClick={refreshAll} disabled={anyBusy}
          style={{fontSize:12,padding:"8px 16px",border:"none",borderRadius:8,background:anyBusy?"#374151":"#111827",color:"#fff",cursor:anyBusy?"wait":"pointer",fontFamily:"inherit",fontWeight:500,display:"inline-flex",alignItems:"center",gap:8,transform:allPressed?"scale(0.96)":"scale(1)",opacity:anyBusy?0.9:1,transition:"transform .12s ease, background .18s, opacity .18s"}}>
          {anyBusy?(<><Spin size={11} color="#fff"/> Refreshing…</>):"↻  Refresh all"}
        </button>
      </div>

      {/* Tab bar */}
      <div style={{display:"flex",gap:4,marginBottom:12}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{fontSize:12,padding:"7px 18px",border:"0.5px solid "+(tab===t.id?"#111827":"#e5e7eb"),borderRadius:8,background:tab===t.id?"#111827":"#fff",color:tab===t.id?"#fff":"#374151",cursor:"pointer",fontFamily:"inherit",fontWeight:500,display:"inline-flex",alignItems:"center",gap:6}}>
            {t.label}
            {t.panel?.busy&&<Spin size={10} color={tab===t.id?"#fff":"#3b82f6"}/>}
          </button>
        ))}
      </div>

      {/* Active tab */}
      <DataRefreshContext.Provider value={ticks}>
      <div style={S.card}>
        {tab==="pricing"&&<ModelPricingTab key={"pricing-"+refreshTick}/>}
        {tab==="gpu"&&<GPUHardwarePricingTab key={"gpu-"+refreshTick}/>}
        {/* Keyed like the other two, so Refresh all remounts it and
            ModelPricingHistoryBlock re-runs its build-hash-keyed fetch. The
            cost is that the embed's measured height resets to its 920 default
            on refresh; the proxy re-posts height on load and at 500/1500/3000ms
            (functions/api/pricepertoken-history-proxy.js), so it regrows within
            a few seconds. google-dash never remounts it — it keys no tab. */}
        {tab==="history"&&<PricingHistoryTab key={"history-"+refreshTick}/>}
      </div>
      </DataRefreshContext.Provider>

      {/* Footer */}
      <div style={{marginTop:10,fontSize:10,color:"#9ca3af",textAlign:"center"}}>
        pricepertoken.com · openrouter.ai · getdeploying.com
      </div>

    </div>
  );
}
