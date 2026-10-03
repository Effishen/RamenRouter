/* RamenRouter browser host. GPL-3.0-or-later. No server, runtime or network. */
'use strict';
(() => {
  const active = new Set(['inspecting','starting','running','stopping']);
  const subscribers = new Set();
  let job = null, worker = null, workerUrl = null, inputText = null;
  let board = null, preview = null, exports = null, serial = 0, timer = null, watchdog = null;
  const logs = [];
  const base = {appVersion:'0.2.0',engineVersion:'Ramen JS 0.2',fanoutVersion:'Ramen SMD escape'};
  function notify() { for (const fn of subscribers) { try { fn(state()); } catch (_) {} } }
  function log(message) {
    logs.push(new Date().toLocaleTimeString() + '  ' + String(message));
    if (logs.length > 20000) logs.splice(0,logs.length-20000);
  }
  function elapsed() { return job ? Math.max(0,((job.endedAt||Date.now())-job.startedAt)/1000) : 0; }
  function state() { return {...base,job:job?{...job,elapsedSeconds:elapsed(),log:logs.slice(-180)}:null}; }
  function kill() {
    if(worker) {worker.onmessage=null;worker.onerror=null;worker.terminate();} worker=null;
    if(workerUrl) URL.revokeObjectURL(workerUrl); workerUrl=null;
    clearTimeout(timer); timer=null; clearTimeout(watchdog); watchdog=null;
  }
  function getSettings(value={}) {
    const s={fanout:true,fanoutOnly:false,optimize:true,deepSearch:true,viaInPad:false,maxPasses:12,timeoutMinutes:30,quality:'balanced',...value,neckdown:false};
    for(const k of ['fanout','fanoutOnly','optimize','deepSearch','viaInPad']) if(typeof s[k]!=='boolean') throw new Error(k+' must be true or false.');
    for(const [k,min,max] of [['maxPasses',1,100],['timeoutMinutes',1,1440]]) {
      if(!Number.isFinite(s[k])||!Number.isInteger(s[k])||s[k]<min||s[k]>max) throw new Error(k+' must be an integer between '+min+' and '+max+'.');
    }
    if(s.fanoutOnly) s.fanout=true;
    return s;
  }
  function workerMain() {
    const dsn=createRamenDSN(), geo=createRamenGeometry(), router=createRamenRouter(geo,createRamenOptimizer(geo),createRamenFanout(geo));
    let cancelled=false,deadline=Infinity;
    const send=(data)=>self.postMessage(data);
    function stats(b,full=true) {
      const c=geo.connectivity(b),v=full?geo.validate(b):null;
      let length=0; for(const t of b.traces||[]) for(let i=1;i<t.points.length;i++) length+=Math.hypot(t.points[i][0]-t.points[i-1][0],t.points[i][1]-t.points[i-1][1]);
      return {unrouted:c.unrouted,viaCount:(b.vias||[]).length,traceCount:(b.traces||[]).length,traceLengthMm:length*b.units.mmPerUnit,
        clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?(v.totalViolations??v.clearanceViolations):null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:null,widthRulesChecked:!!v,
        netCount:b.nets.length,componentCount:new Set(b.pads.map(p=>p.component)).size,layerCount:b.layers.length};
    }
    function geometry(b) {
      const s=b.units.mmPerUnit,p=([x,y])=>[x*s,y*s],name=n=>b.nets.find(n2=>n2.id===n)?.name||'';
      const pads=[];
      for(const pad of b.pads) for(const sh of pad.shapes) {
        const item={layer:sh.layer,x:pad.x*s,y:pad.y*s,component:pad.component,net:name(pad.net)};
        if(sh.type==='circle') {item.x=sh.cx*s;item.y=sh.cy*s;item.radius=sh.r*s;}
        else {item.points=sh.points.map(p);item.radius=0;}
        pads.push(item);
      }
      const air=geo.connectivity(b).airwires||[];
      return {units:'mm',bounds:[b.bounds.minX*s,b.bounds.minY*s,b.bounds.maxX*s,b.bounds.maxY*s],
        layers:b.layers.map(l=>({id:l.index,name:l.name,signal:true})),
        traces:(b.traces||[]).map(t=>({layer:t.layer,width:t.width*s,points:t.points.map(p),net:name(t.net)})),pads,
        vias:(b.vias||[]).map(v=>({x:v.x*s,y:v.y*s,radius:v.diameter*s/2,net:name(v.net),fromLayer:Math.min(...v.layers),toLayer:Math.max(...v.layers)})),
        outlines:(b.outlines||[]).map(poly=>poly.map(p)),
        airwires:air.map(a=>({net:name(a.net),points:(a.points||[a.from,a.to]).map(p)}))};
    }
    self.onmessage=async event=>{
      const m=event.data;
      if(m.type==='stop') {cancelled=true;return;}
      if(m.type!=='inspect'&&m.type!=='run') return;
      try {
        cancelled=false;deadline=Date.now()+(m.options?.timeoutMinutes||30)*60000;
        const b=dsn.parse(m.text,m.name);
        const initial=stats(b);
        send({type:'loaded',board:b,preview:geometry(b),stats:initial,warnings:b.warnings||[]});
        if(m.type==='inspect') {send({type:'ready'});return;}
        let lastPreview=0;
        const out=await router.route(b,m.options,message=>{
          if(typeof message==='string') {send({type:'progress',message});return;}
          const data={type:'progress',phase:message.phase,pass:message.pass,message:message.message};
          if(message.board && Date.now()-lastPreview>750) {
            lastPreview=Date.now();data.board=message.board;data.preview=geometry(message.board);data.stats=stats(message.board,false);
          } else if(message.stats) data.stats=message.stats;
          send(data);
        },()=>cancelled||Date.now()>=deadline);
        const result=out?.board||out||b, finalStats=stats(result);
        const report=geo.validate(result);
        send({type:'done',state:Date.now()>=deadline?'timed_out':(cancelled||out?.stopped?'stopped':'completed'),board:result,preview:geometry(result),stats:finalStats,
          exports:{ses:dsn.exportSes(result,m.name),dsn:dsn.exportDsn(result,m.name),report:JSON.stringify({engine:'Ramen JS 0.2',settings:m.options,units:result.units,bounds:result.bounds,viaInPadApplied:!!result.viaInPadApplied,sesExport:dsn.exportSesReport(result),stats:finalStats,checks:report},null,2)},
          message:finalStats.unrouted===0?'All connections routed. Verify the exported session in your PCB editor.':finalStats.unrouted+' connections remain; best checked result retained.'});
      } catch(error) {send({type:'error',error:error.message||String(error),stack:error.stack||''});}
    };
  }
  function launch(type,options) {
    kill(); exports=null; preview=null; board=null;
    const id=++serial;
    const source='"use strict";\n'+[createRamenDSN,createRamenGeometry,createRamenOptimizer,createRamenFanout,createRamenRouter,workerMain].map(fn=>fn.toString()).join('\n')+'\nworkerMain();';
    workerUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    worker=new Worker(workerUrl);
    job={id:String(id),name:job?.name||'board.dsn',state:type==='inspect'?'inspecting':'starting',phase:'loading',startedAt:Date.now(),settings:options,stats:null,initialStats:null,error:null,hasOutput:false,revision:0,pass:0};
    worker.onmessage=e=>{
      if(id!==serial||!job)return;
      const m=e.data;
      if(m.message)log(m.message);
      if(m.board)board=m.board;
      if(m.preview) {preview=m.preview;job.revision++;}
      if(m.stats)job.stats={...job.stats,...m.stats};
      if(m.phase)job.phase=m.phase;
      if(m.pass!==undefined)job.pass=m.pass;
      if(m.type==='loaded') {
        job.initialStats=m.stats;
        log('Loaded '+job.name+': '+m.stats.netCount+' nets, '+m.stats.unrouted+' incomplete connections.');
        for(const w of m.warnings||[])log('Input note: '+w);
        if(type==='run'&&job.state!=='stopping') {job.state='running';job.phase='routing';}
      }
      if(m.type==='ready') {job.state=job.stopReason||'ready';job.phase=job.state;job.endedAt=Date.now();kill();}
      if(m.type==='done') {
        exports=m.exports;job.hasOutput=true;job.state=job.stopReason||m.state;job.phase=job.state;job.endedAt=Date.now();
        log('Checked result: '+job.stats.unrouted+' incomplete, '+(job.stats.totalViolations??job.stats.clearanceViolations)+' rule issues, '+job.stats.belowNominalWidthTraceCount+' undersized traces.');
        kill();
      }
      if(m.type==='error') {job.state='error';job.phase='error';job.error=m.error;job.endedAt=Date.now();log('Error: '+m.error);if(m.stack)log(m.stack);kill();}
      notify();
    };
    worker.onerror=e=>{if(id!==serial||!job)return;job.error=e.message||'Browser worker failed to start. Use a current Chrome, Edge or Firefox browser.';job.state='error';job.phase='error';job.endedAt=Date.now();log(job.error);kill();notify();};
    worker.postMessage({type,text:inputText,name:job.name,options});
    const timeLimit=type==='run'?options.timeoutMinutes*60000:120000;
    timer=setTimeout(()=>{if(job&&active.has(job.state)){job.stopReason='timed_out';job.state='stopping';job.phase='stopping';log('Time budget reached; requesting a checked partial result.');worker?.postMessage({type:'stop'});notify();}},timeLimit);
    watchdog=setTimeout(()=>{if(id===serial&&job&&active.has(job.state)){kill();job.state='timed_out';job.phase='timed_out';job.endedAt=Date.now();job.hasOutput=false;log('The worker exceeded the stop grace period and was terminated. Unchecked work was not exported.');notify();}},timeLimit+30000);
    notify();return state();
  }
  function requireIdle(){if(job&&active.has(job.state))throw new Error('Stop the current operation before starting another.');}
  async function importText(text,name) {
    requireIdle();if(typeof text!=='string'||!text.trim())throw new Error('The DSN file is empty.');
    if(text.length>64*1024*1024)throw new Error('The DSN file is larger than 64 MiB.');
    if(!/\.dsn$/i.test(name))throw new Error('Choose a Specctra .dsn file.');
    inputText=text;job={name};logs.length=0;
    return launch('inspect',getSettings());
  }
  async function request(path,options={}) {
    const [endpoint,query='']=path.split('?'),params=new URLSearchParams(query);
    let data=options.body;if(typeof data==='string'&&endpoint!=='/api/upload'){try{data=JSON.parse(data);}catch{throw new Error('Invalid settings.');}}
    if(endpoint==='/api/state')return state();
    if(endpoint==='/api/board'){if(!preview)throw new Error('Board preview is still loading.');return preview;}
    if(endpoint==='/api/raw'){if(!board)throw new Error('Board is still loading.');return structuredClone(board);}
    if(endpoint==='/api/demo')return importText(globalThis.RAMEN_DEMO_DSN,'RamenRouter-demo.dsn');
    if(endpoint==='/api/upload') {
      let text;if(typeof data==='string')text=data;else if(data instanceof Blob)text=await data.text();else if(data instanceof ArrayBuffer||ArrayBuffer.isView(data))text=new TextDecoder().decode(data);else throw new Error('Choose a DSN file.');
      return importText(text,params.get('name')||'board.dsn');
    }
    if(endpoint==='/api/run') {
      requireIdle();if(!inputText)throw new Error('Load a board first.');const settings=getSettings(data||{});logs.length=0;
      log('Starting browser-native routing. Original input and nominal trace widths are preserved.');
      if(settings.viaInPad)log('Explicit rule override: vias may attach to SMD pads.');
      return launch('run',settings);
    }
    if(endpoint==='/api/stop') {
      if(!job||!active.has(job.state))return state();
      if(data?.force){kill();job.state='stopped';job.phase='stopped';job.endedAt=Date.now();job.hasOutput=false;log('Worker terminated. An unchecked partial route is not exported.');}
      else {job.state='stopping';job.phase='stopping';worker?.postMessage({type:'stop'});log('Stop requested. Waiting for the engine to return its best checked board.');}
      notify();return state();
    }
    if(endpoint==='/api/download') {
      const type=params.get('type')||'ses',result=getDownload(type);
      return {blob:result.blob,disposition:'attachment; filename="'+result.filename+'"'};
    }
    if(endpoint==='/api/quit') {kill();serial++;job=null;board=null;preview=null;exports=null;inputText=null;logs.length=0;notify();return state();}
    throw new Error('Unknown local action.');
  }
  function getDownload(type) {
    if(!['ses','dsn','log','report'].includes(type))throw new Error('Unknown export type.');
    if(!job)throw new Error('No board is loaded.');
    if(type!=='log'&&(!exports||active.has(job.state)))throw new Error('A checked route is not ready to export.');
    const text=type==='log'?logs.join('\n')+'\n':exports[type];
    const stem=job.name.replace(/\.dsn$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
    const filename=stem+(type==='log'?'-routing.log':type==='report'?'-checks.json':'-routed.'+type);
    return {blob:new Blob([text],{type:type==='report'?'application/json':'text/plain;charset=utf-8'}),filename};
  }
  function download(type) {
    const {blob,filename}=getDownload(type),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return filename;
  }
  globalThis.RamenNative={request,download,subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);}};
  window.addEventListener('beforeunload',event=>{if(job&&active.has(job.state)){event.preventDefault();event.returnValue='';}});
})();
