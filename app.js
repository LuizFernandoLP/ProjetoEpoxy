const video = document.querySelector("#camera");
const canvas = document.querySelector("#overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.querySelector("#startCamera");
const setBtn = document.querySelector("#setFloor");
const clearBtn = document.querySelector("#clearFloor");
const statusEl = document.querySelector("#status");
const emptyEl = document.querySelector("#empty");
const counter = document.querySelector("#counter");
const presetSelect = document.querySelector("#preset");
const fileInput = document.querySelector("#textureFile");
const strength = document.querySelector("#strength");
const gloss = document.querySelector("#gloss");
const scale = document.querySelector("#scale");

let stream = null;
let selecting = false;
let corners = [];
let texture = makeTexture("silver");
let textureName = "silver";

function setStatus(message){ statusEl.textContent = message; }
function resizeCanvas(){
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width*dpr);
  canvas.height = Math.round(rect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function makeTexture(kind){
  const c=document.createElement("canvas"); c.width=900; c.height=900;
  const g=c.getContext("2d");
  const palettes={
    silver:["#202831","#aab5c0","#e6edf2","#4b5967"],
    black:["#05070b","#202a37","#798493","#111722"],
    ocean:["#061d36","#087b9e","#5bc4d0","#102c57"],
    flake:["#343a42","#727d87","#c4cbd0","#181d24"],
    white:["#f7f8f8","#c5d0d8","#ffffff","#8b9aa7"]
  };
  const p=palettes[kind]||palettes.silver;
  const grad=g.createLinearGradient(0,0,900,900);
  p.forEach((color,i)=>grad.addColorStop(i/(p.length-1),color));
  g.fillStyle=grad;g.fillRect(0,0,900,900);
  // Organic metallic veins and soft cloudy variation.
  for(let i=0;i<85;i++){
    const x=Math.random()*900,y=Math.random()*900;
    g.beginPath();g.moveTo(x,y);
    g.bezierCurveTo(x-120+Math.random()*240,y+Math.random()*180,
      x+Math.random()*260-130,y+Math.random()*280-140,
      x+Math.random()*300-150,y+Math.random()*360-180);
    g.strokeStyle=p[Math.floor(Math.random()*p.length)];
    g.globalAlpha=.08+Math.random()*.2;g.lineWidth=2+Math.random()*18;g.stroke();
  }
  if(kind==="flake"){
    for(let i=0;i<5000;i++){
      g.fillStyle=p[Math.floor(Math.random()*p.length)];
      g.globalAlpha=.35+Math.random()*.55;
      const x=Math.random()*900,y=Math.random()*900;
      g.fillRect(x,y,1+Math.random()*5,1+Math.random()*3);
    }
  }
  g.globalAlpha=1;
  return c;
}
function setTexture(kind){
  texture=makeTexture(kind);textureName=kind;
  document.querySelectorAll(".swatch").forEach(b=>b.classList.toggle("selected",b.dataset.preset===kind));
  render();
}
function pointInTriangle(p,a,b,c){
  const v0=[c.x-a.x,c.y-a.y],v1=[b.x-a.x,b.y-a.y],v2=[p.x-a.x,p.y-a.y];
  const dot=(u,v)=>u[0]*v[0]+u[1]*v[1];
  const d00=dot(v0,v0),d01=dot(v0,v1),d02=dot(v0,v2),d11=dot(v1,v1),d12=dot(v1,v2);
  const inv=1/(d00*d11-d01*d01);const u=(d11*d02-d01*d12)*inv,v=(d00*d12-d01*d02)*inv;
  return u>=0&&v>=0&&u+v<=1;
}
// Affine-map a source triangle to a destination triangle.
function affineTriangle(image, src, dst){
  const [s0,s1,s2]=src,[d0,d1,d2]=dst;
  const den=s0.x*(s1.y-s2.y)+s1.x*(s2.y-s0.y)+s2.x*(s0.y-s1.y);
  if(Math.abs(den)<.001)return;
  const a=(d0.x*(s1.y-s2.y)+d1.x*(s2.y-s0.y)+d2.x*(s0.y-s1.y))/den;
  const c=(d0.x*(s2.x-s1.x)+d1.x*(s0.x-s2.x)+d2.x*(s1.x-s0.x))/den;
  const e=(d0.x*(s1.x*s2.y-s2.x*s1.y)+d1.x*(s2.x*s0.y-s0.x*s2.y)+d2.x*(s0.x*s1.y-s1.x*s0.y))/den;
  const b=(d0.y*(s1.y-s2.y)+d1.y*(s2.y-s0.y)+d2.y*(s0.y-s1.y))/den;
  const d=(d0.y*(s2.x-s1.x)+d1.y*(s0.x-s2.x)+d2.y*(s1.x-s0.x))/den;
  const f=(d0.y*(s1.x*s2.y-s2.x*s1.y)+d1.y*(s2.x*s0.y-s0.x*s2.y)+d2.y*(s0.x*s1.y-s1.x*s0.y))/den;
  ctx.save();ctx.beginPath();ctx.moveTo(d0.x,d0.y);ctx.lineTo(d1.x,d1.y);ctx.lineTo(d2.x,d2.y);ctx.closePath();ctx.clip();
  ctx.transform(a,b,c,d,e,f);ctx.drawImage(image,0,0);ctx.restore();
}
function render(){
  const rect=canvas.getBoundingClientRect();const w=rect.width,h=rect.height;
  ctx.clearRect(0,0,w,h);
  if(corners.length===4){
    const strengthValue=Number(strength.value)/100;
    const s=Number(scale.value)/100;
    const src=[{x:0,y:0},{x:texture.width*s,y:0},{x:texture.width*s,y:texture.height*s},{x:0,y:texture.height*s}];
    // Repeat the sample across a larger source plane to avoid stretching a single tile.
    const tile=document.createElement("canvas");tile.width=Math.max(900,Math.round(900*s));tile.height=tile.width;
    const tctx=tile.getContext("2d");
    for(let y=0;y<tile.height;y+=texture.height*s)for(let x=0;x<tile.width;x+=texture.width*s)tctx.drawImage(texture,x,y,texture.width*s,texture.height*s);
    const quad=corners;
    ctx.save();ctx.globalAlpha=strengthValue;
    affineTriangle(tile,[{x:0,y:0},{x:tile.width,y:0},{x:tile.width,y:tile.height}],[quad[0],quad[1],quad[2]]);
    affineTriangle(tile,[{x:0,y:0},{x:tile.width,y:tile.height},{x:0,y:tile.height}],[quad[0],quad[2],quad[3]]);
    ctx.restore();
    const g=Number(gloss.value)/100;
    if(g>0){
      ctx.save();ctx.beginPath();quad.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();
      const sheen=ctx.createLinearGradient(0,0,w,h);
      sheen.addColorStop(0,`rgba(255,255,255,${g*.18})`);sheen.addColorStop(.45,"rgba(255,255,255,0)");
      sheen.addColorStop(1,`rgba(255,255,255,${g*.28})`);ctx.fillStyle=sheen;ctx.fillRect(0,0,w,h);ctx.restore();
    }
  }
  if(selecting){
    ctx.save();ctx.strokeStyle="#8fb0ff";ctx.fillStyle="#8fb0ff";ctx.lineWidth=2;ctx.setLineDash([7,5]);
    if(corners.length){ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();}
    corners.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fill();ctx.fillStyle="#101a2d";ctx.font="12px sans-serif";ctx.fillText(String(i+1),p.x-3,p.y+4);ctx.fillStyle="#8fb0ff";});
    ctx.restore();
  }
  counter.textContent=`${corners.length} / 4 corners`;
}
async function startCamera(){
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}},audio:false});
    video.srcObject=stream;await video.play();emptyEl.style.display="none";
    startBtn.textContent="Camera running";startBtn.disabled=true;setBtn.disabled=false;clearBtn.disabled=false;
    resizeCanvas();setStatus("Camera ready. Tap Set floor area, then tap four floor corners clockwise.");
  }catch(err){setStatus(`Could not start camera: ${err.message}. Use HTTPS and allow camera access.`);}
}
startBtn.addEventListener("click",startCamera);
setBtn.addEventListener("click",()=>{selecting=true;corners=[];setStatus("Tap the four corners of the visible floor, clockwise. Tap Clear area to start over.");render();});
clearBtn.addEventListener("click",()=>{corners=[];selecting=false;render();setStatus("Floor area cleared. Tap Set floor area to outline it again.");});
canvas.addEventListener("click",e=>{
  if(!selecting||corners.length>=4)return;
  const r=canvas.getBoundingClientRect();corners.push({x:e.clientX-r.left,y:e.clientY-r.top});
  if(corners.length===4){selecting=false;setStatus("Floor area set. Choose a finish and adjust its appearance. Reset if the camera moves.");}
  render();
});
presetSelect.addEventListener("change",()=>setTexture(presetSelect.value));
document.querySelectorAll(".swatch").forEach(b=>b.addEventListener("click",()=>{presetSelect.value=b.dataset.preset;setTexture(b.dataset.preset);}));
fileInput.addEventListener("change",e=>{
  const file=e.target.files?.[0];if(!file)return;
  const url=URL.createObjectURL(file),img=new Image();
  img.onload=()=>{texture=img;textureName="custom";render();setStatus(`Loaded ${file.name}.`);URL.revokeObjectURL(url);};
  img.onerror=()=>setStatus("That image could not be loaded.");img.src=url;
});
[strength,gloss,scale].forEach(el=>el.addEventListener("input",()=>{
  document.querySelector("#strengthValue").value=`${strength.value}%`;
  document.querySelector("#glossValue").value=`${gloss.value}%`;
  document.querySelector("#scaleValue").value=`${(Number(scale.value)/100).toFixed(1)}×`;
  render();
}));
window.addEventListener("resize",()=>{resizeCanvas();render();});
if(!navigator.mediaDevices?.getUserMedia){setStatus("This browser does not support camera access. Open this page in a modern browser over HTTPS.");}
resizeCanvas();
