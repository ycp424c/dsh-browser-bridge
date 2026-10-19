import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const DSH_VERSION = '0.2.1-rc.2'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function modules(prefix) { return fs.existsSync(path.join(prefix, 'node_modules')) ? path.join(prefix, 'node_modules') : prefix }
function packages(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).filter(x => x.name.startsWith('@')).flatMap(scope =>
    fs.readdirSync(path.join(dir, scope.name)).map(name => path.join(dir, scope.name, name)))
}
function runtimeTarget(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['import', 'node', 'default', 'require']) { const hit=runtimeTarget(value[key]); if(hit)return hit }
}
export function sdkConfig() {
  const file = path.join(root, '.dsh/sdk.json')
  if (!fs.existsSync(file)) throw new Error('Run node scripts/setup-dsh.mjs <runtime-prefix> <DSH-source-at-dsh-v0.2.1-rc.2> [extra-sdk-prefix] before install/check')
  return json(file)
}
export function testAliases() {
  const { runtime, source, extras } = sdkConfig()
  const aliases = new Map()
  for (const prefix of [runtime, ...extras]) for (const dir of packages(modules(prefix))) {
    const file=path.join(dir,'package.json'); if(!fs.existsSync(file))continue
    const pkg=json(file)
    for (const [key, value] of Object.entries(pkg.exports??{'.':pkg.module??pkg.main})) {
      if(key.includes('*'))continue
      const target=runtimeTarget(value)
      if(target)aliases.set(pkg.name+(key==='.'?'':key.slice(1)),path.resolve(dir,target))
    }
  }
  const sourceFile = relative => path.join(source, relative)
  aliases.set('@deepseek-ai/dsh-client-ui-renderer/client',sourceFile('packages/client/ui-renderer/src/client/registry.ts'))
  aliases.set('@deepseek-ai/dsh-api-session-controller/client',sourceFile('packages/api/session-controller/src/client/scope.ts'))
  aliases.set('@deepseek-ai/dsh-client-ui-conversation/client',path.join(root,'.dsh/conversation-engine.ts'))
  const require=createRequire(path.join(root,'package.json'))
  for(const name of ['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom','react-dom/client','react-dom/server']) {
    try { aliases.set(name,require.resolve(name)) } catch {}
  }
  aliases.set('cordis',aliases.get('@deepseek-ai/cordis'))
  aliases.set('schemastery',aliases.get('@deepseek-ai/schemastery'))
  const entries=[...aliases].filter(([,target])=>target).map(([name,replacement])=>({find:new RegExp('^'+escape(name)+'$'),replacement}))
  entries.unshift({find:/^@deepseek-ai\/dsh-client-ui-chat\/src\/(.*)$/,replacement:sourceFile('packages/client/ui-chat/src/$1')})
  return entries
}
export function setup(args) {
  const argv=args.filter(x=>x!=='--')
  const runtime=path.resolve(argv[0]??process.env.DSH_SDK??'')
  const source=path.resolve(argv[1]??process.env.DSH_SOURCE??'')
  const extras=argv.slice(2).map(x=>path.resolve(x))
  if(!argv[0]&&!process.env.DSH_SDK)throw new Error('usage: node scripts/setup-dsh.mjs <runtime-prefix> <DSH-source-at-dsh-v0.2.1-rc.2> [extra-sdk-prefix]')
  if(json(path.join(modules(runtime),'@deepseek-ai/dsh/package.json')).version!==DSH_VERSION)throw new Error('Installed DSH SDK must be '+DSH_VERSION)
  if(json(path.join(source,'packages/client/ui-conversation/package.json')).version!==DSH_VERSION)throw new Error('Source checkout must be dsh-v'+DSH_VERSION)
  for(const file of ['packages/client/ui-conversation/src/client/conversation/assembler.ts','packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts','packages/client/ui-renderer/src/client/registry.ts','packages/api/session-controller/src/client/scope.ts'])fs.accessSync(path.join(source,file))
  const generated=path.join(root,'.dsh');fs.mkdirSync(generated,{recursive:true})
  const paths={}
  for(const prefix of [runtime,...extras]) for(const dir of packages(modules(prefix))){
    const file=path.join(dir,'package.json');if(!fs.existsSync(file))continue
    const pkg=json(file)
    if ((pkg.name === '@deepseek-ai/dsh' || pkg.name.startsWith('@deepseek-ai/dsh-')) && pkg.version !== DSH_VERSION) {
      throw new Error('SDK package '+pkg.name+' must be '+DSH_VERSION+', got '+pkg.version)
    }
    for(const [key,value] of Object.entries(pkg.exports??{'.':{types:pkg.types}})){
      const target=typeof value==='object'&&value!==null ? runtimeTarget(value.types) : undefined
      if(key.includes('*')||!target)continue
      paths[pkg.name+(key==='.'?'':key.slice(1))]=[path.resolve(dir,target)]
    }
    const link=path.join(generated,'sdk',pkg.name);fs.mkdirSync(path.dirname(link),{recursive:true})
    if(fs.lstatSync(link,{throwIfNoEntry:false})?.isSymbolicLink())fs.unlinkSync(link)
    if(!fs.existsSync(link))fs.symlinkSync(dir,link,'dir')
  }
  for(const name of ['@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives'])if(!paths[name])throw new Error('SDK missing '+name+'; include its installation prefix as an extra SDK argument')
  paths.cordis=paths['@deepseek-ai/cordis'];paths.schemastery=paths['@deepseek-ai/schemastery']
  fs.writeFileSync(path.join(generated,'tsconfig.paths.json'),JSON.stringify({compilerOptions:{paths}},null,2)+'\n')
  fs.writeFileSync(path.join(generated,'sdk.json'),JSON.stringify({version:DSH_VERSION,runtime,source,extras},null,2)+'\n')
  fs.writeFileSync(path.join(generated,'conversation-engine.ts'),['event-registry:ConversationEventRegistry','assembler:ConversationNodeAssembler','view-registry:ConversationViewRegistry','group-registry:ConversationGroupRegistry'].map(item=>{const [file,name]=item.split(':');return `export { ${name} } from ${JSON.stringify(path.join(source,'packages/client/ui-conversation/src/client/conversation',file+'.ts'))}`}).join('\n')+'\n')
  console.log('Configured installed DSH '+DSH_VERSION+' SDK and matching client test source; upstream files were not changed.')
}
