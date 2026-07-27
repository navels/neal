export type LocalNealContextStatePathSource = 'explicit' | 'current_pointer';

export type BuildLocalNealContextPackArgs = {
  cwd: string;
  statePath?: string | null;
  planPath?: string | null;
  now?: Date;
  perArtifactByteLimit?: number;
  totalByteLimit?: number;
};
