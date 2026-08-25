/**
 * A file selected through the upload zone, paired with its path relative to
 * the drop or picker root so directory structure can be preserved.
 */
export interface UploadedFile {
  readonly file: File;
  readonly relativePath: string;
}
