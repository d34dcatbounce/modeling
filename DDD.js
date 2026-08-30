"use strict";
/* ══════════════════════════════════════════════════════
   〈정사영 합〉
   좌: 물체 · 중: 깎기(무한기둥 교집합) · 우: 쌓기(판 적층)
   ══════════════════════════════════════════════════════ */

const FAIL = document.getElementById('fail');
if (typeof THREE === 'undefined') { FAIL.classList.add('on'); throw new Error('three.js'); }

/* ── 상수 ────────────────────────────────── */
const R_MM = 28.75, r_MM = 16.25;                 // 시판 글레이즈드 도넛
const FIT  = 0.82 / ((R_MM + r_MM) / R_MM);
const RR = FIT, rr = FIT * (r_MM / R_MM);

const N = 64, TILES = 8, ATLAS = TILES * N;
const M = 256, S = 1.9, PAD = 2;
const MAXC = 10;                                  // 총 촬영 횟수 상한
const PLATE_TH = 0.060;                           // 판 두께 (좌극한 척도와 공유)
const P1 = new THREE.Color('#FFE2F0'),
      P2 = new THREE.Color('#FF74AA'),
      P3 = new THREE.Color('#CB246C');

const SMALL  = Math.min(innerWidth, innerHeight) < 760;
const STEPS  = SMALL ? 64 : 92;
const MAXDPR = SMALL ? 1.25 : 1.5;

/* ── 연산 코어 (워커/메인 공용) ──────────── */
/* 아래 네 함수는 문자열로 직렬화되어 워커에도 그대로 주입된다.
   따라서 외부 클로저 변수를 참조하지 말 것 — 전역 N/M/S/PAD/CORE만 사용. */
const CORE = { pts:null, alive:null, atlasData:null };

function packFieldCore(){
  const alive=CORE.alive, atlasData=CORE.atlasData, n3=N*N*N;
  let f=new Float32Array(n3), g=new Float32Array(n3);
  for(let i=0;i<n3;i++) f[i]=alive[i];
  const id=(i,j,k)=>(i*N+j)*N+k;
  const cl=v=>v<0?0:(v>N-1?N-1:v);
  for(let pass=0;pass<2;pass++) for(let ax=0;ax<3;ax++){
    for(let i=0;i<N;i++)for(let j=0;j<N;j++)for(let k=0;k<N;k++){
      let a,b,c;
      if(ax===0){a=f[id(cl(i-1),j,k)];b=f[id(i,j,k)];c=f[id(cl(i+1),j,k)];}
      else if(ax===1){a=f[id(i,cl(j-1),k)];b=f[id(i,j,k)];c=f[id(i,cl(j+1),k)];}
      else{a=f[id(i,j,cl(k-1))];b=f[id(i,j,k)];c=f[id(i,j,cl(k+1))];}
      g[id(i,j,k)]=(a+2*b+c)*0.25;
    }
    const t=f; f=g; g=t;
  }
  for(let k=0;k<N;k++){
    const tx=(k%TILES)*N, ty=((k/TILES)|0)*N;
    for(let j=0;j<N;j++)for(let i=0;i<N;i++){
      const o=(((ty+j)*ATLAS)+tx+i)*4;
      atlasData[o]=(f[id(i,j,k)]*255)|0; atlasData[o+3]=255;
    }
  }
}
function edt1dCore(f,n,d,v,z){
  let k=0; v[0]=0; z[0]=-Infinity; z[1]=Infinity;
  for(let q=1;q<n;q++){
    let s=(f[q]+q*q-(f[v[k]]+v[k]*v[k]))/(2*q-2*v[k]);
    while(s<=z[k]){ k--; s=(f[q]+q*q-(f[v[k]]+v[k]*v[k]))/(2*q-2*v[k]); }
    k++; v[k]=q; z[k]=s; z[k+1]=Infinity;
  }
  k=0;
  for(let q=0;q<n;q++){ while(z[k+1]<q) k++; const dq=q-v[k]; d[q]=dq*dq+f[v[k]]; }
}
function edt2dCore(seed,inv){
  const INF=1e12, g=new Float64Array(M*M);
  for(let i=0;i<M*M;i++) g[i]=((inv?!seed[i]:!!seed[i])?0:INF);
  const f=new Float64Array(M), d=new Float64Array(M);
  const v=new Int32Array(M), z=new Float64Array(M+1);
  for(let x=0;x<M;x++){ for(let y=0;y<M;y++) f[y]=g[y*M+x]; edt1dCore(f,M,d,v,z);
    for(let y=0;y<M;y++) g[y*M+x]=d[y]; }
  for(let y=0;y<M;y++){ const row=y*M; for(let x=0;x<M;x++) f[x]=g[row+x]; edt1dCore(f,M,d,v,z);
    for(let x=0;x<M;x++) g[row+x]=d[x]; }
  return g;
}
function runCore(m){
  if(m.cmd==='init'){
    CORE.pts = new Float32Array(m.pts);
    CORE.alive = new Uint8Array(N*N*N).fill(1);
    CORE.atlasData = new Uint8Array(ATLAS*ATLAS*4);
    // 원본(토러스) 부피 — 일치도 분모
    const RR=m.RR, rr2=m.rr*m.rr; let orig=0;
    for(let i=0;i<N;i++){ const x=-1+(i+0.5)*(2/N);
      for(let j=0;j<N;j++){ const y=-1+(j+0.5)*(2/N);
        for(let k=0;k<N;k++){ const z=-1+(k+0.5)*(2/N);
          const q=Math.sqrt(x*x+z*z)-RR;
          if(q*q+y*y<=rr2) orig++;
        } } }
    CORE.orig = orig;
    CORE.stack = new Uint8Array(N*N*N);
    packFieldCore();
    return {cmd:'field', atlas:CORE.atlasData.slice().buffer, live:N*N*N, orig:orig, stack:0};
  }
  if(m.cmd==='reset'){
    CORE.alive.fill(1); CORE.stack.fill(0); packFieldCore();
    return {cmd:'field', atlas:CORE.atlasData.slice().buffer, live:N*N*N, orig:CORE.orig, stack:0};
  }
  const u=m.u, v=m.v, d=m.d, pts=CORE.pts, alive=CORE.alive, stack=CORE.stack;
  const halfTH = m.th*0.5;
  const sc=M/(2*S);
  const sil=new Uint8Array(M*M);
  for(let n=0;n<pts.length;n+=3){
    const x=pts[n],y=pts[n+1],z=pts[n+2];
    const ca=((x*u[0]+y*u[1]+z*u[2]+S)*sc)|0, cb=((x*v[0]+y*v[1]+z*v[2]+S)*sc)|0;
    for(let q=-PAD;q<=PAD;q++){
      const rb=cb+q; if(rb<0||rb>=M) continue; const row=rb*M;
      for(let p=-PAD;p<=PAD;p++){ const ra=ca+p; if(ra>=0&&ra<M) sil[row+ra]=1; }
    }
  }
  let live=0, sv=0;
  for(let i=0;i<N;i++){ const x=-1+(i+0.5)*(2/N);
    for(let j=0;j<N;j++){ const y=-1+(j+0.5)*(2/N);
      for(let k=0;k<N;k++){
        const o=(i*N+j)*N+k;
        const z=-1+(k+0.5)*(2/N);
        const ca=((x*u[0]+y*u[1]+z*u[2]+S)*sc)|0, cb=((x*v[0]+y*v[1]+z*v[2]+S)*sc)|0;
        const inSil = ca>=0 && ca<M && cb>=0 && cb<M && sil[cb*M+ca]===1;
        if(alive[o]){ if(!inSil) alive[o]=0; else live++; }
        if(!stack[o] && inSil && Math.abs(x*d[0]+y*d[1]+z*d[2]) <= halfTH) stack[o]=1;
        if(stack[o]) sv++;
      } } }
  packFieldCore();
  const dOut=edt2dCore(sil,false), dIn=edt2dCore(sil,true);
  const sdf=new Float32Array(M*M);
  for(let i=0;i<M*M;i++) sdf[i]=Math.sqrt(dOut[i])-Math.sqrt(dIn[i]);
  return {cmd:'capture', atlas:CORE.atlasData.slice().buffer, sdf:sdf.buffer,
          live:live, stack:sv, orig:CORE.orig};
}

