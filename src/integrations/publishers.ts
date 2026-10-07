import type {Channel,ExecutionContext,ExecutionResult} from '../shared/types';
import {runTelegraphTask,reconcileTelegraphTask} from './telegraph';
import {runBloggerTask,reconcileBloggerTask} from './blogger';
import {runBlueskyTask,reconcileBlueskyTask} from './bluesky';
import {runParagraphTask,reconcileParagraphTask} from './paragraph';
import {runNostrTask,reconcileNostrTask} from './nostr';
import {runGistTask} from './gist';

export interface ApiPublisher {
  publish(context:ExecutionContext):Promise<ExecutionResult>;
  reconcile?(context:ExecutionContext):Promise<{status:'found';publicUrl:string}|{status:'draft';blogger:NonNullable<ExecutionContext['task']['blogger']>}|{status:'draft';paragraph:NonNullable<ExecutionContext['task']['paragraph']>}|{status:'unknown'}>;
}
const publishers:Readonly<Record<string,ApiPublisher>>={
  paragraph:{publish:runParagraphTask,reconcile:reconcileParagraphTask},
  nostr:{publish:runNostrTask,reconcile:reconcileNostrTask},
  bluesky:{publish:runBlueskyTask,reconcile:reconcileBlueskyTask},
  blogger:{publish:runBloggerTask,reconcile:reconcileBloggerTask},
  telegraph:{publish:runTelegraphTask,reconcile:reconcileTelegraphTask},
  'github-gist':{publish:runGistTask},
};
/** Only registered built-in API adapters may execute; a catalog label grants nothing. */
export function publisherFor(channel:Channel):ApiPublisher|undefined{
  return channel.provenance==='built-in'&&channel.automation==='api'?publishers[channel.id]:undefined;
}
