/** Self-contained browser function: serialize into a JavaScript-disabled native
 * verifier through CDP. Reject unsupported paint effects rather than infer visibility. */
export function requireReadableText(root:Element):number {
 const normalize=(s:string)=>s.normalize('NFC').replace(/\s+/gu,' ').trim();
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('No color evidence');
 const color=(s:string)=>{if(!CSS.supports('color',s))throw Error('Unsupported color');ctx.clearRect(0,0,1,1);ctx.fillStyle=s;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
 const luminance=(c:number[])=>c.slice(0,3).map(n=>{n/=255;return n<=0.04045?n/12.92:Math.pow((n+0.055)/1.055,2.4)}).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i],0);
 const styleVisible=(el:Element)=>{
  let opacity=1;
  for(let p:Element|null=el;p;p=p.parentElement){const s=getComputedStyle(p);opacity*=Number(s.opacity);
   if(s.outlineStyle!=='none'&&Number.parseFloat(s.outlineWidth)>0&&color(s.outlineColor)[3]>0)return false;
   if(s.display==='none'||s.visibility!=='visible'||s.contentVisibility==='hidden'||!Number.isFinite(opacity)||opacity<0.99||s.filter!=='none'||s.backdropFilter!=='none'||s.mixBlendMode!=='normal'||s.clipPath!=='none'||s.clip!=='auto'||s.maskImage!=='none'||s.backgroundImage!=='none'||p.hasAttribute('hidden')||p.getAttribute('aria-hidden')==='true')return false;
  }return true;
 };
 const textPaint=(el:Element)=>{
  const s=getComputedStyle(el);if(Number.parseFloat(s.fontSize)<1)return false;
  const foreground=color(s.webkitTextFillColor==='currentcolor'?s.color:s.webkitTextFillColor);if(foreground[3]===0)return false;
  let bg=[255,255,255,255];const ancestors:Element[]=[];for(let p:Element|null=el;p;p=p.parentElement)ancestors.unshift(p);
  for(const p of ancestors){const c=color(getComputedStyle(p).backgroundColor),a=c[3]/255;bg=bg.map((n,i)=>i<3?c[i]*a+n*(1-a):255)}
  const alpha=foreground[3]/255,composited=foreground.map((n,i)=>i<3?n*alpha+bg[i]*(1-alpha):255);
  const a=luminance(composited),b=luminance(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=1.2;
 };
 // Account for CSS paint outside hit-test rectangles. Only computed pixel
 // shadows are supported; unknown effects fail closed instead of being ignored.
 const effects=(s:CSSStyleDeclaration)=>s.boxShadow!=='none'||s.textShadow!=='none'||s.outlineStyle!=='none'&&Number.parseFloat(s.outlineWidth)>0&&color(s.outlineColor)[3]>0;
 const shadowMargin=(s:CSSStyleDeclaration)=>{
  const m=[0,0,0,0];
  for(const [raw,box] of [[s.boxShadow,true],[s.textShadow,false]] as const){
   if(raw==='none')continue;
   const colors=raw.match(/(?:rgba?|color)\([^()]*\)/g)??[];let ci=0;
   const layers=raw.replace(/(?:rgba?|color)\([^()]*\)/g,'C').split(',');
   if(layers.length>16||colors.length!==layers.length)throw Error('Unsupported shadow syntax');
   for(const layer of layers){const c=color(colors[ci++]);if(c[3]===0)continue;
    const inset=/\binset\b/.test(layer),tokens=layer.replace(/\bC\b|\binset\b/g,'').trim().split(/\s+/);
    if(tokens.length<2||tokens.length>(box?4:3)||tokens.some(v=>! /^-?\d+(?:\.\d+)?px$/.test(v))||inset&&!box)throw Error('Unsupported shadow dimensions');
    const [x,y,blur=0,spread=0]=tokens.map(parseFloat);if(blur<0||[x,y,blur,spread].some(v=>!Number.isFinite(v)||Math.abs(v)>100000))throw Error('Shadow dimension bound exceeded');
    if(inset)continue;
    // Six Gaussian standard deviations, plus a pixel for raster rounding.
    const radius=Math.max(0,3*blur+spread)+1;
    m[0]=Math.max(m[0],radius-x);m[1]=Math.max(m[1],radius+x);m[2]=Math.max(m[2],radius-y);m[3]=Math.max(m[3],radius+y);
   }
  }
  if(s.outlineStyle!=='none'&&Number.parseFloat(s.outlineWidth)>0&&color(s.outlineColor)[3]>0){const n=Math.max(0,parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset))+1;if(!Number.isFinite(n))throw Error('Unsupported outline');for(let i=0;i<4;i++)m[i]=Math.max(m[i],n)}
  return m;
 };
 const hasPaint=(s:CSSStyleDeclaration)=>effects(s)||color(s.backgroundColor)[3]>0||s.backgroundImage!=='none'||['Top','Right','Bottom','Left'].some(side=>Number.parseFloat(s.getPropertyValue('border-'+side.toLowerCase()+'-width'))>0&&color(s.getPropertyValue('border-'+side.toLowerCase()+'-color'))[3]>0);
 // Hit testing ignores pointer-events:none. Reject intersecting painted elements
 // and unverifiable generated paint; no page script is executed to alter them.
 // Permit at most one non-text body decoration whose color stops can reduce
 // contrast by no more than 2%. No images, blending, shadows or filters qualify.
 const faintBodyGradient=(el:Element,s:CSSStyleDeclaration,text:boolean)=>{
  if(el!==document.body||text||s.opacity!=='1'||color(s.backgroundColor)[3]!==0||s.filter!=='none'||s.backdropFilter!=='none'||s.mixBlendMode!=='normal'||s.boxShadow!=='none'||s.textShadow!=='none'||s.maskImage!=='none'||s.transform!=='none'||s.outlineStyle!=='none'&&Number.parseFloat(s.outlineWidth)>0)return false;
  if(['top','right','bottom','left'].some(side=>Number.parseFloat(s.getPropertyValue('border-'+side+'-width'))>0&&color(s.getPropertyValue('border-'+side+'-color'))[3]>0))return false;
  const colors=s.backgroundImage.match(/rgba?\([^()]+\)/g)??[];
  if(colors.length<2||colors.length>8||colors.some(value=>color(value)[3]>5))return false;
  const skeleton=s.backgroundImage.replace(/rgba?\([^()]+\)/g,'C');
  return /^repeating-linear-gradient\(-?\d+(?:\.\d+)?deg, C(?: -?\d+(?:\.\d+)?px)?(?:, C(?: -?\d+(?:\.\d+)?px)?){1,7}\)$/.test(skeleton);
 };
 // Chromium can retain rectangles for unpainted closed-details content. Only
 // exclude it when the actual pseudo-element visibility proves it is hidden;
 // author styles can override the closed state and make that content visible.
 const hiddenByClosedDetails=(el:Element)=>{
  for(let p=el.parentElement;p;p=p.parentElement){
   if(p instanceof HTMLDetailsElement&&!p.open){
    const summary=[...p.children].find(child=>child instanceof HTMLElement&&child.tagName==='SUMMARY');
    if(!summary?.contains(el)&&CSS.supports('selector(details::details-content)')){
     const content=getComputedStyle(p,'::details-content');
     if(content.contentVisibility==='hidden'&&content.display!=='contents'&&!el.checkVisibility({contentVisibilityAuto:true}))return true;
    }
   }
  }return false;
 };
 let faintDecorations=0;
 const possibleBlockers:Element[]=[];const paintMargins=new Map<Element,number[]>();
 for(const el of document.querySelectorAll('body,body *')){
  if(hiddenByClosedDetails(el))continue;
  const base=getComputedStyle(el);if(base.display==='none'||base.visibility!=='visible'||Number(base.opacity)===0)continue;
  if(effects(base)){for(let p:Element|null=el;p;p=p.parentElement){const s=getComputedStyle(p);if(!['1','normal'].includes(s.zoom)||s.transform!=='none'||s.scale!=='none'||s.rotate!=='none'||s.translate!=='none'||s.filter!=='none')throw Error('Transformed shadow paint cannot be bounded')}paintMargins.set(el,shadowMargin(base))}
  for(const pseudo of ['::before','::after']){
   const s=getComputedStyle(el,pseudo),content=s.content;
   if(content==='none'||content==='normal'||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)continue;
   const text=content!==''&&content!=='""'&&content!=="''";
   if(effects(s))throw Error('Unsupported generated shadow or outline paint');
   if(hasPaint(s)||text){if(!faintBodyGradient(el,s,text)||++faintDecorations>1)throw Error('Generated paint cannot be verified')}
  }
  // Descendants may paint over their parent's text; only the current text's
  // own ancestors are exempted below. Replaced/SVG elements paint without CSS
  // background or text, and static elements can overlap through transforms.
  const directText=[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&normalize(n.textContent??''));
  if(hasPaint(base)||directText||el.matches('img,svg,canvas,video,iframe,object,embed,input,textarea,select'))possibleBlockers.push(el);
 }
 // A direct-body fixed positive-z foreground is painted above plain normal-flow
 // content. Exempt only that provable stack order; keep transformed, positioned
 // z layers, generated paint and pointer-events:none overlays fail-closed.
 const plainStack=(e:Element)=>{for(let p:Element|null=e;p;p=p.parentElement){const s=getComputedStyle(p);if(p.matches(':modal,:popover-open,:fullscreen')||s.zIndex!=='auto'||s.transform!=='none'||s.filter!=='none'||s.backdropFilter!=='none'||s.perspective!=='none'||s.isolation!=='auto'||s.mixBlendMode!=='normal'||Number(s.opacity)!==1||s.contain!=='none'||s.willChange!=='auto'||['fixed','sticky'].includes(s.position))return false}return true};
 const rootStyle=getComputedStyle(root),fixedForeground=root.parentElement===document.body&&rootStyle.position==='fixed'&&/^\d+$/.test(rootStyle.zIndex)&&Number(rootStyle.zIndex)>0&&plainStack(document.body);
 const nodes:Text[]=[];const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 for(let n=walker.nextNode();n;n=walker.nextNode())if(normalize(n.textContent??'')&&!n.parentElement?.closest('svg'))nodes.push(n as Text);
 if(!nodes.length)throw Error('Required text is empty');
 const savedX=scrollX,savedY=scrollY;let checked=0;
 try{for(const node of nodes){const el=node.parentElement;if(!el||!styleVisible(el)||!textPaint(el))throw Error('Required text is not visibly painted');
   const range=document.createRange();range.selectNodeContents(node);const count=range.getClientRects().length;if(!count)throw Error('Required text has no rectangles');
   for(let i=0;i<count;i++){
    if(++checked>6000)throw Error('Text visibility bound exceeded');let r=range.getClientRects()[i];
    scrollTo({left:scrollX+(r.left<0?r.left:0),top:scrollY+r.top+r.height/2-innerHeight/2,behavior:'instant'});r=range.getClientRects()[i];
    const x=r.left+r.width/2,y=r.top+r.height/2;if(r.width<=0||r.height<=0||x<0||x>=innerWidth||y<0||y>=innerHeight||document.elementFromPoint(x,y)!==el)throw Error('Required text is occluded');
    for(const blocker of possibleBlockers){
     if(blocker===el||blocker.contains(el)||fixedForeground&&plainStack(blocker))continue;
     const [left,right,top,bottom]=paintMargins.get(blocker)??[0,0,0,0];
     for(const b of blocker.getClientRects())if(b.width+left+right>0&&b.height+top+bottom>0&&b.left-left<r.right&&b.right+right>r.left&&b.top-top<r.bottom&&b.bottom+bottom>r.top)throw Error('Additional paint overlaps required text');
    }
   }
  }return checked;
 }finally{scrollTo({left:savedX,top:savedY,behavior:'instant'})}
}
