/* Independent SES copper-record verifier; test-only, no application parser. */
const requireTrue=(value,message)=>{if(!value)throw Error(message);};
function verifySesGeometry(text,board){
  const tokens=text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g)||[];let pos=0;
  function read(){const token=tokens[pos++];if(token==='('){const out=[];while(tokens[pos]!==')'){requireTrue(pos<tokens.length,'Unclosed SES scope');out.push(read());}pos++;return out;}requireTrue(token!==undefined&&token!==')','Invalid SES token');return token.startsWith('"')?JSON.parse(token):token;}
  const ast=read();requireTrue(pos===tokens.length&&ast[0]==='session','Invalid SES document');
  const routes=ast.find(n=>Array.isArray(n)&&n[0]==='routes');
  const network=routes?.find(n=>Array.isArray(n)&&n[0]==='network_out');
  const resolution=routes?.find(n=>Array.isArray(n)&&n[0]==='resolution');
  requireTrue(network&&resolution,'Missing SES route network/resolution');
  const scale=Number(resolution[2]);
  requireTrue(resolution[1]===board.units.name&&Number.isSafeInteger(scale)&&scale>0,'SES unit/resolution invalid');
  const wires=[],vias=[];
  for(const n of network.slice(1)){if(!Array.isArray(n)||n[0]!=='net')continue;for(const item of n.slice(2)){
    if(item[0]==='wire'){const p=item.find(x=>Array.isArray(x)&&x[0]==='path');requireTrue(p,'SES wire has no path');wires.push({key:JSON.stringify([n[1],p[1],...p.slice(3).map(Number)]),width:Number(p[2])/scale});}
    if(item[0]==='via')vias.push(JSON.stringify([n[1],item[1],Number(item[2]),Number(item[3])]));
  }}
  const net=id=>board.nets.find(n=>n.id===id)?.name;
  const q=n=>Math.round(n*scale);
  const expectedWires=board.traces.map(t=>({key:JSON.stringify([net(t.net),board.layers[t.layer].name,...t.points.flat().map(q)]),width:t.width}));
  const order=(a,b)=>a.key.localeCompare(b.key)||a.width-b.width;
  wires.sort(order);expectedWires.sort(order);
  const expectedVias=board.vias.map(v=>JSON.stringify([net(v.net),v.padstack,q(v.x),q(v.y)])).sort();
  requireTrue(wires.length===expectedWires.length,'SES changed trace count');
  for(let i=0;i<wires.length;i++){const actual=wires[i],expected=expectedWires[i];requireTrue(actual.key===expected.key,'SES changed trace net/layer/coordinates');requireTrue(actual.width>=expected.width-1e-10&&actual.width<=expected.width+1/scale+1e-10,'SES narrowed or unexpectedly widened a trace');}
  requireTrue(JSON.stringify(vias.sort())===JSON.stringify(expectedVias),'SES changed via net/padstack/coordinates or via count');
  const library=routes.find(n=>Array.isArray(n)&&n[0]==='library_out');
  for(const definition of board.viaDefs){
    const padstack=library?.find(n=>Array.isArray(n)&&n[0]==='padstack'&&n[1]===definition.name);
    requireTrue(padstack,'SES lost via definition '+definition.name);
    const circles=padstack.filter(n=>Array.isArray(n)&&n[0]==='shape').map(n=>n[1]);
    for(let layer=definition.fromLayer;layer<=definition.toLayer;layer++){
      const circle=circles.find(n=>n[0]==='circle'&&n[1]===board.layers[layer].name);
      requireTrue(circle,'SES lost via layer '+definition.name);
      const diameter=Number(circle[2])/scale;
      requireTrue(diameter>=definition.diameter-1e-10&&diameter<=definition.diameter+1/scale+1e-10,'SES narrowed or unexpectedly widened via copper');
    }
  }
  return {traces:wires.length,vias:vias.length,sesResolution:scale,everyCopperRecordMatched:true,noCopperWidthRoundedDown:true,cadImportTested:false};
}
module.exports={verifySesGeometry};
