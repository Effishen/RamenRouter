/* Nonprivate, original synthetic interchange regression fixtures. Run: node tests/dsn.test.js */
'use strict';
const assert = require('node:assert/strict');
const { createRamenDSN } = require('../dsn.js');
const api = createRamenDSN();
const fixture = `(pcb "synthetic.dsn"
 (parser (string_quote ") (space_in_quoted_tokens on))
 (resolution mm 1000) (unit mm)
 (structure (layer F (type signal)) (layer B (type signal))
  (boundary (rect pcb 0 0 100 100) (window (rect pcb 40 40 45 45)))
  (via VIA) (rule (width 1.8) (clearance 0.7))
  (keepout K (rect B 80 80 85 85)) (via_keepout V (circle F 3 90 90)))
 (placement (component CHIP (place U1 20 30 front 90) (place U2 70 50 back 90)))
 (library (image CHIP (pin PAD (rotate 90) 1 3 4))
  (padstack PAD (shape (rect F -2 -1 2 1)))
  (padstack VIA (shape (circle F 2)) (shape (circle B 2)) (attach off)))
 (network (net N (pins U1-1 U2-1))
  (class default (rule (width 1.5) (clearance 0.65)))
  (class SPECIAL N (circuit (use_via VIA) (use_layer F B)) (rule (width 1.2) (clearance 0.6))))
 (wiring (wire (path F 1.2 16 33 30 33 30 40) (net N) (type protect))
  (via VIA 30 40 (net N) (type fix))))`;
const board = api.parse(fixture, 'synthetic.dsn');
assert.equal(board.nets[0].width, 1.2);
assert.equal(board.nets[0].clearance, 0.6);
assert.equal(board.defaultWidth, 1.5);
assert.equal(board.defaultClearance, 0.65);
assert.equal(board.structureClearance, 0.7);
assert.equal(board.crossClassClearance, 0.65);
assert.equal(board.edgeClearance, 0.65);
assert.equal(board.clearanceMode, 'specctra-class-matrix');
assert.deepEqual(board.classClearances, {default:0.65,SPECIAL:0.6});
assert.equal(board.nets[0].className, 'SPECIAL');
assert.equal(board.nets[0].clearanceClass, 'SPECIAL');
assert.equal(board.nets[0].routingClearance, 0.65);
assert.deepEqual(board.nets[0].useLayers, [0,1]);
assert.deepEqual(board.pads.map(p=>[p.x,p.y,p.shapes[0].layer]), [[16,33,0],[66,47,1]]);
assert.deepEqual(board.pads[1].shapes[0].points[0], [68,46]);
assert.equal(board.holes.length, 1);
assert.equal(board.keepouts.length, 2);
assert.equal(board.keepouts[1].kind, 'via');
assert.equal(board.traces[0].fixed, true);
assert.equal(board.vias[0].fixed, true);
assert.equal(board.viaDefs[0].attachAllowed, false);

const exported = api.exportDsn(board);
const roundtrip = api.parse(exported, 'synthetic.dsn');
assert.deepEqual(roundtrip.nets, board.nets);
assert.deepEqual(roundtrip.pads, board.pads);
assert.deepEqual(roundtrip.traces, board.traces);
assert.deepEqual(roundtrip.vias, board.vias);
assert.deepEqual(roundtrip.holes, board.holes);
assert.deepEqual(roundtrip.keepouts, board.keepouts);
const sections = b => b._ast.filter(Array.isArray).filter(n=>!['wiring'].includes(n[0].toLowerCase()));
assert.deepEqual(sections(roundtrip), sections(board), 'Original design rules and placement/library syntax must survive export unchanged.');

const enabled = structuredClone(board);
enabled.viaInPadApplied = true;
enabled.viaAtSmd = true;
enabled.viaDefs.forEach(v=>v.attachAllowed=true);
const withPadVias = api.parse(api.exportDsn(enabled));
assert.equal(withPadVias.viaAtSmd, true);
assert.equal(withPadVias.viaDefs[0].attachAllowed, true);
assert.equal(withPadVias.nets[0].width, 1.2);
assert.equal(withPadVias.nets[0].clearance, 0.6);
assert.equal(board.viaAtSmd, false, 'Export must not mutate the source board.');

