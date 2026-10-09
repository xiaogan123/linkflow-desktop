import type {Channel,ExecutionContext,ExecutionResult} from '../shared/types';
import {runTelegraphTask,reconcileTelegraphTask} from './telegraph';
import {runBloggerTask,reconcileBloggerTask} from './blogger';
import {runBlueskyTask,reconcileBlueskyTask} from './bluesky';
import {runParagraphTask,reconcileParagraphTask} from './paragraph';
import {runNostrTask,reconcileNostrTask} from './nostr';
import {preparePaperIdentity,runPaperTask,reconcilePaperTask} from './paper';
import {runHiveTask,reconcileHiveTask} from './hive';
import {prepareMataroaIdentity,runMataroaTask,reconcileMataroaTask} from './mataroa';
import {prepareVerboseIdentity,runVerboseTask,reconcileVerboseTask} from './verbose';
import {runProseTask,reconcileProseTask} from './prose';
import {prepareRentryIdentity,runRentryTask,reconcileRentryTask} from './rentry';
import {runLucidTask,reconcileLucidTask} from './lucid';
import {runBetterThanHtmlTask,reconcileBetterThanHtmlTask} from './betterthanhtml';
import {runWordPressTask,reconcileWordPressTask} from './wordpress';
import {runLeafletTask,reconcileLeafletTask} from './leaflet';
import {runGistTask} from './gist';
import {runSupanoteTask,reconcileSupanoteTask} from './supanote-publisher';

export interface ApiPublisher {
  prepare?(context:ExecutionContext):Promise<ExecutionResult|undefined>;
  publish(context:ExecutionContext):Promise<ExecutionResult>;
  reconcile?(context:ExecutionContext):Promise<{status:'found';publicUrl:string;leaflet?:NonNullable<ExecutionContext['task']['leaflet']>;wordpress?:NonNullable<ExecutionContext['task']['wordpress']>;paper?:NonNullable<ExecutionContext['task']['paper']>;hive?:NonNullable<ExecutionContext['task']['hive']>;mataroa?:NonNullable<ExecutionContext['task']['mataroa']>;verbose?:NonNullable<ExecutionContext['task']['verbose']>;prose?:NonNullable<ExecutionContext['task']['prose']>;rentry?:NonNullable<ExecutionContext['task']['rentry']>;lucid?:NonNullable<ExecutionContext['task']['lucid']>;betterthanhtml?:NonNullable<ExecutionContext['task']['betterthanhtml']>;supanote?:NonNullable<ExecutionContext['task']['supanote']>}|{status:'draft';blogger:NonNullable<ExecutionContext['task']['blogger']>}|{status:'draft';paragraph:NonNullable<ExecutionContext['task']['paragraph']>}|{status:'unknown'}>;
}
const publishers:Readonly<Record<string,ApiPublisher>>={
  paragraph:{publish:runParagraphTask,reconcile:reconcileParagraphTask},
  nostr:{publish:runNostrTask,reconcile:reconcileNostrTask},
  'paper-wf':{prepare:preparePaperIdentity,publish:runPaperTask,reconcile:reconcilePaperTask},
  hive:{publish:runHiveTask,reconcile:reconcileHiveTask},
  mataroa:{prepare:prepareMataroaIdentity,publish:runMataroaTask,reconcile:reconcileMataroaTask},
  verbose:{prepare:prepareVerboseIdentity,publish:runVerboseTask,reconcile:reconcileVerboseTask},
  prose:{publish:runProseTask,reconcile:reconcileProseTask},
  rentry:{prepare:prepareRentryIdentity,publish:runRentryTask,reconcile:reconcileRentryTask},
  'lucid-page':{publish:runLucidTask,reconcile:reconcileLucidTask},
  betterthanhtml:{publish:runBetterThanHtmlTask,reconcile:reconcileBetterThanHtmlTask},
  bluesky:{publish:runBlueskyTask,reconcile:reconcileBlueskyTask},
  blogger:{publish:runBloggerTask,reconcile:reconcileBloggerTask},
  'wordpress-com':{publish:runWordPressTask,reconcile:reconcileWordPressTask},
  leaflet:{publish:runLeafletTask,reconcile:reconcileLeafletTask},
  telegraph:{publish:runTelegraphTask,reconcile:reconcileTelegraphTask},
  'github-gist':{publish:runGistTask},
  supanote:{publish:runSupanoteTask,reconcile:reconcileSupanoteTask},
};
/** Only registered built-in API adapters may execute; a catalog label grants nothing. */
export function publisherFor(channel:Channel):ApiPublisher|undefined{
  return channel.provenance==='built-in'&&channel.automation==='api'?publishers[channel.id]:undefined;
}
