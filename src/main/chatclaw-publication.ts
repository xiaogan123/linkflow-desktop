import {chatClawTesting,type ChatClawIdentity,type ChatClawIntent,type ChatClawOpaqueResponse,type ChatClawPersistence,type ChatClawReceipt,type ChatClawReceiptSource,type ChatClawStage} from '../integrations/chatclaw';
import type {SecretStore,Task} from '../shared/types';

export interface ChatClawRegistrationJournal {version:1;siteId:string;intent:ChatClawIntent;opaque?:ChatClawOpaqueResponse}
export interface ChatClawPublicationJournal {
  version:1;taskId:string;siteId:string;
  intents:Partial<Record<ChatClawStage,ChatClawIntent>>;
  opaque:Partial<Record<ChatClawStage,ChatClawOpaqueResponse>>;
  receipt?:ChatClawReceipt;
  receiptSource?:ChatClawReceiptSource;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function same(a:ChatClawIntent,b:ChatClawIntent){return chatClawTesting.sameIntent(a,b)}

export function parseChatClawIdentitySecret(value:string|undefined):ChatClawIdentity|undefined{
  try{const parsed=JSON.parse(value??'null') as ChatClawIdentity;return object(parsed)&&chatClawTesting.validIdentity(parsed)?parsed:undefined}catch{return}
}
export function parseChatClawRegistrationJournal(value:string|undefined,siteId:string):ChatClawRegistrationJournal|undefined{
  try{const parsed=JSON.parse(value??'null') as ChatClawRegistrationJournal;if(!object(parsed)||parsed.version!==1||parsed.siteId!==siteId||!UUID.test(siteId)||!chatClawTesting.validIntent(parsed.intent)||parsed.intent.stage!=='register'||parsed.opaque&&(!same(parsed.intent,parsed.opaque)||parsed.opaque.stage!=='register'))return;return parsed}catch{return}
}
export function parseChatClawPublicationJournal(value:string|undefined,taskId:string,siteId:string):ChatClawPublicationJournal|undefined{
  try{
    const parsed=JSON.parse(value??'null') as ChatClawPublicationJournal;
    if(!object(parsed)||parsed.version!==1||parsed.taskId!==taskId||parsed.siteId!==siteId||!UUID.test(taskId)||!UUID.test(siteId)||!object(parsed.intents)||!object(parsed.opaque))return;
    for(const stage of ['register','post'] as const){const intent=parsed.intents[stage];if(intent&&(!chatClawTesting.validIntent(intent)||intent.stage!==stage))return;const opaque=parsed.opaque[stage];if(opaque&&(!intent||!same(intent,opaque)))return}
    if(parsed.receipt){if(!parsed.intents.post||!same(parsed.receipt,parsed.intents.post)||parsed.receipt.postId!==parsed.receipt.postId.toLowerCase()||!['post_response','feed_recovery'].includes(parsed.receiptSource??''))return;if(parsed.receiptSource==='post_response'&&!parsed.opaque.post)return}
    else if(parsed.receiptSource)return;
    return parsed;
  }catch{return}
}

export async function createChatClawPublicationPersistence(input:{task:Task;siteId:string;secrets:SecretStore;checkpoint:(partial:Partial<Task>)=>void}):Promise<ChatClawPersistence>{
  const identityKey=`chatclaw:identity:${input.siteId}`,registrationKey=`chatclaw:registration:${input.siteId}`,publicationKey=`chatclaw:publication:${input.task.id}`;
  const identityRaw=await input.secrets.get(identityKey),registrationRaw=await input.secrets.get(registrationKey),publicationRaw=await input.secrets.get(publicationKey);
  let identity=parseChatClawIdentitySecret(identityRaw),registration=registrationRaw?parseChatClawRegistrationJournal(registrationRaw,input.siteId):undefined;
  const savedJournal=publicationRaw?parseChatClawPublicationJournal(publicationRaw,input.task.id,input.siteId):undefined;
  if(identityRaw&&!identity||registrationRaw&&!registration||publicationRaw&&!savedJournal)throw Error('ChatClaw 加密状态无效');
  let journal:ChatClawPublicationJournal=savedJournal??{version:1,taskId:input.task.id,siteId:input.siteId,intents:{},opaque:{}};
  let durable=Promise.resolve(),submittedAt=input.task.submittedAt;
  const saveRegistration=()=>input.secrets.set(registrationKey,JSON.stringify(registration));
  const savePublication=()=>input.secrets.set(publicationKey,JSON.stringify(journal));
  const visible=(intent:ChatClawIntent,stage:NonNullable<Task['chatclaw']>['stage'],extra:Partial<NonNullable<Task['chatclaw']>>={})=>{
    submittedAt??=intent.createdAt;
    input.checkpoint({chatclaw:{stage,intent:structuredClone(intent),...extra},submittedAt,checkpoint:`chatclaw_${stage}`,...(extra.publicUrl?{publicUrl:extra.publicUrl}:{})});
  };
  return {secretStorage:'encrypted',
    loadIdentity(){return identity&&structuredClone(identity)},
    loadIntent(stage){const value=stage==='register'?registration?.intent:journal.intents.post;return value&&structuredClone(value)},
    loadOpaqueResponse(stage){const value=stage==='register'?registration?.opaque:journal.opaque.post;return value&&structuredClone(value)},
    claimIntent(intent){if(intent.stage==='register'){if(registration)return false;registration={version:1,siteId:input.siteId,intent:structuredClone(intent)};visible(intent,'register_submitting');durable=saveRegistration();return true}if(journal.intents.post)return false;journal={...journal,intents:{...journal.intents,post:structuredClone(intent)}};visible(intent,'post_submitting');durable=savePublication();return true},
    async assertReadyToSubmit(intent){await durable;const saved=intent.stage==='register'?registration?.intent:journal.intents.post;if(!saved||!same(saved,intent))throw Error('ChatClaw 加密提交意图不一致');return true as const},
    async persistOpaqueResponse(response){if(response.stage==='register'){if(!registration||!same(registration.intent,response))throw Error('ChatClaw 注册响应与站点提交意图不一致');if(registration.opaque&&registration.opaque.responseSha256!==response.responseSha256)throw Error('ChatClaw 注册响应已经存在');registration={...registration,opaque:structuredClone(response)};await saveRegistration();visible(response,'register_opaque');return}const intent=journal.intents.post;if(!intent||!same(intent,response))throw Error('ChatClaw 原始响应与提交意图不一致');const existing=journal.opaque.post;if(existing&&existing.responseSha256!==response.responseSha256)throw Error('ChatClaw 原始响应已经存在');journal={...journal,opaque:{...journal.opaque,post:structuredClone(response)}};await savePublication();visible(response,'post_opaque')},
    async promoteIdentity(value){if(!registration||!chatClawTesting.validIdentity(value)||value.name!==registration.intent.name||value.handle!==registration.intent.handle)throw Error('ChatClaw 账号与站点注册意图不一致');await input.secrets.set(identityKey,JSON.stringify(value));identity=structuredClone(value)},
    async promoteReceipt(receipt,source){const intent=journal.intents.post;if(!intent||!same(intent,receipt)||!['post_response','feed_recovery'].includes(source)||source==='post_response'&&!journal.opaque.post)throw Error('ChatClaw 帖子返回与提交意图不一致');journal={...journal,receipt:structuredClone(receipt),receiptSource:source};await savePublication();visible(intent,'api_receipt',{postId:receipt.postId,publicUrl:receipt.publicUrl})},
  };
}
