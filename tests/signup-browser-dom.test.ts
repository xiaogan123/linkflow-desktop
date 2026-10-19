import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import type {BrowserWindow} from 'electron';
import {signupBrowserPort,taskActionScript,taskObservationScript} from '../src/integrations/browser';

function page(){
  class Element {
    tagName='DIV';type='';id='';innerText='';textContent='';labels:Array<{innerText:string}>=[];
    form?:Form;href='';disabled=false;clicks=0;badge=false;hidden=false;parent?:Element;
    attributes:Record<string,string>={};
    constructor(tag:string,id:string,type=''){this.tagName=tag;this.id=id;this.type=type;}
    get formAction(){return this.attributes.formaction??'https://example.com/signup';}
    getBoundingClientRect(){return {width:this.hidden?0:20,height:this.hidden?0:20};}
    append(child:Element){child.parent=this;}
    contains(child:Element){for(let parent:Element|undefined=child;parent;parent=parent.parent)if(parent===this)return true;return false;}
    getAttribute(name:string){return this.attributes[name]??(name==='type'?this.type:null);}
    hasAttribute(name:string){return name in this.attributes;}
    closest(selector:string){return selector==='.grecaptcha-badge'&&this.badge||selector==='[data-sitekey],.h-captcha,.g-recaptcha'&&this.hasAttribute('data-sitekey')?this:null;}
    click(){this.clicks++;}
    dispatchEvent(){return true;}
  }
  class Input extends Element {private stored='';get value(){return this.stored;}set value(value:string){this.stored=value;}}
  class Area extends Element {private stored='';get value(){return this.stored;}set value(value:string){this.stored=value;}}
  class Button extends Element {}
  class Anchor extends Element {}
  class Form extends Element {
    get action(){return new URL(this.attributes.action??'','https://example.com/signup').href;}
    set action(value:string){this.attributes.action=value;}
    querySelector(){return null;}
  }
  const elements:Element[]=[];
  const add=<T extends Element>(element:T):T=>{elements.push(element);return element;};
  const context={
    document:{body:{innerText:''},querySelectorAll:(selector:string)=>{
      if(selector.startsWith('a,button,input,textarea,select'))return elements;
      if(selector.startsWith('[name="'))return elements.filter(element=>element.attributes.name===selector.slice(7,-2));
      if(selector.startsWith('iframe[src*='))return elements.filter(element=>element.tagName==='IFRAME'||element.hasAttribute('data-sitekey')||/h-captcha|g-recaptcha|cf-turnstile/.test(element.getAttribute('class')??''));
      if(selector.startsWith('#'))return elements.filter(element=>element.id===selector.slice(1));
      return [];
    }},
    location:{href:'https://example.com/signup'},getComputedStyle:()=>({display:'block',visibility:'visible'}),
    HTMLInputElement:Input,HTMLTextAreaElement:Area,HTMLButtonElement:Button,HTMLAnchorElement:Anchor,HTMLFormElement:Form,
    URL,Event:class Event {constructor(_type:string,_options?:unknown){}},
  };
  const window={isDestroyed:()=>false,webContents:{getURL:()=>context.location.href,executeJavaScriptInIsolatedWorld:async(_id:number,scripts:Array<{code:string}>)=>vm.runInNewContext(scripts[0].code,context)},show(){},close(){}} as unknown as BrowserWindow;
  return {add,Input,Area,Button,Anchor,Element,Form,context,port:signupBrowserPort(window,['example.com'])};
}

