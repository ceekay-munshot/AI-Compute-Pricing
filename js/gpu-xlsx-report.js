/**
 * Builds the GPU pricing workbook spec consumed by js/xlsx-export.js.
 *
 * Two things the customer asked to be able to take away:
 *   1. $ pricing for each GPU model, per period
 *   2. $ GPU rental per hour with MoM and QoQ growth
 * …plus "all the data you have", so the workbook also carries the range
 * midpoint and ceiling behind each floor price, provider breadth, spread,
 * YoY, the resilience signal, the full daily series, and a data-quality
 * sheet that states exactly which periods are thin or empty and why.
 *
 * Growth is written as a REAL FRACTION with a 0.0% number format rather than
 * a pre-formatted string, so the cells stay arithmetic in Excel. Colour
 * follows the dashboard's buyer-side convention (a price rise is red, a fall
 * is green); the Read me sheet says so, because the opposite convention is
 * equally defensible from the seller side and a silent choice would mislead.
 */
import {XS,colLetter} from "./xlsx-export.js";

const H  =v=>({v,s:XS.header});
const HL =v=>({v,s:XS.headerLeft});
const LBL=v=>({v,s:XS.rowLabel});
const TXT=v=>({v,s:XS.text});
const NOTE=v=>({v,s:XS.note});
const DIM=v=>({v,s:XS.mutedLeft});

function money(v){return v==null||!isFinite(v)?{v:null,s:XS.muted}:{v:+v,s:XS.money4};}
function int(v){return v==null||!isFinite(v)?{v:null,s:XS.muted}:{v:Math.round(v),s:XS.int};}
function mult(v){return v==null||!isFinite(v)?{v:null,s:XS.muted}:{v:+v,s:XS.mult};}
function pctRatio(v){ // 0..1 coverage ratio
  return v==null||!isFinite(v)?{v:null,s:XS.muted}:{v:+v,s:XS.pctPlain};
}
// Growth arrives from the API as percent (64.57); Excel wants the fraction.
function growth(v){
  if(v==null||!isFinite(v))return{v:null,s:XS.muted};
  return{v:+(v/100),s:v>0?XS.pctUp:v<0?XS.pctDown:XS.pctFlat};
}

function title(text,sub,width){
  const pad=n=>Array.from({length:Math.max(0,n-1)},()=>({v:"",s:XS.title}));
  return{
    rows:[
      [{v:text,s:XS.title},...pad(width)],
      [{v:sub,s:XS.subtitle}],
      [],
    ],
    merges:["A1:"+colLetter(Math.max(1,width))+"1"],
  };
}
function section(text,width){
  const pad=n=>Array.from({length:Math.max(0,n-1)},()=>({v:"",s:XS.sectionHead}));
  return[{v:text,s:XS.sectionHead},...pad(width)];
}

function recFor(series,sku,period){
  const arr=series[sku]||[];
  for(const x of arr)if(x.period===period)return x;
  return null;
}
function hasPrice(rec){
  if(!rec)return false;
  if(typeof rec.hasPrice==="boolean")return rec.hasPrice;
  return headlinePrice(rec)!=null;
}
// The upstream swapped a min-max range for a single median part-way through
// this history, so a period carries one basis or the other. Both the figure
// and its basis are exported; growth is never computed across a change.
function headlinePrice(rec){
  if(!rec)return null;
  const v=rec.headlinePricePerHour!=null?rec.headlinePricePerHour:rec.avgMinPricePerHour;
  return v!=null&&isFinite(v)?v:null;
}
function basisOf(rec){
  if(!rec)return null;
  if(rec.priceBasis)return rec.priceBasis;
  return headlinePrice(rec)!=null?"floor":null;
}
function pricedCov(rec){
  if(!rec)return null;
  if(rec.pricedCoverageRatioWithinMonth!=null)return rec.pricedCoverageRatioWithinMonth;
  if(rec.pricedCoverageRatioWithinQuarter!=null)return rec.pricedCoverageRatioWithinQuarter;
  if(rec.coverageRatioWithinMonth!=null)return rec.coverageRatioWithinMonth;
  if(rec.coverageRatioWithinQuarter!=null)return rec.coverageRatioWithinQuarter;
  return null;
}
function priorPeriodId(periodId){
  const q=/^(\d{4})-Q([1-4])$/.exec(periodId||"");
  if(q){const y=+q[1],n=+q[2];return n===1?(y-1)+"-Q4":y+"-Q"+(n-1);}
  const m=/^(\d{4})-(\d{2})$/.exec(periodId||"");
  if(m){const y=+m[1],n=+m[2];return n===1?(y-1)+"-12":y+"-"+String(n-1).padStart(2,"0");}
  return null;
}
const LOW_COVERAGE=0.75;

