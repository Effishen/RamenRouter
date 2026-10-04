/* RamenRouter browser-native grid router. GPL-3.0. No Java or external runtime. */
function createRamenRouter(geometry, optimizer, fanout) {
  'use strict';
  const G=geometry, SQRT2=Math.SQRT2, EPS=1e-7;
  const copy=o=>JSON.parse(JSON.stringify(o));
  const yieldNow=()=>new Promise(r=>setTimeout(r,0));
  const length=t=>t.points.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-t.points[i][0],p[1]-t.points[i][1]),0);
  function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let x=Math.imul(seed^seed>>>15,1|seed);x=x+Math.imul(x^x>>>7,61|x)^x;return((x^x>>>14)>>>0)/4294967296;};}
  function shuffled(a,random){a=a.slice();for(let i=a.length-1;i>0;i--){let j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
  function netRules(board){return new Map(board.nets.map(n=>[n.id,n]));}
  function bboxPoints(points){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}return{minX,minY,maxX,maxY};}
  function overlap(a,b){return a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY;}
  function expanded(b,r){return{minX:b.minX-r,minY:b.minY-r,maxX:b.maxX+r,maxY:b.maxY+r};}
  function segmentDistance(x,y,a,b){let dx=b[0]-a[0],dy=b[1]-a[1],v=dx*dx+dy*dy,t=v?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/v)):0;return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);}
  function simplify(points){if(points.length<3)return points;let out=[points[0]];for(let i=1;i<points.length-1;i++){let a=out[out.length-1],b=points[i],c=points[i+1],cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);if(Math.abs(cross)>1e-8)out.push(b);}out.push(points[points.length-1]);return out;}
  class Heap {
    constructor(){this.nodes=[];this.costs=[];}
    push(node,cost){let i=this.nodes.length;this.nodes.push(node);this.costs.push(cost);while(i){let p=(i-1)>>1;if(this.costs[p]<=cost)break;this.nodes[i]=this.nodes[p];this.costs[i]=this.costs[p];i=p;}this.nodes[i]=node;this.costs[i]=cost;}
    pop(){if(!this.nodes.length)return null;let n=this.nodes[0],f=this.costs[0],last=this.nodes.pop(),cost=this.costs.pop();if(this.nodes.length){let i=0;while(true){let l=i*2+1;if(l>=this.nodes.length)break;let r=l+1,c=r<this.nodes.length&&this.costs[r]<this.costs[l]?r:l;if(this.costs[c]>=cost)break;this.nodes[i]=this.nodes[c];this.costs[i]=this.costs[c];i=c;}this.nodes[i]=last;this.costs[i]=cost;}return[n,f];}
  }
  async function route(input,options={},emit=()=>{},isCancelled=()=>false){
    const started=Date.now(),timeout=(options.timeoutMinutes||30)*60000,log=[];
    const stopped=()=>isCancelled()||Date.now()-started>=timeout;
    const say=(message,extra={})=>{log.push(message);emit({type:'progress',message,...extra});};
    // Detail updates carry counters only. Board copies and geometric checks are
    // reserved for previews/checkpoints, keeping a busy worker cheap to observe.
    let lastDetail=0,lastPreview=0,routeActivity={};
    const detail=(message,activity={},phase='routing',force=false)=>{
      const now=Date.now();if(!force&&now-lastDetail<1200)return;lastDetail=now;
      emit({type:'progress',phase,pass:routeActivity.pass||0,message,activity:{...routeActivity,...activity}});return true;
    };
    let original=copy(input);original.traces=original.traces||[];original.vias=original.vias||[];
    if(options.viaInPad){original.viaAtSmd=true;original.viaInPadApplied=true;for(const v of original.viaDefs)v.attachAllowed=true;}
    const rules=netRules(original),padCounts=new Map(original.nets.map(n=>[n.id,original.pads.filter(p=>p.net===n.id).length])), nets=original.nets.filter(n=>original.pads.filter(p=>p.net===n.id).length>1);
    function stats(board,checked=true){detail('Checking connected copper',{stage:'connectivity-check'},'checking');let conn=G.connectivity(board);if(checked)detail('Checking copper clearances and routing rules',{stage:'rule-check'},'checking');let v=checked?G.validate(board):null;return{unrouted:conn.unrouted,viaCount:board.vias.length,traceCount:board.traces.length,traceLengthMm:board.traces.reduce((a,t)=>a+length(t),0)*(board.units.mmPerUnit||1),clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?v.totalViolations:null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:0,widthRulesChecked:!!v,netCount:board.nets.length,componentCount:new Set(board.pads.map(p=>p.component)).size,layerCount:board.layers.length};}
    detail('Checking input clearances and connectivity',{stage:'input-check'},'checking',true);await yieldNow();
    const initialStats=stats(original),baseViolation=initialStats.clearanceViolations,baseWidth=initialStats.belowNominalWidthTraceCount,baseTotal=initialStats.totalViolations;
    let originalStats=initialStats;
    if((options.fanout!==false||options.fanoutOnly)&&fanout&&!stopped()){
      say('Preparing checked SMD escapes.',{phase:'fanout',stats:initialStats});
      const prepared=await fanout.fanout(copy(original),options,emit,stopped),candidate=prepared.board||prepared,candidateStats=stats(candidate);
      if(candidateStats.totalViolations<=baseTotal&&candidateStats.belowNominalWidthTraceCount<=baseWidth&&candidateStats.unrouted<=initialStats.unrouted){original=candidate;originalStats=candidateStats;for(const line of prepared.log||[])log.push(line);say('Fanout added '+(prepared.addedVias||0)+' vias and '+(prepared.addedTraces||0)+' full-width escapes.',{phase:'fanout',board:copy(original),stats:candidateStats});}
      else say('Fanout did not pass the full geometry check; keeping the imported board.',{phase:'checking'});
    }
    let best=copy(original),bestStats=originalStats;
    const checkpoint=(pass=0,phase='routing')=>emit({type:'checkpoint',phase,pass,board:copy(best),stats:bestStats});
    // Only fully checked best boards become interruption-safe snapshots. Live
    // progress may contain a worse rip-up attempt and is never a checkpoint.
    checkpoint();
    if(options.fanoutOnly){if(!fanout)throw new Error('The offline fanout module is not loaded.');return{board:best,stats:bestStats,initialStats,log,stopped:stopped()};}
    const span=Math.max(original.bounds.maxX-original.bounds.minX,original.bounds.maxY-original.bounds.minY);
    const widths=original.nets.map(n=>n.width).filter(w=>w>0);
    const narrowest=widths.length?Math.min(...widths):Math.max(span/900,1e-5);
    let step=Number(options.gridStep)||Math.max(narrowest/5,span/900);step=Math.max(step,span/1500,1e-5);
    const bx=original.bounds.minX,by=original.bounds.minY,nx=Math.ceil((original.bounds.maxX-bx)/step)+1,ny=Math.ceil((original.bounds.maxY-by)/step)+1,plane=nx*ny,total=plane*original.layers.length;
    if(total>6000000)throw new Error('Board grid exceeds the browser memory limit. Use a coarser grid.');
    const layerCount=original.layers.length;
    const traceLayers=net=>net.useLayers||original.layers.map(l=>l.index);
    const idx=(x,y,l)=>l*plane+y*nx+x, xy=id=>{let q=id%plane;return[bx+(q%nx)*step,by+Math.floor(q/nx)*step,Math.floor(id/plane)];};
    const boundaryEdges=G.boundaryEdges(original);
    const padShapes=[];for(const p of original.pads)for(const shape of p.shapes)padShapes.push({pad:p,shape,box:G.shapeBounds(shape)});
    const bases=new Map(),maxRasterCaches=Math.max(1,Math.min(4,Math.floor(96000000/(total*6*4))));
    const clearanceOf=n=>n?.routingClearance??n?.clearance??original.defaultClearance??0;
    const maxClearance=Math.max(original.defaultClearance||0,...original.nets.map(clearanceOf),...(original.keepouts||[]).map(k=>k.clearance||0));
    const indexSize=Math.max(narrowest*4,span/60,1e-5);
    const immutable=G.copper(original).primitives.map(p=>({...p,clearance:clearanceOf(rules.get(p.net))}));
    for(const k of original.keepouts||[])if(k.kind!=='via')for(const layer of k.layers||original.layers.map(l=>l.index))immutable.push({shape:{...k.shape,layer},layer,net:null,clearance:k.clearance??null,keepout:true,bounds:G.shapeBounds(k.shape)});
    const staticIndex=Array.from({length:layerCount},(_,l)=>G.spatialIndex(immutable.filter(p=>p.layer===l),indexSize));
    let dynamicIndex=null,indexGeneration=-1;
    function getDynamicIndex(){if(indexGeneration!==generation){const p=G.copper(board).primitives.filter(p=>(p.object.kind==='trace'&&p.object.index>=original.traces.length)||(p.object.kind==='via'&&p.object.index>=original.vias.length));dynamicIndex=Array.from({length:layerCount},(_,l)=>G.spatialIndex(p.filter(p=>p.layer===l),indexSize));indexGeneration=generation;}return dynamicIndex;}
    function exactEdgeClear(a,b,layer,net,soft){
      if(!traceLayers(net).includes(layer))return false;
      const half=net.width/2,box=expanded(bboxPoints([a,b]),half+maxClearance);
      if(!G.shapeInsideBoard({type:'capsule',a,b,r:half,layer},original,boundaryEdges))return false;
      for(const p of staticIndex[layer].query(box)){if(!p.keepout&&p.net===net.id)continue;const clear=p.keepout?(p.clearance??clearanceOf(net)):Math.max(clearanceOf(net),p.clearance||0);if(G.distanceSegmentShape(a[0],a[1],b[0],b[1],p.shape)<half+clear-EPS)return false;}
      if(!soft)for(const p of getDynamicIndex()[layer].query(box)){if(p.net===net.id)continue;const clear=Math.max(clearanceOf(net),clearanceOf(rules.get(p.net)));if(G.distanceSegmentShape(a[0],a[1],b[0],b[1],p.shape)<half+clear-EPS)return false;}
      return true;
    }
    let generation=0,board=copy(original),cache=null,finishing=false,repairRound=0;const ripHistory=new Map();
    const gCost=new Float64Array(total),visited=new Uint32Array(total),closed=new Uint32Array(total),parent=new Int32Array(total);let searchId=0;
    function eachCell(box,layer,fn){let x0=Math.max(0,Math.floor((box.minX-bx)/step)),x1=Math.min(nx-1,Math.ceil((box.maxX-bx)/step)),y0=Math.max(0,Math.floor((box.minY-by)/step)),y1=Math.min(ny-1,Math.ceil((box.maxY-by)/step));for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)fn(idx(x,y,layer),bx+x*step,by+y*step);}
    function put(arr,i,owner){owner=owner>0?owner:-1;if(!arr[i])arr[i]=owner;else if(arr[i]!==owner)arr[i]=-1;}
    function drawShape(arr,shape,r,owner){eachCell(expanded(G.shapeBounds(shape),r),shape.layer,(i,x,y)=>{if(G.distancePointShape(x,y,shape)<r+EPS)put(arr,i,owner);});}
    function drawSegment(arr,a,b,layer,r,owner){eachCell(expanded(bboxPoints([a,b]),r),layer,(i,x,y)=>{if(segmentDistance(x,y,a,b)<r+EPS)put(arr,i,owner);});}
    function drawTrace(arr,t,r,owner){for(let i=1;i<t.points.length;i++)drawSegment(arr,t.points[i-1],t.points[i],t.layer,r,owner);}
    function drawVia(arr,v,r,owner){for(const l of v.layers)eachCell({minX:v.x-r,minY:v.y-r,maxX:v.x+r,maxY:v.y+r},l,(i,x,y)=>{if(Math.hypot(x-v.x,y-v.y)<r+EPS)put(arr,i,owner);});}
    function allowed(arr,id,net){return arr[id]===0||arr[id]===net;}
    function inside(x,y,r){r+=original.edgeClearance||0;if(x<original.bounds.minX+r||x>original.bounds.maxX-r||y<original.bounds.minY+r||y>original.bounds.maxY-r)return false;if(original.outlines.length&&!original.outlines.some(p=>G.pointInPolygon(x,y,p)))return false;for(const hole of original.holes||[])if(G.pointInPolygon(x,y,hole))return false;for(const p of [...original.outlines,...(original.holes||[])])for(let k=0;k<p.length;k++)if(segmentDistance(x,y,p[k],p[(k+1)%p.length])<r-EPS)return false;return true;}
    async function getRaster(net){
      let lastRasterYield=Date.now();
      const via=original.viaDefs.find(v=>v.name===net.viaName)||original.viaDefs[0]||{name:'no-layer-transition',diameter:net.width,fromLayer:0,toLayer:0,attachAllowed:false,disabled:true};
      const key=[net.width,clearanceOf(net),via.name,original.viaAtSmd&&via.attachAllowed].join('|');
      let c=bases.get(key);
      if(!c){
        // Bound cached rule-class rasters so multi-class boards cannot accumulate gigabytes.
        while(bases.size>=maxRasterCaches)bases.delete(bases.keys().next().value);
        detail('Preparing copper and clearance grid for '+net.name,{stage:'grid',netId:net.id,netName:net.name,processed:0,total:layerCount*ny},'rasterizing');
        await yieldNow();
        c={base:new Int32Array(total),thickBase:new Int32Array(total),viaBase:new Int32Array(total),dyn:new Int32Array(total),thickDyn:new Int32Array(total),viaDyn:new Int32Array(total),via,generation:-1};
        const guard=step*0.72,half=net.width/2;
        for(let l=0;l<layerCount;l++)for(let y=0;y<ny;y++){for(let x=0;x<nx;x++){let id=idx(x,y,l),px=bx+x*step,py=by+y*step;if(!inside(px,py,half))c.base[id]=-1;if(!inside(px,py,half+guard))c.thickBase[id]=-1;if(!inside(px,py,via.diameter/2))c.viaBase[id]=-1;}if(y%32===0){detail('Preparing grid · '+net.name+' · layer '+(l+1)+'/'+layerCount+' · row '+(y+1)+'/'+ny,{stage:'grid',netId:net.id,netName:net.name,layer:l,processed:l*ny+y+1,total:layerCount*ny},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        let rasterItems=0;
        for(const {pad,shape} of padShapes){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(pad.net)));drawShape(c.base,shape,half+clearance,pad.net);drawShape(c.thickBase,shape,half+clearance+guard,pad.net);drawShape(c.viaBase,shape,via.diameter/2+clearance,pad.net);if(++rasterItems%32===0){detail('Preparing pad clearances · '+rasterItems+'/'+padShapes.length,{stage:'pad-clearances',processed:rasterItems,total:padShapes.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        // Same-net pad attachment is independently forbidden unless imported or explicitly enabled.
        if(!(original.viaAtSmd&&via.attachAllowed))for(const {pad,shape} of padShapes)if(new Set(pad.shapes.map(s=>s.layer)).size===1)drawShape(c.viaBase,shape,via.diameter/2,-1);
        for(const ko of original.keepouts||[]){for(const l of ko.layers||original.layers.map(l=>l.index)){let sh={...ko.shape,layer:l};if(ko.kind!=='via'){drawShape(c.base,sh,half+(ko.clearance??clearanceOf(net)),-1);drawShape(c.thickBase,sh,half+(ko.clearance??clearanceOf(net))+guard,-1);}drawShape(c.viaBase,sh,via.diameter/2+(ko.clearance??clearanceOf(net)),-1);}}
        rasterItems=0;
        for(const t of original.traces){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));drawTrace(c.base,t,half+t.width/2+clearance,t.net);drawTrace(c.thickBase,t,half+t.width/2+clearance+guard,t.net);drawTrace(c.viaBase,t,via.diameter/2+t.width/2+clearance,t.net);if(++rasterItems%16===0){detail('Preparing imported trace clearances · '+rasterItems+'/'+original.traces.length,{stage:'trace-clearances',processed:rasterItems,total:original.traces.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        rasterItems=0;
        for(const v of original.vias){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));drawVia(c.base,v,half+v.diameter/2+clearance,v.net);drawVia(c.thickBase,v,half+v.diameter/2+clearance+guard,v.net);drawVia(c.viaBase,v,via.diameter/2+v.diameter/2+clearance,v.net);if(++rasterItems%32===0){detail('Preparing imported via clearances · '+rasterItems+'/'+original.vias.length,{stage:'via-clearances',processed:rasterItems,total:original.vias.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        bases.set(key,c);
      }
      if(c.generation!==generation){
        c.dyn.fill(0);c.thickDyn.fill(0);c.viaDyn.fill(0);const guard=step*0.72;
        const traces=board.traces.slice(original.traces.length),vias=board.vias.slice(original.vias.length);let drawn=0;
        for(const t of traces){let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));drawTrace(c.dyn,t,net.width/2+t.width/2+clear,t.net);drawTrace(c.thickDyn,t,net.width/2+t.width/2+clear+guard,t.net);drawTrace(c.viaDyn,t,c.via.diameter/2+t.width/2+clear,t.net);if(++drawn%24===0){detail('Updating route clearances · '+net.name+' · '+drawn+'/'+(traces.length+vias.length)+' items',{stage:'route-clearances',processed:drawn,total:traces.length+vias.length},finishing?'finishing':'routing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        for(const v of vias){let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));drawVia(c.dyn,v,net.width/2+v.diameter/2+clear,v.net);drawVia(c.thickDyn,v,net.width/2+v.diameter/2+clear+guard,v.net);drawVia(c.viaDyn,v,c.via.diameter/2+v.diameter/2+clear,v.net);if(++drawn%24===0){detail('Updating route clearances · '+net.name+' · '+drawn+'/'+(traces.length+vias.length)+' items',{stage:'route-clearances',processed:drawn,total:traces.length+vias.length},finishing?'finishing':'routing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        c.generation=generation;
      }
      return c;
    }
    function staticSegmentClear(a,b,layer,net,soft=false){
      if(!traceLayers(net).includes(layer))return false;
      const half=net.width/2,segmentBox=bboxPoints([a,b]);
      if(!G.shapeInsideBoard({type:'capsule',a:[a[0],a[1]],b:[b[0],b[1]],r:half,layer},original,boundaryEdges))return false;
      for(const o of padShapes)if(o.shape.layer===layer&&o.pad.net!==net.id){let r=half+Math.max(clearanceOf(net),clearanceOf(rules.get(o.pad.net)));if(overlap(expanded(o.box,r),segmentBox)&&G.distanceSegmentShape(a[0],a[1],b[0],b[1],o.shape)<r-EPS)return false;}
      for(let i=0;i<board.traces.length;i++){const t=board.traces[i];if(t.net!==net.id&&t.layer===layer&&(!soft||i<original.traces.length)){let r=half+t.width/2+Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));if(overlap(expanded(bboxPoints(t.points),r),segmentBox))for(let j=1;j<t.points.length;j++)if(G.distanceSegments(a,b,t.points[j-1],t.points[j])<r-EPS)return false;}}
      for(let i=0;i<board.vias.length;i++){const v=board.vias[i];if(v.net!==net.id&&v.layers.includes(layer)&&(!soft||i<original.vias.length)){let r=half+v.diameter/2+Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));if(segmentDistance(v.x,v.y,a,b)<r-EPS)return false;}}
      for(const k of original.keepouts||[])if(k.kind!=='via'&&(!k.layers||k.layers.includes(layer))){let r=half+(k.clearance??clearanceOf(net));if(overlap(expanded(G.shapeBounds(k.shape),r),segmentBox)&&G.distanceSegmentShape(a[0],a[1],b[0],b[1],k.shape)<r-EPS)return false;}
      return true;
    }
    function endpointVia(p,net,c,soft){
      const def=c.via,l=p[2]??0;
      if(def.disabled||def.name!==net.viaName||!original.viaAtSmd||def.attachAllowed===false||l<def.fromLayer||l>def.toLayer)return null;
      const pad=original.pads.find(a=>a.net===net.id&&Math.hypot(a.x-p[0],a.y-p[1])<EPS&&a.shapes.some(s=>s.layer===l));
      if(!pad||new Set(pad.shapes.map(s=>s.layer)).size!==1)return null;
      const layers=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i);
      // The via retains its entire physical span, including excluded trace
      // layers. Check all of its copper before using it as a routing endpoint.
      for(const layer of layers){
        if(!staticIndex[layer])return null;
        const shape={type:'circle',cx:p[0],cy:p[1],r:def.diameter/2,layer},bounds=G.shapeBounds(shape);
        if(!G.shapeInsideBoard(shape,original,boundaryEdges))return null;
        for(const q of staticIndex[layer].query(bounds,maxClearance)){
          if(!q.keepout&&q.net===net.id)continue;
          const clearance=q.keepout?(q.clearance??clearanceOf(net)):Math.max(clearanceOf(net),q.clearance||0),distance=G.distanceShapes(shape,q.shape);
          if(distance+EPS<clearance||distance<EPS)return null;
        }
        if(!soft)for(const q of getDynamicIndex()[layer].query(bounds,maxClearance)){
          if(q.net===net.id)continue;
          const distance=G.distanceShapes(shape,q.shape);
          if(distance+EPS<Math.max(clearanceOf(net),clearanceOf(rules.get(q.net)))||distance<EPS)return null;
        }
        for(const k of original.keepouts||[]){
          if(k.layers&&!k.layers.includes(layer))continue;
          const distance=G.distanceShapes(shape,k.shape);
          if(distance+EPS<(k.clearance??clearanceOf(net))||distance<EPS)return null;
        }
      }
      return {net:net.id,x:p[0],y:p[1],diameter:def.diameter,padstack:def.name,layers,fixed:false};
    }
    function groupSeeds(group,net,c,soft=false){
      let seeds=new Map(),points=group.points||[],layers=traceLayers(net);
      for(const p of points){const padLayer=p[2]??0,via=layers.includes(padLayer)?null:endpointVia(p,net,c,soft);
        const sourceLayers=layers.includes(padLayer)?[padLayer]:via?layers.filter(l=>via.layers.includes(l)):[];
        for(const l of sourceLayers){
        let anchors=[{at:[p[0],p[1],l],bridge:[[p[0],p[1]]]}];
        if(options.fanout!==false){
          const pad=original.pads.find(a=>a.net===net.id&&Math.hypot(a.x-p[0],a.y-p[1])<EPS);
          if(pad){let shape=pad.shapes.find(s=>s.layer===l),box=shape?G.shapeBounds(shape):null;
            let directions=box&&box.maxX-box.minX>box.maxY-box.minY?[[1,0],[-1,0],[0,1],[0,-1]]:[[0,1],[0,-1],[1,0],[-1,0]];
            // Exact pad-axis escapes precede the grid, so narrow pad pitch is not
            // quantized to a coarse global raster. Every bridge is checked at full width.
            for(const d of directions)for(const distance of [1,2,3,4,6].map(a=>a*net.width)){
              const end=[p[0]+d[0]*distance,p[1]+d[1]*distance,l];
              if(staticSegmentClear(p,end,l,net,soft))anchors.push({at:end,bridge:[[p[0],p[1]],[end[0],end[1]]]});
            }
          }
        }
        for(const anchor of anchors){let at=anchor.at,gx=Math.round((at[0]-bx)/step),gy=Math.round((at[1]-by)/step);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){let x=gx+dx,y=gy+dy;if(x<0||x>=nx||y<0||y>=ny)continue;let id=idx(x,y,l),v=xy(id);if(allowed(c.base,id,net.id)&&(soft||allowed(c.dyn,id,net.id))&&staticSegmentClear(at,v,l,net,soft)){let bridge=anchor.bridge.concat([[v[0],v[1]]]),cost=length({points:bridge})+(via?(options.viaCost||net.width*5):0);let old=seeds.get(id);if(!old||cost<old.cost)seeds.set(id,{point:p,bridge,cost,via});}}}
        }
      }return seeds;
    }
    async function search(seeds,targets,net,c,soft=false,softPenalty=80){
      if(!seeds.size||!targets.size)return null;
      let tag=++searchId;if(!tag){visited.fill(0);closed.fill(0);tag=++searchId;}
      let goalPoints=[...targets.keys()].map(xy),startPoint=xy(seeds.keys().next().value);
      goalPoints.sort((a,b)=>Math.hypot(a[0]-startPoint[0],a[1]-startPoint[1])-Math.hypot(b[0]-startPoint[0],b[1]-startPoint[1]));goalPoints=goalPoints.slice(0,12);
      let goalBox=bboxPoints(goalPoints),heap=new Heap(),visitedCount=0;
      const heuristic=id=>{let p=xy(id),dx=Math.max(goalBox.minX-p[0],0,p[0]-goalBox.maxX)/step,dy=Math.max(goalBox.minY-p[1],0,p[1]-goalBox.maxY)/step;return Math.max(dx,dy)+(SQRT2-1)*Math.min(dx,dy);};
      const layers=traceLayers(net),viaCost=(options.viaCost||net.width*5)/step;
      for(const [id,seed]of seeds){visited[id]=tag;gCost[id]=(seed.cost||0)/step;parent[id]=-1;heap.push(id,gCost[id]+heuristic(id));}
      function relax(from,to,cost){if(closed[to]===tag)return;let g=gCost[from]+cost;if(visited[to]!==tag||g<gCost[to]){visited[to]=tag;gCost[to]=g;parent[to]=from;heap.push(to,g+heuristic(to));}}
      while(heap.nodes.length){let entry=heap.pop(),id=entry[0];if(closed[id]===tag)continue;closed[id]=tag;if(targets.has(id)){let path=[];for(let p=id;p>=0;p=parent[p])path.push(p);path.reverse();return{path,seeds,targets};}
        if(++visitedCount%4096===0){detail((soft?'Searching repair for ':'Searching ')+net.name+' · '+visitedCount.toLocaleString('en-US')+' grid positions explored',{stage:'search',netId:net.id,netName:net.name,expanded:visitedCount,repair:soft},finishing?'finishing':'routing');await yieldNow();if(stopped())return null;}
        let l=Math.floor(id/plane),q=id%plane,x=q%nx,y=Math.floor(q/nx);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;let xx=x+dx,yy=y+dy;if(xx<0||xx>=nx||yy<0||yy>=ny)continue;let next=idx(xx,yy,l);if(!allowed(c.base,next,net.id))continue;let occupied=!allowed(c.dyn,next,net.id);if(occupied&&!soft)continue;const near=!allowed(c.thickBase,id,net.id)||!allowed(c.thickBase,next,net.id)||(!soft&&(!allowed(c.thickDyn,id,net.id)||!allowed(c.thickDyn,next,net.id)));if(near&&!exactEdgeClear(xy(id).slice(0,2),xy(next).slice(0,2),l,net,soft))continue;let bend=0;if(parent[id]>=0&&Math.floor(parent[id]/plane)===l){let prev=xy(parent[id]),cur=xy(id);if(Math.abs((cur[0]-prev[0])*dy-(cur[1]-prev[1])*dx)>EPS)bend=0.035;}
          let preferred=(l%2===0?dy!==0:dx!==0)?0.05:0;relax(id,next,(dx&&dy?SQRT2:1)+bend+preferred+(occupied?softPenalty*(1+Math.min(10,(padCounts.get(c.dyn[next])||6)/3))*(finishing?1+(ripHistory.get(c.dyn[next])||0)*.4:1):0));}
        if(layerCount>1&&!c.via.disabled&&l>=c.via.fromLayer&&l<=c.via.toLayer){let safe=true,occupied=false;for(let z=c.via.fromLayer;z<=c.via.toLayer;z++){let vi=idx(x,y,z);if(!allowed(c.viaBase,vi,net.id)){safe=false;break;}if(!allowed(c.viaDyn,vi,net.id))occupied=true;}if(safe&&(!occupied||soft))for(const z of layers)if(z!==l&&z>=c.via.fromLayer&&z<=c.via.toLayer){let next=idx(x,y,z);if(allowed(c.base,next,net.id))relax(id,next,viaCost+(occupied?softPenalty*4:0));}}
      }
      return null;
    }
    function convertPath(found,net){
      let p=found.path,segments=[],vias=[],first=xy(p[0]),last=xy(p[p.length-1]);
      let start=found.seeds.get(p[0])||first,end=found.targets.get(p[p.length-1])||last;
      for(const via of [start.via,end.via])if(via&&!vias.some(v=>Math.hypot(v.x-via.x,v.y-via.y)<EPS))vias.push(via);
      let points=start.bridge?start.bridge.map(p=>p.slice()):[[start[0],start[1]],[first[0],first[1]]],layer=first[2];
      for(let i=1;i<p.length;i++){let v=xy(p[i]);if(v[2]!==layer){if(points.length>1)segments.push({net:net.id,layer,width:net.width,points:simplify(points),fixed:false});let def=original.viaDefs.find(v=>v.name===net.viaName)||original.viaDefs[0];if(!vias.some(a=>Math.hypot(a.x-v[0],a.y-v[1])<EPS))vias.push({net:net.id,x:v[0],y:v[1],diameter:def.diameter,padstack:def.name,layers:Array.from({length:def.toLayer-def.fromLayer+1},(_,k)=>k+def.fromLayer),fixed:false});layer=v[2];points=[[v[0],v[1]]];}else points.push([v[0],v[1]]);}
      if(end.bridge)points.push(...end.bridge.slice().reverse().map(p=>p.slice()));else points.push([end[0],end[1]]);
      segments.push({net:net.id,layer,width:net.width,points:simplify(points),fixed:false});return{traces:segments.filter(t=>length(t)>EPS),vias};
    }
    function blockers(copper,net){let out=new Set();out.traces=new Set();out.vias=new Set();for(const t of board.traces.slice(original.traces.length)){if(t.net===net.id)continue;let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));for(const a of copper.traces)if(a.layer===t.layer&&overlap(expanded(bboxPoints(a.points),a.width/2+t.width/2+clear+EPS),bboxPoints(t.points))){outer:for(let i=1;i<a.points.length;i++)for(let j=1;j<t.points.length;j++)if(G.distanceSegments(a.points[i-1],a.points[i],t.points[j-1],t.points[j])<a.width/2+t.width/2+clear+EPS){{out.add(t.net);out.traces.add(t);}break outer;}}
        for(const v of copper.vias)if(v.layers.includes(t.layer)&&t.points.some((p,i)=>i&&segmentDistance(v.x,v.y,t.points[i-1],p)<v.diameter/2+t.width/2+clear+EPS)){out.add(t.net);out.traces.add(t);}}
      for(const v of board.vias.slice(original.vias.length)){if(v.net===net.id)continue;let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));for(const t of copper.traces)if(v.layers.includes(t.layer)&&t.points.some((p,i)=>i&&segmentDistance(v.x,v.y,t.points[i-1],p)<v.diameter/2+t.width/2+clear+EPS)){out.add(v.net);out.vias.add(v);}for(const w of copper.vias)if(v.layers.some(l=>w.layers.includes(l))&&Math.hypot(v.x-w.x,v.y-w.y)<v.diameter/2+w.diameter/2+clear+EPS){out.add(v.net);out.vias.add(v);}}return out;}
    function removeNet(net){board.traces=board.traces.filter((t,i)=>i<original.traces.length||t.net!==net);board.vias=board.vias.filter((v,i)=>i<original.vias.length||v.net!==net);generation++;}
    detail('Preparing connected-pad groups for routing',{stage:'route-groups'},'routing');await yieldNow();
    const initialConnections=G.connectivity(original),groupsByNet=new Map(initialConnections.components.map(c=>[c.net,c.groups]));
    const densityScores=new Map();
    async function sortByDensity(order){
      let lastOrderYield=Date.now();
      // Density depends only on imported pads and net width. Compute it once
      // per net, rather than repeating the same scan in every sort comparison.
      for(let i=0;i<order.length;i++){
        const net=order[i];
        if(!densityScores.has(net.id))densityScores.set(net.id,original.pads.filter(p=>p.net===net.id).reduce((sum,p)=>sum+original.pads.filter(q=>q.net!==net.id&&Math.hypot(q.x-p.x,q.y-p.y)<net.width*5).length,0));
        if(i%8===0){detail('Prioritizing dense nets · '+(i+1)+'/'+order.length,{stage:'net-order',processed:i+1,total:order.length},finishing?'finishing':'routing');if(Date.now()-lastOrderYield>=24){await yieldNow();lastOrderYield=Date.now();}if(stopped())return;}
      }
      order.sort((a,b)=>densityScores.get(b.id)-densityScores.get(a.id));
    }

    async function routeNet(net,softAllowed,keepExisting=false){detail('Routing '+net.name+' · attempt '+(routeActivity.attempt||1),{stage:'net',netId:net.id,netName:net.name},finishing?'finishing':'routing');let c=await getRaster(net);if(stopped())return{failed:true,ripped:new Set()};let groups=(keepExisting?(G.connectivity(board).components.find(c=>c.net===net.id)?.groups||[]):(groupsByNet.get(net.id)||[])).filter(g=>g.points&&g.points.length);if(groups.length<=1)return{failed:false,ripped:new Set()};let ordered=groups.map(g=>({group:g,seeds:groupSeeds(g,net,c)}));ordered.sort((a,b)=>b.seeds.size-a.seeds.size);let root=ordered.shift(),targets=new Map(root.seeds),targetGroups=[root.group],remaining=ordered,ripped=new Set(),failed=false;
      while(remaining.length&&!stopped()){let targetCoordinates=targets.size?[...targets.keys()].map(xy):targetGroups.flatMap(group=>group.points);remaining.sort((a,b)=>distanceToTree(a.group,targetCoordinates)-distanceToTree(b.group,targetCoordinates));let next=remaining.shift(),found=await search(next.seeds,targets,net,c,false);
        if(!found&&softAllowed){
          // Generated routes can block the attachment bridge before A* starts.
          // Let soft search reach those endpoints, then rip every crossed net
          // using the same blocker check as the body of the candidate route.
          const softTargets=new Map(targets);
          for(const group of targetGroups)for(const [id,seed]of groupSeeds(group,net,c,true)){const old=softTargets.get(id);if(!old||(seed.cost||0)<(old.cost||0))softTargets.set(id,seed);}
          found=await search(groupSeeds(next.group,net,c,true),softTargets,net,c,true,finishing?[4,12,35,90,250,.5][(repairRound-1)%6]:35);
        }
        if(!found){failed=true;continue;}let copper=convertPath(found,net),blocked=blockers(copper,net);if(blocked.size){
          if(finishing){
            // Retain connected branches of a blocked net. Only copper actually
            // crossed by this candidate needs to be repaired.
            board.traces=board.traces.filter(t=>!blocked.traces.has(t));
            board.vias=board.vias.filter(v=>!blocked.vias.has(v));generation++;
            for(const n of blocked){ripped.add(n);ripHistory.set(n,(ripHistory.get(n)||0)+1);}
          }else for(const n of blocked){removeNet(n);ripped.add(n);}
          c=await getRaster(net);
        }
        board.traces.push(...copper.traces);for(const v of copper.vias)if(!board.vias.some(w=>w.net===v.net&&Math.hypot(w.x-v.x,w.y-v.y)<EPS))board.vias.push(v);generation++;
        targetGroups.push(next.group);for(const id of found.path)targets.set(id,xy(id));for(const [id,p]of next.seeds)targets.set(id,p);
      }return{failed,ripped};}
    function distanceToTree(group,points){let best=Infinity;for(const p of group.points)for(const q of points)best=Math.min(best,Math.hypot(p[0]-q[0],p[1]-q[1]));return best;}
    function scoreBetter(a,b){if(a.totalViolations>baseTotal||a.clearanceViolations>baseViolation||a.belowNominalWidthTraceCount>baseWidth)return false;let ka=[a.unrouted,a.viaCount,a.traceLengthMm],kb=[b.unrouted,b.viaCount,b.traceLengthMm];for(let i=0;i<ka.length;i++){if(ka[i]<kb[i]-1e-8)return true;if(ka[i]>kb[i]+1e-8)return false;}return false;}
    // Bounded complete-board restarts with difficult-net-first ordering and rip-up repair.
    let failures=new Set(),passes=options.deepSearch===false?1:Math.max(1,Math.min(options.maxPasses||12,100));
    say('Native router: '+nx+' × '+ny+' grid, '+layerCount+' layers, '+step.toPrecision(3)+' '+original.units.name+' step.',{phase:'routing',pass:0,board:copy(best),stats:bestStats});
    for(let pass=1;pass<=passes&&!stopped();pass++){
      const repairMode=pass>1&&pass%2===0;board=copy(repairMode?best:original);generation++;let random=rng(0x52414D45+pass*7919),order=shuffled(nets,random);
      if(pass===1)await sortByDensity(order);else order.sort((a,b)=>(failures.has(b.id)?1:0)-(failures.has(a.id)?1:0));
      let queue=order.filter(n=>!repairMode||failures.has(n.id)),attempts=new Map(),currentFailures=new Set(),processed=0,maxWork=nets.length*(pass===1?2:3);
      routeActivity={pass,processed:0,total:maxWork};detail('Starting pass '+pass+'/'+passes+' · '+queue.length+' nets queued',{stage:'pass',queued:queue.length},'routing',true);await yieldNow();
      while(queue.length&&processed<maxWork&&!stopped()){
        let net=queue.shift(),count=(attempts.get(net.id)||0)+1;routeActivity={pass,netId:net.id,netName:net.name,processed,total:maxWork,attempt:count};attempts.set(net.id,count);if(count>3){currentFailures.add(net.id);continue;}if(!repairMode)removeNet(net.id);let result=await routeNet(net,pass>1&&count<3,repairMode);processed++;if(result.failed)currentFailures.add(net.id);else currentFailures.delete(net.id);for(const id of result.ripped){let n=rules.get(id);if(n&&!queue.some(x=>x.id===id))queue.push(n);currentFailures.add(id);}
        if(G.connectivity(board).unrouted<bestStats.unrouted){if(detail('Checking improved route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();let candidateStats=stats(board,true);if(scoreBetter(candidateStats,bestStats)){best=copy(board);bestStats=candidateStats;checkpoint(pass);}}
        if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'routing',pass,message:'Pass '+pass+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false)});}await yieldNow();}
      }
      emit({type:'progress',phase:'checking',pass,message:'Checking full clearances and connectivity'});await yieldNow();let measured=stats(board,true);if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;checkpoint(pass);}failures=new Set(G.connectivity(best).components.filter(c=>c.groups.length>1).map(c=>c.net));say('Pass '+pass+': '+measured.unrouted+' remaining, '+measured.viaCount+' vias; best '+bestStats.unrouted+' remaining.',{phase:'routing',pass,board:copy(best),stats:bestStats});if(bestStats.unrouted===0)break;
    }
    if(options.optimize!==false&&optimizer&&!stopped()){emit({type:'progress',phase:'optimizing',message:'Refining the checked route'});const optimized=await optimizer.optimize(copy(best),options,emit,stopped);let candidate=stats(optimized,true);if(scoreBetter(candidate,bestStats)){best=optimized;bestStats=candidate;checkpoint(passes);}}
    // When only a few connections remain, repair local congestion without
    // discarding whole nets. Every retained result still passes the full checks.
    if(options.deepSearch!==false&&bestStats.unrouted>0&&bestStats.unrouted<=6&&!stopped()){
      const beforeFinishing=bestStats.unrouted,viaKey=v=>JSON.stringify([v.net,v.padstack,v.x,v.y,v.diameter,v.layers]);
      const originalViaKeys=new Set(original.vias.map(viaKey));
      // Refinement can reshape escape stubs and remove unused escape vias.
      // Rebuild the immutable prefix before the router indexes generated copper.
      const restored=copy(best);
      restored.traces=[...copy(original.traces),...restored.traces.slice(original.traces.length)];
      restored.vias=[...copy(original.vias),...restored.vias.filter(v=>!originalViaKeys.has(viaKey(v)))];
      const restoredStats=stats(restored,true);
      const safe=restoredStats.unrouted<=bestStats.unrouted&&restoredStats.totalViolations<=bestStats.totalViolations&&restoredStats.clearanceViolations<=bestStats.clearanceViolations&&restoredStats.belowNominalWidthTraceCount<=bestStats.belowNominalWidthTraceCount;
      if(safe&&!stopped()){
        // The working seed may contain extra escape vias. Keep it separate from
        // the best exportable result, which must never get worse during repair.
        let repairBest=restored,repairStats=restoredStats;
        let repairFailures=new Set(G.connectivity(repairBest).components.filter(c=>c.groups.length>1).map(c=>c.net));
        finishing=true;ripHistory.clear();
        const retain=(measured)=>{
          if(scoreBetter(measured,repairStats)){repairBest=copy(board);repairStats=measured;}
          if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;checkpoint(passes,'finishing');}
        };
        for(repairRound=1;repairRound<=18&&!stopped()&&bestStats.unrouted>0;repairRound++){
          board=copy(repairBest);generation++;
          let random=rng(0x52414D45+repairRound*7919),order=shuffled(nets,random);
          if(repairRound===1)await sortByDensity(order);else order.sort((a,b)=>(repairFailures.has(b.id)?1:0)-(repairFailures.has(a.id)?1:0));
          const queue=order.filter(n=>repairFailures.has(n.id)),attempts=new Map();
          let processed=0,maxWork=nets.length*(repairRound===1?2:3);
          emit({type:'progress',phase:'finishing',pass:passes,message:'Finishing remaining connections · repair '+repairRound});
          while(queue.length&&processed<maxWork&&!stopped()){
            const net=queue.shift(),count=(attempts.get(net.id)||0)+1;routeActivity={pass:passes,repairRound,netId:net.id,netName:net.name,processed,total:maxWork,attempt:count};attempts.set(net.id,count);if(count>3)continue;
            const result=await routeNet(net,repairRound>1&&count<3,true);processed++;
            for(const id of result.ripped){const n=rules.get(id);if(n&&!queue.some(x=>x.id===id))queue.push(n);}
            if(G.connectivity(board).unrouted<repairStats.unrouted){if(detail('Checking repaired route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();retain(stats(board,true));}
            if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'finishing',pass:passes,message:'Finishing repair '+repairRound+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false)});}await yieldNow();}
          }
          emit({type:'progress',phase:'checking',pass:passes,message:'Checking the repaired connections'});await yieldNow();
          const measured=stats(board,true);retain(measured);
          repairFailures=new Set(G.connectivity(repairBest).components.filter(c=>c.groups.length>1).map(c=>c.net));
          say('Finishing repair '+repairRound+': '+measured.unrouted+' remaining; best '+bestStats.unrouted+' remaining.',{phase:'finishing',pass:passes,board:copy(best),stats:bestStats});
        }
        finishing=false;
        if(bestStats.unrouted<beforeFinishing&&options.optimize!==false&&optimizer&&!stopped()){
          emit({type:'progress',phase:'optimizing',message:'Refining the repaired route'});
          const optimized=await optimizer.optimize(copy(best),options,emit,stopped),measured=stats(optimized,true);
          if(scoreBetter(measured,bestStats)){best=optimized;bestStats=measured;checkpoint(passes);}
        }
      }else if(!safe)say('Keeping the checked route: escape restoration did not pass the full rule check.',{phase:'checking'});
    }
    emit({type:'progress',phase:'checking',board:copy(best),stats:bestStats,message:bestStats.unrouted+' connection(s) remaining.'});
    return{board:best,stats:bestStats,initialStats,log,stopped:stopped()};
  }
  return{route};
}
if(typeof globalThis!=='undefined')globalThis.createRamenRouter=createRamenRouter;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenRouter};
