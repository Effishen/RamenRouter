/* RamenRouter checked path refinement. GPL-3.0-or-later. */
function createRamenOptimizer(geometry) {
  'use strict';
  const G=geometry,EPS=1e-8;
  const clone=x=>JSON.parse(JSON.stringify(x));
  const length=points=>points.slice(1).reduce((sum,p,i)=>sum+G.distance(points[i],p),0);
  const wait=()=>new Promise(resolve=>setTimeout(resolve,0));
  function compact(points){return points.filter((p,i)=>i===0||G.distance(p,points[i-1])>EPS);}
  function shortcuts(a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],x=Math.abs(dx),y=Math.abs(dy),sx=Math.sign(dx),sy=Math.sign(dy);
    if(x<EPS||y<EPS||Math.abs(x-y)<EPS)return [[a,b]];
    const first=x>y?[a[0]+sx*(x-y),a[1]]:[a[0],a[1]+sy*(y-x)];
    const second=x>y?[a[0]+sx*y,b[1]]:[b[0],a[1]+sy*x];
    return [[a,first,b],[a,second,b]];
  }
  async function optimize(input,options={},emit=()=>{},isCancelled=()=>false){
    let board=clone(input),base=G.validate(board),unrouted=G.connectivity(board).unrouted;
    const nets=new Map(board.nets.map(n=>[n.id,n])),edges=G.boundaryEdges(board);
    let changed=0,removed=0;
    const originalLength=board.traces.reduce((s,t)=>s+length(t.points),0);
    const maxClearance=Math.max(board.defaultClearance||0,...board.nets.map(n=>n.clearance||0));
    for(let index=0;index<board.traces.length&&!isCancelled();index++){
      const trace=board.traces[index];if(trace.fixed||trace.points.length<3)continue;
      const net=nets.get(trace.net),ownClear=net?.routingClearance??net?.clearance??0;
      const primitives=G.copper(board).primitives.filter(p=>p.layer===trace.layer&&p.net!==trace.net);
      const spatial=G.spatialIndex(primitives,Math.max((board.bounds.maxX-board.bounds.minX)/40,trace.width*4));
      function safe(a,b){
        const shape={type:'capsule',a,b,r:trace.width/2,layer:trace.layer};
        if(!G.shapeInsideBoard(shape,board,edges))return false;
        for(const other of spatial.query(G.shapeBounds(shape),maxClearance+EPS)){
          const clearance=G.clearance(board,trace.net,other.net);
          if(G.distanceShapes(shape,other.shape)+EPS<clearance)return false;
        }
        for(const k of board.keepouts||[]){
          if(k.kind==='via'||(k.layers&&!k.layers.includes(trace.layer)))continue;
          if(G.distanceShapes(shape,k.shape)+EPS<(k.clearance??ownClear))return false;
        }
        return true;
      }
      const previous=trace.points,proposed=[previous[0]];
      let i=0;
      while(i<previous.length-1){
        let chosen=null,end=i+1;
        for(let j=previous.length-1;j>i+1;j--){
          const old=length(previous.slice(i,j+1));
          for(const candidate of shortcuts(previous[i],previous[j])){
            if(length(candidate)>=old-EPS)continue;
            if(candidate.slice(1).every((p,k)=>safe(candidate[k],p))){chosen=candidate;end=j;break;}
          }
          if(chosen)break;
        }
        if(chosen)proposed.push(...chosen.slice(1));else proposed.push(previous[end]);
        i=end;
      }
      const candidate=compact(proposed);
      if(length(candidate)<length(previous)-EPS){
        trace.points=candidate;
        // Shortcutting a trunk must not disconnect branches that join its interior.
        const next=G.connectivity(board).unrouted;
        if(next<=unrouted){changed++;unrouted=next;}else trace.points=previous;
      }
      if(index%6===0){emit({type:'progress',phase:'optimizing',message:'Refining paths '+(index+1)+'/'+board.traces.length,board});await wait();}
    }
    // Remove electrically redundant generated vias, checking the complete copper graph.
    for(let index=board.vias.length-1;index>=0&&!isCancelled();index--){
      if(board.vias[index].fixed)continue;
      const via=board.vias[index];board.vias.splice(index,1);
      const next=G.connectivity(board).unrouted;
      if(next<=unrouted){removed++;unrouted=next;}else board.vias.splice(index,0,via);
      if(index%8===0)await wait();
    }
    const checked=G.validate(board),beforeConnections=G.connectivity(input).unrouted;
    if(checked.totalViolations>base.totalViolations||checked.clearanceViolations>base.clearanceViolations||checked.belowNominalWidthTraceCount>base.belowNominalWidthTraceCount||unrouted>beforeConnections){
      emit({type:'progress',phase:'optimizing',message:'Refinement rejected by final rule/connectivity check; original checked board retained.'});return input;
    }
    const savings=(originalLength-board.traces.reduce((s,t)=>s+length(t.points),0))*board.units.mmPerUnit;
    emit({type:'progress',phase:'optimizing',message:'Refinement: '+changed+' paths shortened, '+removed+' redundant vias removed, '+savings.toFixed(4)+' mm saved.',board});
    return board;
  }
  return {optimize};
}
if(typeof globalThis!=='undefined')globalThis.createRamenOptimizer=createRamenOptimizer;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenOptimizer};
