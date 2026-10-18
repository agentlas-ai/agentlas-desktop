import type { HarnessPortResultView } from '@shared/types';
export interface SkillPluginMention {id:string;slug:string;mention:string;name:string;description:string}
type Reader={search:(query:string,kind:'plugin')=>Promise<Array<{id:string}>>;call:(operation:string,args?:Record<string,unknown>)=>Promise<HarnessPortResultView>};
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
/** Discovery never enables a plugin or changes MCP selection. Verify installed state and readable router bytes. */
export async function loadSkillPluginMentions(reader:Reader):Promise<SkillPluginMention[]> {
 const found=await reader.search('','plugin');if(!Array.isArray(found))return [];
 const rows=found.slice(0,100).map(record).filter((row):row is Record<string,unknown>=>!!row&&typeof row.id==='string'&&/^plugin:[a-z0-9][a-z0-9_-]{0,127}$/.test(row.id));
 const result:SkillPluginMention[]=[];let next=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(next<rows.length){const candidate=rows[next++];try{
  const described=await reader.call('plugin.describe',{packageId:candidate.id});const data=record(described.data);if(described.status!=='ok'||!data||data.installed!==true||data.enabled!==true||data.hasSkills!==true||data.id!==candidate.id||typeof data.slug!=='string'||data.id!==`plugin:${data.slug}`||typeof data.mention!=='string'||!/^@[a-z0-9][a-z0-9_-]{0,127}$/i.test(data.mention)||typeof data.name!=='string'||!data.name.trim()||!Array.isArray(data.skills))continue;
  const names=data.skills.filter((name):name is string=>typeof name==='string'&&/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(name)).sort();const entry=names.includes('index')?'index':names[0];if(!entry)continue;
  const read=await reader.call('skill.read',{skillId:`${data.id}/${entry}`});const skill=record(read.data);if(read.status!=='ok'||!skill||skill.skillId!==`${data.id}/${entry}`||typeof skill.content!=='string'||!skill.content.trim()||typeof skill.revision!=='string'||!/^[a-f0-9]{64}$/.test(skill.revision))continue;
  result.push({id:data.id,slug:data.slug,mention:data.mention,name:data.name.slice(0,160),description:typeof data.description==='string'?data.description.slice(0,280):''});
 }catch{/* An unreadable or removed entry is omitted, never represented as usable. */}}}));
 const counts=new Map<string,number>();for(const row of result)counts.set(row.mention.toLowerCase(),(counts.get(row.mention.toLowerCase())??0)+1);
 return result.filter(row=>counts.get(row.mention.toLowerCase())===1).sort((a,b)=>a.slug.localeCompare(b.slug));
}
export function matchingSkillPluginMentions(rows:readonly SkillPluginMention[],query:string):SkillPluginMention[]{const q=query.toLowerCase();return rows.filter(row=>!q||[row.slug,row.mention,row.name].some(value=>value.toLowerCase().includes(q))).slice(0,8);}
export function appendSkillPluginMention(text:string,mention:string):string{return `${text}${text&&!/\s$/.test(text)?' ':''}${mention} `;}
