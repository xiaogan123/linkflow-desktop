export type UpdatePlatform='darwin-arm64'|'win32-x64';
export type UpdateAssetFormat='zip'|'nsis';
export type UpdatePhase='idle'|'checking'|'available'|'downloading'|'prepared'|'installing'|'installed'|'up-to-date'|'unsupported'|'failed';

export interface UpdateAsset {
  url:string;
  size:number;
  sha256:string;
  format:UpdateAssetFormat;
}

export interface UpdateManifest {
  schemaVersion:1;
  version:string;
  publishedAt:string;
  releaseNotes:string;
  assets:Partial<Record<UpdatePlatform,UpdateAsset>>;
}

export interface UpdateProgress {
  receivedBytes:number;
  totalBytes:number;
  percent:number;
}

export interface UpdateState {
  phase:UpdatePhase;
  currentVersion:string;
  targetVersion?:string;
  releaseNotes?:string;
  publishedAt?:string;
  checkedAt?:string;
  progress?:UpdateProgress;
  retryable?:boolean;
  error?:string;
}

export interface UpdateInstallHandoff {
  accepted:true;
  targetVersion:string;
}