/* ── 워커: 되면 쓰고, 안 되면 메인에서 ───── */
let worker=null, workerReady=false, bootTimer=null;
function toMain(msg){ handleResult(msg); }

function runLocal(msg){
  // 메인 스레드 폴백 — 프레임을 한 번 넘겨 로딩 표시가 그려지게 함
  setTimeout(()=>{ toMain(runCore(msg)); }, 0);
}
function dispatch(msg, transfer){
  if(worker && workerReady!==false){ worker.postMessage(msg, transfer||[]); }
  else { runLocal(msg); }
}
function dropWorker(reason){
  if(workerReady===false) return;
  workerReady=false;
  if(worker){ try{ worker.terminate(); }catch(e){} worker=null; }
  if(bootTimer){ clearTimeout(bootTimer); bootTimer=null; }
  if(!CORE.alive) runLocal({cmd:'init', pts:PTS_BACKUP.buffer.slice(0), RR:RR, rr:rr});
}

try{
  const src = [
    'const N='+N+',TILES='+TILES+',ATLAS='+ATLAS+',M='+M+',S='+S+',PAD='+PAD+';',
    'const CORE={pts:null,alive:null,atlasData:null};',
    packFieldCore.toString(),
    edt1dCore.toString(),
    edt2dCore.toString(),
    runCore.toString(),
    'self.onmessage=function(e){',
    '  const r=runCore(e.data);',
    '  const t=[r.atlas]; if(r.sdf) t.push(r.sdf);',
    '  self.postMessage(r,t);',
    '};'
  ].join('\n');
  worker = new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})));
  worker.onmessage = e => { workerReady=true; if(bootTimer){clearTimeout(bootTimer);bootTimer=null;} handleResult(e.data); };
  worker.onerror = () => dropWorker('error');
  worker.onmessageerror = () => dropWorker('messageerror');
}catch(err){ worker=null; }