/* ─── Levels sheet: every captured measure, stacked by section ─── */
function levelsSheet(name,heading,sub,labels,series,skus,partialKey){
  const width=labels.length+1;
  const t=title(heading,sub,width);
  const rows=[...t.rows];
  // Order matters: the current period can be BOTH in-progress and entirely
  // uncaptured, and "no data" is the more useful of the two to show.
  const head=[HL("GPU model"),...labels.map(l=>H(
    l.label+(l.hasData===false?" (no data)":l.hasPrice===false?" (no price)":(l.isMTD||l.isQTD)?" (in progress)":"")
  ))];

  const block=(sectionTitle,pick,note)=>{
    rows.push(section(sectionTitle,width));
    if(note)rows.push([NOTE(note)]);
    rows.push(head);
    for(const sku of skus){
      rows.push([LBL(sku.shortLabel),...labels.map(l=>pick(recFor(series,sku.sku,l.period),l))]);
    }
    rows.push([]);
  };

  block("Headline price — $/hr (period average)",
    r=>money(headlinePrice(r)),
    "The figure the dashboard charts. Median across providers where the source publishes one; the floor of the vendor range for earlier periods. The row below states which applies to each period — do not compare a median against a floor.");
  block("Price basis",
    r=>({v:basisOf(r)==="median"?"median":basisOf(r)==="floor"?"floor (min)":"",s:XS.text}),
    "Which measure the headline row above is carrying for that period. The source switched from a per-vendor range to a single median on 2026-07-28, so the step between the two is a change of measure, not a price move.");
  block("Days behind the headline",
    r=>int(r?r.basisDaysUsed:null),
    "How many priced days the headline average above actually rests on. A period that straddles the change uses only the days on its own measure.");
  block("Other measure in this period — $/hr",
    r=>money(r&&r.mixedBasis?r.alternatePricePerHour:null),
    "Only populated for a period that straddles the change: what its days on the OTHER measure averaged. Comparing this against the neighbouring period on that same measure shows the market move with the units change taken out.");
  block("Median price — $/hr (period average)",
    r=>money(r?r.avgMedianPricePerHour:null),
    "Median listing across providers. This is a market rate.");
  block("Floor price — min $/hr (period average)",
    r=>money(r?r.avgMinPricePerHour:null),
    "Cheapest listing observed on each day, averaged over the period. One outlier vendor moves this line — read it against the midpoint and ceiling below.");
  block("Range midpoint — $/hr (period average)",
    r=>money(r?r.avgPriceMidpoint:null),
    "Midpoint of the observed min-max range, not a median of vendor prices; it inherits the same outliers at both ends.");
  block("Ceiling price — max $/hr (period average)",
    r=>money(r?r.avgMaxPricePerHour:null));
  block("Provider count (period average)",
    r=>int(r?r.avgProviderCount:null),
    "Distinct vendors quoting the SKU — vendor breadth, not price.");
  block("Spread multiple (max / min)",
    r=>mult(r?r.avgSpreadMultiple:null),
    "How far apart the cheapest and dearest listings sit. A high multiple means the floor is an outlier rather than a market rate.");
  block("Priced-day coverage",
    r=>pctRatio(pricedCov(r)),
    "Share of days in the period that actually carry a price. Anything under "+Math.round(LOW_COVERAGE*100)+"% makes the period average indicative only.");

  return{
    name,
    cols:[{w:30},...labels.map(()=>({w:15}))],
    freeze:{row:3,col:1},
    merges:t.merges,
    rows,
  };
}