const ses = api.exportSes(board, 'synthetic.dsn');
assert.match(ses, /^\(session synthetic\.ses/);
assert.match(ses, /\(base_design synthetic\.dsn\)/);
const sesResolution=Number(ses.match(/\(resolution mm (\d+)\)/)[1]);
assert.ok(sesResolution>board.units.resolution);
assert.match(ses,new RegExp('\\(path F '+[1.2,16,33,30,33,30,40].map(v=>Math.round(v*sesResolution)).join(' ')+'\\)'));
assert.match(ses,new RegExp('\\(via VIA '+30*sesResolution+' '+40*sesResolution));
assert.doesNotMatch(ses, /polygon_path/);
assert.match(ses, /\(attach off\)/);
const quantized=structuredClone(board);
quantized.traces[0].width=0.984300123;
quantized.traces[0].points[0]=[16.000000123,33.000000789];
quantized.viaDefs[0].diameter=1.574800123;
const qSes=api.exportSes(quantized),qReport=api.exportSesReport(quantized);
const qResolution=Number(qSes.match(/\(resolution mm (\d+)\)/)[1]);
const qWidth=Number(qSes.match(/\(path F (\d+)/)[1])/qResolution;
const qDiameter=Number(qSes.match(/\(circle F (\d+)/)[1])/qResolution;
assert.ok(qWidth>=quantized.traces[0].width-1e-14);
assert.ok(qWidth-quantized.traces[0].width<=1/qResolution+1e-14);
assert.ok(qDiameter>=quantized.viaDefs[0].diameter-1e-14);
assert.ok(qDiameter-quantized.viaDefs[0].diameter<=1/qResolution+1e-14);
assert.equal(qReport.resolution,qResolution);
assert.equal(qReport.widthsExpanded,1);
assert.equal(qReport.viaDefinitionsExpanded,1);
assert.ok(qReport.maximumCoordinateErrorNative<=Math.SQRT2/(2*qResolution)+1e-12);
const veryLarge=structuredClone(board);
veryLarge.bounds.maxX=20000000;veryLarge.traces[0].points[0][0]=20000000;
const largeReport=api.exportSesReport(veryLarge);
assert.ok(Number.isInteger(largeReport.resolution));
assert.ok(largeReport.resolution<board.units.resolution);
assert.ok(largeReport.coarserThanInput);
assert.ok(20000000*largeReport.resolution<=2147483647);
assert.doesNotThrow(()=>api.exportSes(veryLarge));
veryLarge.bounds.maxX=3e9;
assert.throws(()=>api.exportSes(veryLarge),/signed 32-bit/);

const flip = fixture.replace('(placement ', '(placement (place_control (flip_style rotate_first)) ');
assert.deepEqual(api.parse(flip).pads[1].shapes[0].points[0], [72,54]);
assert.deepEqual([api.parse(flip).pads[1].x,api.parse(flip).pads[1].y], [74,53]);
const capsule = fixture.replace('(rect F -2 -1 2 1)', '(path F 2 -2 0 2 0)');
const capBoard = api.parse(capsule);
assert.equal(capBoard.pads[0].shapes[0].type, 'polygon');
assert.ok(capBoard.pads[0].shapes[0].points.length >= 32);
assert.ok(capBoard.warnings.some(w=>w.includes('capsule')));
const defaultOnly = fixture.replace('(class SPECIAL N (circuit (use_via VIA) (use_layer F B)) (rule (width 1.2) (clearance 0.6)))','');
assert.equal(api.parse(defaultOnly).nets[0].width, 1.5);
assert.equal(api.parse(defaultOnly).nets[0].clearance, 0.65);
assert.equal(api.parse(defaultOnly).nets[0].clearanceClass, 'default');
const twoClasses = fixture
  .replace('(clearance 0.7)', '(clearance 0.505)')
  .replace('(class default (rule (width 1.5) (clearance 0.65)))', '')
  .replace('(network ', '(network (net A) (net B) (net C) (net D) (class SECOND B (rule (clearance 0.5))) (class WIDTHONLY C (rule (width 1.1))) (class WIDE D (rule (clearance 0.8))) ')
  .replace('(class SPECIAL N ', '(class SPECIAL N A ')
  .replace('(clearance 0.6)', '(clearance 0.5)');
const matrixBoard=api.parse(twoClasses);
const byName=name=>matrixBoard.nets.find(net=>net.name===name);
assert.equal(matrixBoard.crossClassClearance,0.505);
assert.equal(byName('N').clearance,0.5);
assert.equal(byName('N').clearanceClass,byName('A').clearanceClass);
assert.notEqual(byName('N').clearanceClass,byName('B').clearanceClass);
assert.equal(byName('C').clearanceClass,'default','Width-only classes inherit the default clearance class.');
assert.equal(matrixBoard.classClearances.SPECIAL,0.5);
assert.equal(matrixBoard.classClearances.SECOND,0.5);
assert.equal(byName('N').routingClearance,0.8,'Planning must account for a foreign class with a larger clearance.');
assert.equal(matrixBoard.edgeClearance,0.8,'A higher class-to-outline rule must not be relaxed.');
const lowClasses=api.parse(twoClasses.replace('(class WIDE D (rule (clearance 0.8)))',''));
assert.equal(lowClasses.nets.find(net=>net.name==='N').routingClearance,0.505,'Distinct classes must retain the global cross-class clearance.');
assert.equal(lowClasses.edgeClearance,0.505);
assert.deepEqual(api.parse(api.exportDsn(matrixBoard)).classClearances,matrixBoard.classClearances);

assert.throws(()=>api.parse(fixture.replace('(use_layer F B)', '(use_layer F B) (length 10 20)')), /Unsupported length/);
assert.throws(()=>api.parse(fixture.replace('(rect F -2 -1 2 1)', '(ellipse F 2 1 0 0)')), /Unsupported shape ellipse/);
assert.throws(()=>api.parse(fixture.replace('(clearance 0.6)', '(clearance 0.6 (type custom_pair))')), /Pair-specific clearance/);
assert.throws(()=>api.parse(fixture.replace('U2-1','MISSING-1')), /missing pin/);
assert.throws(()=>api.parse(fixture.slice(0,-1)), /Missing closing/);
const serializedFactory = Function('return (' + createRamenDSN.toString() + ')')();
assert.deepEqual(serializedFactory().parse(fixture).pads, board.pads, 'The factory must work when serialized into an isolated worker.');
console.log('PASS DSN transforms, strict constraints, exact rule/geometry roundtrip, fixed copper, holes/keepouts, explicit permission export, SES units, and isolated factory.');