/* ── 도넛 ────────────────────────────────── */
const tp = (u,v)=>[ (RR+rr*Math.cos(v))*Math.cos(u), rr*Math.sin(v), (RR+rr*Math.cos(v))*Math.sin(u) ];
function torusGeometry(US,VS){
  const pos=[],idx=[];
  for(let i=0;i<=US;i++){ const u=i/US*Math.PI*2;
    for(let j=0;j<=VS;j++){ const p=tp(u, j/VS*Math.PI*2); pos.push(p[0],p[1],p[2]); } }
  const w=VS+1;
  for(let i=0;i<US;i++)for(let j=0;j<VS;j++){
    const a=i*w+j,b=i*w+j+1,c=(i+1)*w+j,d=(i+1)*w+j+1;
    idx.push(a,c,b, b,c,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
function torusCloud(US,VS){
  const out=new Float32Array(US*VS*3); let n=0;
  for(let i=0;i<US;i++){ const u=i/US*Math.PI*2;
    for(let j=0;j<VS;j++){ const p=tp(u, j/VS*Math.PI*2);
      out[n++]=p[0]; out[n++]=p[1]; out[n++]=p[2]; } }
  return out;
}

/* ── 셰이더 ──────────────────────────────── */
const CEL = `
uniform vec3 uP1, uP2, uP3, uLine;
uniform float uEntry;
vec3 cel(float lam){
  if(lam > 0.72) return uP1;
  if(lam > 0.34) return uP2;
  return uP3;
}
bool bandEdge(float lam){
  return abs(lam-0.34) < 0.018 || abs(lam-0.72) < 0.018;
}
`;
const CARVE_FRAG = `
precision highp float;
#define STEPS ${STEPS}
varying vec3 vP;
uniform sampler2D uAtlas;
uniform vec3 uCamL;
uniform float uN, uTiles, uSize;
` + CEL + `
float slice(float s, vec2 xy){
  s = clamp(s, 0.0, uN-1.0);
  float ty = floor(s/uTiles);
  float tx = s - ty*uTiles;
  vec2 uv = (vec2(tx,ty)*uN + clamp(xy, vec2(0.5), vec2(uN-0.5))) / uSize;
  return texture2D(uAtlas, uv).r;
}
float field(vec3 p){
  vec3 q = (p*0.5+0.5)*uN;
  float z = clamp(q.z-0.5, 0.0, uN-1.0);
  float z0 = floor(z);
  return mix(slice(z0,q.xy), slice(z0+1.0,q.xy), z-z0);
}
void main(){
  vec3 ro = uCamL;
  vec3 rd = normalize(vP - ro);
  float dt = 3.6/float(STEPS);
  float t = length(vP - ro) + dt*0.3;
  float tprev = t; bool hit=false;
  for(int i=0;i<STEPS;i++){
    vec3 p = ro + rd*t;
    if(abs(p.x)>1.002 || abs(p.y)>1.002 || abs(p.z)>1.002) break;
    if(field(p) > 0.5){ hit=true; break; }
    tprev=t; t+=dt;
  }
  if(!hit) discard;
  float lo=tprev, hi=t;
  for(int i=0;i<9;i++){
    float mid=(lo+hi)*0.5;
    if(field(ro+rd*mid) > 0.5) hi=mid; else lo=mid;
  }
  vec3 p = ro + rd*hi;
  float e = 1.3/uN;
  vec3 n = -normalize(vec3(
    field(p+vec3(e,0.0,0.0))-field(p-vec3(e,0.0,0.0)),
    field(p+vec3(0.0,e,0.0))-field(p-vec3(0.0,e,0.0)),
    field(p+vec3(0.0,0.0,e))-field(p-vec3(0.0,0.0,e))) + vec3(1e-7));
  vec3 L = normalize(vec3(0.42,0.82,0.48));
  float lam = clamp(dot(n,L),0.0,1.0);
  vec3 col = mix(vec3(0.0), cel(lam), uEntry);
  vec3 ln  = mix(vec3(1.0), uLine, uEntry);
  if(bandEdge(lam)) col = ln;
  if(1.0 - max(dot(n,-rd),0.0) > 0.60) col = ln;
  gl_FragColor = vec4(col, 1.0);
}
`;
const OBJ_VERT = `
attribute float aU;
varying vec3 vN; varying vec3 vV; varying float vU;
void main(){
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  vV = -normalize(mv.xyz);
  vU = aU;
  gl_Position = projectionMatrix * mv;
}
`;
const OBJ_FRAG = `
precision highp float;
varying vec3 vN; varying vec3 vV; varying float vU;
uniform float uPhase, uFlat, uGlow, uArc;
` + CEL + `
void main(){
  vec3 n = normalize(vN);
  float lam = clamp(dot(n, normalize(vec3(0.42,0.82,0.55))),0.0,1.0);
  vec3 shaded = mix(vec3(0.0), cel(lam), uEntry);
  vec3 ln  = mix(vec3(1.0), uLine, uEntry);
  if(bandEdge(lam)) shaded = ln;
  if(1.0 - max(dot(n, normalize(vV)),0.0) > 0.66) shaded = ln;

  /* 로딩 단계(uFlat=1): 음영 없는 흐린 트랙 — 통상적인 스피너의 바탕 링 */
  vec3 flatCol = ln * 0.20;
  vec3 col = mix(shaded, flatCol, uFlat);

  /* uPhase가 흘러 밝은 호(arc)가 표면을 돈다 — 그라데이션 없는 단색 하양 */
  float eu = fract(vU - uPhase + 1.0);
  float aa = 0.004;                                   // 양 끝만 최소 AA
  float glow = smoothstep(0.0, aa, eu) * smoothstep(uArc, uArc-aa, eu) * uGlow;
  col = mix(col, ln, glow);

  gl_FragColor = vec4(col, 1.0);
}
`;
const POST_VERT = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`;
const POST_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uP1,uP2,uP3;
uniform float uEntry;
void main(){
  float v = texture2D(uTex, vUv).r;
  vec3 c = uP3;
  if(v > 0.30) c = uP2;
  if(v > 0.62) c = uP1;
  gl_FragColor = vec4(mix(vec3(0.0), c, uEntry), 1.0);
}
`;

/* ── 렌더러 ──────────────────────────────── */
const panels = document.getElementById('panels');
const pObj = document.getElementById('pObj'),
      pCar = document.getElementById('pCar'),
      pStk = document.getElementById('pStk');
const flashEl = document.getElementById('flash');

let renderer;
try{
  renderer = new THREE.WebGLRenderer({
    canvas:document.getElementById('gl'), antialias:true, alpha:true,
    preserveDrawingBuffer:true, powerPreference:'high-performance'
  });
}catch(err){ FAIL.classList.add('on'); throw err; }
renderer.setPixelRatio(Math.min(devicePixelRatio||1, MAXDPR));
renderer.autoClear = false;

const sObj=new THREE.Scene(), sCar=new THREE.Scene(), sStk=new THREE.Scene();
const mkCam=z=>{const c=new THREE.PerspectiveCamera(26,1,0.05,60); c.position.set(0,0,z); c.lookAt(0,0,0); return c;};
const cObj=mkCam(5.4), cCar=mkCam(6.1), cStk=mkCam(6.1);

const uEntry = {value:0};
const pal = ()=>({uP1:{value:P1},uP2:{value:P2},uP3:{value:P3},uEntry:uEntry});

const LOOP_US = SMALL?240:360, LOOP_VS = SMALL?96:140;
const donut = new THREE.Mesh(torusGeometry(LOOP_US, LOOP_VS),
  new THREE.ShaderMaterial({ vertexShader:OBJ_VERT, fragmentShader:OBJ_FRAG,
    uniforms:Object.assign(pal(),{uLine:{value:P3}, uPhase:{value:0},
      uFlat:{value:0}, uGlow:{value:0}, uArc:{value:0.30}}) }));   // 밝은 바탕 → 진한 선
{
  // 루프 둘레 각도(0~1) — 입장 시퀀스에서 로딩 스피너의 '호'를 그리는 데 쓰인다
  const aU = new Float32Array((LOOP_US+1)*(LOOP_VS+1));
  let n=0;
  for(let i=0;i<=LOOP_US;i++){ const uu=i/LOOP_US; for(let j=0;j<=LOOP_VS;j++){ aU[n++]=uu; } }
  donut.geometry.setAttribute('aU', new THREE.Float32BufferAttribute(aU,1));
}
sObj.add(donut);

const atlasData = new Uint8Array(ATLAS*ATLAS*4);
const atlas = new THREE.DataTexture(atlasData, ATLAS, ATLAS, THREE.RGBAFormat);
atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;

const solid = new THREE.Mesh(new THREE.BoxGeometry(2,2,2),
  new THREE.ShaderMaterial({
    vertexShader:`varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:CARVE_FRAG, side:THREE.FrontSide,
    uniforms:Object.assign(pal(),{
      uLine:{value:P1}, uAtlas:{value:atlas}, uN:{value:N},
      uTiles:{value:TILES}, uSize:{value:ATLAS}, uCamL:{value:new THREE.Vector3()}
    })
  }));
sCar.add(solid);

const plates = new THREE.Group(); sStk.add(plates);
const rt = new THREE.WebGLRenderTarget(16,16,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),
  new THREE.ShaderMaterial({ vertexShader:POST_VERT, fragmentShader:POST_FRAG,
    uniforms:Object.assign(pal(),{uTex:{value:rt.texture}}) })));

const ST = {
  q:new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5,0.45,0,'YXZ')),
  qT:new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5,0.45,0,'YXZ')),
  touch:false, lastT:performance.now(),
  rects:null, n:0, busy:true,
  maxAniso:renderer.capabilities.getMaxAnisotropy(),
  quad:new THREE.PlaneGeometry(2*S,2*S)
};

/* ── 배치 ────────────────────────────────── */
function measure(){
  const sb = panels.getBoundingClientRect();
  if(sb.width<2||sb.height<2) return;
  const dp = renderer.getPixelRatio();
  const snap = v => Math.round(v*dp)/dp;
  const H = snap(sb.height);
  const rect = el=>{
    const b=el.getBoundingClientRect();
    const l=snap(b.left-sb.left), r=snap(b.right-sb.left);
    const t=snap(b.top-sb.top),  bo=snap(b.bottom-sb.top);
    return { x:l, y:H-bo, w:r-l, h:bo-t };
  };
  renderer.setSize(sb.width, sb.height, false);
  ST.cssW=sb.width; ST.cssH=sb.height;
  const o=rect(pObj), c=rect(pCar), s=rect(pStk);
  ST.rects={o,c,s};
  cObj.aspect=o.w/o.h; cObj.updateProjectionMatrix();
  cCar.aspect=c.w/c.h; cCar.updateProjectionMatrix();
  cStk.aspect=s.w/s.h; cStk.updateProjectionMatrix();
  const rw=Math.max(2,Math.round(s.w*dp)), rh=Math.max(2,Math.round(s.h*dp));
  if(rt.width!==rw || rt.height!==rh) rt.setSize(rw,rh);
  Object.assign(flashEl.style,{
    left:(o.x+o.w/2)+'px', top:(sb.height-o.y-o.h/2)+'px',
    width:Math.min(o.w,o.h)*0.42+'px'
  });
}
new ResizeObserver(measure).observe(panels);
addEventListener('orientationchange', ()=>setTimeout(measure,180));

/* ── 루프 ────────────────────────────────── */
const inv = new THREE.Matrix4();
const BLACK = new THREE.Color(0x000000);
const bgObj = new THREE.Color(), bgCar = new THREE.Color();
let entered=false, swallowClick=false;
let anim=null;   // {from,to,t0,dur}

function animEntry(to,dur){ anim={from:uEntry.value,to:to,t0:performance.now(),dur:dur}; }
function beginEntry(){
  if(entered) return;
  entered = true; swallowClick = true;
  setTimeout(()=>{ swallowClick = false; }, 600);   // 안전장치: 클릭이 안 와도 풀림
  document.body.classList.add('entered');
  animEntry(1, 1100);
}
function leaveToEntry(){
  entered = false;
  document.body.classList.remove('entered');
  animEntry(0, 900);
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const AX_X = new THREE.Vector3(1,0,0), AX_Y = new THREE.Vector3(0,1,0);
const AX_SPIN = new THREE.Vector3(0.34,1,0.12).normalize();
function spin(ax, ang){ _qa.setFromAxisAngle(ax, ang); ST.qT.premultiply(_qa).normalize(); }

function tick(){
  if(anim){
    const k = Math.min(1, (performance.now()-anim.t0)/anim.dur);
    const e = k<0.5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2;
    uEntry.value = anim.from + (anim.to-anim.from)*e;
    measure();
    if(performance.now()-anim.t0 > anim.dur+400) anim=null;
  }
  const _now = performance.now();
  const dt = Math.min((_now - ST.lastT)/1000, 0.05); ST.lastT = _now;
  if(!entered){
    if(introRunning){
      // 표면 위 밝은 호(uPhase)가 도는 동시에, 입체가 되고 나면 물체 자체도 함께 구른다
      donut.material.uniforms.uPhase.value = (_now/PHASE_PERIOD_MS) % 1;
      introAngle += INTRO_TUMBLE_RATE * dt * introTumbleW;
      _qa.setFromAxisAngle(AX_SPIN, introAngle);
      ST.q.copy(introBaseQ).premultiply(_qa).normalize();
      ST.qT.copy(ST.q);
    } else {
      spin(AX_SPIN, 0.26*dt);            // 입장 화면: 스스로 천천히 구른다
    }
  }
  const kf = 1 - Math.exp(-dt/0.055);          // 시간상수 55ms — 프레임률 무관
  ST.q.slerp(ST.qT, kf);
  donut.quaternion.copy(ST.q);
  solid.quaternion.copy(ST.q);
  plates.quaternion.copy(ST.q);
  solid.updateMatrixWorld();
  inv.copy(solid.matrixWorld).invert();
  solid.material.uniforms.uCamL.value.copy(cCar.position).applyMatrix4(inv);

  const R = ST.rects;
  if(R){
    renderer.setScissorTest(false);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000,1); renderer.clear();
    renderer.render(sStk, cStk);
    renderer.setRenderTarget(null);

    renderer.setViewport(0,0,ST.cssW,ST.cssH);
    renderer.setClearColor(0x000000,0); renderer.clear();
    renderer.setScissorTest(true);
    const draw=(r,scene,cam,bg)=>{
      if(r.w<=0||r.h<=0) return;
      renderer.setViewport(r.x,r.y,r.w,r.h);
      renderer.setScissor(r.x,r.y,r.w,r.h);
      renderer.setClearColor(bg,1); renderer.clear();
      renderer.render(scene,cam);
    };
    bgObj.copy(BLACK).lerp(P1, uEntry.value);
    bgCar.copy(BLACK).lerp(P3, uEntry.value);
    draw(R.o, sObj, cObj, bgObj);
    draw(R.c, sCar, cCar, bgCar);
    renderer.setViewport(R.s.x,R.s.y,R.s.w,R.s.h);
    renderer.setScissor(R.s.x,R.s.y,R.s.w,R.s.h);
    renderer.clear();
    renderer.render(postScene, postCam);
  }
  requestAnimationFrame(tick);
}

/* ── 계기 ────────────────────────────────── */
const tallyEl=document.getElementById('tally'),
      fillEl=document.getElementById('fill'),
      shutterEl=document.getElementById('shutter');

function refreshTally(){
  const frag=document.createDocumentFragment();
  for(let i=0;i<MAXC;i++){
    const s=document.createElement('span');
    s.style.height = i<ST.n ? '18px' : '5px';
    frag.appendChild(s);
  }
  tallyEl.replaceChildren(frag);
}
function setBusy(b){ ST.busy=b; shutterEl.disabled = b || ST.n>=MAXC; }

/* ── 실루엣 → 커버리지 캔버스 ────────────── */
const smoothstep=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0))); return t*t*(3-2*t);};
function coverageCanvas(sdf, mode){
  const cv=document.createElement('canvas'); cv.width=M; cv.height=M;
  const c=cv.getContext('2d'), img=c.createImageData(M,M), W=2.6;
  for(let b=0;b<M;b++){ const row=(M-1-b)*M;
    for(let a=0;a<M;a++){
      const d=sdf[b*M+a];
      const val = mode==='edge' ? 1-smoothstep(W*0.35,W,Math.abs(d))
                                : 1-smoothstep(-0.9,0.9,d);
      const o=(row+a)*4, g=(val*255)|0;
      img.data[o]=img.data[o+1]=img.data[o+2]=g; img.data[o+3]=255;
    } }
  c.putImageData(img,0,0); return cv;
}
function screenMat(map,k){
  return new THREE.MeshBasicMaterial({
    map, color:new THREE.Color(k,k,k), side:THREE.DoubleSide,
    depthWrite:false, depthTest:false,
    blending:THREE.CustomBlending, blendEquation:THREE.AddEquation,
    blendSrc:THREE.OneFactor, blendDst:THREE.OneMinusSrcColorFactor
  });
}
function makeTex(cv){
  const t=new THREE.CanvasTexture(cv);
  t.minFilter=THREE.LinearMipmapLinearFilter; t.magFilter=THREE.LinearFilter;
  t.generateMipmaps=true; t.anisotropy=ST.maxAniso; return t;
}

/* ── 촬영 ────────────────────────────────── */
function basisFromDir(d){
  const up = Math.abs(d.y)>0.96 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
  const u = new THREE.Vector3().crossVectors(up,d).normalize();
  const v = new THREE.Vector3().crossVectors(d,u).normalize();
  return {u,v};
}
let pending=null;
function capture(){
  if(!entered){ if(!introRunning) beginEntry(); return; }
  if(swallowClick){ swallowClick=false; return; }
  if(ST.busy || ST.n>=MAXC) return;
  setBusy(true);
  const d = new THREE.Vector3(0,0,1).applyQuaternion(ST.q.clone().invert()).normalize();
  const {u,v} = basisFromDir(d);
  pending = {d,u,v};
  dispatch({cmd:'capture', u:[u.x,u.y,u.z], v:[v.x,v.y,v.z], d:[d.x,d.y,d.z], th:PLATE_TH});
}

function handleResult(m){
  atlasData.set(new Uint8Array(m.atlas));
  atlas.needsUpdate=true;
  fillEl.style.width = (m.live/(N*N*N)*100)+'%';

  if(m.cmd==='field'){
    if(m.orig) ORIG = m.orig;
    setBusy(false);
    return;
  }
  const sdf = new Float32Array(m.sdf);
  const {d,u,v} = pending;
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u,v,d));
  const fillTex = makeTex(coverageCanvas(sdf,'fill'));
  const edgeTex = makeTex(coverageCanvas(sdf,'edge'));
  const TH=PLATE_TH, plate=new THREE.Group();
  [TH/2,-TH/2].forEach(z=>{ const p=new THREE.Mesh(ST.quad, screenMat(fillTex,0.26)); p.position.z=z; plate.add(p); });
  [TH/2,TH/6,-TH/6,-TH/2].forEach(z=>{ const p=new THREE.Mesh(ST.quad, screenMat(edgeTex,0.30)); p.position.z=z; plate.add(p); });
  plate.quaternion.copy(q);
  plates.add(plate);

  // 노광
  flashEl.width=M; flashEl.height=M;
  const fc=flashEl.getContext('2d');
  fc.drawImage(coverageCanvas(sdf,'fill'),0,0);
  fc.globalCompositeOperation='source-in';
  fc.fillStyle='#CB246C'; fc.fillRect(0,0,M,M);
  flashEl.classList.remove('ex'); void flashEl.offsetWidth; flashEl.classList.add('ex');

  ST.n++; refreshTally();
  if(ST.n >= MAXC){
    setBusy(true); const hv=m.live, sv=m.stack;
    // 계기와 구분선을 걷어 세 도형만 남긴 뒤(레이아웃 전이 1100ms), 녹여 흘린다
    setTimeout(()=>{ document.body.classList.add('melting'); }, 600);
    setTimeout(()=>showResult(hv, sv), 2000);
  }
  else setBusy(false);
}

/* ── 좌극한 · 원본 · 우극한 ────────────────── */
let ORIG = 0;
const resultEl=document.getElementById('result'),
      lNumEl=document.getElementById('lNum'), rNumEl=document.getElementById('rNum'),
      lArcEl=document.getElementById('lArc'), rArcEl=document.getElementById('rArc'),
      lOvfEl=document.getElementById('lOvf'), rOvfEl=document.getElementById('rOvf');
let resultTimer=null;

/* 링 게이지 — 원본과의 편차만 보인다.
   12시가 원본(편차 0). 초과는 시계방향, 부족은 반시계방향으로 뻗고
   한 바퀴 = 100%p. 100%p를 넘긴 몫은 바깥 링에 이어 그린다. */
const C_VAL = 2*Math.PI*78, C_OVF = 2*Math.PI*90;
const CW = 'rotate(-90deg)', CCW = 'scaleX(-1) rotate(-90deg)';
function setGauge(arcEl, ovfEl, ratio){
  const dev = ratio - 1;                        // 1 = 원본 대비 +100%p
  const mag = Math.abs(dev);
  const base = Math.min(mag, 1), over = Math.min(Math.max(mag-1, 0), 1);
  const dir = dev < 0 ? CCW : CW;               // 방향이 부호를 말한다 — 색에 기대지 않음
  arcEl.style.transform = dir; ovfEl.style.transform = dir;
  arcEl.style.strokeDasharray = `${base*C_VAL} ${C_VAL}`;
  arcEl.style.visibility = base > 0.001 ? '' : 'hidden';
  ovfEl.style.strokeDasharray = `${over*C_OVF} ${C_OVF}`;
  ovfEl.style.visibility = over > 0.001 ? '' : 'hidden';
}
const devText = dev => (dev<0 ? '−' : '+') + Math.abs(dev*100).toFixed(1);

/* ── 용해: 남은 세 도형이 녹아 흘러내린다 ────────────────
   화면을 한 장 떠서 세로 띠로 자르고, 띠마다 다른 시점·속도로
   아래로 흘리며 늘여 붙인다. 흘러내린 자리로 결과 화면이 드러난다. */
const fxEl = document.getElementById('fx');
const appEl = document.getElementById('app');
const MELT_MS = 2600;

function runMelt(onProgress, onDone){
  const dpr = Math.min(devicePixelRatio||1, 1.5);
  const W = innerWidth, H = innerHeight;
  fxEl.width = Math.round(W*dpr); fxEl.height = Math.round(H*dpr);
  fxEl.style.width = W+'px'; fxEl.style.height = H+'px';
  const ctx = fxEl.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.imageSmoothingEnabled = false;

  // 지금 화면(세 도형)을 그대로 한 장 떠 둔다
  const gl = renderer.domElement;
  const glBox = gl.getBoundingClientRect();
  const snap = document.createElement('canvas');
  snap.width = Math.max(1, Math.round(W*dpr));
  snap.height = Math.max(1, Math.round(H*dpr));
  const sctx = snap.getContext('2d');
  sctx.setTransform(dpr,0,0,dpr,0,0);
  let ok = true;
  try{ sctx.drawImage(gl, glBox.left, glBox.top, glBox.width, glBox.height); }
  catch(e){ ok = false; }
  if(!ok){ onProgress(1); onDone(); return; }

  // 뜬 그림이 곧 화면을 대신한다 — 살아있는 장면은 감춰 이중으로 보이지 않게
  appEl.style.visibility = 'hidden';

  const CW = 3;                                  // 띠 너비(CSS px)
  const COLS = Math.ceil(W/CW);
  const delay = new Float32Array(COLS), rate = new Float32Array(COLS);
  for(let i=0;i<COLS;i++){
    // 이웃끼리 이어지도록 매끄러운 잡음으로 시점·속도를 정한다
    const a = Math.sin(i*0.037)*0.5 + Math.sin(i*0.0113+1.7)*0.5;   // -1..1
    const b = Math.sin(i*0.021+4.2)*0.5 + Math.sin(i*0.0071+2.3)*0.5;
    delay[i] = (a*0.5+0.5) * 900;
    rate[i]  = 0.72 + (b*0.5+0.5) * 0.62;
  }

  const FALL = MELT_MS - 900;
  const t0 = performance.now();
  fxEl.classList.add('on');
  (function frame(){
    const el = performance.now() - t0;
    ctx.clearRect(0,0,W,H);
    for(let i=0;i<COLS;i++){
      const k = Math.max(0, Math.min(1, (el - delay[i])/FALL));
      const drop    = H*1.5 * k*k * rate[i];      // 중력처럼 가속하며 흘러내리고
      const stretch = 1 + 1.15 * k * rate[i];     // 엿가락처럼 늘어난다
      if(drop >= H) continue;                     // 화면 밖으로 다 흘렀다
      const x = i*CW;
      ctx.drawImage(snap, x*dpr, 0, CW*dpr, snap.height,
                          x, drop, CW, H*stretch);
    }
    onProgress(Math.min(1, el/MELT_MS));
    if(el < MELT_MS) requestAnimationFrame(frame);
    else { ctx.clearRect(0,0,W,H); fxEl.classList.remove('on'); onDone(); }
  })();
}

function showResult(hullVox, stackVox){
  if(!ORIG) return;
  const right = hullVox/ORIG;      // 깎기 — 위에서 내려옴
  const left  = stackVox/ORIG;     // 쌓기 — 아래에서 올라옴
  resultEl.classList.add('on');
  runMelt(
    f => {                                   // 용해가 진행되는 만큼 편차가 원점에서 자라난다
      lNumEl.textContent = devText((left-1)*f);
      rNumEl.textContent = devText((right-1)*f);
      setGauge(lArcEl, lOvfEl, 1 + (left-1)*f);
      setGauge(rArcEl, rOvfEl, 1 + (right-1)*f);
    },
    () => {
      lNumEl.textContent = devText(left-1);
      rNumEl.textContent = devText(right-1);
      setGauge(lArcEl, lOvfEl, left);
      setGauge(rArcEl, rOvfEl, right);
      if(resultTimer) clearTimeout(resultTimer);
      resultTimer = setTimeout(dismissResult, 5000);
      resultEl.addEventListener('click', dismissResult, {once:true});
    });
}
function dismissResult(){
  if(!resultEl.classList.contains('on')) return;
  if(resultTimer){ clearTimeout(resultTimer); resultTimer=null; }
  resultEl.classList.remove('on');
  setGauge(lArcEl, lOvfEl, 1); setGauge(rArcEl, rOvfEl, 1);   // 편차 0으로 되돌림
  lNumEl.textContent = rNumEl.textContent = '0.0';
  if(document.pointerLockElement) document.exitPointerLock();
  document.body.classList.remove('melting');   // 계기·구분선 복귀
  appEl.style.visibility = '';                 // 감춰둔 장면 복귀
  leaveToEntry();
  hardReset();
}

function hardReset(){
  ST.n = 0; refreshTally();
  while(plates.children.length){
    const p = plates.children.pop();
    p.traverse(o=>{
      if(o.material){ if(o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    plates.remove(p);
  }
  setBusy(true);
  dispatch({cmd:'reset'});
}

shutterEl.addEventListener('click', capture);
addEventListener('keydown', e=>{
  if(e.repeat) return;
  if(e.code==='Space'||e.code==='Enter'){ e.preventDefault(); capture(); }
});

/* ── 조작: 포인터 잠금 + 상대 이동 회전 ─── */
const SENS = 0.0095;                       // 픽셀당 라디안
const MAXSTEP = 90;                        // 한 이벤트당 이동 상한 (튐 방지)
let locked = false;

function look(mx, my){
  if(!entered) return;
  mx = Math.max(-MAXSTEP, Math.min(MAXSTEP, mx));
  my = Math.max(-MAXSTEP, Math.min(MAXSTEP, my));
  if(mx) spin(AX_Y,  mx * SENS);
  if(my) spin(AX_X, -my * SENS);   // 위아래 무제한, 걸리는 곳 없음
}
function onLockedMove(e){ look(e.movementX||0, e.movementY||0); }

function grabPointer(){
  if(locked || ST.touch) return;
  if(pObj.requestPointerLock){
    try{ pObj.requestPointerLock({unadjustedMovement:true}); }
    catch(err){ try{ pObj.requestPointerLock(); }catch(e2){} }
  }
}
document.addEventListener('pointerlockchange', ()=>{
  locked = (document.pointerLockElement === pObj);
  if(locked) document.addEventListener('mousemove', onLockedMove);
  else       document.removeEventListener('mousemove', onLockedMove);
});
document.addEventListener('pointerlockerror', ()=>{ locked=false; });

/* 잠금이 막힌 환경 대비: 창 전체에서 상대 이동을 받는다.
   커서가 가운데 패널을 벗어나도 회전이 끊기지 않는다. */
addEventListener('pointermove', e=>{
  if(locked) return;                       // 잠금 중엔 mousemove 경로만
  if(e.pointerType === 'touch'){ ST.touch = true; if(e.buttons) look(e.movementX||0, e.movementY||0); return; }
  look(e.movementX||0, e.movementY||0);
});
addEventListener('pointerdown', e=>{
  if(e.pointerType === 'touch') ST.touch = true;
  if(!entered && !introRunning) beginEntry();
}, {passive:true});

/* 클릭 = 촬영. 패널 어디를 눌러도 되고, 매번 잠금을 다시 시도한다 */
panels.addEventListener('click', ()=>{
  if(!entered){ if(!introRunning){ beginEntry(); grabPointer(); } return; }
  grabPointer();
  if(swallowClick){ swallowClick=false; return; }
  if(ST.touch) return;
  capture();
});

/* ── 입장 시퀀스: 재생 → (도넛 자신이) 로딩 스피너 → 위상동형 변신 → 도넛 → 입장 ── */
/* 별도의 2D 스피너는 없다 — 로딩 스피너 자체가 바로 이 3D 오브젝트다.
   가는 호(弧)로 빠르게 돌다가, 호가 닫혀 온전한 고리가 되고, 그 고리가
   두꺼워져 도넛이 된 뒤, 같은 (u,v) 격자 위에서 매개변수(경로 반지름/
   단면 굵기/각도지수)만 보간해 머그컵·수영튜브·빨대 — 모두 "구멍 하나"
   위상(genus-1)을 공유하는 형태들 — 을 거쳐 다시 도넛으로 돌아온다. */
let introRunning = true;
const playBtn = document.getElementById('playBtn');
const bootEl = document.getElementById('boot');

const signedPow = (x,n) => Math.sign(x) * Math.pow(Math.abs(x), 2/n);
function loopPoint(u, v, p, out){
  const cu = signedPow(Math.cos(u), p.n), su = signedPow(Math.sin(u), p.n);
  const rad = Math.cos(u), radz = Math.sin(u);
  // p.m: 단면의 초타원 지수 — 2면 원(도넛), 크면 사각(바움쿠헨·반지의 띠 단면)
  const cv = signedPow(Math.cos(v), p.m), sv = signedPow(Math.sin(v), p.m);
  out[0] = p.Ra*cu + p.tube*cv*rad;
  out[1] = p.tube*sv*p.sq;
  out[2] = p.Rb*su + p.tube*cv*radz;
}
function writeLoopGeometry(geo, US, VS, p){
  const arr = geo.attributes.position.array;
  const out = [0,0,0];
  let n = 0;
  for(let i=0;i<=US;i++){ const u=i/US*Math.PI*2;
    for(let j=0;j<=VS;j++){ const v=j/VS*Math.PI*2;
      loopPoint(u,v,p,out);
      arr[n++]=out[0]; arr[n++]=out[1]; arr[n++]=out[2];
    } }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
}
function lerpShape(a,b,t,out){
  out.Ra=a.Ra+(b.Ra-a.Ra)*t; out.Rb=a.Rb+(b.Rb-a.Rb)*t;
  out.tube=a.tube+(b.tube-a.tube)*t; out.n=a.n+(b.n-a.n)*t;
  out.sq=a.sq+(b.sq-a.sq)*t; out.m=a.m+(b.m-a.m)*t;
  return out;
}
/* Ra,Rb: 고리 경로 반지름 · tube: 단면 굵기 · n: 경로 초타원 지수
   sq: 단면 세로 배율 · m: 단면 초타원 지수(2=원, 크면 사각) */
const SHAPE_SPIN  = {Ra:RR,      Rb:RR,      tube:rr*0.115,n:2,   sq:1,    m:2};  // 통상적인 로딩 스피너의 가는 링
const SHAPE_DONUT = {Ra:RR,      Rb:RR,      tube:rr,      n:2,   sq:1,    m:2};
const SHAPE_MUG   = {Ra:RR*1.32, Rb:RR*0.72, tube:rr*0.86, n:4.2, sq:1,    m:2.6}; // 머그컵
const SHAPE_STRAW = {Ra:RR*1.72, Rb:RR*1.72, tube:rr*0.28, n:2,   sq:1,    m:2};   // 빨대
const SHAPE_TUBE  = {Ra:RR*1.05, Rb:RR*1.05, tube:rr*2.15, n:2,   sq:0.85, m:2};   // 수영 튜브
const SHAPE_BAUM  = {Ra:RR*1.14, Rb:RR*1.14, tube:rr*0.82, n:2,   sq:2.0,  m:7};   // 바움쿠헨
const SHAPE_RING  = {Ra:RR*1.46, Rb:RR*1.46, tube:rr*0.20, n:2,   sq:2.4,  m:7};   // 반지

const PHASE_PERIOD_MS = 1500;        // 밝은 호가 표면을 한 바퀴 도는 시간
const INTRO_TUMBLE_RATE = 0.75;      // 입체가 된 뒤 물체 자체가 구르는 속도 (rad/s)
const HOLD_MS = 2600;                // 순수 로딩 스피너 상태로 유지되는 시간
const SEG_MS  = 1900;                // 이후 각 변형 구간

/* 스피너는 화면과 나란한 원(정면)으로 보여야 한다 — 링이 XZ평면에 있으므로
   X축으로 90° 세워 화면 평면(XY)에 놓고, 도넛이 될 때 원래 자세로 눕힌다. */
const Q_FACE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI/2);
const Q_REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5,0.45,0,'YXZ'));

/* 인트로 자세: 키프레임이 정한 기준 자세(introBaseQ) 위에
   구르기(introAngle)를 얹는다. introTumbleW는 구르기의 가중치(0=정면 스피너). */
const introBaseQ = new THREE.Quaternion().copy(Q_FACE);
let introAngle = 0, introTumbleW = 0;

function easeInOutQuad(k){ return k<0.5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2; }

/* 키프레임: {s:형상, flat:납작함(1=스피너/0=입체), glow:회전광, orient:자세(0=정면,1=최종), d:구간시간} */
function runKeyframes(keys, onDone){
  const durs = keys.slice(0,-1).map((k,i)=>keys[i+1].d);
  const total = durs.reduce((a,b)=>a+b,0);
  const cum=[0]; for(const d of durs) cum.push(cum[cum.length-1]+d);
  const tmp = {Ra:0,Rb:0,tube:0,n:0,sq:0,m:0};
  const U = donut.material.uniforms;
  const apply = (shape, flat, glow, orient)=>{
    writeLoopGeometry(donut.geometry, LOOP_US, LOOP_VS, shape);
    U.uFlat.value = flat; U.uGlow.value = glow;
    // 기준 자세만 정하고, 실제 구르기는 tick()이 매 프레임 누적해 얹는다
    introBaseQ.copy(Q_FACE).slerp(Q_REST, orient);
    introTumbleW = orient;            // 정면 스피너일 땐 0 → 구르지 않는다
  };
  const t0 = performance.now();
  (function frame(){
    const el = performance.now()-t0;
    if(el >= total){
      const L = keys[keys.length-1];
      apply(L.s, L.flat, L.glow, L.orient);
      onDone(); return;
    }
    let i=0; while(i<durs.length-1 && el>cum[i+1]) i++;
    const a=keys[i], b=keys[i+1];
    const e = easeInOutQuad(Math.min(1, Math.max(0,(el-cum[i])/durs[i])));
    apply(lerpShape(a.s,b.s,e,tmp),
          a.flat   + (b.flat  -a.flat  )*e,
          a.glow   + (b.glow  -a.glow  )*e,
          a.orient + (b.orient-a.orient)*e);
    requestAnimationFrame(frame);
  })();
}

function runShapeSequence(){
  runKeyframes([
    // 흰 로딩 스피너 그대로 유지 → 두꺼워지고 부풀어 도넛이 됨(자세도 눕는다)
    {s:SHAPE_SPIN,  flat:1, glow:1, orient:0, d:0},
    {s:SHAPE_SPIN,  flat:1, glow:1, orient:0, d:HOLD_MS},
    {s:SHAPE_DONUT, flat:0, glow:1, orient:1, d:SEG_MS*1.2},
    // 이후 같은 위상(구멍 하나)의 형상들로 변모 — 밝은 호는 계속 회전
    {s:SHAPE_MUG,   flat:0, glow:1, orient:1, d:SEG_MS},
    {s:SHAPE_STRAW, flat:0, glow:1, orient:1, d:SEG_MS},
    {s:SHAPE_TUBE,  flat:0, glow:1, orient:1, d:SEG_MS},
    {s:SHAPE_BAUM,  flat:0, glow:1, orient:1, d:SEG_MS},
    {s:SHAPE_RING,  flat:0, glow:1, orient:1, d:SEG_MS},
    // 최종 도넛으로 돌아오며 회전광이 잦아든다
    {s:SHAPE_DONUT, flat:0, glow:0, orient:1, d:SEG_MS*1.2}
  ], ()=>{ introRunning = false; beginEntry(); });
}
function startIntro(){
  document.body.classList.add('started');   // 이 시점부터 커서를 감춘다
  playBtn.style.display = 'none';
  bootEl.classList.add('gone');           // 검은 배경은 그대로 이어진다 — 패널 배경도 검정이므로 이음매 없음
  runShapeSequence();
}
playBtn.addEventListener('click', startIntro);

/* ── 기동 ────────────────────────────────── */
const PTS_BACKUP = torusCloud(SMALL?520:700, SMALL?190:260);
measure();
refreshTally();
tick();

if(worker){
  // 2.5초 안에 응답이 없으면 (샌드박스 차단 등) 메인 스레드로 전환
  bootTimer = setTimeout(()=>dropWorker('timeout'), 2500);
  const c = PTS_BACKUP.slice();
  worker.postMessage({cmd:'init', pts:c.buffer, RR:RR, rr:rr}, [c.buffer]);
}else{
  runLocal({cmd:'init', pts:PTS_BACKUP.buffer.slice(0), RR:RR, rr:rr});
}
