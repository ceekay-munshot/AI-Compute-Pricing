/**
 * Minimal, dependency-free .xlsx writer.
 *
 * An .xlsx file is a ZIP of XML parts, so the whole thing is reachable from
 * plain browser JS. We write it by hand rather than pulling in SheetJS or
 * ExcelJS because this dashboard ships as a single pre-bundled index.html
 * with no CDN script tags — adding a ~900KB runtime dependency (or a remote
 * <script>) to emit a spreadsheet would cost more than the feature.
 *
 * ZIP entries are STORED (compression method 0). Deflate would shrink the
 * file, but store keeps this module small and Excel, LibreOffice, Numbers and
 * Google Sheets all open stored archives without complaint. The workbooks we
 * emit are a few hundred KB at most.
 *
 * Public surface:
 *   buildXlsx({sheets:[...]})  → Uint8Array
 *   downloadXlsx(filename, bytes)
 *   XS                          → named style ids for cells
 *
 * Sheet shape:
 *   {
 *     name:   "Monthly $ per hour",     // <=31 chars, no []:*?/\
 *     cols:   [{w:28},{w:12}, ...],     // optional widths, in Excel units
 *     freeze: {row:4, col:1},           // optional frozen pane origin
 *     filter: "A4:H120",                // optional autofilter range
 *     merges: ["A1:H1"],                // optional merged ranges
 *     rows:   [ [cell, cell, ...], ...] // cell = null | primitive | {v,s,t,f}
 *   }
 *
 * Cell objects: {v: value, s: styleId, t: "n"|"s"|"b", f: "SUM(...)"}
 * Bare primitives are typed automatically (number → numeric, else string).
 */