test('native signup fill rejects a password in text controls and mismatched email fields',async()=>{
  const p=page();
  const username=p.add(new p.Input('INPUT','username','text'));username.attributes.name='username';
  const password=p.add(new p.Input('INPUT','password','password'));password.attributes.name='password';
  const email=p.add(new p.Input('INPUT','email','email'));email.attributes.name='email';
  assert.equal(await p.port.act('fill','#username','private-password',undefined,'identity.password'),false);
  assert.equal(username.value,'');
  assert.equal(await p.port.act('fill','#password','owner@example.com',undefined,'identity.email'),false);
  assert.equal(password.value,'');
  assert.equal(await p.port.act('fill','#username','owner@example.com',undefined,'identity.email'),false);
  assert.equal(await p.port.act('fill','#email','owner@example.com',undefined,'identity.email'),true);
  assert.equal(email.value,'owner@example.com');
  assert.equal(await p.port.act('fill','#password','private-password',undefined,'identity.password'),true);
  assert.equal(password.value,'private-password');
});

test('native preflight checks the exact submit control without clicking',async()=>{
  const p=page(),button=p.add(new p.Button('BUTTON','submit','submit'));
  button.innerText='Register';button.form=new p.Form('FORM','signup');
  button.disabled=true;assert.equal(await p.port.probeIrreversible('#submit'),'disabled');
  button.disabled=false;button.attributes.formaction='https://outside.example/register';assert.equal(await p.port.probeIrreversible('#submit'),'unsafe');
  button.attributes.formaction='https://example.com/register';assert.equal(await p.port.probeIrreversible('#submit'),'ready');
  delete button.attributes.formaction;button.form.action='https://outside.example/register';
  assert.equal(button.formAction,'https://example.com/signup');
  assert.equal(await p.port.probeIrreversible('#submit'),'unsafe');
  assert.equal(await p.port.act('irreversible','#submit'),false);
  button.form.action='https://example.com:8443/register';assert.equal(await p.port.probeIrreversible('#submit'),'unsafe');
  button.form.action='https://example.com/signup';
  assert.equal(button.clicks,0);
  const duplicate=p.add(new p.Button('BUTTON','submit','submit'));duplicate.form=new p.Form('FORM','signup');
  assert.equal(await p.port.probeIrreversible('#submit'),'missing');assert.equal(button.clicks,0);
  duplicate.id='different';assert.equal(await p.port.act('irreversible','#submit'),true);assert.equal(button.clicks,1);
});

test('named action fields cannot hide an external form action in deterministic or AI paths',async()=>{
  const p=page(),form=new p.Form('FORM','signup'),named=p.add(new p.Input('INPUT','action','hidden'));
  form.attributes.action='https://outside.example/register';named.attributes.name='action';
  Object.defineProperty(form,'action',{value:named,configurable:true});
  const button=p.add(new p.Button('BUTTON','submit','submit'));button.innerText='Register';button.form=form;
  const email=p.add(new p.Input('INPUT','email','email'));email.form=form;
  assert.equal(form.action as unknown,named);
  assert.equal(await p.port.probeIrreversible('#submit'),'unsafe');
  assert.equal(await p.port.act('irreversible','#submit'),false);
  assert.equal(await p.port.act('fill','#email','owner@example.com',undefined,'identity.email'),false);
  assert.equal(button.clicks,0);assert.equal(email.value,'');
  const observed=vm.runInNewContext(taskObservationScript([]),p.context);
  const control=observed.controls.find((item:{label:string})=>item.label==='Register');
  assert.equal(control.formAction,'https://outside.example/register');
  assert.equal(vm.runInNewContext(taskActionScript(control,{kind:'click',id:control.id,ref:'none',option:0,purpose:'register',reason:''},['example.com']),p.context),false);
  assert.equal(button.clicks,0);
  // The dispatch guard also re-reads the native action after observation.
  form.attributes.action='https://example.com/register';
  const allowed=vm.runInNewContext(taskObservationScript([]),p.context).controls.find((item:{label:string})=>item.label==='Register');
  form.attributes.action='https://outside.example/register';
  assert.equal(vm.runInNewContext(taskActionScript(allowed,{kind:'click',id:allowed.id,ref:'none',option:0,purpose:'register',reason:''},['example.com']),p.context),false);
  assert.equal(button.clicks,0);
});

