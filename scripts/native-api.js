/* RamenRouter browser host. GPL-3.0-or-later. No server, runtime or network. */
'use strict';
(() => {
  const active = new Set(['inspecting','starting','running','stopping','clearing','updating_rules']);
  const subscribers = new Set(), activitySubscribers = new Set();
  let activitySequence=0;
  let job = null, worker = null, workerUrl = null, inputText = null;
  let board = null, preview = null, exports = null, bestChecked = null, clearTransaction = null, ruleTransaction = null, importedNetRules = null, serial = 0, timer = null, watchdog = null;
  const logs = [];
  const base = {appVersion:'0.2.13',engineVersion:'Ramen JS 0.2.13',fanoutVersion:'Ramen SMD escape'};
  function notifyActivity() {
    const update={jobId:job?.id,state:job?.state,phase:job?.phase,activity:job?.activity,lastEngineUpdateAt:job?.lastEngineUpdateAt,operation:job?.operation,counters:job?.counters,deadlineAt:job?.deadlineAt,remainingSeconds:remaining(),startedAt:job?.startedAt,endedAt:job?.endedAt};
    for(const fn of activitySubscribers){try{fn(update);}catch(_){}}
  }
  function notify() { notifyActivity(); for (const fn of subscribers) { try { fn(state()); } catch (_) {} } }
  function log(message) {
    logs.push(new Date().toLocaleTimeString() + '  ' + String(message));
    if (logs.length > 20000) logs.splice(0,logs.length-20000);
  }
  function elapsed() { return job ? Math.max(0,((job.endedAt||Date.now())-job.startedAt)/1000) : 0; }
  function remaining() { return job?.operation==='run'&&Number.isFinite(job.deadlineAt)?Math.max(0,(job.deadlineAt-(job.endedAt??Date.now()))/1000):null; }
  function state() { return {...base,job:job?{...job,elapsedSeconds:elapsed(),remainingSeconds:remaining(),log:logs.slice(-180)}:null}; }
  function kill() {
    if(job?.activity)job.activity={...job.activity,visual:null,sequence:++activitySequence};
    if(worker) {worker.onmessage=null;worker.onerror=null;worker.terminate();} worker=null;
    if(workerUrl) URL.revokeObjectURL(workerUrl); workerUrl=null;
    clearTimeout(timer); timer=null; clearTimeout(watchdog); watchdog=null;
  }
  function rememberChecked(m) {
    if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked)return;
    bestChecked={board:m.board,preview:m.preview,stats:m.stats,exports:m.exports,advice:m.advice||{items:[]},fromInput:!!m.fromInput};
    job.bestResult={available:true,unrouted:m.stats.unrouted,traceCount:m.stats.traceCount,viaCount:m.stats.viaCount,fromInput:!!m.fromInput};
  }
  function routingSummary(b) {
    return {traceCount:(b?.traces||[]).length,viaCount:(b?.vias||[]).length,
      fixedTraceCount:(b?.traces||[]).filter(t=>t.fixed).length,fixedViaCount:(b?.vias||[]).filter(v=>v.fixed).length};
  }
  function netLayerSettings(b) {
    const layers=(b?.layers||[]).map(layer=>({id:layer.index,name:layer.name})),all=layers.map(layer=>layer.id);
    const padsByNet=new Map();
    for(const pad of b?.pads||[]) {
      if(!padsByNet.has(pad.net))padsByNet.set(pad.net,[]);
      padsByNet.get(pad.net).push([...new Set(pad.shapes.map(shape=>shape.layer))]);
    }
    const nets=(b?.nets||[]).map(net=>({id:net.id,name:net.name,
      allowedLayers:[...(net.useLayers||all)],importedLayers:[...(importedNetRules?.[net.id]?.layers||net.useLayers||all)],
      preferShort:net.preferShort===true,importedPreferShort:importedNetRules?.[net.id]?.preferShort??(net.preferShort===true),
      padLayers:padsByNet.get(net.id)||[]}));
    return {jobId:job?.id,layers,nets};
  }
  function updateLayerRules() {
    if(!job||!board)return;
    const settings=netLayerSettings(board),nets=new Map(settings.nets.map(net=>[net.id,net]));
    const same=(a,b)=>a.length===b.length&&a.every(layer=>b.includes(layer));
    job.layerRulesChanged=settings.nets.some(net=>!same(net.allowedLayers,net.importedLayers)||net.preferShort!==net.importedPreferShort);
    job.layerRuleSummary={restrictedNets:settings.nets.filter(net=>net.allowedLayers.length<settings.layers.length).length,
      totalNets:settings.nets.length,shortRouteNets:settings.nets.filter(net=>net.preferShort).length,
      conflictingTraces:(board.traces||[]).filter(trace=>nets.has(trace.net)&&!nets.get(trace.net).allowedLayers.includes(trace.layer)).length,
      inaccessiblePads:settings.nets.reduce((count,net)=>count+net.padLayers.filter(layers=>!layers.some(layer=>net.allowedLayers.includes(layer))).length,0)};
    job.routingRulesChanged=job.layerRulesChanged;job.routingRuleSummary=job.layerRuleSummary;
  }
  function restoreBeforeRules(message,error=null) {
    kill();
    const saved=ruleTransaction;ruleTransaction=null;
    if(saved) {
      job={...saved.job,ruleError:error};board=saved.board;preview=saved.preview;
      exports=saved.exports;bestChecked=saved.bestChecked;inputText=saved.inputText;
    }
    log(message);notify();return state();
  }
  function restoreBeforeClear(message,error=null) {
    kill();
    const saved=clearTransaction;clearTransaction=null;
    if(saved) {
      job={...saved.job,clearError:error};board=saved.board;preview=saved.preview;
      exports=saved.exports;bestChecked=saved.bestChecked;inputText=saved.inputText;
    }
    log(message);notify();return state();
  }
  function stopWithBest(reason,message) {
    if(clearTransaction)return restoreBeforeClear(message+' Routing was not cleared; the previous board is unchanged.');
    if(ruleTransaction)return restoreBeforeRules(message+' Routing rules were not changed; the previous board is unchanged.');
    kill();job.stopReason=reason;job.state=reason;job.phase=reason;job.endedAt=Date.now();job.suggestions={};
    if(bestChecked) {
      board=bestChecked.board;preview=bestChecked.preview;exports=bestChecked.exports;
      job.stats={...bestChecked.stats};job.routingSummary=routingSummary(board);updateLayerRules();job.advice=bestChecked.advice;job.hasOutput=true;job.revision++;
      log(message+' Best checked result retained: '+job.stats.unrouted+' incomplete.');
    } else {
      board=null;preview=null;exports=null;job.stats=null;job.routingSummary=null;job.advice={items:[]};job.hasOutput=false;
      log(message+' No checked result was available yet.');
    }
    notify();return state();
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
    let cancelled=false,deadline=Infinity,activityScale=1,lastSpatialAt=-Infinity;
    let activityNets=new Map();
    function visualInMm(visual) {
      if(!visual||!['pad','via','grid','search','candidate','trace','check'].includes(visual.kind))return null;
      const point=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1]);
      const result={kind:visual.kind,units:'mm',label:String(visual.label||'').slice(0,160)};
      if(Number.isInteger(visual.layer))result.layer=visual.layer;
      if(visual.searchId!==undefined)result.searchId=visual.searchId;
      result.points=(visual.points||[]).slice(0,64).filter(point).map(p=>[p[0]*activityScale,p[1]*activityScale,...(Number.isInteger(p[2])?[p[2]]:[])]);
      let remaining=512;result.paths=[];
      for(const path of (visual.paths||[]).slice(0,32)) {
        if(remaining<2)break;
        const points=(path.points||[]).slice(0,remaining);
        if(points.length<2||!points.every(point)||!Number.isInteger(path.layer))continue;
        result.paths.push({layer:path.layer,points:points.map(p=>[p[0]*activityScale,p[1]*activityScale])});remaining-=points.length;
      }
      if(Array.isArray(visual.bounds)&&visual.bounds.length===4&&visual.bounds.every(Number.isFinite))result.bounds=visual.bounds.map(n=>n*activityScale);
      return result;
    }
    const send=data=>{
      if(data.type==='activity'&&data.activity?.visual){const now=Date.now();if(now-lastSpatialAt<150)return;lastSpatialAt=now;}
      if(data.activity)data={...data,activity:{...data.activity,visual:visualInMm(data.activity.visual)}};
      self.postMessage(data);
    };
    function checkedActivity(activity) {
      const phase=activity.stage==='advising'?'advising':'checking';
      const netName=activityNets.get(activity.netId);
      const label=activity.visual?.label||(phase==='advising'?'Reviewing placement advice':'Checking board geometry');
      send({type:'activity',phase,message:label+(netName?' · '+netName:''),activity:{...activity,netName}});
    }
    const dsn=createRamenDSN(), geo=createRamenGeometry(checkedActivity), advisor=createRamenAdvisor(geo), router=createRamenRouter(geo,createRamenOptimizer(geo),createRamenFanout(geo));
    const stage=(phase,message,activity={},writeLog=true)=>send({type:'progress',phase,message,activity,log:writeLog});
    function placementAdvice(b,initialBoard,includeIncomplete) {
      try {return advisor.analyze(b,{initialBoard,includeIncomplete,onActivity:checkedActivity});}
      catch(error) {send({type:'progress',message:'Placement advice unavailable: '+(error.message||String(error))});return {items:[]};}
    }
    function restrictedSmdNets(b) {
      const candidates=new Set(), copperLayers=new Set(b.layers.map(layer=>layer.index));
      if(copperLayers.size<2)return candidates;
      const nets=new Map(b.nets.map(net=>[net.id,net]));
      for(const pad of b.pads) {
        const padLayers=new Set(pad.shapes.map(shape=>shape.layer)),net=nets.get(pad.net);
        if(padLayers.size!==1||!net)continue;
        const layer=[...padLayers][0],via=b.viaDefs.find(def=>def.name===net.viaName);
        if(!via||!Number.isFinite(via.diameter)||via.diameter<=0||!Number.isInteger(via.fromLayer)||!Number.isInteger(via.toLayer)||via.fromLayer>=via.toLayer||!copperLayers.has(via.fromLayer)||!copperLayers.has(via.toLayer))continue;
        if(b.viaAtSmd&&via.attachAllowed)continue;
        const permitted=(net.useLayers||[...copperLayers]).filter(value=>copperLayers.has(value)&&value>=via.fromLayer&&value<=via.toLayer);
        if(layer>=via.fromLayer&&layer<=via.toLayer&&permitted.some(value=>value!==layer))candidates.add(net.id);
      }
      return candidates;
    }
    function stats(b,full=true,connection=null,validation=null) {
      const c=connection||geo.connectivity(b),v=full?(validation||geo.validate(b)):null;
      let length=0; for(const t of b.traces||[]) for(let i=1;i<t.points.length;i++) length+=Math.hypot(t.points[i][0]-t.points[i-1][0],t.points[i][1]-t.points[i-1][1]);
      return {unrouted:c.unrouted,viaCount:(b.vias||[]).length,traceCount:(b.traces||[]).length,traceLengthMm:length*b.units.mmPerUnit,
        inactiveLayerViolations:v?v.violations.filter(issue=>issue.type==='inactive_layer').length:null,clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?(v.totalViolations??v.clearanceViolations):null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:null,widthRulesChecked:!!v,
        netCount:b.nets.length,componentCount:new Set(b.pads.map(p=>p.component)).size,layerCount:b.layers.length};
    }
    function geometry(b,connection=null) {
      const s=b.units.mmPerUnit,p=([x,y])=>[x*s,y*s],names=new Map(b.nets.map(net=>[net.id,net.name])),name=n=>names.get(n)||'';
      const pads=[];
      for(const pad of b.pads) for(const sh of pad.shapes) {
        const item={layer:sh.layer,x:pad.x*s,y:pad.y*s,component:pad.component,net:name(pad.net)};
        if(sh.type==='circle') {item.x=sh.cx*s;item.y=sh.cy*s;item.radius=sh.r*s;}
        else {item.points=sh.points.map(p);item.radius=0;}
        pads.push(item);
      }
      const air=(connection||geo.connectivity(b)).airwires||[];
      return {units:'mm',bounds:[b.bounds.minX*s,b.bounds.minY*s,b.bounds.maxX*s,b.bounds.maxY*s],
        layers:b.layers.map(l=>({id:l.index,name:l.name,signal:true})),
        traces:(b.traces||[]).map(t=>({layer:t.layer,width:t.width*s,points:t.points.map(p),net:name(t.net)})),pads,
        vias:(b.vias||[]).map(v=>({x:v.x*s,y:v.y*s,radius:v.diameter*s/2,net:name(v.net),fromLayer:Math.min(...v.layers),toLayer:Math.max(...v.layers)})),
        outlines:(b.outlines||[]).map(poly=>poly.map(p)),
        airwires:air.map(a=>({net:name(a.net),points:(a.points||[a.from,a.to]).map(p)}))};
    }
    function checkedResult(result,initialBoard,options,name,initialStats,finalStats,fromInput=false,includeIncomplete=!options.fanoutOnly,prepared=null,writeLog=false) {
      stage('checking','Checking clearances and trace widths for a saved result.',{},writeLog);
      const report=prepared?.validation||geo.validate(result);
      stage('advising','Reviewing remaining connections and placement advice.',{},writeLog);
      const advice=placementAdvice(result,initialBoard,includeIncomplete);
      stage('exporting','Preparing the checked preview and downloadable results.',{},writeLog);
      return {board:result,preview:geometry(result,prepared?.connection),stats:finalStats,advice,fromInput,
        exports:{ses:dsn.exportSes(result,name),dsn:dsn.exportDsn(result,name),report:JSON.stringify({engine:'Ramen JS 0.2.13',settings:options,routingRules:{shorterNets:result.nets.filter(net=>net.preferShort).map(net=>net.name)},units:result.units,bounds:result.bounds,viaInPadApplied:!!result.viaInPadApplied,sesExport:dsn.exportSesReport(result),initialStats,stats:finalStats,checks:report,advice},null,2)}};
    }
    self.onmessage=async event=>{
      const m=event.data;
      if(m.type==='stop') {cancelled=true;return;}
      if(!['inspect','run','clear','layer-rules'].includes(m.type)) return;
      try {
        cancelled=false;deadline=Number.isFinite(m.deadlineAt)?m.deadlineAt:Date.now()+(m.options?.timeoutMinutes||30)*60000;
        stage('reading','Reading the DSN board and its routing rules.');
        const b=dsn.parse(m.text,m.name);
        activityScale=b.units.mmPerUnit;activityNets=new Map(b.nets.map(net=>[net.id,net.name]));
        stage('checking','Loaded '+b.nets.length+' nets, '+b.pads.length+' pads and '+b.layers.length+' copper layers. Checking the input board.');
        if(m.type==='clear') {
          // No host state changes until parsing, geometry checks, preview and
          // exports have all succeeded in this worker.
          const clearedInput=dsn.clearRoutingDsn(b),cleared=dsn.parse(clearedInput,m.name),finalStats=stats(cleared);
          if(cleared.traces.length||cleared.vias.length)throw new Error('The design still contains routing after clearing.');
          const result=checkedResult(cleared,cleared,m.options,m.name,finalStats,finalStats,true,false,null,true);
          result.exports.dsn=clearedInput;
          send({type:'cleared',clearedInput,warnings:cleared.warnings||[],...result});return;
        }
        if(m.type==='layer-rules') {
          const editedInput=dsn.setNetRoutingRules(b,m.changes),edited=dsn.parse(editedInput,m.name),finalStats=stats(edited);
          // Forbidden imported traces remain visible and checked. The user can
          // widen the rule or deliberately clear routing before trying again.
          const result=checkedResult(edited,edited,m.options,m.name,finalStats,finalStats,true,false,null,true);
          result.exports.dsn=editedInput;
          send({type:'rules-updated',editedInput,warnings:edited.warnings||[],...result});return;
        }
        const inputConnection=geo.connectivity(b),inputValidation=geo.validate(b),initial=stats(b,true,inputConnection,inputValidation);
        // Build the fallback before routing starts. Stop never has to validate,
        // analyze or serialize copper on the UI thread after terminating work.
        const initialResult=checkedResult(b,b,m.options,m.name,initial,initial,true,!m.options.fanoutOnly,{connection:inputConnection,validation:inputValidation},true);
        send({type:'loaded',...initialResult,advice:placementAdvice(b,b,false),checkpointAdvice:initialResult.advice,warnings:b.warnings||[]});
        if(m.type==='inspect') {send({type:'ready'});return;}
        if(initial.inactiveLayerViolations) {
          const error=new Error(initial.inactiveLayerViolations+' imported trace(s) use layers that are not allowed for their nets. Clear routing & start over, or change the net layer rules before routing.');
          error.code='NET_LAYER_CONFLICT';throw error;
        }
        // Capture the original permissions before routing. This only identifies
        // relevant options; it does not predict that an override will succeed.
        const padViaCandidates=m.options.viaInPad||m.options.fanoutOnly?new Set():restrictedSmdNets(b);
        let lastPreview=0;
        const out=await router.route(b,m.options,message=>{
          if(typeof message==='string') {send({type:'progress',message});return;}
          if(message.type==='activity'){send(message);return;}
          if(message.type==='checkpoint') {
            const fromInput=message.stats.traceCount===initial.traceCount&&message.stats.viaCount===initial.viaCount&&message.stats.unrouted===initial.unrouted;
            send({type:'checkpoint',...checkedResult(message.board,b,m.options,m.name,initial,message.stats,fromInput),phase:message.phase,pass:message.pass,counters:message.counters});return;
          }
          const data={type:'progress',phase:message.phase,pass:message.pass,message:message.message,activity:message.activity,log:message.log,counters:message.counters};
          if(message.board && Date.now()-lastPreview>1200) {
            const connection=geo.connectivity(message.board);
            lastPreview=Date.now();data.board=message.board;data.preview=geometry(message.board,connection);data.stats=message.stats||stats(message.board,false,connection);
          } else if(message.stats) data.stats=message.stats;
          send(data);
        },()=>cancelled||Date.now()>=deadline);
        stage('checking','Routing search finished. Checking the retained result.');
        const result=out?.board||out||b,finalConnection=geo.connectivity(result),finalValidation=geo.validate(result),finalStats=stats(result,true,finalConnection,finalValidation);
        const checked=checkedResult(result,b,m.options,m.name,initial,finalStats,false,!m.options.fanoutOnly,{connection:finalConnection,validation:finalValidation},true);
        const endState=Date.now()>=deadline?'timed_out':(cancelled||out?.stopped?'stopped':'completed');
        const suggestions=endState==='completed'&&finalStats.unrouted>0&&padViaCandidates.size&&finalConnection.components.some(component=>component.groups.length>1&&padViaCandidates.has(component.net))?{viaInPad:true}:{};
        send({type:'done',state:endState,suggestions,counters:out?.counters,...checked,
          message:finalStats.unrouted===0?(finalStats.totalViolations?'All connections routed, but '+finalStats.totalViolations+' rule issue(s) remain. Review them in your PCB editor.':'All connections routed. Verify the exported session in your PCB editor.'):finalStats.unrouted+' connections remain; best checked result retained.'});
      } catch(error) {send({type:'error',error:error.message||String(error),code:error.code,stack:error.stack||''});}
    };
  }
  function launch(type,options,changes) {
    const clearing=type==='clear',editingRules=type==='layer-rules',transactional=clearing||editingRules;
    const saved=transactional?{job,board,preview,exports,bestChecked,inputText}:null;
    const routingCleared=!!job?.routingCleared,layerRulesChanged=!!job?.layerRulesChanged,layerRuleSummary=job?.layerRuleSummary||null;
    kill();
    clearTransaction=clearing?saved:null;ruleTransaction=editingRules?saved:null;
    if(!transactional) {exports=null;preview=null;board=null;bestChecked=null;}
    const id=++serial;
    const source='"use strict";\n'+[createRamenDSN,createRamenGeometry,createRamenOptimizer,createRamenFanout,createRamenRouter,createRamenAdvisor,workerMain].map(fn=>fn.toString()).join('\n')+'\nworkerMain();';
    job={id:String(id),name:job?.name||'board.dsn',state:clearing?'clearing':editingRules?'updating_rules':type==='inspect'?'inspecting':'starting',phase:clearing?'clearing':editingRules?'updating_rules':'loading',startedAt:Date.now(),settings:options,stats:transactional?saved.job.stats:null,initialStats:null,error:null,clearError:null,ruleError:null,hasOutput:false,routingCleared,layerRulesChanged,layerRuleSummary,routingSummary:transactional?routingSummary(board):null,suggestions:{},advice:{items:[]},bestResult:{available:false},revision:0,pass:0};
    job.routingRulesChanged=layerRulesChanged;job.routingRuleSummary=layerRuleSummary;
    job.operation=type;job.counters=null;
    job.deadlineAt=job.startedAt+(type==='run'?options.timeoutMinutes*60000:120000);
    job.lastEngineUpdateAt=null;
    job.activity={message:'Starting browser worker…',phase:job.phase,updatedAt:job.startedAt,source:'host',visual:null,sequence:++activitySequence};
    try {
      workerUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      worker=new Worker(workerUrl);
    } catch(error) {
      if(clearing)restoreBeforeClear('Routing could not be cleared: '+error.message,error.message);
      if(editingRules)restoreBeforeRules('Routing rules could not be updated: '+error.message,error.message);
      throw error;
    }
    worker.onmessage=e=>{
      if(id!==serial||!job||!active.has(job.state))return;
      const m=e.data;
      job.lastEngineUpdateAt=Date.now();
      if(m.counters){job.counters=m.counters;job.pass=m.counters.attempt?.current??job.pass;}
      if(m.type==='activity'||m.message)job.activity={...(m.activity||{}),visual:m.activity?.visual||null,message:String(m.message||m.activity?.visual?.label||'Working on the board'),phase:m.phase||job.phase,updatedAt:job.lastEngineUpdateAt,source:'engine',sequence:++activitySequence};
      // Spatial updates are small and independent of logs, statistics and board previews.
      if(m.type==='activity'){if(m.phase&&!transactional)job.phase=m.phase;notifyActivity();return;}
      if(m.type==='progress'&&transactional){if(m.message&&m.log!==false)log(m.message);notify();return;}
      if(editingRules) {
        if(m.type==='error') {restoreBeforeRules('Routing rules could not be updated: '+m.error,m.error);return;}
        if(m.type!=='rules-updated')return;
        if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked||typeof m.editedInput!=='string') {
          restoreBeforeRules('Routing rules could not be updated: the worker did not return a checked result.','The worker did not return a checked result.');return;
        }
        board=m.board;preview=m.preview;exports=m.exports;inputText=m.editedInput;
        job.stats=m.stats;job.initialStats=m.stats;job.routingSummary=routingSummary(board);updateLayerRules();
        job.advice=m.advice||{items:[]};job.hasOutput=true;
        job.state='ready';job.phase='ready';job.endedAt=Date.now();job.revision++;
        rememberChecked(m);ruleTransaction=null;kill();
        log('Routing rules updated. Existing input routing is retained. Start routing when ready.');
        if(job.layerRuleSummary.conflictingTraces)log(job.layerRuleSummary.conflictingTraces+' imported trace(s) are on disallowed layers. Clear routing & start over, or change these rules.');
        if(job.layerRuleSummary.inaccessiblePads)log(job.layerRuleSummary.inaccessiblePads+' pad(s) have no copper on a selected trace layer and may need a permitted via or a different layer selection.');
        for(const warning of m.warnings||[])log('Input note: '+warning);
        notify();return;
      }
      if(clearing) {
        if(m.type==='error') {restoreBeforeClear('Routing could not be cleared: '+m.error,m.error);return;}
        if(m.type!=='cleared')return;
        if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked||typeof m.clearedInput!=='string'||m.board.traces?.length!==0||m.board.vias?.length!==0) {
          restoreBeforeClear('Routing could not be cleared: the worker did not return a checked, empty result.','The worker did not return a checked, empty result.');return;
        }
        board=m.board;preview=m.preview;exports=m.exports;inputText=m.clearedInput;
        job.stats=m.stats;job.initialStats=m.stats;job.routingSummary=routingSummary(board);updateLayerRules();
        job.advice=m.advice||{items:[]};job.hasOutput=true;job.routingCleared=true;
        job.state='ready';job.phase='ready';job.endedAt=Date.now();job.revision++;
        rememberChecked(m);clearTransaction=null;kill();
        log('All traces and routing vias cleared. Components, pads, connections and design rules are unchanged. Ready to route again.');
        notify();return;
      }
      if(m.type==='checkpoint') {
        rememberChecked(m);
        job.phase=m.phase||'routing';
        job.activity={message:'Saved checked result: '+m.stats.unrouted+' connections remaining.',phase:m.phase||'routing',updatedAt:job.lastEngineUpdateAt,source:'engine',visual:null,sequence:++activitySequence};
        if(!job.lastCheckpointLogAt||Date.now()-job.lastCheckpointLogAt>=5000){log(job.activity.message);job.lastCheckpointLogAt=Date.now();}
        notify();return;
      }
      if(m.message&&m.log!==false)log(m.message);
      if(m.board) {board=m.board;job.routingSummary=routingSummary(board);updateLayerRules();}
      if(m.preview) {preview=m.preview;job.revision++;}
      if(m.stats)job.stats={...job.stats,...m.stats};
      if(m.phase)job.phase=m.phase;
      if(m.pass!==undefined&&!job.counters)job.pass=m.pass;
      if(m.type==='loaded') {
        if(importedNetRules===null)importedNetRules=Object.fromEntries(netLayerSettings(board).nets.map(net=>[net.id,{layers:net.allowedLayers.slice(),preferShort:net.preferShort}]));
        updateLayerRules();
        job.initialStats=m.stats;
        rememberChecked({...m,advice:m.checkpointAdvice||m.advice});
        job.advice=m.advice||{items:[]};
        log('Loaded '+job.name+': '+m.stats.netCount+' nets, '+m.stats.unrouted+' incomplete connections.');
        for(const w of m.warnings||[])log('Input note: '+w);
        if(type==='run'&&job.state!=='stopping') {job.state='running';job.phase='routing';}
      }
      if(m.type==='ready') {job.state=job.stopReason||'ready';job.phase=job.state;job.endedAt=Date.now();kill();}
      if(m.type==='done') {
        rememberChecked(m);exports=m.exports;job.hasOutput=true;job.state=job.stopReason||m.state;job.phase=job.state;job.endedAt=Date.now();
        job.suggestions=job.state==='completed'?(m.suggestions||{}):{};
        job.advice=m.advice||{items:[]};
        log('Checked result: '+job.stats.unrouted+' incomplete, '+(job.stats.totalViolations??job.stats.clearanceViolations)+' rule issues, '+job.stats.belowNominalWidthTraceCount+' undersized traces.');
        kill();
      }
      if(m.type==='error') {if(m.code==='NET_LAYER_CONFLICT'&&bestChecked?.fromInput){board=bestChecked.board;preview=bestChecked.preview;exports=bestChecked.exports;job.stats={...bestChecked.stats};job.routingSummary=routingSummary(board);updateLayerRules();job.advice=bestChecked.advice;job.hasOutput=true;job.revision++;}job.state='error';job.phase='error';job.error=m.error;job.endedAt=Date.now();log('Error: '+m.error);if(m.stack)log(m.stack);kill();}
      notify();
    };
    worker.onerror=e=>{if(id!==serial||!job||!active.has(job.state))return;const message=e.message||'Browser worker failed to start. Use a current Chrome, Edge or Firefox browser.';if(clearing){restoreBeforeClear('Routing could not be cleared: '+message,message);return;}if(editingRules){restoreBeforeRules('Routing rules could not be updated: '+message,message);return;}job.error=message;job.state='error';job.phase='error';job.endedAt=Date.now();log(job.error);kill();notify();};
    try {worker.postMessage({type,text:inputText,name:job.name,options,changes,deadlineAt:job.deadlineAt});}
    catch(error) {if(clearing)restoreBeforeClear('Routing could not be cleared: '+error.message,error.message);if(editingRules)restoreBeforeRules('Routing rules could not be updated: '+error.message,error.message);throw error;}
    const timeLimit=Math.max(0,job.deadlineAt-Date.now());
    timer=setTimeout(()=>{if(id===serial&&job&&active.has(job.state))stopWithBest('timed_out','Time budget reached.');},timeLimit);
    watchdog=setTimeout(()=>{if(id===serial&&job&&active.has(job.state))stopWithBest('timed_out','The worker exceeded its time budget and was terminated.');},timeLimit+30000);
    notify();return state();
  }
  function requireIdle(){if(job&&active.has(job.state))throw new Error('Stop the current operation before starting another.');}
  async function importText(text,name) {
    requireIdle();if(typeof text!=='string'||!text.trim())throw new Error('The DSN file is empty.');
    if(text.length>64*1024*1024)throw new Error('The DSN file is larger than 64 MiB.');
    if(!/\.dsn$/i.test(name))throw new Error('Choose a Specctra .dsn file.');
    inputText=text;job={name};importedNetRules=null;logs.length=0;
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
    if(endpoint==='/api/routing-rules'||endpoint==='/api/net-layers') {
      requireIdle();
      if(!inputText||!board||!job)throw new Error('Load a board before choosing routing rules.');
      const method=String(options.method||'GET').toUpperCase();
      if(method==='GET')return netLayerSettings(board);
      if(method!=='POST')throw new Error('Routing rule changes require a confirmed POST action.');
      if(typeof data?.jobId!=='string'||data.jobId!==job.id)throw new Error('The selected board changed. Review its routing rules again.');
      if(!Array.isArray(data.changes))throw new Error('Choose the nets and their routing rules.');
      const settings=netLayerSettings(board),nets=new Map(settings.nets.map(net=>[net.id,net]));
      const layerIds=new Set(settings.layers.map(layer=>layer.id)),seen=new Set();
      for(const change of data.changes) {
        if(!change||!Number.isInteger(change.netId)||!nets.has(change.netId))throw new Error('A selected net is unknown. Reload the routing rules.');
        if(seen.has(change.netId))throw new Error('Each net may only be changed once.');
        seen.add(change.netId);
        const hasLayers=Object.prototype.hasOwnProperty.call(change,'layers'),hasShort=Object.prototype.hasOwnProperty.call(change,'preferShort');
        if(!hasLayers&&!hasShort)throw new Error('Choose a routing rule to change.');
        if(hasShort&&typeof change.preferShort!=='boolean')throw new Error('The shorter-route preference must be true or false.');
        if(hasLayers) {
          if(!Array.isArray(change.layers)||!change.layers.length)throw new Error('Every net needs at least one allowed layer.');
          if(change.layers.some(layer=>!Number.isInteger(layer)||!layerIds.has(layer)))throw new Error('Choose only existing copper layers.');
          if(new Set(change.layers).size!==change.layers.length)throw new Error('An allowed layer cannot be listed twice.');
        }
      }
      const changes=data.changes.filter(change=>{const current=nets.get(change.netId);return (Object.prototype.hasOwnProperty.call(change,'layers')&&(current.allowedLayers.length!==change.layers.length||current.allowedLayers.some(layer=>!change.layers.includes(layer))))||
        (Object.prototype.hasOwnProperty.call(change,'preferShort')&&current.preferShort!==change.preferShort);});
      if(!changes.length)return state();
      log('Updating routing rules. The board will return to its input routing.');
      return launch('layer-rules',getSettings(job.settings),changes);
    }
    if(endpoint==='/api/run') {
      requireIdle();if(!inputText)throw new Error('Load a board first.');const settings=getSettings(data||{});logs.length=0;
      log(job?.routingCleared?'Starting browser-native routing from the cleared board. Nominal trace widths are preserved.':'Starting browser-native routing. Original input and nominal trace widths are preserved.');
      if(settings.viaInPad)log('Explicit rule override: vias may attach to SMD pads.');
      return launch('run',settings);
    }
    if(endpoint==='/api/clear-routing') {
      if(String(options.method||'GET').toUpperCase()!=='POST')throw new Error('Clear routing requires a confirmed POST action.');
      requireIdle();
      if(!inputText||!board||!job)throw new Error('Load a board before clearing its routing.');
      if(typeof data?.jobId!=='string'||data.jobId!==job.id)throw new Error('The selected board changed. Review it and confirm clearing again.');
      if(!board.traces.length&&!board.vias.length)throw new Error('This board has no traces or routing vias to clear.');
      log('Clearing all traces and routing vias, including fixed and protected routing.');
      return launch('clear',getSettings(job.settings));
    }
    if(endpoint==='/api/stop') {
      if(!job||!active.has(job.state))return state();
      return stopWithBest(job.stopReason||'stopped','Stopped immediately.');
    }
    if(endpoint==='/api/download') {
      const type=params.get('type')||'ses',result=getDownload(type);
      return {blob:result.blob,disposition:'attachment; filename="'+result.filename+'"'};
    }
    if(endpoint==='/api/quit') {kill();serial++;job=null;board=null;preview=null;exports=null;bestChecked=null;clearTransaction=null;ruleTransaction=null;importedNetRules=null;inputText=null;logs.length=0;notify();return state();}
    throw new Error('Unknown local action.');
  }
  function getDownload(type) {
    if(!['ses','dsn','log','report'].includes(type))throw new Error('Unknown export type.');
    if(!job)throw new Error('No board is loaded.');
    if(type!=='log'&&(!exports||active.has(job.state)))throw new Error('A checked route is not ready to export.');
    const text=type==='log'?logs.join('\n')+'\n':exports[type];
    const stem=job.name.replace(/\.dsn$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
    const filename=stem+(type==='log'?'-routing.log':type==='report'?'-checks.json':job.routingCleared&&job.state==='ready'?'-unrouted.'+type:'-routed.'+type);
    return {blob:new Blob([text],{type:type==='report'?'application/json':'text/plain;charset=utf-8'}),filename};
  }
  function download(type) {
    const {blob,filename}=getDownload(type),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return filename;
  }
  globalThis.RamenNative={request,download,subscribeActivity(fn){activitySubscribers.add(fn);return()=>activitySubscribers.delete(fn);},subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);}};
  window.addEventListener('beforeunload',event=>{if(job&&active.has(job.state)){event.preventDefault();event.returnValue='';}});
})();
