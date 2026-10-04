import type { LinkedFileArtifact } from "@/components/Markdown";
import type { LiveOutputKind } from "@/components/LiveOutputViewer";

export interface PersonalOneFile {
  name: string;
  path: string;
  source: string;
  kind: LiveOutputKind | "markdown" | "text" | "unsupported";
  chatId: string;
}
/** Reuse Main's authorized localfile protocol; never construct an executable file/HTML frame. */
export function personalOneFile(file:LinkedFileArtifact,chatId:string):PersonalOneFile {
  const path=[file.path,...(file.paths ?? []),file.href].find(value=>typeof value==='string' && (/^\//.test(value)||/^[A-Za-z]:[\\/]/.test(value)));
  if(!path || /\u0000/u.test(path)) throw new TypeError('personal_one_file_reference_unavailable');
  const filename=path.replaceAll('\\','/').split('/').at(-1) || 'File';
  const ext=filename.split('.').at(-1)?.toLowerCase();
  // A prose link label such as "Read PDF" is not a filename. Preserve the real
  // extension for the existing viewer's format detection instead of guessing from it.
  const name=file.name?.split('.').at(-1)?.toLowerCase()===ext?file.name:filename;
  const formats:Record<string,PersonalOneFile['kind']>={png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',avif:'image',svg:'image',
    mp4:'video',webm:'video',mov:'video',m4v:'video',mp3:'audio',m4a:'audio',wav:'audio',ogg:'audio',flac:'audio',
    pdf:'pdf',doc:'document',docx:'document',docm:'document',rtf:'document',odt:'document',pages:'document',hwp:'document',hwpx:'document',
    ppt:'presentation',pptx:'presentation',odp:'presentation',key:'presentation',xls:'spreadsheet',xlsx:'spreadsheet',csv:'spreadsheet',tsv:'spreadsheet',ods:'spreadsheet',numbers:'spreadsheet',zip:'archive',
    md:'markdown',mdx:'markdown',txt:'text',json:'text',jsonl:'text',js:'text',ts:'text',tsx:'text',py:'text',html:'text',htm:'text',css:'text',yaml:'text',yml:'text',tex:'text'};
  return {name,path,source:`agentlas://localfile/?p=${encodeURIComponent(path)}`,kind:formats[ext ?? ''] ?? 'unsupported',chatId};
}
