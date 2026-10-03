'use strict';
const assert=require('node:assert/strict');
const {createRamenGeometry}=require('../geometry.js');
const g=createRamenGeometry();
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const rect=(x0,y0,x1,y1,layer=0)=>({type:'polygon',layer,points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
const circle=(x,y,r,layer=0)=>({type:'circle',cx:x,cy:y,r,layer});
function board(){return {name:'test',bounds:{minX:-5,minY:-5,maxX:20,maxY:20},outlines:[[[-5,-5],[20,-5],[20,20],[-5,20]]],holes:[],layers:[{index:0,name:'top'},{index:1,name:'bottom'}],nets:[{id:1,name:'one',width:1,clearance:.5,viaName:'V',useLayers:[0,1]},{id:2,name:'two',width:1,clearance:.5,viaName:'V',useLayers:[0,1]}],pads:[],traces:[],vias:[],viaDefs:[{name:'V',diameter:1,fromLayer:0,toLayer:1,attachAllowed:true}],viaAtSmd:false,keepouts:[],units:{mmPerUnit:1}};}
function pad(id,x,y,net=1,layers=[0]){return {id,component:id,pin:'1',x,y,net,shapes:layers.map(l=>circle(x,y,.5,l))};}
let tests=0;
function test(name,fn){fn();tests++;console.log('PASS',name);}
test('Exact segment distances including crossing, collinear and zero-length',()=>{
 near(g.distanceSegments([0,0],[2,2],[0,2],[2,0]),0);
 near(g.distanceSegments([0,0],[1,0],[2,0],[3,0]),1);
 near(g.distanceSegments([0,0],[3,0],[2,0],[4,0]),0);
 near(g.distanceSegments([1,1],[1,1],[2,0],[2,3]),1);
});
test('Exact circle, polygon and capsule copper distances',()=>{
 near(g.distanceShapes(circle(0,0,1),circle(4,0,1)),2);
 near(g.distanceShapes(circle(0,0,1),rect(3,-2,4,2)),2);
 near(g.distanceSegmentShape(-1,1,3,1,rect(0,0,2,2)),0);
 near(g.distanceSegmentShape(-1,3,3,3,rect(0,0,2,2)),1);
 near(g.distanceShapes({type:'capsule',a:[0,0],b:[5,0],r:.5},circle(3,2,.5)),1);
 near(g.distanceShapes(rect(0,0,3,3),rect(1,1,2,2)),0);
});
test('Polygon boundaries and concavities',()=>{
 const p=[[0,0],[4,0],[4,4],[3,4],[3,1],[1,1],[1,4],[0,4]];
 assert.equal(g.pointInPolygon(2,2,p),false);assert.equal(g.pointInPolygon(1,2,p),true);assert.equal(g.pointInPolygon(.5,2,p),true);
});
test('Spatial index returns exact nearby candidates and handles oversized objects',()=>{
 const a={bounds:{minX:0,minY:0,maxX:1,maxY:1}},b={bounds:{minX:2,minY:0,maxX:3,maxY:1}},huge={bounds:{minX:-1e9,minY:-1e9,maxX:1e9,maxY:1e9}};
 const index=g.spatialIndex([a,b,huge],1);assert.deepEqual(new Set(index.query(a.bounds)),new Set([a,huge]));
 assert.equal(index.query(a.bounds,1).length,3);index.remove(huge);assert.equal(index.query(a.bounds).length,1);
});
test('Connectivity joins touching copper but never joins foreign-net crossings',()=>{
 const b=board();b.pads=[pad('a',0,0),pad('b',10,0),pad('c',5,-3,2),pad('d',5,3,2)];
 assert.equal(g.connectivity(b).unrouted,2);
 b.traces=[{net:1,layer:0,width:1,points:[[1,0],[9,0]]},{net:2,layer:0,width:1,points:[[5,-3],[5,3]]}];
 assert.equal(g.connectivity(b).unrouted,0);assert.equal(g.connectivity(b).components.length,2);
 assert.ok(g.validate(b).clearanceViolations>0);
});
test('Different layers stay disconnected until a real via or through-hole pad joins them',()=>{
 const b=board();b.pads=[pad('a',0,0,1,[0]),pad('b',0,0,1,[1])];
 assert.equal(g.connectivity(b).unrouted,1);b.vias=[{x:0,y:0,net:1,padstack:'V',diameter:1,layers:[0,1]}];
 assert.equal(g.connectivity(b).unrouted,0);assert.equal(g.validate(b).viaInPadViolations,2);
 b.viaAtSmd=true;assert.equal(g.validate(b).totalViolations,0);
});
test('Strict validation detects width reductions, changed via size and changed via span',()=>{
 const b=board();b.traces=[{net:1,layer:0,width:.8,points:[[0,0],[3,0]]}];
 b.vias=[{x:3,y:0,net:1,padstack:'V',diameter:.8,layers:[0]}];
 const v=g.validate(b);assert.equal(v.belowNominalWidthTraceCount,1);assert.ok(v.violations.some(x=>x.type==='via_size'));assert.ok(v.violations.some(x=>x.type==='via_span'));assert.equal(v.totalViolations,3);
});
test('Net class overrides are used, rather than imposing the unrelated default clearance',()=>{
 const b=board();b.defaultClearance=2;b.pads=[pad('a',0,0,1),pad('b',1.6,0,2)];assert.equal(g.validate(b).clearanceViolations,0);
 b.pads[1].x=1.4;b.pads[1].shapes=[circle(1.4,0,.5)];assert.equal(g.validate(b).clearanceViolations,1);
});
test('Specctra clearance matrix preserves cross-class default and same-class diagonal',()=>{
 const b=board();b.clearanceMode='specctra-class-matrix';b.defaultClearance=.505;b.crossClassClearance=.505;
 b.classClearances={a:.5,b:.5,c:.8};b.nets[0].clearanceClass='a';b.nets[1].clearanceClass='b';
 b.pads=[pad('a',0,0,1),pad('b',1.502,0,2)];
 near(g.clearance(b,1,2),.505);assert.equal(g.validate(b).clearanceViolations,1);
 b.nets[1].clearanceClass='a';near(g.clearance(b,b.nets[0],b.nets[1]),.5);assert.equal(g.validate(b).clearanceViolations,0);
 b.nets[1].clearanceClass='c';b.nets[1].clearance=.8;near(g.clearance(b,1,2),.8);near(g.clearance(b,1,null),.505);
 assert.equal(g.validate(b).clearanceViolations,1);
});
test('Copper radius must fit inside the outline, not just its center',()=>{
 const b=board();b.traces=[{net:1,layer:0,width:1,points:[[-4.8,0],[-4.8,3]]}];assert.equal(g.validate(b).outlineViolations,1);
 b.traces[0].points=[[-4.4,0],[-4.4,3]];assert.equal(g.validate(b).outlineViolations,0);
 b.edgeClearance=.2;assert.equal(g.validate(b).outlineViolations,1);
});
test('A narrow concave notch cannot be crossed by polygon edges',()=>{
 const b=board();b.outlines=[[[0,0],[100,0],[100,10],[41,10],[41,1],[40,1],[40,10],[0,10]]];
 assert.equal(g.shapeInsideBoard(rect(2,4,98,6),b),false);
});
test('Holes are checked even when entirely enclosed by a copper polygon',()=>{
 const b=board();b.holes=[[[4,4],[6,4],[6,6],[4,6]]];assert.equal(g.shapeInsideBoard(rect(2,2,8,8),b),false);
 assert.equal(g.shapeInsideBoard(circle(3,5,1.1),b),false);
});
test('Overlapping outlines use their union rather than treating internal seams as board edges',()=>{
 const b=board();b.outlines=[[[0,0],[6,0],[6,6],[0,6]],[[4,0],[10,0],[10,6],[4,6]]];
 assert.equal(g.shapeInsideBoard({type:'capsule',a:[2,3],b:[8,3],r:.5},b),true);
});
test('Via-only keepouts do not prohibit traces but do prohibit vias',()=>{
 const b=board();b.keepouts=[{layers:[0,1],kind:'via',shape:rect(1,-1,3,1)}];b.traces=[{net:1,layer:0,width:1,points:[[0,0],[4,0]]}];
 assert.equal(g.validate(b).keepoutViolations,0);b.vias=[{net:1,x:2,y:0,padstack:'V',diameter:1,layers:[0,1]}];assert.equal(g.validate(b).keepoutViolations,2);
});
test('A disconnected copper island remains a separate electrical component',()=>{
 const b=board();b.pads=[pad('a',0,0)];b.traces=[{net:1,layer:0,width:1,points:[[5,0],[8,0]]}];
 const c=g.connectivity(b);assert.equal(c.unrouted,1);assert.equal(c.airwires.length,1);assert.equal(c.components[0].groups.length,2);
});
test('Factory serialization works without outside bindings',()=>{
 const recreated=Function('return ('+createRamenGeometry.toString()+')()')();near(recreated.distanceSegments([0,0],[1,0],[2,0],[3,0]),1);
});
console.log(`${tests} geometry tests passed.`);