/* ─── Growth sheet: MoM or QoQ plus YoY, one grid each ─── */
function growthSheet(name,heading,sub,labels,series,growthMap,yoyMap,skus,partialKey,growthLabel){
  const width=labels.length+1;
  const t=title(heading,sub,width);
  const rows=[...t.rows];
  const head=[HL("GPU model"),...labels.map(l=>H(l.label))];

  const grid=(sectionTitle,map,note)=>{
    rows.push(section(sectionTitle,width));
    if(note)rows.push([NOTE(note)]);
    rows.push(head);
    for(const sku of skus){
      const g=map[sku.sku]||{};
      rows.push([LBL(sku.shortLabel),...labels.map(l=>{
        const rec=recFor(series,sku.sku,l.period);
        // A period still running is not comparable against a completed prior.
        if(l[partialKey]||(rec&&rec[partialKey]))return{v:null,s:XS.muted};
        return growth(g[l.period]);
      })]);
    }
    rows.push([]);
  };

  grid(growthLabel+" growth — headline price",growthMap,
    "(current period average − prior period average) ÷ prior period average. Red = price rose, green = price fell (buyer's cost lens). Blank for a period still in progress, and blank across a change of price basis — a median and a floor are not comparable.");
  grid("YoY growth — headline price",yoyMap,
    "Same period one year earlier. Blank until a year of history exists.");

  // Resilience signal, computed exactly as the dashboard renders it so the
  // export can be audited against the screen.
  rows.push(section("Price resilience signal",width));
  rows.push([NOTE("\"Stable/up\" = headline price held or rose across two consecutive completed periods (both growth readings >= 0). \"Falling\" = it did not. Blank where the period has no price, is still running, or the two-period look-back is unavailable. A trailing ° marks a reading that rests on a period with under "+Math.round(LOW_COVERAGE*100)+"% priced days.")]);
  rows.push(head);
  for(const sku of skus){
    const g=growthMap[sku.sku]||{};
    rows.push([LBL(sku.shortLabel),...labels.map(l=>{
      const rec=recFor(series,sku.sku,l.period);
      if(!rec)return{v:"no capture",s:XS.badgeMuted};
      if(!hasPrice(rec))return{v:"no price",s:XS.badgeWarn};
      if(l[partialKey]||rec[partialKey])return{v:"in progress",s:XS.badgeMuted};
      const pid=priorPeriodId(l.period);
      const cur=g[l.period],prv=pid?g[pid]:null;
      if(cur==null||prv==null||!isFinite(cur)||!isFinite(prv))return{v:"",s:XS.badgeMuted};
      const cc=pricedCov(rec),pc=pricedCov(pid?recFor(series,sku.sku,pid):null);
      const thin=(cc!=null&&cc<LOW_COVERAGE)||(pc!=null&&pc<LOW_COVERAGE);
      const stable=cur>=0&&prv>=0;
      return{v:(stable?"Stable/up":"Falling")+(thin?" °":""),s:stable?XS.badgeGood:XS.badgeMuted};
    })]);
  }

  return{
    name,
    cols:[{w:30},...labels.map(()=>({w:15}))],
    freeze:{row:3,col:1},
    merges:t.merges,
    rows,
  };
}

