/* Focused native router regressions; no browser or installed routing engine needed. */
const assert=require('node:assert/strict');
const {createRamenGeometry}=require('../geometry.js');
const {createRamenRouter}=require('../router.js');
const G=createRamenGeometry();
const base={name:'native-router-regression',units:{name:'mm',resolution:1000,mmPerUnit:1},bounds:{minX:0,minY:0,maxX:10,maxY:10},layers:[{name:'Top',index:0,type:'signal'}],nets:[],pads:[],viaDefs:[],vias:[],traces:[],outlines:[[[0,0],[10,0],[10,10],[0,10]]],keepouts:[],viaAtSmd:false,defaultClearance:.5};
const clone=o=>JSON.parse(JSON.stringify(o));
(async()=>{
  let result=await createRamenRouter(G).route(clone(base),{deepSearch:false,optimize:false,fanout:false,timeoutMinutes:.1});
  assert.equal(result.stats.unrouted,0);assert.equal(result.stats.totalViolations,0);
  assert.equal(result.board.traces.length,0);assert.equal(result.board.vias.length,0);
  const board=clone(base);board.nets=[{id:1,name:'signal',pins:['a','b'],width:.6,clearance:.4,useLayers:[0]}];
  board.pads=[{id:'a',component:'A',pin:'1',net:1,x:2,y:2,shapes:[{type:'circle',layer:0,cx:2,cy:2,r:.4}]},{id:'b',component:'B',pin:'1',net:1,x:8,y:8,shapes:[{type:'circle',layer:0,cx:8,cy:8,r:.4}]},{id:'obstacle',component:'X',pin:'1',net:null,x:5,y:3,shapes:[{type:'polygon',layer:0,points:[[4,1],[6,1],[6,6],[4,6]]}]}];
  result=await createRamenRouter(G).route(board,{deepSearch:false,optimize:false,fanout:false,timeoutMinutes:.1,gridStep:.25});
  assert.equal(result.initialStats.unrouted,1);assert.equal(result.stats.unrouted,0);
  assert.equal(result.stats.totalViolations,0);assert.equal(result.board.vias.length,0);
  assert.ok(result.board.traces.length>0);assert.equal(G.validate(result.board).totalViolations,0);
  const classes=clone(board);classes.nets[0].routingClearance=1.1;
  const stricter=await createRamenRouter(G).route(classes,{deepSearch:false,optimize:false,fanout:false,timeoutMinutes:.1,gridStep:.25});
  assert.equal(stricter.stats.unrouted,0);assert.equal(stricter.stats.totalViolations,0);
  assert.equal(stricter.board.nets[0].clearance,.4,'planning must preserve the original class rule');
  const obstacle=classes.pads.find(p=>p.id==='obstacle').shapes[0];
  for(const trace of stricter.board.traces)for(let i=1;i<trace.points.length;i++){
    const a=trace.points[i-1],b=trace.points[i];
    assert.ok(G.distanceSegmentShape(a[0],a[1],b[0],b[1],obstacle)-trace.width/2>=1.1-1e-7,'routingClearance must govern actual copper planning');
  }
  console.log('router.test.cjs: empty-board, single-layer, exact-clearance, and class-clearance regressions passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
