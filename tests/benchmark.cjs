/* Developer-only Node runner for the exact same factories used by the browser. */
const fs=require('node:fs');
const path=require('node:path');
require('../dsn.js');require('../geometry.js');require('../router.js');require('../optimizer.js');require('../fanout.js');
const a=process.argv.slice(2),input=a[0];
if(!input)throw new Error('Usage: node tests/benchmark.cjs input.dsn [--via] [--passes N] [--minutes N] [--out path] [--no-fanout]');
const value=(k,f)=>a.includes(k)?a[a.indexOf(k)+1]:f;
const out=value('--out',path.join(process.cwd(),'benchmark-output'));
const options={fanout:!a.includes('--no-fanout'),fanoutOnly:false,optimize:!a.includes('--no-optimize'),deepSearch:!a.includes('--single'),viaInPad:a.includes('--via'),maxPasses:Number(value('--passes',12)),timeoutMinutes:Number(value('--minutes',30)),quality:value('--quality','balanced'),...(a.includes('--grid')?{gridStep:Number(value('--grid'))}:{})};
const start=Date.now(),deadline=start+options.timeoutMinutes*60000;
let cancel=false;process.on('SIGINT',()=>{cancel=true;console.log('Stop requested.');});
const dsn=createRamenDSN(),geo=createRamenGeometry(),router=createRamenRouter(geo,createRamenOptimizer(geo),createRamenFanout(geo));
const b=dsn.parse(fs.readFileSync(input,'utf8'),path.basename(input));
function measure(board) {let length=0;for(const t of board.traces)for(let i=1;i<t.points.length;i++)length+=Math.hypot(t.points[i][0]-t.points[i-1][0],t.points[i][1]-t.points[i-1][1]);return {unrouted:geo.connectivity(board).unrouted,viaCount:board.vias.length,traceCount:board.traces.length,traceLengthMm:length*board.units.mmPerUnit,...geo.validate(board)};}
const initial=measure(b),logs=[];
console.log(JSON.stringify({initial,options}));
(async()=>{
const result=await router.route(b,options,m=>{const entry={seconds:(Date.now()-start)/1000,...(typeof m==='string'?{message:m}:m)};delete entry.board;logs.push(entry);console.log(JSON.stringify(entry));},()=>cancel||Date.now()>deadline);
const board=result.board||result,stats=measure(board);
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'result.dsn'),dsn.exportDsn(board,path.basename(input)));
fs.writeFileSync(path.join(out,'result.ses'),dsn.exportSes(board,path.basename(input)));
fs.writeFileSync(path.join(out,'board.json'),JSON.stringify(board));
fs.writeFileSync(path.join(out,'status.json'),JSON.stringify({engine:'Ramen JS0.2',state:cancel?'stopped':Date.now()>deadline?'timed_out':'completed',elapsedSeconds:(Date.now()-start)/1000,initial,stats,options},null,2));
fs.writeFileSync(path.join(out,'job.log'),logs.map(e=>JSON.stringify(e)).join('\n'));
console.log(JSON.stringify({final:stats,elapsedSeconds:(Date.now()-start)/1000,out}));
})().catch(e=>{console.error(e);process.exitCode=1;});