/* ─── Daily raw: long format, one row per SKU-day ─── */
function dailySheet(daily,skus){
  const head=["Date","GPU model","Measure","Headline $/hr","Median $/hr","Floor $/hr (min)","Range midpoint $/hr","Ceiling $/hr (max)",
              "Spread absolute $","Spread multiple (x)","Provider count","Has price","Recovered from max field"];
  const rows=[head.map(h=>H(h))];
  const order=skus.map(s=>s.sku);
  const known=new Set(order);
  const series=(daily&&daily.series)||{};
  const names=[...order.filter(s=>series[s]),...Object.keys(series).filter(s=>!known.has(s))];
  const byDate=new Map();
  for(const sku of names){
    for(const p of (series[sku]||[])){
      if(!byDate.has(p.date))byDate.set(p.date,[]);
      byDate.get(p.date).push({sku,p});
    }
  }
  const labelOf=Object.fromEntries(skus.map(s=>[s.sku,s.shortLabel]));
  for(const date of [...byDate.keys()].sort()){
    for(const{sku,p}of byDate.get(date)){
      // dailyPrice/dailyBasis come from the API's normalization, so a day
      // whose price was captured into the wrong field reads as priced here
      // rather than as a hole. Older payloads predate the fields.
      const dailyPrice=p.dailyPrice!=null&&isFinite(p.dailyPrice)?p.dailyPrice
        :(p.medianPricePerHour!=null&&isFinite(p.medianPricePerHour)?p.medianPricePerHour
        :(p.minPricePerHour!=null&&isFinite(p.minPricePerHour)?p.minPricePerHour:null));
      const dailyBasis=p.dailyBasis||(p.medianPricePerHour!=null?"median":p.minPricePerHour!=null?"floor":null);
      const priced=dailyPrice!=null;
      rows.push([
        {v:date,s:XS.text},
        {v:labelOf[sku]||sku,s:XS.text},
        {v:dailyBasis==="median"?"median":dailyBasis==="floor"?"floor (min)":"",s:XS.text},
        money(dailyPrice),
        money(p.medianPricePerHour),
        money(p.minPricePerHour),
        money(p.priceMidpoint),
        money(p.maxPricePerHour),
        money(p.spreadAbsolute),
        mult(p.spreadMultiple),
        int(p.providerCount),
        {v:priced?"yes":"NO",s:priced?XS.text:XS.warn},
        {v:p.basisRemapped?"yes":"",s:XS.text},
      ]);
    }
  }
  return{
    name:"Daily raw observations",
    cols:[{w:13},{w:26},{w:13},{w:15},{w:15},{w:18},{w:20},{w:18},{w:17},{w:19},{w:15},{w:11},{w:23}],
    freeze:{row:1},
    filter:"A1:"+colLetter(head.length)+Math.max(1,rows.length),
    rows,
  };
}

