import type {Channel,ExecutionContext,ExecutionResult} from '../shared/types';
import {runTelegraphTask,reconcileTelegraphTask} from './telegraph';
import {runBloggerTask,reconcileBloggerTask} from './blogger';
import {runGistTask} from './gist';

export interface ApiPublisher {
  publish(context:ExecutionContext):Promise<ExecutionResult>;
  reconcile?(context:ExecutionContext):Promise<{status:'found';publicUrl:string}|{status:'draft';blogger:NonNullable<ExecutionContext['task']['blogger']>}|{status:'unknown'}>;
}
const publishers:Readonly<Record<string,ApiPublisher>>={
  blogger:{publish:runBloggerTask,reconcile:reconcileBloggerTask},
  telegraph:{publish:runTelegraphTask,reconcile:reconcileTelegraphTask},
  'github-gist':{publish:runGistTask},
};
/** Only registered built-in API adapters may execute; a catalog label grants nothing. */
export function publisherFor(channel:Channel):ApiPublisher|undefined{
  return channel.provenance==='built-in'&&channel.automation==='api'?publishers[channel.id]:undefined;
}
