'use strict';
const assert=require('node:assert/strict');
const {createRamenGeometry}=require('../geometry.js'),{createRamenFanout}=require('../fanout.js');
const g=createRamenGeometry(),f=createRamenFanout(g);
function synthetic(angle){
 const rot=p=>[Math.cos(angle)*p[0]-Math.sin(angle)*p[1],Math.sin(angle)*p[0]+Math.cos(angle)*p[1]];
 const b={name:'dense-row',units:{name:'mm',mmPerUnit:1},bounds:{minX:-30,minY:-30,maxX:30,maxY:30},outlines:[[[-30,-30],[30,-30],[30,30],[-30,30]]],layers:[{index:0,name:'top'},{index:1,name:'bottom'}],nets:[],pads:[],traces:[],vias:[],keepouts:[],holes:[],viaDefs:[{name:'V',diameter:1.6,fromLayer:0,toLayer:1,attachAllowed:true}],viaAtSmd:false,defaultClearance:.3};
 for(let i=0;i<5;i++){const y=(i-2)*1.5,p=rot([0,y]),poly=[[-1,y-.35],[1,y-.35],[1,y+.35],[-1,y+.35]].map(rot),remote=rot([15,y*3]);
  b.nets.push({id:i+1,name:'signal'+i,pins:['P'+i,'R'+i],width:.9,clearance:.3,viaName:'V',useLayers:[0,1]});
  b.pads.push({id:'P'+i,component:'combined-export',pin:''+i,net:i+1,x:p[0],y:p[1],shapes:[{type:'polygon',layer:0,points:poly}]});
  b.pads.push({id:'R'+i,component:'combined-export',pin:'r'+i,net:i+1,x:remote[0],y:remote[1],shapes:[{type:'circle',layer:0,cx:remote[0],cy:remote[1],r:.5}]});
 }return b;
}
(async()=>{
 for(const angle of [0,Math.PI/4,Math.PI/6]){const b=synthetic(angle),source=JSON.stringify(b),r=await f.fanout(b,{timeoutMinutes:1});
  assert.equal(JSON.stringify(b),source,'input must remain unchanged');assert.equal(g.validate(r.board).totalViolations,0);assert.ok(r.addedVias>=5,'dense row must escape');
  for(const c of g.connectivity(r.board).components){const group=c.groups.find(group=>group.pads.some(id=>id[0]==='P'));assert.equal(new Set(group.points.map(p=>p[2])).size,2,'row pad must reach both layers');}
 console.log('PASS generic rotated row',angle,r.addedVias);
 }
 const matrix=synthetic(0);matrix.clearanceMode='specctra-class-matrix';matrix.crossClassClearance=.5;matrix.defaultClearance=.5;matrix.classClearances={};
 for(const n of matrix.nets){n.clearanceClass=n.name;n.routingClearance=.5;matrix.classClearances[n.name]=n.clearance;}
 const matrixResult=await f.fanout(matrix,{timeoutMinutes:1});assert.ok(matrixResult.addedVias>=5);assert.equal(g.validate(matrixResult.board).totalViolations,0);
 assert.ok(matrixResult.board.nets.every(n=>n.clearance===.3),'routing clearance must not rewrite class rules');console.log('PASS cross-class fanout spacing and original class rules');
 const recreate=Function('return ('+createRamenFanout.toString()+')')()(g);assert.equal(typeof recreate.fanout,'function');
 const cancelled=await f.fanout(synthetic(0),{},()=>{},()=>true);assert.equal(cancelled.addedVias,0);assert.equal(cancelled.stopped,true);
 console.log('PASS generic cancellation and factory serialization');
})().catch(e=>{console.error(e);process.exitCode=1;});
