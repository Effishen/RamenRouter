#!/usr/bin/env node
/* Actual file:// browser acceptance checks. Node/Playwright are test-only tools;
   the application itself requires neither. Tests use local synthetic input. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
function option(name, fallback) { const i=argv.indexOf(name); return i<0 ? fallback : argv[i+1]; }
const appRoot=path.resolve(option('--root',path.join(__dirname,'..')));
const reportPath=path.resolve(option('--report',path.join(appRoot,'tests/browser-results.json')));
// CHROME_PATH/--browser select an installed browser; otherwise use Playwright Chromium.
const browserPath=option('--browser',process.env.CHROME_PATH || process.env.RAMEN_TEST_BROWSER);
const modulePath=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const {chromium}=require(modulePath ? path.join(modulePath,'playwright') : 'playwright');
const report={app:'RamenRouter browser-native',started:new Date().toISOString(),scheme:'file:',platform:process.platform,scope:'Generic synthetic-fixture checks only',checks:[],errors:[],externalRequests:[],workerUrls:[]};
const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'ramen-browser-native-'));
let browser, page;
const requireTrue=(value,message)=>{if(!value)throw Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,fn) {
  const start=Date.now();
  try {const detail=await fn();report.checks.push({name,passed:true,seconds:(Date.now()-start)/1000,detail});console.log('PASS '+name+': '+JSON.stringify(detail));}
  catch(error){report.checks.push({name,passed:false,seconds:(Date.now()-start)/1000,error:error.message});throw error;}
}
async function request(endpoint,options) {return page.evaluate(async({endpoint,options})=>RamenNative.request(endpoint,options),{endpoint,options});}
async function state(){return request('/api/state');}
async function waitState(predicate,timeout=15000){const deadline=Date.now()+timeout;let s;while(Date.now()<deadline){s=await state();if(predicate(s))return s;await pause(50);}throw Error('State wait expired: '+JSON.stringify(s));}
async function upload(file){
  await page.waitForFunction(()=>!document.querySelector('#dropzone').disabled);
  const previous=(await state()).job?.id??null;
  await page.locator('#fileInput').setInputFiles(file);
  await waitState(s=>s.job&&s.job.id!==previous);
  return waitJob(['ready']);
}
async function waitJob(expected,{timeout=90000,output=false}={}) {
  const deadline=Date.now()+timeout;
  let latest;
  while(Date.now()<deadline){latest=(await state()).job;if(latest&&['ready','completed','stopped','timed_out','error'].includes(latest.state)){
    requireTrue(expected.includes(latest.state),'Unexpected terminal state: '+JSON.stringify(latest));
    if(!output||latest.hasOutput)return latest;
  }await pause(75);}
  throw Error('Job did not finish: '+JSON.stringify(latest));
}
async function setCheck(selector,on){if(await page.locator(selector).isChecked()!==on){
  await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);
  const label=page.locator('label[for="'+selector.slice(1)+'"]');
  if(await label.count())await label.click();else await page.locator(selector).setChecked(on);
  requireTrue(await page.locator(selector).isChecked()===on,'Toggle failed: '+selector);
}}
async function exportFile(selector,extension){
  const waiting=page.waitForEvent('download',{timeout:15000});
  await page.locator(selector).click();
  const download=await waiting;
  requireTrue(download.suggestedFilename().toLowerCase().endsWith(extension),'Unexpected download filename '+download.suggestedFilename());
  const target=path.join(outputDir,download.suggestedFilename());await download.saveAs(target);
  return {target,name:download.suggestedFilename(),bytes:fs.readFileSync(target)};
}
function verifySesGeometry(text,board){
  const tokens=text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g)||[];let pos=0;
  function read(){const token=tokens[pos++];if(token==='('){const out=[];while(tokens[pos]!==')'){requireTrue(pos<tokens.length,'Unclosed SES scope');out.push(read());}pos++;return out;}requireTrue(token!==undefined&&token!==')','Invalid SES token');return token.startsWith('"')?JSON.parse(token):token;}
  const ast=read();requireTrue(pos===tokens.length&&ast[0]==='session','Invalid SES document');
  const routes=ast.find(n=>Array.isArray(n)&&n[0]==='routes');
  const network=routes?.find(n=>Array.isArray(n)&&n[0]==='network_out');
  const resolution=routes?.find(n=>Array.isArray(n)&&n[0]==='resolution');
  requireTrue(network&&resolution,'Missing SES route network/resolution');
  const scale=Number(resolution[2]);
  requireTrue(resolution[1]===board.units.name&&Number.isSafeInteger(scale)&&scale>0,'SES unit/resolution invalid');
  const wires=[],vias=[];
  for(const n of network.slice(1)){if(!Array.isArray(n)||n[0]!=='net')continue;for(const item of n.slice(2)){
    if(item[0]==='wire'){const p=item.find(x=>Array.isArray(x)&&x[0]==='path');requireTrue(p,'SES wire has no path');wires.push({key:JSON.stringify([n[1],p[1],...p.slice(3).map(Number)]),width:Number(p[2])/scale});}
    if(item[0]==='via')vias.push(JSON.stringify([n[1],item[1],Number(item[2]),Number(item[3])]));
  }}
  const net=id=>board.nets.find(n=>n.id===id)?.name;
  const q=n=>Math.round(n*scale);
  const expectedWires=board.traces.map(t=>({key:JSON.stringify([net(t.net),board.layers[t.layer].name,...t.points.flat().map(q)]),width:t.width}));
  const order=(a,b)=>a.key.localeCompare(b.key)||a.width-b.width;
  wires.sort(order);expectedWires.sort(order);
  const expectedVias=board.vias.map(v=>JSON.stringify([net(v.net),v.padstack,q(v.x),q(v.y)])).sort();
  requireTrue(wires.length===expectedWires.length,'SES changed trace count');
  for(let i=0;i<wires.length;i++){const actual=wires[i],expected=expectedWires[i];requireTrue(actual.key===expected.key,'SES changed trace net/layer/coordinates');requireTrue(actual.width>=expected.width-1e-10&&actual.width<=expected.width+1/scale+1e-10,'SES narrowed or unexpectedly widened a trace');}
  requireTrue(JSON.stringify(vias.sort())===JSON.stringify(expectedVias),'SES changed via net/padstack/coordinates or via count');
  const library=routes.find(n=>Array.isArray(n)&&n[0]==='library_out');
  for(const definition of board.viaDefs){
    const padstack=library?.find(n=>Array.isArray(n)&&n[0]==='padstack'&&n[1]===definition.name);
    requireTrue(padstack,'SES lost via definition '+definition.name);
    const circles=padstack.filter(n=>Array.isArray(n)&&n[0]==='shape').map(n=>n[1]);
    for(let layer=definition.fromLayer;layer<=definition.toLayer;layer++){
      const circle=circles.find(n=>n[0]==='circle'&&n[1]===board.layers[layer].name);
      requireTrue(circle,'SES lost via layer '+definition.name);
      const diameter=Number(circle[2])/scale;
      requireTrue(diameter>=definition.diameter-1e-10&&diameter<=definition.diameter+1/scale+1e-10,'SES narrowed or unexpectedly widened via copper');
    }
  }
  return {traces:wires.length,vias:vias.length,sesResolution:scale,everyCopperRecordMatched:true,noCopperWidthRoundedDown:true,cadImportTested:false};
}
function stressDsn(count=128){
  const pins=Array.from({length:count},(_,n)=>`(pin PAD ${n+1} 0 ${-n*1100})`).join('\n');
  const nets=Array.from({length:count},(_,n)=>`(net N${n+1} (pins U1-${n+1} U2-${count-n}))`).join('\n');
  const h=(count+3)*1100;
  return `(pcb "RamenRouter-native-stop.dsn"
 (parser (string_quote ") (space_in_quoted_tokens on)) (resolution um 10) (unit um)
 (structure (layer Top (type signal) (property (index 0))) (layer Bottom (type signal) (property (index 1)))
  (boundary (path pcb 0 0 0 80000 0 80000 -${h} 0 -${h} 0 0)) (via VIA) (rule (width 200) (clearance 150)))
 (placement (component ROW (place U1 15000 -2200 front 0) (place U2 65000 -2200 front 0)))
 (library (image ROW ${pins}) (padstack PAD (shape (rect Top -600 -250 600 250)) (attach off))
 (padstack VIA (shape (circle Top 500)) (shape (circle Bottom 500)) (attach off)))
 (network ${nets} (class default (circuit (use_via VIA)) (rule (width 200) (clearance 150)))))`;
}
(async()=>{
try {
  browser=await chromium.launch({headless:true,...(browserPath?{executablePath:browserPath}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}});
  await page.context().setOffline(true);report.browserNetworkOffline=true;report.browserVersion=browser.version();
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('request',req=>{if(/^https?:/.test(req.url()))report.externalRequests.push(req.url());});
  page.on('worker',worker=>report.workerUrls.push(worker.url()));
  await check('direct file launch with adjacent scripts and no server',async()=>{
    await page.goto(pathToFileURL(path.join(appRoot,fs.existsSync(path.join(appRoot,'RamenRouter.html'))?'RamenRouter.html':'index.html')).href,{waitUntil:'load'});
    await page.waitForFunction(()=>typeof RamenNative!=='undefined'&&typeof RamenNative.request==='function');
    requireTrue(page.url().startsWith('file:'),'Application did not launch directly from file');
    await page.locator('#fileInput').waitFor({state:'attached'});
    const s=await state();requireTrue(s.engineVersion,'Engine identity missing');
    return {engineVersion:s.engineVersion,appVersion:s.appVersion};
  });
  let initial, completed, exported;
  await check('real DSN upload and board geometry',async()=>{
    const file=path.join(outputDir,'demo.dsn');
    const text=await page.evaluate(()=>globalThis.RAMEN_DEMO_DSN);
    requireTrue(typeof text==='string'&&text.startsWith('(pcb'),'Synthetic demo text missing');
    fs.writeFileSync(file,text);
    initial=await upload(file);
    const board=await request('/api/board');
    requireTrue(initial.stats.unrouted>0,'Demo must start unrouted');
    requireTrue(board.units==='mm'&&board.layers.length===2,'Wrong board units/layers');
    requireTrue(board.pads.length>=16,'Missing demo pads');
    requireTrue(board.bounds[2]>board.bounds[0],'Invalid board bounds');
    return {initialStats:initial.stats,pads:board.pads.length,layers:board.layers.length};
  });
  await check('optional SMD escape-only mode creates checked escape copper',async()=>{
    // The stock SO8 sample is intentionally too roomy to justify dense-row
    // escape. Increase only its via diameter to exercise the dense-row path.
    const denseFile=path.join(outputDir,'dense-escape.dsn');
    const dense=fs.readFileSync(path.join(outputDir,'demo.dsn'),'utf8')
      .replace('(circle F.Cu 600)','(circle F.Cu 1200)')
      .replace('(circle B.Cu 600)','(circle B.Cu 1200)');
    requireTrue(dense.includes('(circle F.Cu 1200)')&&dense.includes('(circle B.Cu 1200)'), 'Dense escape fixture replacement failed');
    fs.writeFileSync(denseFile,dense);await upload(denseFile);
    await setCheck('#fanout',true);await setCheck('#fanoutOnly',true);
    await page.locator('#runButton').click();
    const escaped=await waitJob(['completed'],{timeout:90000,output:true});
    requireTrue(escaped.stats.viaCount>0&&escaped.stats.traceCount>0,'SMD escape-only created no escape copper');
    requireTrue(escaped.stats.unrouted>0,'Escape-only unexpectedly completed the full route');
    requireTrue(escaped.stats.totalViolations===0&&escaped.stats.belowNominalWidthTraceCount===0,'SMD escape-only violated routing rules');
    await setCheck('#fanoutOnly',false);initial=await upload(path.join(outputDir,'demo.dsn'));
    return {stats:escaped.stats};
  });
  await check('Smart routing and optimization in a Blob worker preserve nominal widths',async()=>{
    await setCheck('#fanout',true);await setCheck('#deepSearch',true);await setCheck('#optimize',true);
    await setCheck('#viaInPad',false);await page.locator('#maxPasses').fill('12');
    const beforeWorkers=report.workerUrls.length;
    await page.locator('#runButton').click();completed=await waitJob(['completed'],{timeout:120000,output:true});
    requireTrue(report.workerUrls.length>beforeWorkers,'Routing did not create a Web Worker');
    requireTrue(report.workerUrls.slice(beforeWorkers).some(url=>url.startsWith('blob:')),'Expected local Blob worker');
    requireTrue(completed.stats.unrouted===0,'Demo did not fully route: '+JSON.stringify(completed.stats));
    requireTrue(completed.stats.totalViolations===0,'Demo has geometric/rule violations: '+JSON.stringify(completed.stats));
    const board=await request('/api/board');requireTrue(board.traces.length>0,'No actual routed traces');
    requireTrue(board.traces.every(t=>Number.isFinite(t.width)&&t.width>=.249),'Demo copper narrowed below0.25mm');
    requireTrue(completed.stats.belowNominalWidthTraceCount===0,'Engine reports undersized traces');
    await page.waitForFunction(()=>!document.querySelector('#downloadSes').disabled&&document.querySelector('#unroutedValue').textContent.trim()==='0');
    await page.waitForFunction(()=>/·\s*[1-9][0-9,]* trace/.test(document.querySelector('#geometrySummary').textContent));
    await page.screenshot({path:path.join(appRoot,'tests/browser-routed.png'),fullPage:true});
    return {stats:completed.stats,workerCount:report.workerUrls.length-beforeWorkers};
  });
  await check('SES and DSN downloads contain real copper',async()=>{
    const ses=await exportFile('#downloadSes','.ses');exported=await exportFile('#downloadDsn','.dsn');
    requireTrue(/\(session\s/i.test(ses.bytes.toString())&&/\(wire\s/i.test(ses.bytes.toString()),'SES contains no routing');
    requireTrue(/\(pcb\s/i.test(exported.bytes.toString())&&/\(wire\s/i.test(exported.bytes.toString()),'DSN contains no routing');
    const geometryCheck=verifySesGeometry(ses.bytes.toString(),await request('/api/raw'));
    const checks=await exportFile('#downloadChecks','.json');const checkReport=JSON.parse(checks.bytes.toString());
    requireTrue(checkReport.stats.unrouted===completed.stats.unrouted&&checkReport.stats.belowNominalWidthTraceCount===0,'Downloaded check report does not match routed board');
    return {sesName:ses.name,sesBytes:ses.bytes.length,dsnName:exported.name,dsnBytes:exported.bytes.length,checksBytes:checks.bytes.length,geometryCheck};
  });
  await check('exported DSN reload retains routed connectivity',async()=>{
    const reloaded=await upload(exported.target);
    requireTrue(reloaded.stats.unrouted===completed.stats.unrouted,'DSN export/reimport changed connectivity');
    requireTrue(reloaded.stats.traceCount>0,'Reimport lost routed wires');
    return {stats:reloaded.stats};
  });
  await check('single-layer board routes without any via definitions',async()=>{
    const file=path.join(outputDir,'single-layer-no-vias.dsn');
    fs.writeFileSync(file,`(pcb "single-layer-no-vias.dsn"
      (parser (string_quote ") (space_in_quoted_tokens on)) (resolution um 10) (unit um)
      (structure (layer Top (type signal) (property (index 0)))
        (boundary (path pcb 0 0 0 40000 0 40000 -20000 0 -20000 0 0))
        (rule (width 250) (clearance 200)))
      (library (image POINT (pin PAD 1 0 0)) (padstack PAD (shape (rect Top -500 -500 500 500))))
      (placement (component POINT (place A 10000 -10000 front 0) (place B 30000 -10000 front 0)))
      (network (net N (pins A-1 B-1)) (class default N (rule (width 250) (clearance 200))))
      (wiring))`);
    const before=await upload(file);requireTrue(before.stats.layerCount===1&&before.stats.unrouted===1,'Single-layer fixture failed to import');
    const raw=await request('/api/raw');requireTrue(raw.viaDefs.length===0,'Single-layer fixture must not define vias');
    await setCheck('#fanout',false);await setCheck('#deepSearch',false);await setCheck('#optimize',false);
    await page.locator('#runButton').click();const routed=await waitJob(['completed'],{timeout:30000,output:true});
    requireTrue(routed.stats.unrouted===0&&routed.stats.viaCount===0&&routed.stats.traceCount>0,'Single-layer/no-via route failed');
    requireTrue(routed.stats.totalViolations===0&&routed.stats.belowNominalWidthTraceCount===0,'Single-layer route violated rules');
    return {stats:routed.stats};
  });
  await check('running worker stops and the interface recovers',async()=>{
    const input=path.join(outputDir,'native-stop.dsn');fs.writeFileSync(input,stressDsn());
    const loaded=await upload(input);
    requireTrue(loaded.stats.unrouted>=100,'Stop fixture did not load correctly');
    await setCheck('#deepSearch',true);await page.locator('#maxPasses').fill('100');
    await page.locator('#runButton').click();
    await waitState(s=>s.job&&['running','starting'].includes(s.job.state),10000);
    await page.locator('#stopButton').click();
    const stopped=await waitJob(['stopped'],{timeout:15000});
    requireTrue(stopped.stats.unrouted>0,'Stop occurred only after full routing');
    const next=await upload(path.join(outputDir,'demo.dsn'));
    return {state:stopped.state,remaining:stopped.stats.unrouted,recoveryState:next.state};
  });
  await check('force termination discards unchecked output and can reopen a board',async()=>{
    const input=path.join(outputDir,'native-force-stop.dsn');fs.writeFileSync(input,stressDsn());
    await upload(input);await page.locator('#runButton').click();
    await waitState(s=>s.job&&['running','starting'].includes(s.job.state),10000);
    await request('/api/stop',{method:'POST',body:JSON.stringify({force:true})});
    const stopped=await waitJob(['stopped'],{timeout:5000});
    requireTrue(stopped.hasOutput===false,'Forced termination offered unchecked output');
    const rejected=await page.evaluate(async()=>{try{await RamenNative.request('/api/download?type=dsn');return false;}catch{return true;}});
    requireTrue(rejected,'Export allowed after unchecked force termination');
    await upload(path.join(outputDir,'demo.dsn'));
    return {state:stopped.state,uncheckedExportRejected:true,recovery:'ready'};
  });
  await check('local assets, clear console and rendered board',async()=>{
    requireTrue(report.externalRequests.length===0,'External requests: '+report.externalRequests.join(','));
    requireTrue(report.errors.length===0,'JavaScript errors: '+report.errors.join('\n'));
    await page.locator('#runButton').waitFor({state:'visible',timeout:10000});
    await page.waitForFunction(()=>!document.querySelector('#dropzone').disabled);
    requireTrue(await page.locator('#runButton').isVisible(),'Start routing control missing');
    const box=await page.locator('#boardCanvas').boundingBox();requireTrue(box&&box.width>300&&box.height>200,'Board canvas not usable');
    await page.screenshot({path:path.join(appRoot,'tests/browser-file.png'),fullPage:true});
    return {errors:0,externalRequests:0,canvas:{width:box.width,height:box.height}};
  });
  report.passed=true;
}catch(error){report.passed=false;report.error=error.stack||error.message;console.error(error.stack||error);process.exitCode=1;}
finally{
  if(browser)await browser.close();
  report.files={};for(const file of fs.readdirSync(appRoot).filter(name=>/\.(?:js|html|css|svg)$/.test(name)).sort()){
    const p=path.join(appRoot,file);if(fs.existsSync(p))report.files[file]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log('Report: '+reportPath);
}
})().catch(error=>{console.error(error);process.exitCode=1});
