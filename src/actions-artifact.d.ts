declare module "@actions/artifact" {
  export interface UploadArtifactResponse {
    size?: number;
    id?: number;
    digest?: string;
  }

  export interface UploadArtifactOptions {
    retentionDays?: number;
    compressionLevel?: number;
    includeHiddenFiles?: boolean;
  }

  export interface ArtifactClient {
    uploadArtifact(
      name: string,
      files: string[],
      rootDirectory: string,
      options?: UploadArtifactOptions
    ): Promise<UploadArtifactResponse>;
  }

  const client: ArtifactClient;
  export default client;
}