/* ─── CRC32 ───────────────────────────────────────────────── */
let CRC_TABLE = null;
function crcTable(){
  if(CRC_TABLE)return CRC_TABLE;
  const t=new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
    t[n]=c>>>0;
  }
  CRC_TABLE=t;
  return t;
}
function crc32(bytes){
  const t=crcTable();
  let c=0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++)c=t[(c^bytes[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

const enc=new TextEncoder();
function utf8(str){return enc.encode(str);}

/* ─── ZIP (store only) ────────────────────────────────────── */
function zip(files){
  // DOS timestamp. A fixed, valid value keeps output byte-stable across runs
  // (handy for diffing) and Excel does not care about file mtimes.
  const dosTime=(12<<11)|(0<<5)|(0>>1);        // 12:00:00
  const dosDate=((2024-1980)<<9)|(1<<5)|1;     // 1980-relative: 2024-01-01

  const locals=[];
  const centrals=[];
  let offset=0;

  for(const f of files){
    const nameBytes=utf8(f.name);
    const data=f.data;
    const crc=crc32(data);

    const lh=new Uint8Array(30+nameBytes.length);
    const lv=new DataView(lh.buffer);
    lv.setUint32(0,0x04034b50,true);
    lv.setUint16(4,20,true);          // version needed
    lv.setUint16(6,0x0800,true);      // UTF-8 filename flag
    lv.setUint16(8,0,true);           // method: store
    lv.setUint16(10,dosTime,true);
    lv.setUint16(12,dosDate,true);
    lv.setUint32(14,crc,true);
    lv.setUint32(18,data.length,true);
    lv.setUint32(22,data.length,true);
    lv.setUint16(26,nameBytes.length,true);
    lv.setUint16(28,0,true);
    lh.set(nameBytes,30);

    const cd=new Uint8Array(46+nameBytes.length);
    const cv=new DataView(cd.buffer);
    cv.setUint32(0,0x02014b50,true);
    cv.setUint16(4,20,true);          // version made by
    cv.setUint16(6,20,true);          // version needed
    cv.setUint16(8,0x0800,true);
    cv.setUint16(10,0,true);
    cv.setUint16(12,dosTime,true);
    cv.setUint16(14,dosDate,true);
    cv.setUint32(16,crc,true);
    cv.setUint32(20,data.length,true);
    cv.setUint32(24,data.length,true);
    cv.setUint16(28,nameBytes.length,true);
    cv.setUint16(30,0,true);          // extra
    cv.setUint16(32,0,true);          // comment
    cv.setUint16(34,0,true);          // disk
    cv.setUint16(36,0,true);          // internal attrs
    cv.setUint32(38,0,true);          // external attrs
    cv.setUint32(42,offset,true);
    cd.set(nameBytes,46);

    locals.push(lh,data);
    centrals.push(cd);
    offset+=lh.length+data.length;
  }

  const cdSize=centrals.reduce((a,b)=>a+b.length,0);
  const eocd=new Uint8Array(22);
  const ev=new DataView(eocd.buffer);
  ev.setUint32(0,0x06054b50,true);
  ev.setUint16(8,files.length,true);
  ev.setUint16(10,files.length,true);
  ev.setUint32(12,cdSize,true);
  ev.setUint32(16,offset,true);

  const total=offset+cdSize+22;
  const out=new Uint8Array(total);
  let p=0;
  for(const part of locals){out.set(part,p);p+=part.length;}
  for(const part of centrals){out.set(part,p);p+=part.length;}
  out.set(eocd,p);
  return out;
}

/* ─── XML helpers ─────────────────────────────────────────── */
function esc(v){
  return String(v)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&apos;")
    // Excel rejects most C0 control characters outright.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"");
}
export function colLetter(n){ // 1 → A, 27 → AA
  let s="";
  while(n>0){
    const r=(n-1)%26;
    s=String.fromCharCode(65+r)+s;
    n=Math.floor((n-1)/26);
  }
  return s;
}

/* ─── Style catalogue ─────────────────────────────────────────
   Fixed style table shared by every sheet. Index positions are exported as
   XS so callers reference styles by name, never by magic number.

   Fills 0 and 1 are reserved: Excel requires fill 0 = none and fill 1 =
   gray125, and silently repairs (i.e. discards all formatting in) a
   stylesheet that does not honour that.                                   */
const NUMFMTS=[
  {id:164,code:'"$"#,##0.0000'},
  {id:165,code:'"$"#,##0.00'},
  {id:166,code:'0.0%'},
  {id:167,code:'0.0"x"'},
  {id:168,code:'0'},
  {id:169,code:'yyyy\\-mm\\-dd'},
  {id:170,code:'0.0'},
];

const INK   = "FF111827";
const MUTED = "FF6B7280";
const FAINT = "FFB6BCC6";
const BLUE  = "FF1D4ED8";
const RED   = "FFB91C1C";
const GREEN = "FF047857";
const AMBER = "FF92400E";

const FONTS=[
  /*0*/ {sz:10,color:INK,name:"Calibri"},
  /*1*/ {sz:18,b:1,color:INK,name:"Calibri"},
  /*2*/ {sz:10,color:MUTED,name:"Calibri"},
  /*3*/ {sz:10,b:1,color:"FFFFFFFF",name:"Calibri"},
  /*4*/ {sz:11,b:1,color:INK,name:"Calibri"},
  /*5*/ {sz:10,color:INK,name:"Consolas"},
  /*6*/ {sz:10,color:RED,name:"Consolas"},
  /*7*/ {sz:10,color:GREEN,name:"Consolas"},
  /*8*/ {sz:10,color:FAINT,name:"Calibri"},
  /*9*/ {sz:10,b:1,color:BLUE,name:"Calibri"},
  /*10*/{sz:10,color:AMBER,name:"Calibri"},
  /*11*/{sz:10,b:1,color:GREEN,name:"Calibri"},
  /*12*/{sz:12,b:1,color:"FFFFFFFF",name:"Calibri"},
  /*13*/{sz:9,i:1,color:MUTED,name:"Calibri"},
];

const FILLS=[
  /*0*/ null,               // none    (reserved)
  /*1*/ null,               // gray125 (reserved)
  /*2*/ "FF1D4ED8",         // header blue
  /*3*/ "FFF3F4F6",         // band grey
  /*4*/ "FFFEF3C7",         // amber wash
  /*5*/ "FFECFDF5",         // green wash
  /*6*/ "FFFEF2F2",         // red wash
  /*7*/ "FF111827",         // title bar ink
  /*8*/ "FFEFF6FF",         // pale blue wash
];

// border 0 = none, 1 = thin bottom rule, 2 = thin box
const BORDERS=3;

// [fontId, fillId, borderId, numFmtId, align, wrap]
const XFS=[
  /* 0  default      */ [0,0,0,0,null,0],
  /* 1  title        */ [12,7,0,0,"left",0],
  /* 2  subtitle     */ [13,0,0,0,"left",1],
  /* 3  sectionHead  */ [9,8,1,0,"left",0],
  /* 4  header       */ [3,2,0,0,"center",1],
  /* 5  headerLeft   */ [3,2,0,0,"left",1],
  /* 6  rowLabel     */ [4,0,1,0,"left",0],
  /* 7  money4       */ [5,0,1,164,"right",0],
  /* 8  money2       */ [5,0,1,165,"right",0],
  /* 9  pctUp        */ [6,0,1,166,"right",0],
  /*10  pctDown      */ [7,0,1,166,"right",0],
  /*11  pctFlat      */ [5,0,1,166,"right",0],
  /*12  int          */ [5,0,1,168,"right",0],
  /*13  mult         */ [5,0,1,167,"right",0],
  /*14  date         */ [5,0,1,169,"left",0],
  /*15  text         */ [0,0,1,0,"left",0],
  /*16  textWrap     */ [0,0,1,0,"left",1],
  /*17  muted        */ [8,0,1,0,"right",0],
  /*18  mutedLeft    */ [8,0,1,0,"left",0],
  /*19  warn         */ [10,4,1,0,"left",1],
  /*20  good         */ [11,5,1,0,"left",0],
  /*21  bad          */ [0,6,1,0,"left",1],
  /*22  dec1         */ [5,0,1,170,"right",0],
  /*23  note         */ [2,0,0,0,"left",1],
  /*24  keyLabel     */ [4,3,1,0,"left",0],
  /*25  pctPlain     */ [5,0,1,166,"right",0],
  /*26  badgeGood    */ [11,5,1,0,"center",0],
  /*27  badgeMuted   */ [2,3,1,0,"center",0],
  /*28  badgeWarn    */ [10,4,1,0,"center",0],
];

export const XS={
  default:0, title:1, subtitle:2, sectionHead:3, header:4, headerLeft:5,
  rowLabel:6, money4:7, money2:8, pctUp:9, pctDown:10, pctFlat:11,
  int:12, mult:13, date:14, text:15, textWrap:16, muted:17, mutedLeft:18,
  warn:19, good:20, bad:21, dec1:22, note:23, keyLabel:24, pctPlain:25,
  badgeGood:26, badgeMuted:27, badgeWarn:28,
};

function stylesXml(){
  const numFmts='<numFmts count="'+NUMFMTS.length+'">'
    +NUMFMTS.map(f=>'<numFmt numFmtId="'+f.id+'" formatCode="'+esc(f.code)+'"/>').join("")
    +'</numFmts>';
  const fonts='<fonts count="'+FONTS.length+'">'
    +FONTS.map(f=>'<font>'
      +(f.b?'<b/>':'')+(f.i?'<i/>':'')
      +'<sz val="'+f.sz+'"/><color rgb="'+f.color+'"/><name val="'+f.name+'"/></font>').join("")
    +'</fonts>';
  const fills='<fills count="'+FILLS.length+'">'
    +FILLS.map((c,i)=>{
      if(i===0)return'<fill><patternFill patternType="none"/></fill>';
      if(i===1)return'<fill><patternFill patternType="gray125"/></fill>';
      return'<fill><patternFill patternType="solid"><fgColor rgb="'+c+'"/><bgColor indexed="64"/></patternFill></fill>';
    }).join("")
    +'</fills>';
  const thin='<left/><right/><top/><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/>';
  const box='<left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right>'
    +'<top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/>';
  const borders='<borders count="'+BORDERS+'">'
    +'<border><left/><right/><top/><bottom/><diagonal/></border>'
    +'<border>'+thin+'</border>'
    +'<border>'+box+'</border>'
    +'</borders>';
  const cellXfs='<cellXfs count="'+XFS.length+'">'
    +XFS.map(([fontId,fillId,borderId,numFmtId,align,wrap])=>{
      const alignXml=(align||wrap)
        ?'<alignment'+(align?' horizontal="'+align+'"':'')+' vertical="center"'+(wrap?' wrapText="1"':'')+'/>'
        :'';
      return'<xf numFmtId="'+numFmtId+'" fontId="'+fontId+'" fillId="'+fillId+'" borderId="'+borderId+'" xfId="0"'
        +(numFmtId?' applyNumberFormat="1"':'')
        +' applyFont="1"'+(fillId?' applyFill="1"':'')+(borderId?' applyBorder="1"':'')
        +(alignXml?' applyAlignment="1"':'')
        +(alignXml?'>'+alignXml+'</xf>':'/>');
    }).join("")
    +'</cellXfs>';
  return'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    +numFmts+fonts+fills+borders
    +'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    +cellXfs
    +'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    +'</styleSheet>';
}

/* ─── Worksheet ───────────────────────────────────────────── */
function cellXml(ref,cell){
  if(cell==null)return"";
  let v,s,t,f;
  if(typeof cell==="object"&&!(cell instanceof Date)){
    v=cell.v;s=cell.s;t=cell.t;f=cell.f;
  }else{
    v=cell;
  }
  const sAttr=s?' s="'+s+'"':"";
  if(f)return'<c r="'+ref+'"'+sAttr+'><f>'+esc(f)+'</f></c>';
  if(v==null||v==="")return s?'<c r="'+ref+'"'+sAttr+'/>':"";
  if(t==="b")return'<c r="'+ref+'"'+sAttr+' t="b"><v>'+(v?1:0)+'</v></c>';
  const numeric=t==="n"||(t==null&&typeof v==="number");
  if(numeric){
    if(!isFinite(v))return s?'<c r="'+ref+'"'+sAttr+'/>':"";
    return'<c r="'+ref+'"'+sAttr+'><v>'+v+'</v></c>';
  }
  return'<c r="'+ref+'"'+sAttr+' t="inlineStr"><is><t xml:space="preserve">'+esc(v)+'</t></is></c>';
}

function sheetXml(sheet){
  const rows=sheet.rows||[];
  const maxCols=rows.reduce((m,r)=>Math.max(m,r?r.length:0),1);

  let cols="";
  if(sheet.cols&&sheet.cols.length){
    cols='<cols>'+sheet.cols.map((c,i)=>
      '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+(c&&c.w?c.w:12)+'" customWidth="1"/>'
    ).join("")+'</cols>';
  }

  let pane="";
  if(sheet.freeze&&(sheet.freeze.row||sheet.freeze.col)){
    const r=sheet.freeze.row||0, c=sheet.freeze.col||0;
    const topLeft=colLetter(c+1)+(r+1);
    const active=r&&c?"bottomRight":r?"bottomLeft":"topRight";
    pane='<pane'+(c?' xSplit="'+c+'"':'')+(r?' ySplit="'+r+'"':'')
      +' topLeftCell="'+topLeft+'" activePane="'+active+'" state="frozen"/>'
      +'<selection pane="'+active+'" activeCell="'+topLeft+'" sqref="'+topLeft+'"/>';
  }

  const body=rows.map((row,ri)=>{
    if(!row)return'<row r="'+(ri+1)+'"/>';
    const cells=row.map((cell,ci)=>cellXml(colLetter(ci+1)+(ri+1),cell)).join("");
    const h=sheet.rowHeights&&sheet.rowHeights[ri];
    return'<row r="'+(ri+1)+'"'+(h?' ht="'+h+'" customHeight="1"':'')+'>'+cells+'</row>';
  }).join("");

  const dim="A1:"+colLetter(Math.max(1,maxCols))+Math.max(1,rows.length);
  // Schema order is strict: sheetData, then autoFilter, then mergeCells.
  const filter=sheet.filter?'<autoFilter ref="'+esc(sheet.filter)+'"/>':"";
  const merges=(sheet.merges&&sheet.merges.length)
    ?'<mergeCells count="'+sheet.merges.length+'">'
      +sheet.merges.map(m=>'<mergeCell ref="'+esc(m)+'"/>').join("")+'</mergeCells>'
    :"";

  return'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    +'<dimension ref="'+dim+'"/>'
    +'<sheetViews><sheetView showGridLines="0" workbookViewId="0">'+pane+'</sheetView></sheetViews>'
    +'<sheetFormatPr defaultRowHeight="15"/>'
    +cols
    +'<sheetData>'+body+'</sheetData>'
    +filter+merges
    +'<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    +'</worksheet>';
}

// Excel forbids []:*?/\ in sheet names, caps them at 31 chars, and rejects
// duplicates case-insensitively. Silently repairing here beats handing the
// user a workbook Excel refuses to open.
function safeSheetName(name,taken){
  let n=String(name||"Sheet").replace(/[\[\]:*?\/\\]/g," ").trim().slice(0,31)||"Sheet";
  let base=n,i=2;
  while(taken.has(n.toLowerCase())){
    const suffix=" ("+i+")";
    n=base.slice(0,31-suffix.length)+suffix;
    i++;
  }
  taken.add(n.toLowerCase());
  return n;
}

export function buildXlsx(workbook){
  const sheets=(workbook&&workbook.sheets)||[];
  const taken=new Set();
  const named=sheets.map(sh=>({...sh,name:safeSheetName(sh.name,taken)}));

  const files=[];
  files.push({name:"[Content_Types].xml",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    +'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    +'<Default Extension="xml" ContentType="application/xml"/>'
    +'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    +named.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")
    +'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    +'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    +'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    +'</Types>')});

  files.push({name:"_rels/.rels",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    +'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    +'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    +'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    +'</Relationships>')});

  files.push({name:"xl/workbook.xml",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    +' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    +'<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
    +named.map((sh,i)=>'<sheet name="'+esc(sh.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join("")
    +'</sheets></workbook>')});

  files.push({name:"xl/_rels/workbook.xml.rels",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    +named.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join("")
    +'<Relationship Id="rId'+(named.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    +'</Relationships>')});

  files.push({name:"xl/styles.xml",data:utf8(stylesXml())});
  named.forEach((sh,i)=>files.push({name:"xl/worksheets/sheet"+(i+1)+".xml",data:utf8(sheetXml(sh))}));

  const now=new Date().toISOString().replace(/\.\d+Z$/,"Z");
  const title=esc((workbook&&workbook.title)||"Export");
  files.push({name:"docProps/core.xml",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    +' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    +' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    +'<dc:title>'+title+'</dc:title>'
    +'<dc:creator>'+esc((workbook&&workbook.creator)||"Dashboard")+'</dc:creator>'
    +'<cp:lastModifiedBy>'+esc((workbook&&workbook.creator)||"Dashboard")+'</cp:lastModifiedBy>'
    +'<dcterms:created xsi:type="dcterms:W3CDTF">'+now+'</dcterms:created>'
    +'<dcterms:modified xsi:type="dcterms:W3CDTF">'+now+'</dcterms:modified>'
    +'</cp:coreProperties>')});

  files.push({name:"docProps/app.xml",data:utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    +' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    +'<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>'
    +'<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>'
    +'<vt:variant><vt:i4>'+named.length+'</vt:i4></vt:variant></vt:vector></HeadingPairs>'
    +'<TitlesOfParts><vt:vector size="'+named.length+'" baseType="lpstr">'
    +named.map(sh=>'<vt:lpstr>'+esc(sh.name)+'</vt:lpstr>').join("")
    +'</vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
    +'<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>')});

  return zip(files);
}

export function downloadXlsx(filename,bytes){
  const blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=filename;
  a.style.display="none";
  document.body.appendChild(a);
  a.click();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in Safari before the navigation to the blob URL has started.
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},2000);
}
