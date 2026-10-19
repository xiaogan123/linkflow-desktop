import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// Technical values, identifiers and comments remain untouched. Only wording
// that can become visible is checked, including labels in lookup tables.
const oldTerms=/渠道|独立审核|独立 ?AI ?(?:内容)?审核|独立核对|AI 独立审核|AI 核对|自动核对|核验|计划复核|调用预算|预算|额度|邮箱池|凭据|身份|公开结果|成果|产出|迁移网址|自动执行已暂停|计划已暂停|系统处理已暂停|已终结|已搁置|\b(?:WORKBENCH|WORK QUEUE|LINK REPORTS|IDENTITIES|CONNECTIONS|CHANNEL INTELLIGENCE|APPLICATION|MAILBOX IMPORT|MAILBOX POOL|CHANNEL LIBRARY)\b/;
const retiredContext=/客户端|系统推进|应用内|应用更新|本应用|应用运行|当前来源|新来源|来源余量|来源样本|个来源|条来源|来源分布|公开页面|已发布页面|新增页面|页面机会|页面数|个页面|\bGSC\b/;
const oldTaglines=/链接成果，一眼看清|从待办到公开成果|跨站查看，分清证据|需要时再连接账号|连接清楚，执行才可预期|按实际推进方式找渠道/;
// Backend copy can mention the operating system and third-party systems. Only
// phrases that describe this software use the additional backend rule.
const retiredBackendSoftware=/本系统|系统已|系统将|系统正在|系统推进|客户端|本应用|当前应用|本工具|应用内|应用更新|应用运行|已发布页面/;
const retiredBackendSelfReference=/等待应用重启|真实安装应用|应用正在退出|应用所在位置|更新应用|应用未配置|与应用不在|预期的应用|软件(?:不会|无法|可继续|一次创建)/;
const chineseFollowWording=/(?:[\u3400-\u9fff].*\b(?:no)?follow\b|\b(?:no)?follow\b.*[\u3400-\u9fff])/i;
// Existing saved task reasons are matched by src/main/task-reason-migration.ts
// and controller recovery branches. Changing these exact messages would change
// recovery behavior for existing data. The controller recovery messages are
// also exact replace inputs. Keep this list scoped to file and
// complete literal; other messages in those files remain under the guard.
const legacyReasonLiterals:Record<string,readonly string[]>={
  'src/main/shareyourhtml-reviewed-publication.ts':['ShareYourHTML 当前站点不符合渠道资格'],
  'src/main/controller.ts':[
    '渠道已停用','唯一一次追加独立审核未通过：',
    '独立审核发现可修订内容，AI 将自动修稿一次并重新审核。',
    '临时故障，将在次日进行最后一轮有预算的恢复。',
    '当前任务 AI 调用预算已用完，保留稿件；不会通过新建任务重复付费。',
    '当前任务 AI 调用预算已用完，已保留稿件与记录。',
    '渠道已停用，不能生成投稿材料',
  ],
  'src/main/article-review.ts':[
    'AI 核对未通过：无法取得足够且可验证的公开证据。',
    'AI 核对未通过：稿件正文为空。',
    'AI 核对未通过：稿件包含收益或无风险承诺。',
    'AI 核对未通过：',
  ],
  'src/main/main.ts':['人工已检查，仍需 AI 独立核对后才会发布'],
  'src/main/task-recovery.ts':['当前任务不足两次 AI 调用额度，无法同时完成备用选题的新稿与 AI 复核；已在付费前停止。'],
};
// Google names the imported OAuth credential a "client". These exact errors
// describe that third-party file, not the Linkflow desktop software.
const thirdPartyTerminologyLiterals:Record<string,readonly string[]>={
  'src/integrations/blogger.ts':[
    'Google OAuth 客户端文件过大',
    'Google OAuth 客户端 JSON 无法解析',
    '请选择 Google Cloud 生成的 Desktop app OAuth 客户端 JSON；不接受 Web application 客户端',
    'Desktop OAuth 客户端 ID 无效',
    'Desktop OAuth 客户端 secret 无效',
  ],
  'src/main/main.ts':['选择Google OAuth桌面客户端配置','客户端配置文件无效或过大'],
  'src/main/blogger-management.ts':['本机保险箱中没有可复用的 Google OAuth 桌面客户端配置；请重新导入桌面客户端 JSON。'],
};
type Finding={line:number;text:string};
type CopyScope='ui'|'backend';
function inTechnicalDetails(node:ts.Node):boolean{
  for(let ancestor:ts.Node|undefined=node.parent;ancestor;ancestor=ancestor.parent){
    if(!ts.isJsxElement(ancestor))continue;
    const opening=ancestor.openingElement;
    if(opening.tagName.getText()!=='details')continue;
    if(opening.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&(attribute.name.getText()==='data-technical-details'||attribute.name.getText()==='className'&&attribute.initializer?.getText().includes('technical-details'))))return true;
  }
  return false;
}
function isAiJsonInstruction(node:ts.Node):boolean{
  for(let ancestor:ts.Node|undefined=node.parent;ancestor;ancestor=ancestor.parent){
    if(!ts.isCallExpression(ancestor))continue;
    const call=ancestor.expression;
    // This codebase's AI JSON API takes instruction, input and schema. A
    // one-argument json(...) call is not an AI prompt.
    if(!ts.isPropertyAccessExpression(call)||call.name.text!=='json'||ancestor.arguments.length<3)continue;
    const instruction=ancestor.arguments[0];
    if(instruction&&node.getStart()>=instruction.getStart()&&node.getEnd()<=instruction.getEnd())return true;
  }
  return false;
}
function isComparisonLiteral(node:ts.Node):boolean{
  let operand=node;
  while(ts.isParenthesizedExpression(operand.parent))operand=operand.parent;
  const parent=operand.parent;
  return ts.isBinaryExpression(parent)
    &&[ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)
    &&(parent.left===operand||parent.right===operand);
}
function isBackendNonCopy(node:ts.Node,file:string):boolean{
  // Prompt instructions go to the model, not the product UI. The registration
  // prompt is stored in a named property instead of a *_INSTRUCTION constant.
  if(isAiJsonInstruction(node)||isComparisonLiteral(node))return true;
  const relative=path.relative(process.cwd(),path.resolve(file)).replaceAll(path.sep,'/');
  for(let ancestor:ts.Node|undefined=node.parent;ancestor;ancestor=ancestor.parent){
    if(ts.isVariableDeclaration(ancestor)&&ts.isIdentifier(ancestor.name)&&/(?:^|_)INSTRUCTIONS?$/.test(ancestor.name.text))return true;
    if(ts.isPropertyAssignment(ancestor)&&ancestor.name.getText().replace(/['"]/g,'')==='signupAiInstruction')return true;
    if(ts.isFunctionDeclaration(ancestor)&&ancestor.name?.text==='buildProfileDraftInstruction')return true;
    // Browser observation is injected JavaScript. Its Chinese words are field
    // matching criteria and changing them changes runtime behavior.
    if(relative==='src/integrations/browser.ts'&&ts.isVariableDeclaration(ancestor)&&ts.isIdentifier(ancestor.name)&&ancestor.name.text==='OBSERVE_JS')return true;
    // The per-platform format table and builder feed article-writing prompts.
    if(relative==='src/main/draft-contract.ts'&&ts.isVariableDeclaration(ancestor)&&ts.isIdentifier(ancestor.name)&&ancestor.name.text==='FORMATS')return true;
    if(relative==='src/main/draft-contract.ts'&&ts.isFunctionDeclaration(ancestor)&&ancestor.name?.text==='profileDraftInstruction')return true;
    // This sentence is generated as public-article disclosure, not software UI.
    if(ts.isVariableDeclaration(ancestor)&&ts.isIdentifier(ancestor.name)&&ancestor.name.text==='ZH_DISCLOSURE'&&ts.isStringLiteralLike(node)&&node.text==='以推广发布者身份介绍{brand}，并非第三方推荐。')return true;
  }
  return false;
}
function isApprovedBackendLiteral(file:string,text:string):boolean{
  const relative=path.relative(process.cwd(),path.resolve(file)).replaceAll(path.sep,'/');
  return (legacyReasonLiterals[relative]?.includes(text)??false)||(thirdPartyTerminologyLiterals[relative]?.includes(text)??false);
}
function collectCopyFindings(source:string,file='fixture.tsx',scope:CopyScope='ui'):Finding[]{
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS),findings:Finding[]=[];
  function visit(node:ts.Node){
    const literal=ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)||ts.isJsxText(node);
    if(literal&&!inTechnicalDetails(node)&&(scope==='ui'||!isBackendNonCopy(node,file))){
      const text=node.getText(ast);
      // TypeScript decodes \uXXXX escapes in node.text. Use that value for
      // backend matching so escaped Chinese cannot bypass the guard.
      const matchText=scope==='backend'&&!ts.isJsxText(node)?node.text:text;
      const nonOsText=text.replace(/跟随系统|操作系统|系统设置|当前系统或架构/g,'');
      const systemTerm=/系统/.test(nonOsText);
      const englishEyebrow=ts.isJsxText(node)&&ts.isJsxElement(node.parent)&&node.parent.openingElement.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText()==='className'&&attribute.initializer?.getText().includes('eyebrow'))&&/[A-Za-z]/.test(text);
      const parent=node.parent;
      const internalAttribute=ts.isJsxAttribute(parent)&&!['title','placeholder','aria-label','alt','label','hint','body','note','message'].includes(parent.name.getText());
      const propertyName=(ts.isPropertyAssignment(parent)||ts.isPropertySignature(parent))&&parent.name===node;
      const importPath=ts.isImportDeclaration(parent)||ts.isExportDeclaration(parent);
      const hasUiCopy=/[\u3400-\u9fff]/.test(matchText)||ts.isJsxText(node)||/\b(?:WORKBENCH|WORK QUEUE|LINK REPORTS|IDENTITIES|CONNECTIONS|CHANNEL INTELLIGENCE)\b/.test(matchText);
      const retired=scope==='ui'
        ? oldTerms.test(text)||oldTaglines.test(text)||retiredContext.test(text)||systemTerm||englishEyebrow
        : oldTerms.test(matchText)||retiredBackendSoftware.test(matchText)||retiredBackendSelfReference.test(matchText)||chineseFollowWording.test(matchText);
      const approved=scope==='backend'&&isApprovedBackendLiteral(file,matchText);
      if(hasUiCopy&&!internalAttribute&&!propertyName&&!importPath&&!approved&&retired)findings.push({line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,text:text.trim().slice(0,180)});
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);return findings;
}
function uiSourceFiles(directory:string):string[]{
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const file=path.join(directory,entry.name);return entry.isDirectory()?uiSourceFiles(file):/\.tsx?$/.test(file)?[file]:[]});
}

