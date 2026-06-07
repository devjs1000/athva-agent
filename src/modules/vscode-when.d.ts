export interface VscodeWhenContext {
  resourcePath: string;
  resourceName: string;
  resourceExtname: string;
  resourceFilename: string;
  resourceIsFolder: boolean;
  resourceIsRoot: boolean;
  resourceScheme: string;
  resourceLangId?: string;
  resourceReadonly?: boolean;
  isFileSystemResource?: boolean;
  editorFocus?: boolean;
  textInputFocus?: boolean;
  selectionExists?: boolean;
  view?: string;
}

export declare function matchesVscodeWhenClause(when: string | undefined, context: VscodeWhenContext): boolean;
