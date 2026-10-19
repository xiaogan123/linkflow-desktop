import type {Store} from '../../src/main/store';
import {capturePublicationSnapshots} from '../../src/main/publication-snapshot';

/** Modern receipt fixtures represent the same atomic snapshot written by production before POST. */
export function pinPublicationFixtures(store:Store):Store {
  const state=store.read();
  if(state.tasks.some(task=>task.submittedAt&&task.draft&&!task.publicationSnapshot))store.update(next=>{
    const previous={tasks:next.tasks.map(task=>task.publicationSnapshot?task:{...task,submittedAt:undefined})};
    capturePublicationSnapshots(previous,next);
  });
  return store;
}
