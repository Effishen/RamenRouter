/* Checked off-grid fanout for the browser engine. GPL-3.0. */
function createRamenFanout(geometry) {
  'use strict';
  const G=geometry,EPS=1e-7,copy=x=>JSON.parse(JSON.stringify(x));
  const dot=(p,v)=>p[0]*v[0]+p[1]*v[1];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  function axisFor(shape) {
    if(shape.type!=='polygon'||shape.points.length<3)return null;
    let longest=0,axis=null;
    for(let i=0;i<shape.points.length;i++){const a=shape.points[i],b=shape.points[(i+1)%shape.points.length],length=dist(a,b);if(length>longest){longest=length;axis=[(b[0]-a[0])/length,(b[1]-a[1])/length];}}
    if(!axis)return null;if(axis[0]<-EPS||Math.abs(axis[0])<=EPS&&axis[1]<0)axis=axis.map(v=>-v);
    const tangent=[-axis[1],axis[0]],along=shape.points.map(p=>dot(p,axis)),across=shape.points.map(p=>dot(p,tangent));
    const longSpan=Math.max(...along)-Math.min(...along),shortSpan=Math.max(...across)-Math.min(...across);
    return {axis,tangent,longSpan,shortSpan,ratio:longSpan/Math.max(shortSpan,EPS)};
  }
  async function fanout(input,options={},emit=()=>{},isCancelled=()=>false) {
    const board=copy(input),log=[],started=Date.now(),deadline=started+(options.timeoutMinutes||30)*60000;
    if(options.viaInPad){board.viaAtSmd=true;board.viaInPadApplied=true;for(const def of board.viaDefs)def.attachAllowed=true;}
    const cancelled=()=>isCancelled()||Date.now()>deadline;
    let lastDetail=0;
    const detail=(message,activity={},force=false)=>{const now=Date.now();if(!force&&now-lastDetail<1200)return;lastDetail=now;emit({type:'progress',phase:'fanout',message,activity});};
    const pause=()=>new Promise(r=>setTimeout(r,0));
    detail('Checking pads and existing copper for fanout',{stage:'fanout-prepare',processed:0,total:board.pads.length},true);await pause();
    const nets=new Map(board.nets.map(n=>[n.id,n])),defs=new Map(board.viaDefs.map(v=>[v.name,v]));
    const traceLayers=net=>net.useLayers||board.layers.map(l=>l.index);
    const padCounts=new Map(board.nets.map(n=>[n.id,board.pads.filter(p=>p.net===n.id).length]));
    const baseValidation=G.validate(board),edges=G.boundaryEdges(board),primitives=G.copper(board).primitives;
    const span=Math.max(board.bounds.maxX-board.bounds.minX,board.bounds.maxY-board.bounds.minY),cell=Math.max(span/60,.01);
    const indices=new Map(board.layers.map(l=>[l.index,G.spatialIndex([],cell)]));
    for(const p of primitives)indices.get(p.layer)?.insert(p);
    const initialTraces=board.traces.length,initialVias=board.vias.length;
    const attached=new Set();
    for(const c of G.connectivity(board).components)for(const group of c.groups)for(const id of group.pads){
      const pad=board.pads.find(p=>p.id===id),net=nets.get(c.net);
      if(pad&&net&&group.points.some(p=>traceLayers(net).includes(p[2])&&!pad.shapes.some(s=>s.layer===p[2])))attached.add(id);
    }
    const shapes=board.pads.filter(p=>p.net&&new Set(p.shapes.map(s=>s.layer)).size===1&&padCounts.get(p.net)>1).map(p=>({pad:p,shape:p.shapes[0],geometry:axisFor(p.shapes[0]),net:nets.get(p.net)})).filter(p=>{
      const def=p.net&&defs.get(p.net.viaName);
      return def&&traceLayers(p.net).some(l=>l!==p.shape.layer&&l>=def.fromLayer&&l<=def.toLayer);
    });
    const allPadShapes=board.pads.flatMap(p=>p.shapes.map(s=>({pad:p,shape:s,box:G.shapeBounds(s)})));
    function sameNet(a,b){return a!=null&&a===b;}
    const clearance=net=>nets.get(net)?.routingClearance??nets.get(net)?.clearance??board.defaultClearance??0;
    const maxClearance=Math.max(board.crossClassClearance||0,board.defaultClearance||0,...board.nets.map(n=>clearance(n.id)),...Object.values(board.classClearances||{}));
    function itemPrimitives(bundle) {
      const out=[];
      for(const t of bundle.traces)for(let i=1;i<t.points.length;i++){const shape={type:'capsule',a:t.points[i-1],b:t.points[i],r:t.width/2,layer:t.layer};out.push({shape,layer:t.layer,net:t.net,bounds:G.shapeBounds(shape),kind:'trace'});}
      for(const v of bundle.vias)for(const layer of v.layers){const shape={type:'circle',cx:v.x,cy:v.y,r:v.diameter/2,layer};out.push({shape,layer,net:v.net,bounds:G.shapeBounds(shape),kind:'via',via:v});}
      return out;
    }
    function clearPrimitive(p,temporary=[]) {
      if(!G.shapeInsideBoard(p.shape,board,edges))return false;
      const radius=clearance(p.net),near=indices.get(p.layer)?.query(p.bounds,maxClearance)||[];
      for(const q of near.concat(temporary.filter(q=>q.layer===p.layer))){
        const distance=G.distanceShapes(p.shape,q.shape),otherNet=q.net;
        if(!sameNet(p.net,otherNet)){if(distance+EPS<G.clearance(board,nets.get(p.net),nets.get(otherNet))||distance<EPS)return false;}
        else if(p.kind==='via'&&distance<=EPS){
          const pad=q.object?.kind==='pad'?q.object.item:null;
          if(pad&&new Set(pad.shapes.map(s=>s.layer)).size===1&&!(board.viaAtSmd&&defs.get(p.via.padstack)?.attachAllowed!==false))return false;
        }
      }
      for(const k of board.keepouts||[]){if(k.layers&&!k.layers.includes(p.layer)||k.kind==='via'&&p.kind!=='via')continue;const distance=G.distanceShapes(p.shape,k.shape);if(distance+EPS<(k.clearance??radius)||distance<=EPS)return false;}
      return true;
    }
    function legalBundle(bundle,temporary=[]) {return bundle.traces.every(t=>traceLayers(nets.get(t.net)).includes(t.layer))&&itemPrimitives(bundle).every(p=>clearPrimitive(p,temporary));}
    function bundleFor(entry,end,normal,shoulder) {
      const p=entry.pad,net=entry.net,def=defs.get(net.viaName),layer=entry.shape.layer;
      const points=[[p.x,p.y]];
      if(shoulder>EPS)points.push([p.x+normal[0]*shoulder,p.y+normal[1]*shoulder]);
      if(dist(points[points.length-1],end)>EPS)points.push(end);
      const trace={net:net.id,layer,width:net.width,points,fixed:false,fanout:true};
      const via={x:end[0],y:end[1],net:net.id,padstack:def.name,diameter:def.diameter,layers:Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i),fixed:false,fanout:true};
      if(layer<def.fromLayer||layer>def.toLayer||points.length>1&&!traceLayers(net).includes(layer))return null;
      return {traces:points.length>1?[trace]:[],vias:[via],pads:[p.id]};
    }
    function commit(bundle){
      board.traces.push(...bundle.traces);board.vias.push(...bundle.vias);
      for(const p of itemPrimitives(bundle))indices.get(p.layer)?.insert(p);
      for(const id of bundle.pads)attached.add(id);
    }
    // A row is inferred from nearby, parallel elongated pads, never component IDs.
    const buckets=[];
    for(const entry of shapes){if(!traceLayers(entry.net).includes(entry.shape.layer)||!entry.geometry||entry.geometry.ratio<1.6)continue;
      // Compare directions directly: angular rounding splits a 45-degree row
      // across adjacent bins when floating-point error straddles a bin edge.
      let bucket=buckets.find(b=>b.layer===entry.shape.layer&&dot(b.axis,entry.geometry.axis)>Math.cos(Math.PI/90));
      if(!bucket){bucket={layer:entry.shape.layer,axis:entry.geometry.axis,entries:[]};buckets.push(bucket);}bucket.entries.push(entry);
    }
    const rows=[];
    for(const record of buckets){const bucket=record.entries;
      const axis=bucket[0].geometry.axis,tangent=[-axis[1],axis[0]];
      const sorted=bucket.map(e=>({...e,n:dot([e.pad.x,e.pad.y],axis),t:dot([e.pad.x,e.pad.y],tangent)})).sort((a,b)=>a.n-b.n);
      const lines=[];
      for(const e of sorted){let line=lines.find(l=>Math.abs(l[0].n-e.n)<Math.min(e.net.width,l[0].net.width)*.12);if(!line){line=[];lines.push(line);}line.push(e);}
      for(const line of lines){line.sort((a,b)=>a.t-b.t);let run=[];
        for(const e of line){const prev=run[run.length-1],threshold=prev?Math.max(defs.get(e.net.viaName).diameter,defs.get(prev.net.viaName).diameter)+Math.max(clearance(e.net.id),clearance(prev.net.id))+Math.max(e.net.width,prev.net.width)*.15:Infinity;
          if(prev&&e.t-prev.t>threshold){if(run.length>=3)rows.push({entries:run,axis,tangent});run=[];}run.push(e);
        }if(run.length>=3)rows.push({entries:run,axis,tangent});
      }
    }
    rows.sort((a,b)=>b.entries.length-a.entries.length);
    let rowCount=0,rowIndex=0;
    detail('Preparing SMD escapes · '+shapes.length+' eligible pads · '+rows.length+' dense rows',{stage:'fanout-rows',processed:0,total:rows.length},true);
    for(const row of rows){if(cancelled())break;rowIndex++;
      detail('Preparing dense row '+rowIndex+'/'+rows.length+' · '+row.entries.length+' pads',{stage:'fanout-rows',processed:rowIndex,total:rows.length});
      const entries=row.entries.filter(e=>!attached.has(e.pad.id));if(entries.length<2)continue;
      const width=Math.max(...entries.map(e=>e.net.width)),normalHalf=Math.max(...entries.map(e=>e.geometry.longSpan/2));
      const pitch=Math.max(...entries.map(e=>defs.get(e.net.viaName).diameter+clearance(e.net.id)))+Math.max(.02,width*.025);
      const centerT=(entries[0].t+entries[entries.length-1].t)/2,centerN=entries.reduce((s,e)=>s+e.n,0)/entries.length;
      let best=null;const choices=entries.map(()=>[]);
      for(const sign of [1,-1]){
        const normal=row.axis.map(v=>v*sign);
        for(const multiplier of [3,4,5,6,8,10,12]){
          if(cancelled())break;
          const offset=Math.max(normalHalf+width,multiplier*width),shoulder=normalHalf+width*.55;
          for(const shift of [0,-width*.5,width*.5]){
            const bundle={traces:[],vias:[],pads:[]},temporary=[];
            for(let i=0;i<entries.length;i++){
              const entry=entries[i],t=centerT+(i-(entries.length-1)/2)*pitch+shift;
              const end=[row.axis[0]*(centerN+sign*offset)+row.tangent[0]*t,row.axis[1]*(centerN+sign*offset)+row.tangent[1]*t];
              const candidate=bundleFor(entry,end,normal,Math.min(shoulder,offset));
              if(candidate&&legalBundle(candidate))choices[i].push(candidate);if(candidate&&legalBundle(candidate,temporary)){bundle.traces.push(...candidate.traces);bundle.vias.push(...candidate.vias);bundle.pads.push(...candidate.pads);temporary.push(...itemPrimitives(candidate));}
            }
            if(!best||bundle.pads.length>best.pads.length)best=bundle;
            if(bundle.pads.length===entries.length)break;
          }
          if(best?.pads.length===entries.length)break;
          detail('Trying dense-row escapes · row '+rowIndex+'/'+rows.length+' · '+(best?.pads.length||0)+'/'+entries.length+' pads placed',{stage:'fanout-row-escapes',processed:rowIndex,total:rows.length,placed:best?.pads.length||0,pads:entries.length});await pause();
        }
        if(best?.pads.length===entries.length)break;
      }
      if(best&&best.pads.length<entries.length&&entries.length<=12&&!cancelled()){
        const rowDeadline=Math.min(deadline,Date.now()+15000);
        // Reconsider each checked escape as a constraint choice; a whole row
        // need not put every via on the same normal-distance line.
        for(let i=0;i<entries.length;i++){
          if(cancelled()||Date.now()>rowDeadline)break;
          await pause();
          const entry=entries[i];let candidates=0,lastCandidateYield=Date.now();
          detail('Checking escape positions · '+entry.net.name+' · pad '+(i+1)+'/'+entries.length,{stage:'fanout-candidates',netId:entry.net.id,netName:entry.net.name,processed:i+1,total:entries.length});
          candidateSearch:for(const sign of [1,-1])for(const offsetFactor of [2,2.5,3,3.5,4,4.5,5,6,7,8,10,12])for(const deltaFactor of [-2,-1.5,-1,-.75,-.5,-.25,0,.25,.5,.75,1,1.5,2])for(const shoulderFactor of [.05,.3,.55]){
            const normal=row.axis.map(v=>v*sign),offset=offsetFactor*width,t=entry.t+deltaFactor*width;
            const end=[row.axis[0]*(centerN+sign*offset)+row.tangent[0]*t,row.axis[1]*(centerN+sign*offset)+row.tangent[1]*t];
            const candidate=bundleFor(entry,end,normal,Math.min(entry.geometry.longSpan/2+width*shoulderFactor,offset));
            if(candidate&&legalBundle(candidate))choices[i].push(candidate);
            if(++candidates%64===0){detail('Checking escape positions · '+entry.net.name+' · '+candidates+' candidates',{stage:'fanout-candidates',netId:entry.net.id,netName:entry.net.name,processed:i+1,total:entries.length,candidates});if(Date.now()-lastCandidateYield>=24){await pause();lastCandidateYield=Date.now();}if(cancelled())break candidateSearch;}
          }
        }
        const all=choices.map(list=>{const seen=new Set();return list.filter(b=>{const v=b.vias[0],k=[v.x,v.y,...b.traces.flatMap(t=>t.points.flat())].join('|');if(seen.has(k))return false;seen.add(k);b._primitives=itemPrimitives(b);return true;});});
        for(const list of all)list.sort((a,b)=>{const cost=x=>x.traces.reduce((s,t)=>s+t.points.slice(1).reduce((v,p,i)=>v+dist(p,t.points[i]),0),0);return cost(a)-cost(b);});
        let work=0,complete=null,uid=0,exhausted=false;
        for(const list of all)for(const b of list)b._uid=uid++;
        const checked=new Map();
        const compatible=(a,b)=>{
          const k=a._uid*uid+b._uid;
          if(checked.has(k))return checked.get(k);
          const valid=a._primitives.every(p=>b._primitives.every(q=>{
            if(p.layer!==q.layer||sameNet(p.net,q.net))return true;
            const distance=G.distanceShapes(p.shape,q.shape);
            return distance>=EPS&&distance+EPS>=G.clearance(board,nets.get(p.net),nets.get(q.net));
          }));
          if(checked.size>=500000)checked.clear();
          checked.set(k,valid);return valid;
        };
        async function searchChoices(domains,chosen){
          if(++work>12000||cancelled()||Date.now()>rowDeadline){exhausted=true;return;}
          if(complete)return;
          if(!domains.length){complete=chosen;return;}
          if(work%128===0){detail('Fitting dense-row escapes · row '+rowIndex+'/'+rows.length+' · '+work+' combinations checked',{stage:'fanout-combinations',processed:rowIndex,total:rows.length,combinations:work});await pause();}
          domains.sort((a,b)=>a.length-b.length);
          if(!domains[0].length)return;
          for(const candidate of domains[0]){
            if(complete||exhausted)break;
            const remaining=domains.slice(1).map(d=>d.filter(other=>compatible(candidate,other)));
            await searchChoices(remaining,chosen.concat(candidate));
          }
        }
        await searchChoices(all,[]);
        if(complete){best={traces:complete.flatMap(b=>b.traces),vias:complete.flatMap(b=>b.vias),pads:complete.flatMap(b=>b.pads)};}
      }
      if(best&&best.pads.length){commit(best);rowCount++;detail('Checked off-grid fanout · '+(board.vias.length-initialVias)+' new escape vias · row '+rowIndex+'/'+rows.length,{stage:'fanout-rows',processed:rowIndex,total:rows.length,addedVias:board.vias.length-initialVias});}
      await new Promise(r=>setTimeout(r,0));
    }
    // Compact isolated pads and enclosed thermal pads get a conservative local search.
    let padIndex=0;detail('Checking remaining SMD pad escapes',{stage:'fanout-pads',processed:0,total:shapes.length},true);
    for(const entry of shapes){if(cancelled())break;padIndex++;if(padIndex%32===0){detail('Checking SMD pads · '+padIndex+'/'+shapes.length,{stage:'fanout-pads',processed:padIndex,total:shapes.length});await pause();if(cancelled())break;}if(attached.has(entry.pad.id))continue;
      detail('Trying pad escape · '+entry.net.name+' · '+padIndex+'/'+shapes.length,{stage:'fanout-pads',netId:entry.net.id,netName:entry.net.name,processed:padIndex,total:shapes.length});
      const box=G.shapeBounds(entry.shape),shortSpan=Math.min(box.maxX-box.minX,box.maxY-box.minY),net=entry.net,p=entry.pad;
      let neighbours=0;for(const q of allPadShapes)if(q.shape.layer===entry.shape.layer&&q.pad.net!==p.net&&G.distanceShapes(entry.shape,q.shape)<net.width+clearance(net.id))neighbours++;
      const padLayerAllowed=traceLayers(net).includes(entry.shape.layer);
      if(padLayerAllowed&&shortSpan>net.width*1.3&&neighbours<6)continue;
      const axis=entry.geometry?.axis||[1,0],tangent=[-axis[1],axis[0]],directions=[axis,axis.map(v=>-v),tangent,tangent.map(v=>-v)];
      let found=null;
      if(board.viaAtSmd&&defs.get(net.viaName).attachAllowed!==false){const b=bundleFor(entry,[p.x,p.y],[1,0],0);if(b&&legalBundle(b))found=b;}
      if(padLayerAllowed)for(const multiplier of [2,3,4,6,8,10]){if(found)break;for(const direction of directions){const end=[p.x+direction[0]*net.width*multiplier,p.y+direction[1]*net.width*multiplier],b=bundleFor(entry,end,direction,0);if(b&&legalBundle(b)){found=b;break;}}}
      if(found)commit(found);
      await new Promise(r=>setTimeout(r,0));
    }
    detail('Checking completed fanout clearances and connectivity',{stage:'fanout-check',addedVias:board.vias.length-initialVias},true);await pause();
    const validation=G.validate(board);
    if(validation.totalViolations>baseValidation.totalViolations||validation.belowNominalWidthTraceCount>baseValidation.belowNominalWidthTraceCount){
      log.push('Fanout rejected: final geometric validation found new rule violations.');
      return {board:copy(input),addedVias:0,addedTraces:0,log,stopped:cancelled()};
    }
    log.push('Checked geometric fanout: '+(board.vias.length-initialVias)+' vias and '+(board.traces.length-initialTraces)+' full-width stubs across '+rowCount+' dense rows.');
    emit({type:'progress',phase:'fanout',message:log[log.length-1],board:copy(board),stats:G.stats(board,validation)});
    return {board,addedVias:board.vias.length-initialVias,addedTraces:board.traces.length-initialTraces,log,stopped:cancelled()};
  }
  return {fanout};
}
globalThis.createRamenFanout=createRamenFanout;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenFanout};
