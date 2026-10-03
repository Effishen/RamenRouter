const assert=require('node:assert/strict');
require('../geometry.js');require('../optimizer.js');
const g=createRamenGeometry(),o=createRamenOptimizer(g);
const copy=b=>JSON.parse(JSON.stringify(b));
function fixture(){return {bounds:{minX:0,minY:0,maxX:20,maxY:20},outlines:[[[0,0],[20,0],[20,20],[0,20]]],holes:[],units:{mmPerUnit:1},layers:[{index:0,name:'top'}],nets:[{id:1,name:'signal',width:.5,clearance:.5,useLayers:[0]},{id:2,name:'obstacle',width:.5,clearance:.5,useLayers:[0]}],pads:[{id:'a',component:'U1',net:1,x:2,y:2,shapes:[{type:'circle',layer:0,cx:2,cy:2,r:.6}]},{id:'b',component:'U2',net:1,x:18,y:18,shapes:[{type:'circle',layer:0,cx:18,cy:18,r:.6}]}],traces:[{net:1,layer:0,width:.5,points:[[2,2],[2,18],[18,18]],fixed:false}],vias:[],viaDefs:[],keepouts:[],defaultClearance:.5};}
(async()=>{
 const a=fixture(),original=copy(a),r=await o.optimize(a,{},()=>{},()=>false);
 assert.equal(g.connectivity(r).unrouted,0);assert.equal(g.validate(r).totalViolations,0);assert.ok(g.stats(r).traceLengthMm<g.stats(a).traceLengthMm);assert.deepEqual(a,original);console.log('PASS clear route shortened without mutating caller');
 const b=fixture();b.pads.push({id:'obstacle',component:'U3',net:2,x:10,y:10,shapes:[{type:'circle',layer:0,cx:10,cy:10,r:2}]});
 const s=await o.optimize(b,{},()=>{},()=>false);assert.equal(g.validate(s).totalViolations,0);assert.equal(g.connectivity(s).unrouted,0);assert.equal(g.stats(s).traceLengthMm,32);console.log('PASS shortcut cannot cross foreign copper');
 const c=fixture();c.pads.push({id:'branch',component:'U3',net:1,x:2,y:10,shapes:[{type:'circle',layer:0,cx:2,cy:10,r:.6}]});
 const t=await o.optimize(c,{},()=>{},()=>false);assert.equal(g.connectivity(t).unrouted,0);assert.deepEqual(t.traces[0].points,c.traces[0].points);console.log('PASS trunk shortcut retains an interior branch connection');
 const d=fixture();d.traces[0].fixed=true;const u=await o.optimize(d,{},()=>{},()=>false);assert.deepEqual(u.traces,d.traces);const v=await o.optimize(fixture(),{},()=>{},()=>true);assert.deepEqual(v.traces,fixture().traces);console.log('PASS fixed copper and cancellation preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