/* ─── Data quality: the coverage story, per period ─── */
function qualitySheet(fHist,skus){
  const dq=fHist.dataQuality||{};
  const rows=[];
  const t=title("Data quality & coverage","Read this before quoting any number off the other sheets.",6);
  rows.push(...t.rows);

  rows.push(section("Feed status",6));
  const kv=(k,v,style)=>rows.push([{v:k,s:XS.keyLabel},{v:v,s:style||XS.text}]);
  kv("Tracking started",fHist.trackingSinceRealDate||"—");
  kv("Latest GPU observation",dq.latestGPUObservationDate||"—",dq.gpuFeedStale?XS.warn:XS.text);
  kv("Days since latest GPU observation",dq.daysSinceLatestGPUObservation==null?"—":dq.daysSinceLatestGPUObservation,dq.gpuFeedStale?XS.warn:XS.text);
  kv("Latest observation carrying a price",dq.latestPricedObservationDate||"—",dq.priceFieldStale?XS.warn:XS.text);
  kv("Days since latest priced observation",dq.daysSinceLatestPricedObservation==null?"—":dq.daysSinceLatestPricedObservation,dq.priceFieldStale?XS.warn:XS.text);
  kv("Captured days",dq.observationDays==null?"—":dq.observationDays);
  kv("Days carrying a price",dq.pricedDays==null?"—":dq.pricedDays);
  kv("Days captured WITHOUT a price",dq.unpricedDays==null?"—":dq.unpricedDays,dq.unpricedDays?XS.warn:XS.text);
  if(dq.priceFieldDroppedWhileFeedLive){
    rows.push([{v:"The feed kept delivering GPU rows after "+(dq.latestPricedObservationDate||"the last priced date")
      +" but with no minPricePerHour, so provider counts continued updating while every price cell went blank. That is an upstream shape change, not a flat market.",s:XS.bad}]);
    rows.push([]);
  }
  if(dq.monthsMissing&&dq.monthsMissing.length)
    rows.push([{v:"Calendar months with no capture at all: "+dq.monthsMissing.join(", "),s:XS.warn}]);
  if(dq.monthsUnpriced&&dq.monthsUnpriced.length)
    rows.push([{v:"Months captured but carrying no price: "+dq.monthsUnpriced.join(", "),s:XS.warn}]);
  for(const g of (dq.significantCaptureGaps||[])){
    rows.push([{v:"No capture for "+g.missingDays+" days between "+g.afterDate+" and "+g.beforeDate
      +". The months either side rest on fewer days than their length implies.",s:XS.warn}]);
  }
  if(dq.remappedPriceDays)
    rows.push([{v:dq.remappedPriceDays+" captured days carried their price in maxPricePerHour because the source replaced its vendor range with a single figure. They are reclassified as medians when this workbook is built; the stored snapshots are unchanged.",s:XS.text}]);
  rows.push([]);

  // The change of measure, stated as its own block — it is the single thing
  // most likely to be misread as a price move.
  const pb=fHist.priceBasis;
  if(pb&&pb.hasChange){
    rows.push(section("Change in what the source publishes",6));
    for(const c of (pb.timeline.changes||[])){
      rows.push([{v:"On "+c.effectiveDate+" the source stopped publishing a "+(c.from==="floor"?"per-vendor min-max range (headline = the cheapest listing)":c.from)
        +" and began publishing a single "+(c.to==="median"?"median across providers":c.to)
        +". Levels either side of that date are different statistics and are not comparable; growth across it is left blank rather than reported.",s:XS.bad}]);
    }
    for(const seg of (pb.timeline.segments||[])){
      rows.push([TXT(seg.from+" → "+seg.to),TXT(seg.basis==="floor"?"floor (min $/hr)":seg.basis),int(seg.days),TXT("captured days on this measure")]);
    }
    rows.push([]);
  }

  const covBlock=(heading,labels,series,dayKey,priceKey,denomKey)=>{
    rows.push(section(heading,6));
    rows.push([HL("Period"),H("GPU model"),H("Days captured"),H("Days priced"),H("Days in period"),H("Priced coverage")]);
    for(const l of labels){
      for(const sku of skus){
        const r=recFor(series,sku.sku,l.period);
        rows.push([
          {v:l.label+" ("+l.period+")",s:XS.rowLabel},
          {v:sku.shortLabel,s:XS.text},
          r?int(r[dayKey]):{v:0,s:XS.int},
          r?int(r[priceKey]):{v:0,s:XS.int},
          r?int(r[denomKey]):{v:null,s:XS.muted},
          pctRatio(pricedCov(r)),
        ]);
      }
    }
    rows.push([]);
  };
  covBlock("Monthly coverage",fHist.monthly?.labels||[],fHist.monthly?.series||{},
    "daysCoveredInMonth","daysWithPriceInMonth","monthDayCount");
  covBlock("Quarterly coverage",fHist.quarterly?.labels||[],fHist.quarterly?.series||{},
    "daysCoveredInQuarter","daysWithPriceInQuarter","quarterDayCount");

  return{name:"Data quality",cols:[{w:24},{w:26},{w:15},{w:14},{w:15},{w:16}],freeze:{row:3},merges:t.merges,rows};
}

