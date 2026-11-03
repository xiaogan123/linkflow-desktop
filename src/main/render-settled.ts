/** The page's load event can arrive before the debugger reports the same responses finished; wait briefly for those reports. */
export async function networkEventsSettled(done:()=>boolean,signal:AbortSignal,timeoutMs=3000):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!done()&&!signal.aborted&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
}
