'use strict';

/** Dependency-free copper geometry. The factory is self-contained for Blob workers. */
function createRamenGeometry() {
  const EPS = 1e-8;
  const sq = x => x * x;
  const point = p => Array.isArray(p) ? p : [p.x, p.y];
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  function closestPointOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den)) : 0;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  function distancePointSegment(x,y,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/den)):0;
    return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);
  }
  function pointOnSegment(p, a, b) { return distancePointSegment(p[0],p[1],a,b) <= EPS; }
  function segmentIntersection(a, b, c, d) {
    const abC = cross(a,b,c), abD = cross(a,b,d), cdA = cross(c,d,a), cdB = cross(c,d,b);
    if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
        ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true;
    return pointOnSegment(a,c,d) || pointOnSegment(b,c,d) || pointOnSegment(c,a,b) || pointOnSegment(d,a,b);
  }
  function closestSegmentPoints(a, b, c, d) {
    const dx = b[0]-a[0], dy = b[1]-a[1], ex = d[0]-c[0], ey = d[1]-c[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > EPS * EPS) {
      const t = ((c[0]-a[0]) * ey - (c[1]-a[1]) * ex) / den;
      const u = ((c[0]-a[0]) * dy - (c[1]-a[1]) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const p = [a[0]+t*dx,a[1]+t*dy]; return {distance:0, a:p, b:p};
      }
    }
    const candidates = [[a,closestPointOnSegment(a,c,d)],[b,closestPointOnSegment(b,c,d)],
      [closestPointOnSegment(c,a,b),c],[closestPointOnSegment(d,a,b),d]];
    let best = null;
    for (const [p,q] of candidates) { const length=distance(p,q); if (!best || length < best.distance) best={distance:length,a:p,b:q}; }
    return best;
  }
  function distanceSegments(a,b,c,d) { return closestSegmentPoints(point(a),point(b),point(c),point(d)).distance; }
  function pointInPolygon(x, y, polygon) {
    const p=[x,y]; let result=false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const a=polygon[j], b=polygon[i];
      if (pointOnSegment(p,a,b)) return true;
      if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) result=!result;
    }
    return result;
  }
  function shapeBounds(shape) {
    if (shape.type==='circle') return {minX:shape.cx-shape.r,minY:shape.cy-shape.r,maxX:shape.cx+shape.r,maxY:shape.cy+shape.r};
    const points=shape.type==='capsule' ? [shape.a,shape.b] : shape.points;
    const radius=shape.type==='capsule' ? shape.r : 0;
    return {minX:Math.min(...points.map(p=>p[0]))-radius,minY:Math.min(...points.map(p=>p[1]))-radius,
      maxX:Math.max(...points.map(p=>p[0]))+radius,maxY:Math.max(...points.map(p=>p[1]))+radius};
  }
  function pointInShape(x,y,shape) {
    if (shape.type==='circle') return Math.hypot(x-shape.cx,y-shape.cy)<=shape.r+EPS;
    if (shape.type==='capsule') return distance([x,y],closestPointOnSegment([x,y],shape.a,shape.b))<=shape.r+EPS;
    return pointInPolygon(x,y,shape.points);
  }
  function shapeCore(shape) {
    if (shape.type==='circle') { const p=[shape.cx,shape.cy]; return {points:[p],edges:[[p,p]],radius:shape.r,polygon:false}; }
    if (shape.type==='capsule') return {points:[shape.a,shape.b],edges:[[shape.a,shape.b]],radius:shape.r,polygon:false};
    return {points:shape.points,edges:shape.points.map((p,i)=>[p,shape.points[(i+1)%shape.points.length]]),radius:0,polygon:true};
  }
  function closestShapePoints(a,b) {
    const ac=shapeCore(a),bc=shapeCore(b);
    if (ac.polygon) for (const p of bc.points) if (pointInPolygon(p[0],p[1],ac.points)) return {distance:0,a:p,b:p};
    if (bc.polygon) for (const p of ac.points) if (pointInPolygon(p[0],p[1],bc.points)) return {distance:0,a:p,b:p};
    let best={distance:Infinity,a:ac.points[0],b:bc.points[0]};
    for (const ae of ac.edges) for (const be of bc.edges) {
      const pair=closestSegmentPoints(ae[0],ae[1],be[0],be[1]);
      if (pair.distance<best.distance) best=pair;
      if (best.distance===0) break;
    }
    if (best.distance<=ac.radius+bc.radius+EPS) {
      const p=best.distance ? [best.a[0]+(best.b[0]-best.a[0])*Math.min(1,ac.radius/best.distance),best.a[1]+(best.b[1]-best.a[1])*Math.min(1,ac.radius/best.distance)] : best.a;
      return {distance:0,a:p,b:p};
    }
    const dx=(best.b[0]-best.a[0])/best.distance,dy=(best.b[1]-best.a[1])/best.distance;
    return {distance:best.distance-ac.radius-bc.radius,a:[best.a[0]+dx*ac.radius,best.a[1]+dy*ac.radius],b:[best.b[0]-dx*bc.radius,best.b[1]-dy*bc.radius]};
  }
  function distanceShapes(a,b) {
    if(a.type==='circle')return Math.max(0,distancePointShape(a.cx,a.cy,b)-a.r);
    if(b.type==='circle')return Math.max(0,distancePointShape(b.cx,b.cy,a)-b.r);
    if(a.type==='capsule')return Math.max(0,distanceSegmentShape(a.a[0],a.a[1],a.b[0],a.b[1],b)-a.r);
    if(b.type==='capsule')return Math.max(0,distanceSegmentShape(b.a[0],b.a[1],b.b[0],b.b[1],a)-b.r);
    return closestShapePoints(a,b).distance;
  }
  function distancePointShape(x,y,shape) {
    if(shape.type==='circle')return Math.max(0,Math.hypot(x-shape.cx,y-shape.cy)-shape.r);
    if(shape.type==='capsule')return Math.max(0,distancePointSegment(x,y,shape.a,shape.b)-shape.r);
    if(pointInPolygon(x,y,shape.points))return 0;
    let best=Infinity;for(let i=0;i<shape.points.length;i++)best=Math.min(best,distancePointSegment(x,y,shape.points[i],shape.points[(i+1)%shape.points.length]));return best;
  }
  function distanceSegmentShape(ax,ay,bx,by,shape) {
    const a=[ax,ay],b=[bx,by];
    if(shape.type==='circle')return Math.max(0,distancePointSegment(shape.cx,shape.cy,a,b)-shape.r);
    if(shape.type==='capsule')return Math.max(0,distanceSegments(a,b,shape.a,shape.b)-shape.r);
    if(pointInPolygon(ax,ay,shape.points)||pointInPolygon(bx,by,shape.points))return 0;
    let best=Infinity;for(let i=0;i<shape.points.length;i++){best=Math.min(best,distanceSegments(a,b,shape.points[i],shape.points[(i+1)%shape.points.length]));if(best<=EPS)return 0;}return best;
  }
  function nearestPointOnShape(x,y,shape) { return closestShapePoints({type:'circle',cx:x,cy:y,r:0},shape).b; }
  function boxesOverlap(a,b,pad=0) { return a.minX<=b.maxX+pad && a.maxX+pad>=b.minX && a.minY<=b.maxY+pad && a.maxY+pad>=b.minY; }
  function spatialIndex(items=[],cellSize=5,getBounds=x=>x.bounds||shapeBounds(x.shape||x)) {
    cellSize=Math.max(EPS,cellSize);
    const cells=new Map(),entries=new Map(),large=new Set();
    function keys(bounds) {
      const result=[];
      if(![bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].every(Number.isFinite))return null;
      const minX=Math.floor(bounds.minX/cellSize),maxX=Math.floor(bounds.maxX/cellSize),minY=Math.floor(bounds.minY/cellSize),maxY=Math.floor(bounds.maxY/cellSize);
      if((maxX-minX+1)*(maxY-minY+1)>20000)return null;
      for (let x=minX;x<=maxX;x++) for (let y=minY;y<=maxY;y++) result.push(x+','+y);
      return result;
    }
    function insert(item) { const bounds=getBounds(item);entries.set(item,bounds);const itemKeys=keys(bounds);if(itemKeys===null)large.add(item);else for (const key of itemKeys) { if(!cells.has(key))cells.set(key,new Set());cells.get(key).add(item); } return item; }
    function remove(item) { const bounds=entries.get(item);if(!bounds)return;large.delete(item);for(const key of keys(bounds)||[]){const bucket=cells.get(key);bucket?.delete(item);if(bucket?.size===0)cells.delete(key);}entries.delete(item); }
    function query(bounds,pad=0) {
      const expanded={minX:bounds.minX-pad,minY:bounds.minY-pad,maxX:bounds.maxX+pad,maxY:bounds.maxY+pad};
      const found=new Set(),queryKeys=keys(expanded);
      if(queryKeys===null){for(const [item,b] of entries)if(boxesOverlap(b,expanded))found.add(item);}
      else{for(const key of queryKeys)for(const item of cells.get(key)||[])if(boxesOverlap(entries.get(item),expanded))found.add(item);for(const item of large)if(boxesOverlap(entries.get(item),expanded))found.add(item);}
      return [...found];
    }
    for (const item of items) insert(item);
    return {insert,remove,query,clear(){cells.clear();entries.clear();large.clear();},size:()=>entries.size};
  }
  function netKey(net) { return net===null || net===undefined || net===0 || net==='' ? null : String(net); }
  // Specctra's class rule supplies a matrix diagonal. It does not reduce the
  // global distance between copper in two different clearance classes.
  // Accept net objects as well as IDs so collision loops can avoid lookups.
  function clearance(board,netA,netB) {
    const resolve=net=>net&&typeof net==='object'?net:(board.nets||[]).find(n=>netKey(n.id)===netKey(net));
    const a=resolve(netA),b=resolve(netB),base=Math.max(0,board.crossClassClearance??board.defaultClearance??0);
    if(board.clearanceMode!=='specctra-class-matrix')return Math.max(0,a?.clearance??base,b?.clearance??base);
    if(!a||!b)return base;
    const ca=a.clearanceClass??'default',cb=b.clearanceClass??'default';
    const value=c=>Math.max(0,board.classClearances?.[c]??(c===ca?a.clearance:b.clearance)??base);
    return ca===cb?value(ca):Math.max(base,value(ca),value(cb));
  }
  function unionFind(count) {
    const parent=Array.from({length:count},(_,i)=>i),rank=new Uint8Array(count);
    function find(i){while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return;if(rank[a]<rank[b])[a,b]=[b,a];parent[b]=a;if(rank[a]===rank[b])rank[a]++;}
    return {find,union};
  }
  function copper(board) {
    const objects=[],primitives=[];
    function add(kind,index,item,shapes,points,id) {
      const object={uid:objects.length,kind,index,id:id??kind+':'+index,net:item.net,item,points,primitives:[]};objects.push(object);
      for (const shape of shapes) {const primitive={object,shape,layer:shape.layer,net:item.net,bounds:shapeBounds(shape)};object.primitives.push(primitive);primitives.push(primitive);}
    }
    (board.pads||[]).forEach((p,i)=>add('pad',i,p,p.shapes||[],(p.shapes||[]).map(s=>[p.x,p.y,s.layer]),p.id));
    (board.traces||[]).forEach((t,i)=>{
      const shapes=[];for(let n=1;n<t.points.length;n++)shapes.push({type:'capsule',a:t.points[n-1],b:t.points[n],r:t.width/2,layer:t.layer});
      if(t.points.length===1)shapes.push({type:'circle',cx:t.points[0][0],cy:t.points[0][1],r:t.width/2,layer:t.layer});
      add('trace',i,t,shapes,t.points.map(p=>[p[0],p[1],t.layer]));
    });
    (board.vias||[]).forEach((v,i)=>{
      const def=(board.viaDefs||[]).find(d=>d.name===v.padstack);
      const layers=v.layers||Array.from({length:(def?.toLayer??0)-(def?.fromLayer??0)+1},(_,n)=>n+(def?.fromLayer??0));
      add('via',i,v,layers.map(layer=>({type:'circle',cx:v.x,cy:v.y,r:(v.diameter??def?.diameter??0)/2,layer})),layers.map(layer=>[v.x,v.y,layer]));
    });
    return {objects,primitives};
  }
  function indexing(board,primitives) {
    const bounds=board.bounds||{minX:0,minY:0,maxX:100,maxY:100};
    const span=Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY,1);
    const cellSize=Math.max(span/Math.max(8,Math.sqrt(primitives.length)),EPS*100);
    const layers=new Map();
    for(const p of primitives){if(!layers.has(p.layer))layers.set(p.layer,spatialIndex([],cellSize));layers.get(p.layer).insert(p);}
    return layers;
  }
  function connectivity(board) {
    const {objects,primitives}=copper(board),uf=unionFind(objects.length),layers=indexing(board,primitives);
    for(const p of primitives){if(netKey(p.net)===null)continue;for(const q of layers.get(p.layer).query(p.bounds,EPS)){
      if(q.object.uid<=p.object.uid || netKey(q.net)!==netKey(p.net) || uf.find(q.object.uid)===uf.find(p.object.uid))continue;
      if(distanceShapes(p.shape,q.shape)<=EPS)uf.union(p.object.uid,q.object.uid);
    }}
    const byNet=new Map();
    for(const object of objects){const key=netKey(object.net);if(key===null || !object.primitives.length)continue;
      if(!byNet.has(key))byNet.set(key,new Map());const groups=byNet.get(key),id=uf.find(object.uid);
      if(!groups.has(id))groups.set(id,{id,net:object.net,items:[],pads:[],points:[],_primitives:[]});
      const group=groups.get(id);group.items.push({kind:object.kind,index:object.index,id:object.id,points:object.points});
      if(object.kind==='pad')group.pads.push(object.id);group.points.push(...object.points);group._primitives.push(...object.primitives);
    }
    const components=[],airwires=[];let unrouted=0;
    for(const [key,groupMap] of byNet){
      const groups=[...groupMap.values()];unrouted+=Math.max(0,groups.length-1);
      if(groups.length>1){
        const used=new Set([0]),best=new Array(groups.length).fill(null);
        function groupDistance(a,b){let closest={distance:Infinity,from:a.points[0]?.slice(0,2),to:b.points[0]?.slice(0,2)};
          for(const ap of a._primitives)for(const bp of b._primitives){
            const dx=Math.max(0,ap.bounds.minX-bp.bounds.maxX,bp.bounds.minX-ap.bounds.maxX),dy=Math.max(0,ap.bounds.minY-bp.bounds.maxY,bp.bounds.minY-ap.bounds.maxY);
            if(Math.hypot(dx,dy)>=closest.distance)continue;
            const pair=closestShapePoints(ap.shape,bp.shape);
            if(pair.distance<closest.distance)closest={distance:pair.distance,from:pair.a,to:pair.b,fromLayer:ap.layer,toLayer:bp.layer};
          }return closest;}
        let last=0;
        while(used.size<groups.length){for(let j=0;j<groups.length;j++)if(!used.has(j)){
          const pair=groupDistance(groups[last],groups[j]);if(!best[j]||pair.distance<best[j].distance)best[j]={...pair,fromGroup:groups[last].id,toGroup:groups[j].id};
        }
          let next=-1;for(let j=0;j<groups.length;j++)if(!used.has(j)&&best[j]&&(next<0||best[j].distance<best[next].distance))next=j;
          if(next<0)break;airwires.push({net:groups[next].net,...best[next]});used.add(next);last=next;
        }
      }
      for(const group of groups)delete group._primitives;
      components.push({net:groups[0]?.net??key,groups});
    }
    return {unrouted,components,airwires};
  }
  function pointInBoard(x,y,board) {
    const outlines=board.outlines||[];
    if(!outlines.length){const b=board.bounds;if(b&&(x<b.minX-EPS||x>b.maxX+EPS||y<b.minY-EPS||y>b.maxY+EPS))return false;}
    else if(!outlines.some(p=>pointInPolygon(x,y,p)))return false;
    return !(board.holes||[]).some(h=>pointInPolygon(x,y,h.points||h));
  }
  function boundaryEdges(board) {
    const polygons=[...(board.outlines||[]),...(board.holes||[]).map(h=>h.points||h)];
    if(!polygons.length&&board.bounds){const b=board.bounds;polygons.push([[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]]);}
    const edges=polygons.flatMap(poly=>poly.map((p,i)=>[p,poly[(i+1)%poly.length]]));
    // Split boundaries where polygons overlap; only exposed union boundaries count.
    const result=[];
    for(const [a,b] of edges){const ts=[0,1],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<=EPS)continue;
      for(const [c,d] of edges){const ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;if(Math.abs(den)<=EPS*EPS)continue;
        const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;
        if(t>EPS&&t<1-EPS&&u>=0&&u<=1)ts.push(t);
      }
      ts.sort((x,y)=>x-y);
      for(let i=1;i<ts.length;i++){const t=(ts[i]+ts[i-1])/2,m=[a[0]+dx*t,a[1]+dy*t],n=[-dy/length*EPS*20,dx/length*EPS*20];
        if(pointInBoard(m[0]+n[0],m[1]+n[1],board)!==pointInBoard(m[0]-n[0],m[1]-n[1],board))
          result.push([[a[0]+dx*ts[i-1],a[1]+dy*ts[i-1]],[a[0]+dx*ts[i],a[1]+dy*ts[i]]]);
      }
    }return result;
  }
  function shapeInsideBoard(shape,board,edges=boundaryEdges(board),edgeClearance=board.edgeClearance||0) {
    const core=shapeCore(shape);
    if(core.points.some(p=>!pointInBoard(p[0],p[1],board)))return false;
    for(const [a,b] of core.edges){const ts=[0,1],dx=b[0]-a[0],dy=b[1]-a[1];
      for(const [c,d] of edges){
        const dist=distanceSegments(a,b,c,d);
        if(dist+EPS<core.radius+edgeClearance)return false;
        // Collect ALL crossings before sampling intervals, including narrow notches.
        const ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;
        if(Math.abs(den)>EPS*EPS){const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;if(t>0&&t<1&&u>=0&&u<=1)ts.push(t);}
      }
      ts.sort((x,y)=>x-y);for(let j=1;j<ts.length;j++){const t=(ts[j-1]+ts[j])/2;if(!pointInBoard(a[0]+dx*t,a[1]+dy*t,board))return false;}
    }
    // A polygon can entirely enclose a hole without its edges crossing the hole.
    if(core.polygon)for(const hole of board.holes||[])for(const p of hole.points||hole)if(pointInPolygon(p[0],p[1],core.points))return false;
    return true;
  }
  function validate(board) {
    const {objects,primitives}=copper(board),layers=indexing(board,primitives);
    const nets=new Map((board.nets||[]).map(n=>[netKey(n.id),n]));
    const allowedLayers=new Set((board.layers||[]).map((l,i)=>l.index??i));
    const netClearance=net=>Math.max(0,nets.get(netKey(net))?.routingClearance??nets.get(netKey(net))?.clearance??board.defaultClearance??0);
    const maxClearance=Math.max(board.crossClassClearance||0,board.defaultClearance||0,...(board.nets||[]).map(n=>n.routingClearance??n.clearance??0),...Object.values(board.classClearances||{}));
    const violations=[],widthDeviations=[],seen=new Set();
    function violation(type,key,detail){if(seen.has(key))return;seen.add(key);violations.push({type,...detail});}
    for(const net of board.nets||[])if(!Number.isFinite(net.width)||net.width<=0||!Number.isFinite(net.clearance)||net.clearance<0)violation('invalid_rule',`nrule:${net.id}`,{net:net.id,width:net.width,clearance:net.clearance});
    for(const object of objects)if((netKey(object.net)!==null&&!nets.has(netKey(object.net)))||(object.kind!=='pad'&&netKey(object.net)===null))violation('unknown_net',`n:${object.uid}`,{kind:object.kind,index:object.index,net:object.net});
    for(const p of primitives)if(!allowedLayers.has(p.layer))violation('unknown_layer',`l:${p.object.uid}:${p.layer}`,{kind:p.object.kind,index:p.object.index,layer:p.layer});
    for(const p of primitives)for(const q of layers.get(p.layer).query(p.bounds,maxClearance+EPS)){
      if(q.object.uid<=p.object.uid)continue;
      const same=netKey(p.net)!==null&&netKey(p.net)===netKey(q.net),actual=distanceShapes(p.shape,q.shape);
      if(!same){const required=clearance(board,nets.get(netKey(p.net)),nets.get(netKey(q.net)));if(actual+EPS<required||actual<=EPS)
        violation(actual<=EPS?'short':'clearance',`c:${p.object.uid}:${q.object.uid}:${p.layer}`,{layer:p.layer,a:{kind:p.object.kind,index:p.object.index,id:p.object.id,net:p.net},b:{kind:q.object.kind,index:q.object.index,id:q.object.id,net:q.net},actual,required});
      }else if(actual<=EPS){
        const via=p.object.kind==='via'?p.object:q.object.kind==='via'?q.object:null;
        const pad=p.object.kind==='pad'?p.object:q.object.kind==='pad'?q.object:null;
        if(via&&pad&&new Set(pad.item.shapes.map(s=>s.layer)).size===1){
          const def=(board.viaDefs||[]).find(d=>d.name===via.item.padstack);
          if(!(board.viaAtSmd&&def?.attachAllowed!==false))violation('via_in_pad',`a:${via.uid}:${pad.uid}`,{via:via.index,pad:pad.id,net:via.net,layer:p.layer});
        }
      }
    }
    for(const [index,t] of (board.traces||[]).entries()){
      const net=nets.get(netKey(t.net));
      if(net&&t.width+EPS<net.width)widthDeviations.push({index,net:t.net,layer:t.layer,actual:t.width,required:net.width});
      if(net?.useLayers&&!net.useLayers.includes(t.layer))violation('inactive_layer',`l:t:${index}`,{kind:'trace',index,layer:t.layer,net:t.net});
      if(!Number.isFinite(t.width)||t.width<=0||t.points.length<2||t.points.some(p=>p.length<2||!p.every(Number.isFinite)))violation('invalid_geometry',`i:t:${index}`,{kind:'trace',index});
    }
    for(const [index,v] of (board.vias||[]).entries()){
      const net=nets.get(netKey(v.net)),def=(board.viaDefs||[]).find(d=>d.name===v.padstack);
      if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||!Number.isFinite(v.diameter??def?.diameter)||(v.diameter??def?.diameter)<=0)violation('invalid_geometry',`i:v:${index}`,{kind:'via',index});
      if(!def)violation('unknown_via',`u:v:${index}`,{index,padstack:v.padstack});
      else if(Math.abs((v.diameter??def.diameter)-def.diameter)>EPS)violation('via_size',`s:v:${index}`,{index,actual:v.diameter,required:def.diameter});
      if(def&&v.layers){const expected=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>i+def.fromLayer);if(expected.length!==v.layers.length||expected.some(l=>!v.layers.includes(l)))violation('via_span',`p:v:${index}`,{index,actual:v.layers,required:expected});}
      if(net?.viaName&&v.padstack!==net.viaName)violation('via_rule',`r:v:${index}`,{index,padstack:v.padstack,required:net.viaName});
    }
    const edges=boundaryEdges(board);
    for(const p of primitives){
      if(!shapeInsideBoard(p.shape,board,edges))violation('outline',`o:${p.object.uid}:${p.layer}`,{kind:p.object.kind,index:p.object.index,id:p.object.id,net:p.net,layer:p.layer});
      for(const [index,k] of (board.keepouts||[]).entries()){
        if(k.layers&&!k.layers.includes(p.layer)||k.kind==='via'&&p.object.kind!=='via')continue;
        const required=k.clearance??netClearance(p.net),actual=distanceShapes(p.shape,k.shape);
        if(actual+EPS<required||actual<=EPS)violation('keepout',`k:${p.object.uid}:${index}:${p.layer}`,{kind:p.object.kind,index:p.object.index,keepout:index,net:p.net,layer:p.layer,actual,required});
      }
    }
    const count=type=>violations.filter(v=>type.includes(v.type)).length;
    return {clearanceViolations:count(['clearance','short']),belowNominalWidthTraceCount:widthDeviations.length,
      viaInPadViolations:count(['via_in_pad']),outlineViolations:count(['outline']),keepoutViolations:count(['keepout']),
      totalViolations:violations.length+widthDeviations.length,violations,widthDeviations};
  }
  function stats(board,validation=validate(board),connections=connectivity(board)) {
    let traceLength=0;for(const t of board.traces||[])for(let i=1;i<t.points.length;i++)traceLength+=distance(t.points[i-1],t.points[i]);
    return {unrouted:connections.unrouted,viaCount:(board.vias||[]).length,traceCount:(board.traces||[]).length,
      traceLengthMm:traceLength*(board.units?.mmPerUnit??1),clearanceViolations:validation.clearanceViolations,drcChecked:true,
      belowNominalWidthTraceCount:validation.belowNominalWidthTraceCount,widthRulesChecked:true,
      totalViolations:validation.totalViolations,viaInPadViolations:validation.viaInPadViolations,outlineViolations:validation.outlineViolations,keepoutViolations:validation.keepoutViolations,
      netCount:(board.nets||[]).length,componentCount:new Set((board.pads||[]).map(p=>p.component)).size,layerCount:(board.layers||[]).length};
  }
  return {EPS,distance,distancePointSegment,pointInPolygon,pointInShape,pointInBoard,pointOnSegment,segmentIntersection,closestPointOnSegment,
    closestSegmentPoints,distanceSegments,closestShapePoints,distanceShapes,distancePointShape,distanceSegmentShape,nearestPointOnShape,
    shapeBounds,boxesOverlap,spatialIndex,unionFind,copper,connectivity,boundaryEdges,shapeInsideBoard,clearance,validate,stats};
}
globalThis.createRamenGeometry=createRamenGeometry;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenGeometry};