test('URL guards reject an object without string-coercing it into an allowed relative URL',async()=>{
  const p=page(),link=p.add(new p.Anchor('A','link'));let coerced=0;
  link.href={toString(){coerced++;return '/register';}} as unknown as string;
  assert.equal(await p.port.act('click','#link'),false);assert.equal(link.clicks,0);assert.equal(coerced,0);
});

test('native repeatable clicks reject same-page anchors and script URLs',async()=>{
  const p=page(),link=p.add(new p.Anchor('A','link'));
  link.href='https://example.com/signup#register';assert.equal(await p.port.act('click','#link'),false);
  link.href='javascript:fetch("/register")';assert.equal(await p.port.act('click','#link'),false);
  link.href='https://example.com/next';assert.equal(await p.port.act('click','#link'),true);
  assert.equal(link.clicks,1);
});

test('native CAPTCHA inspection distinguishes an unsolved widget, a token, and a badge',async()=>{
  const p=page(),widget=p.add(new p.Element('DIV','challenge'));widget.attributes.class='g-recaptcha';widget.attributes['data-sitekey']='public-test-key';
  assert.equal((await p.port.inspect()).captcha,true);
  const token=p.add(new p.Input('INPUT','token','hidden'));token.attributes.name='g-recaptcha-response';
  widget.append(token);
  token.value='solved-token';assert.equal((await p.port.inspect()).captcha,false);
  const second=p.add(new p.Element('DIV','second-challenge'));second.attributes.class='g-recaptcha';second.attributes['data-sitekey']='public-test-key-2';
  assert.equal((await p.port.inspect()).captcha,true);
  second.badge=true;assert.equal((await p.port.inspect()).captcha,false);
  token.value='';widget.badge=true;assert.equal((await p.port.inspect()).captcha,false);
});

test('a token from an old provider or hidden challenge cannot clear a new CAPTCHA',async()=>{
  const p=page(),old=p.add(new p.Element('DIV','old'));old.attributes.class='h-captcha';old.attributes['data-sitekey']='public-old';
  const oldToken=p.add(new p.Input('INPUT','old-token','hidden'));oldToken.attributes.name='h-captcha-response';oldToken.value='old-token';old.append(oldToken);
  assert.equal((await p.port.inspect()).captcha,false);
  const newWidget=p.add(new p.Element('DIV','new'));newWidget.attributes.class='g-recaptcha';newWidget.attributes['data-sitekey']='public-new';
  assert.equal((await p.port.inspect()).captcha,true);
  const newToken=p.add(new p.Input('INPUT','new-token','hidden'));newToken.attributes.name='g-recaptcha-response';newToken.value='fresh-token';newWidget.append(newToken);
  assert.equal((await p.port.inspect()).captcha,false);
  old.hidden=true;newToken.value='';
  assert.equal((await p.port.inspect()).captcha,true);
});

test('a hidden old widget token cannot solve a replacement from the same provider',async()=>{
  const p=page(),old=p.add(new p.Element('DIV','old'));old.attributes.class='g-recaptcha';old.attributes['data-sitekey']='public-old';
  const oldToken=p.add(new p.Input('INPUT','old-token','hidden'));oldToken.attributes.name='g-recaptcha-response';oldToken.value='stale-token';old.append(oldToken);
  assert.equal((await p.port.inspect()).captcha,false);
  old.hidden=true;
  const replacement=p.add(new p.Element('DIV','replacement'));replacement.attributes.class='g-recaptcha';replacement.attributes['data-sitekey']='public-new';
  assert.equal((await p.port.inspect()).captcha,true);
});

test('invisible CAPTCHA on a submit control remains a human stop, never a selector failure',async()=>{
  const p=page(),button=p.add(new p.Button('BUTTON','register','submit'));
  button.form=new p.Form('FORM','signup');button.attributes['data-sitekey']='public-test-key';
  assert.equal((await p.port.inspect()).captcha,true);
  assert.equal(await p.port.probeIrreversible('#register'),'captcha');
  assert.equal(await p.port.act('irreversible','#register'),false);
  assert.equal(button.clicks,0);
});
