/** Per-document startup handshake: receiving a snapshot alone does not confirm a render. */
export class RendererReadiness {
  private delivered=false;
  private ready=false;
  private waiters:Array<()=>void>=[];
  reset(){this.delivered=false;this.ready=false}
  snapshotDelivered(){this.delivered=true}
  acknowledge():boolean {
    if(!this.delivered)return false;
    this.ready=true;for(const resolve of this.waiters.splice(0))resolve();return true;
  }
  isReady(){return this.ready}
  wait():Promise<void>{return this.ready?Promise.resolve():new Promise(resolve=>this.waiters.push(resolve))}
}
