import {runBatch5AccountedTask,reconcileBatch5AccountedTask,verifyBatch5AccountedPublication,prepareBatch5Account} from './batch5-accounted';
import type {ExecutionContext,ExecutionResult,LinkResult} from '../shared/types';
import {runBatch5DirectTask,reconcileBatch5DirectTask,verifyBatch5DirectPublication} from './batch5-direct';
import {runWhiteWindTask,reconcileWhiteWindTask,verifyWhiteWindPublication} from './whitewind';
import {runHackMdTask,reconcileHackMdTask,verifyHackMdPublication} from './hackmd';

const directVerify=(context:ExecutionContext):Promise<LinkResult>=>verifyBatch5DirectPublication(context.task,context.site,context.task.topicUrl??context.site.url,context.batch5Persistence!,context.batch5Dependencies,context.signal);
const accounted={prepare:prepareBatch5Account,publish:runBatch5AccountedTask,reconcile:reconcileBatch5AccountedTask,verify:(context:ExecutionContext)=>verifyBatch5AccountedPublication(context,context.task.topicUrl??context.site.url)};
export const BATCH5_PUBLISHERS={
  slopit:accounted,
  rant:accounted,
  yeetmd:{publish:runBatch5DirectTask,reconcile:reconcileBatch5DirectTask,verify:directVerify},
  markdownpage:{publish:runBatch5DirectTask,reconcile:reconcileBatch5DirectTask,verify:directVerify},
  whitewind:{publish:runWhiteWindTask,reconcile:reconcileWhiteWindTask,verify:verifyWhiteWindPublication},
  hackmd:{publish:runHackMdTask,reconcile:reconcileHackMdTask,verify:verifyHackMdPublication},
};
export function batch5Publisher(id:string){return Object.hasOwn(BATCH5_PUBLISHERS,id)?BATCH5_PUBLISHERS[id as keyof typeof BATCH5_PUBLISHERS]:undefined;}
export function batch5FailureResult(result:ExecutionResult):ExecutionResult {
  const {failureKind:kind,...value}=result as ExecutionResult&{failureKind?:string};
  if(kind==='rate_limited')return {...value,reasonCode:'platform_rate_limited',trialFailure:result.message};
  if(kind==='provider_rejected'||kind==='verification_failed')return {...value,reasonCode:'platform_rejected',trialFailure:result.message};
  if(kind==='format_invalid')return {...value,reasonCode:'format_invalid'};
  if(kind==='account_handoff')return {...value,reasonCode:'account_handoff'};
  if(kind==='unknown')return {...value,reasonCode:'submission_unknown'};
  return value;
}
