export interface Template {
  name: string;
  label: string;
  description: string;
  githubRepo: string;
  tags?: string[];
  icon?: string;
}

/**
 * One file on its way out of a template repo and into the WebContainer.
 *
 * `content` is base64 when `isBinary`, UTF-8 text otherwise. base64 is legitimate here because this
 * is a WIRE format (`spec/binary-files.md`): it is decoded to bytes at the `fs.writeFile` call, never
 * becomes live store state, and never travels through a `boltArtifact`.
 */
export interface TemplateFile {
  name: string;
  path: string;
  content: string;
  isBinary?: boolean;
}