/* ─── Read me ─── */
function readmeSheet(fHist,generatedAt){
  const dq=fHist.dataQuality||{};
  const rows=[];
  const t=title("GPU rental pricing — full export","Google / Gemini Tracking Dash · financial correlation view",4);
  rows.push(...t.rows);

  rows.push(section("What is in this workbook",4));
  const item=(a,b)=>rows.push([{v:a,s:XS.keyLabel},{v:b,s:XS.textWrap}]);
  item("Monthly $ per hour","Headline $/hr per GPU model per calendar month, the measure it is on, plus floor, midpoint, ceiling, provider count, spread and priced-day coverage.");
  item("Quarterly $ per hour","The same measures aggregated by calendar quarter. Quarter columns are labelled by quarter-end month (Mar/Jun/Sep/Dec).");
  item("MoM growth","Month-over-month and year-over-year change in the headline price, plus the price resilience signal. Blank across a change of measure.");
  item("QoQ growth","Quarter-over-quarter and year-over-year change in the headline price, plus the price resilience signal. Blank across a change of measure.");
  item("Daily raw observations","Every captured day for every SKU — the source rows every average above is built from.");
  item("Data quality","Feed status and per-period coverage. Start here.");
  rows.push([]);

  rows.push(section("How to read the numbers",4));
  item("Price basis","The source changed what it publishes part-way through this history. Earlier periods carry the FLOOR of the vendor range (the single cheapest listing among the providers quoting that SKU that day) — not a market rate, and one outlier listing moves it. Later periods carry the MEDIAN across providers, which is a market rate. Every sheet states the basis per period, and growth is never computed across the change.");
  item("Averaging","Period figures are arithmetic means of the daily values inside the calendar period, computed from daily observations directly rather than averaging monthly averages.");
  item("Growth","(current period average − prior period average) ÷ prior period average, stored as a real number so the cells stay arithmetic. Red = price rose, green = price fell — a buyer's cost lens. Invert the reading if you are looking at it as a vendor.");
  item("Suppression","Growth is blank for a period still in progress, and for any period with no price. Nothing is inferred or carried forward.");
  item("° marker","The reading rests on a period where under "+Math.round(LOW_COVERAGE*100)+"% of days carry a price.");
  item("Empty periods","Calendar periods with no capture are kept as columns rather than dropped, so a gap in the data stays visible.");
  rows.push([]);

  rows.push(section("Provenance",4));
  item("Generated",generatedAt);
  item("Tracking since",fHist.trackingSinceRealDate||"—");
  item("Latest GPU observation",dq.latestGPUObservationDate||"—");
  item("Latest priced observation",dq.latestPricedObservationDate||"—");
  item("Snapshots included","Real captures only — synthetic and backfill snapshots are excluded.");
  item("Source","getdeploying.com GPU vendor basket, captured daily and stored as immutable day snapshots.");

  if(dq.gpuFeedStale||dq.priceFieldStale){
    rows.push([]);
    rows.push([{v:"⚠ The feed is not current — see the Data quality sheet before using these figures.",s:XS.bad}]);
  }
  return{name:"Read me",cols:[{w:30},{w:96}],freeze:{row:3},merges:t.merges,rows};
}

/**
 * @param fHist  /api/gpu-hardware-pricing-history?view=financial payload
 * @param daily  /api/gpu-hardware-pricing-history (daily view) payload, or null
 * @param skus   [{sku,shortLabel}] in display order
 */
export function buildGPUPricingWorkbook(fHist,daily,skus){
  const generatedAt=new Date().toISOString().replace("T"," ").slice(0,16)+" UTC";
  const mLabels=fHist.monthly?.labels||[];
  const qLabels=fHist.quarterly?.labels||[];
  const mSeries=fHist.monthly?.series||{};
  const qSeries=fHist.quarterly?.series||{};

  const sheets=[readmeSheet(fHist,generatedAt)];

  if(mLabels.length)sheets.push(levelsSheet(
    "Monthly $ per hour","GPU rental $ per hour — by model, by month",
    "Period averages of daily observations · headline / floor / midpoint / ceiling · generated "+generatedAt,
    mLabels,mSeries,skus,"isMTD"));

  if(qLabels.length)sheets.push(levelsSheet(
    "Quarterly $ per hour","GPU rental $ per hour — by model, by quarter",
    "Columns labelled by quarter-end month · generated "+generatedAt,
    qLabels,qSeries,skus,"isQTD"));

  if(mLabels.length)sheets.push(growthSheet(
    "MoM growth","GPU rental $ per hour — month-over-month",
    "Change in the headline price · red = price rose, green = price fell · generated "+generatedAt,
    mLabels,mSeries,fHist.monthly?.mom||{},fHist.monthly?.yoy||{},skus,"isMTD","MoM"));

  if(qLabels.length)sheets.push(growthSheet(
    "QoQ growth","GPU rental $ per hour — quarter-over-quarter",
    "Change in the headline price · red = price rose, green = price fell · generated "+generatedAt,
    qLabels,qSeries,fHist.quarterly?.qoq||{},fHist.quarterly?.yoy||{},skus,"isQTD","QoQ"));

  if(daily&&daily.series&&Object.keys(daily.series).length)sheets.push(dailySheet(daily,skus));

  sheets.push(qualitySheet(fHist,skus));
  return{title:"GPU rental pricing export",creator:"Google / Gemini Tracking Dash",sheets};
}

export function gpuWorkbookFilename(fHist){
  const d=(fHist&&fHist.dataQuality&&fHist.dataQuality.latestGPUObservationDate)
    ||new Date().toISOString().slice(0,10);
  return"gpu-rental-pricing_"+d+".xlsx";
}
