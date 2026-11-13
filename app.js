const video = document.querySelector("#camera");
const canvas = document.querySelector("#overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.querySelector("#startCamera");
const autoBtn = document.querySelector("#autoDetect");
const stopBtn = document.querySelector("#stopTracking");
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
let segmenter = null;
let segmenterPromise = null;
let trackingEnabled = false;
let inferenceBusy = false;
let trackingTimer = null;
let trackingGeneration = 0;
let autoQuad = null;
let floorMaskCanvas = null;
let lastDetection = 0;

function setStatus(message){ statusEl.textContent = message; }
function resizeCanvas(){
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width*dpr);
  canvas.height = Math.round(rect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if (trackingEnabled && floorMaskCanvas) render();
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
function drawTextureInQuad(quad,w,h,maskCanvas=null){
  const strengthValue=Number(strength.value)/100;
  const s=Number(scale.value)/100;
  const tile=document.createElement("canvas");tile.width=Math.max(900,Math.round(900*s));tile.height=tile.width;
  const tctx=tile.getContext("2d");
  for(let y=0;y<tile.height;y+=texture.height*s)for(let x=0;x<tile.width;x+=texture.width*s)tctx.drawImage(texture,x,y,texture.width*s,texture.height*s);
  ctx.save();ctx.globalAlpha=strengthValue;
  affineTriangle(tile,[{x:0,y:0},{x:tile.width,y:0},{x:tile.width,y:tile.height}],[quad[0],quad[1],quad[2]]);
  affineTriangle(tile,[{x:0,y:0},{x:tile.width,y:tile.height},{x:0,y:tile.height}],[quad[0],quad[2],quad[3]]);
  ctx.restore();
  if(maskCanvas){
    ctx.save();ctx.globalCompositeOperation="destination-in";ctx.drawImage(maskCanvas,0,0,w,h);ctx.restore();
  }
  const g=Number(gloss.value)/100;
  if(g>0){
    ctx.save();
    if(maskCanvas)ctx.drawImage(maskCanvas,0,0,w,h);
    else {ctx.beginPath();quad.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();}
    const sheen=ctx.createLinearGradient(0,0,w,h);
    sheen.addColorStop(0,`rgba(255,255,255,${g*.18})`);sheen.addColorStop(.45,"rgba(255,255,255,0)");
    sheen.addColorStop(1,`rgba(255,255,255,${g*.28})`);ctx.fillStyle=sheen;ctx.fillRect(0,0,w,h);ctx.restore();
  }
}
function render(){
  const rect=canvas.getBoundingClientRect();const w=rect.width,h=rect.height;
  ctx.clearRect(0,0,w,h);
  if(trackingEnabled && autoQuad && floorMaskCanvas){
    drawTextureInQuad(autoQuad,w,h,floorMaskCanvas);
  } else if(corners.length===4){
    drawTextureInQuad(corners,w,h);
  }
  if(selecting){
    ctx.save();ctx.strokeStyle="#8fb0ff";ctx.fillStyle="#8fb0ff";ctx.lineWidth=2;ctx.setLineDash([7,5]);
    if(corners.length){ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();}
    corners.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fill();ctx.fillStyle="#101a2d";ctx.font="12px sans-serif";ctx.fillText(String(i+1),p.x-3,p.y+4);ctx.fillStyle="#8fb0ff";});
    ctx.restore();
  }
  counter.textContent=trackingEnabled ? (lastDetection ? `Auto tracking · ${Math.max(0,Math.round((Date.now()-lastDetection)/1000))}s ago` : "Finding floor…") : `${corners.length} / 4 corners`;
}
function makeMaskAndQuad(mask){
  const mw=mask.width,mh=mask.height,data=mask.data;
  if(!mw||!mh||!data)throw new Error("The segmentation model returned an empty mask.");
  const channels=data.length/(mw*mh);
  const binary=new Uint8ClampedArray(mw*mh*4);
  let minX=mw,minY=mh,maxX=0,maxY=0,count=0;
  const rowLeft=new Int32Array(mh).fill(mw),rowRight=new Int32Array(mh).fill(-1),rowCount=new Int32Array(mh);
  for(let y=0;y<mh;y++)for(let x=0;x<mw;x++){
    const idx=(y*mw+x)*channels;
    const value=channels>=3 ? Math.max(data[idx],data[idx+1],data[idx+2]) : data[idx];
    const on=value>80;
    if(on){
      const p=(y*mw+x)*4;binary[p]=255;binary[p+1]=255;binary[p+2]=255;binary[p+3]=255;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++;
      rowLeft[y]=Math.min(rowLeft[y],x);rowRight[y]=Math.max(rowRight[y],x);rowCount[y]++;
    }
  }
  const ratio=count/(mw*mh);
  if(ratio<.035||maxY-minY<mh*.12) return null;
  // Use robust row percentiles to avoid isolated mask speckles at the boundary.
  const rows=[];
  for(let y=minY;y<=maxY;y++)if(rowCount[y]>mw*.025)rows.push(y);
  if(rows.length<4)return null;
  const top=rows[Math.floor(rows.length*.08)],bottom=rows[Math.floor(rows.length*.92)];
  const leftAt=y=>rowLeft[y],rightAt=y=>rowRight[y];
  const src=document.createElement("canvas");src.width=mw;src.height=mh;
  src.getContext("2d").putImageData(new ImageData(binary,mw,mh),0,0);
  // Match object-fit: cover, which is used by both the video and overlay canvases.
  const rect=canvas.getBoundingClientRect(),cw=rect.width,ch=rect.height;
  const scaleCover=Math.max(cw/mw,ch/mh),drawW=mw*scaleCover,drawH=mh*scaleCover;
  const offsetX=(cw-drawW)/2,offsetY=(ch-drawH)/2;
  const map=(x,y)=>({x:x*scaleCover+offsetX,y:y*scaleCover+offsetY});
  const q=[map(leftAt(top),top),map(rightAt(top),top),map(rightAt(bottom),bottom),map(leftAt(bottom),bottom)];
  const maskCanvas=document.createElement("canvas");maskCanvas.width=Math.round(cw);maskCanvas.height=Math.round(ch);
  const mctx=maskCanvas.getContext("2d");mctx.imageSmoothingEnabled=false;
  mctx.drawImage(src,0,0,mw,mh,offsetX,offsetY,drawW,drawH);
  return {quad:q,maskCanvas};
}
async function loadFloorModel(){
  if(segmenter)return segmenter;
  try{
    if(!segmenterPromise){
      setStatus("Loading the floor-detection AI model. The first load may take a minute and downloads the model to your browser.");
      segmenterPromise=(async()=>{
        const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2");
        env.allowLocalModels=false;
        env.useBrowserCache=true;
        if(navigator.gpu){
          try{
            return await pipeline("image-segmentation","Xenova/segformer-b0-finetuned-ade-512-512",{device:"webgpu"});
          }catch(webgpuError){
            console.warn("WebGPU unavailable; using CPU/WASM inference.",webgpuError);
          }
        }
        return pipeline("image-segmentation","Xenova/segformer-b0-finetuned-ade-512-512");
      })();
    }
    segmenter=await segmenterPromise;
    return segmenter;
  }catch(err){
    segmenterPromise=null;
    throw err;
  }
}
async function detectFloor(generation){
  if(!trackingEnabled||generation!==trackingGeneration||inferenceBusy||!segmenter||video.readyState<2)return;
  inferenceBusy=true;
  try{
    const frame=document.createElement("canvas");
    const frameScale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
    frame.width=Math.max(1,Math.round(video.videoWidth*frameScale));
    frame.height=Math.max(1,Math.round(video.videoHeight*frameScale));
    frame.getContext("2d",{willReadFrequently:true}).drawImage(video,0,0,frame.width,frame.height);
    const results=await segmenter(frame);
    if(!trackingEnabled||generation!==trackingGeneration)return;
    const floor=results.find(item=>/\bfloor\b|flooring/i.test(item.label||""));
    if(!floor){setStatus("The model did not identify a floor in this view. Aim at a larger, well-lit floor area and try again.");return;}
    const result=makeMaskAndQuad(floor.mask);
    if(!result){setStatus("Floor detected weakly. Move back a little, include more of the floor, and keep the camera steady for a moment.");return;}
    autoQuad=result.quad;floorMaskCanvas=result.maskCanvas;lastDetection=Date.now();
    setStatus(`Tracking floor automatically (${Math.round((floor.score||0)*100)}% model confidence). Move slowly; detection refreshes about once per second.`);
    render();
  }catch(err){
    console.error(err);
    if(trackingEnabled&&generation===trackingGeneration){
      setStatus(`Floor detection error: ${err.message}`);
      stopTracking();
    }
  }finally{inferenceBusy=false;}
}
async function startTracking(){
  if(!stream){setStatus("Start the camera first.");return;}
  if(trackingEnabled)return;
  trackingEnabled=true;selecting=false;corners=[];autoQuad=null;floorMaskCanvas=null;lastDetection=0;
  const generation=++trackingGeneration;
  autoBtn.disabled=true;stopBtn.disabled=false;setBtn.disabled=true;clearBtn.disabled=false;
  try{
    await loadFloorModel();
    if(!trackingEnabled||generation!==trackingGeneration)return;
    setStatus("AI model ready. Looking for the floor… keep the floor clearly visible.");
    await detectFloor(generation);
    if(trackingEnabled&&generation===trackingGeneration){
      if(trackingTimer)clearInterval(trackingTimer);
      trackingTimer=setInterval(()=>detectFloor(generation),1100);
    }
  }catch(err){
    console.error(err);setStatus(`Could not load floor detection: ${err.message}. You can still use the manual four-corner mode.`);stopTracking();
  }
}
function stopTracking(){
  trackingEnabled=false;
  trackingGeneration++;
  if(trackingTimer){clearInterval(trackingTimer);trackingTimer=null;}
  autoBtn.disabled=false;stopBtn.disabled=true;setBtn.disabled=!stream;render();
}
async function startCamera(){
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}},audio:false});
    video.srcObject=stream;await video.play();emptyEl.style.display="none";
    startBtn.textContent="Camera running";startBtn.disabled=true;setBtn.disabled=false;clearBtn.disabled=false;autoBtn.disabled=false;
    resizeCanvas();setStatus("Camera ready. Use Auto-detect floor for AI segmentation, or select the floor manually.");
  }catch(err){setStatus(`Could not start camera: ${err.message}. Use HTTPS and allow camera access.`);}
}
startBtn.addEventListener("click",startCamera);
autoBtn.addEventListener("click",startTracking);
stopBtn.addEventListener("click",()=>{stopTracking();setStatus("Automatic tracking stopped.");});
setBtn.addEventListener("click",()=>{stopTracking();selecting=true;corners=[];setStatus("Tap the four corners of the visible floor, clockwise. This manual overlay does not track camera movement.");render();});
clearBtn.addEventListener("click",()=>{stopTracking();corners=[];autoQuad=null;floorMaskCanvas=null;selecting=false;render();setStatus("Floor area cleared. Choose automatic detection or set the four corners manually.");});
canvas.addEventListener("click",e=>{
  if(!selecting||corners.length>=4)return;
  const r=canvas.getBoundingClientRect();corners.push({x:e.clientX-r.left,y:e.clientY-r.top});
  if(corners.length===4){selecting=false;setStatus("Manual floor area set. It stays fixed to the camera view; use Auto-detect for refreshed floor segmentation as you move.");}
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