function backendSourceFiles():string[]{
  const directories=['src/main','src/integrations','src/shared'];
  // Platform catalog data: its descriptions and taxonomy are source material, not status wording.
  const catalogData=new Set(['src/integrations/catalog.ts']);
  return directories.flatMap(directory=>uiSourceFiles(path.resolve(directory))).filter(file=>!catalogData.has(path.relative(process.cwd(),file).replaceAll(path.sep,'/')));
}

test('UI wording excludes retired terminology and English eyebrows',()=>{
  const files=uiSourceFiles(path.resolve('src/ui'));
  const findings=files.flatMap(file=>collectCopyFindings(fs.readFileSync(file,'utf8'),file).map(finding=>`${path.relative(process.cwd(),file)}:${finding.line} ${finding.text}`));
  assert.deepEqual(findings,[],findings.join('\n'));
});
test('copy guard reads JSX, attributes, maps and template fragments',()=>{
  const fixture='const labels={ready:"渠道"}; const node=<p title="核验">公开结果{`预算 ${count}`}</p>;';
  assert.equal(collectCopyFindings(fixture).length,4);
  assert.equal(collectCopyFindings('<p>系统推进</p><p>新增页面</p><span className="eyebrow">ACCOUNT SETUP</span>').length,3);
});
test('copy guard allows identifiers, comments, protocol values and explicit technical details',()=>{
  const fixture='// 渠道\nconst channel="follow"; const 身份="account"; const node=<><p className="渠道">平台 · 跟随系统 · 操作系统</p><details data-technical-details><summary>技术详情</summary><p>渠道核验</p></details></>;';
  assert.deepEqual(collectCopyFindings(fixture),[]);
});
test('backend wording excludes retired terminology',()=>{
  const findings=backendSourceFiles().flatMap(file=>collectCopyFindings(fs.readFileSync(file,'utf8'),file,'backend').map(finding=>`${path.relative(process.cwd(),file)}:${finding.line} ${finding.text}`));
  assert.deepEqual(findings,[],findings.join('\n'));
});
test('backend guard reads template fragments and concatenated messages',()=>{
  const fixture='const first=`系统已${count}项`; const second="客户端"+count+"项目"; const third="本应用"+"准备完成";';
  assert.equal(collectCopyFindings(fixture,'fixture.ts','backend').length,3);
  assert.equal(collectCopyFindings(String.raw`const status='\u5ba2\u6237\u7aef';`,'fixture.ts','backend').length,1);
  assert.equal(collectCopyFindings("const status='本工具已处理已发布页面'; const rel='nofollow'; const explanation='结果为 nofollow 链接';",'fixture.ts','backend').length,2);
  assert.deepEqual(collectCopyFindings("const value='跟随操作系统设置';",'fixture.ts','backend'),[]);
  assert.equal(collectCopyFindings("const message='等待应用重启'; const failure='更新应用路径无效';",'fixture.ts','backend').length,2);
});
test('backend guard excludes model prompts but still checks messages in the same file',()=>{
  const fixture=`const FACT_REVIEW_INSTRUCTION='渠道';
    const REGISTRATION={signupAiInstruction:'身份'};
    const answer=ai.json<{ok:boolean}>(\`本系统\${mode}\`,{notice:'凭据'},schema);
    const other=config.json('渠道');
    function buildProfileDraftInstruction(){return '预算';}
    const ZH_DISCLOSURE=['以推广发布者身份介绍{brand}，并非第三方推荐。'];
    const warning='客户端';`;
  assert.deepEqual(collectCopyFindings(fixture,'fixture.ts','backend').map(finding=>finding.text),["'凭据'","'渠道'","'客户端'"]);
});
test('backend guard treats comparison tokens as data but checks adjacent messages',()=>{
  const fixture="const matches=kind===('渠道'); const message='渠道不可用'; const notified=notify('渠道已关闭')===true;";
  assert.deepEqual(collectCopyFindings(fixture,'fixture.ts','backend').map(finding=>finding.text),["'渠道不可用'","'渠道已关闭'"]);
});
test('article format prompts are excluded only in their source file',()=>{
  const fixture="const FORMATS={sample:'发布身份'}; function profileDraftInstruction(){return '渠道格式';} const message='身份不可用';";
  assert.deepEqual(collectCopyFindings(fixture,'src/main/draft-contract.ts','backend').map(finding=>finding.text),["'身份不可用'"]);
  assert.equal(collectCopyFindings(fixture,'src/main/other.ts','backend').length,3);
});
test('legacy reason exception requires the exact file and literal',()=>{
  const original="const message='渠道已停用'; const changed='渠道已停用，请重试';";
  assert.deepEqual(collectCopyFindings(original,'src/main/controller.ts','backend').map(finding=>finding.text),["'渠道已停用，请重试'"]);
  assert.equal(collectCopyFindings("const message='渠道已停用';",'src/main/other.ts','backend').length,1);
});
test('third-party OAuth terminology and injected browser criteria are narrowly excluded',()=>{
  assert.equal(collectCopyFindings("const message='Google OAuth 客户端文件过大';",'src/integrations/blogger.ts','backend').length,0);
  assert.equal(collectCopyFindings("const message='Google OAuth 客户端文件过大';",'src/integrations/other.ts','backend').length,1);
  assert.equal(collectCopyFindings('const OBSERVE_JS=`const match=/身份/;`; const message="身份错误";','src/integrations/browser.ts','backend').length,1);
});
